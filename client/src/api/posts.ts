/**
 * ============================================================
 * 类型化 API 层 - 帖子/评论（/api/posts）
 * ============================================================
 * 集中定义端点与参数类型，替代散落各处的字符串 URL 拼接。
 */

import api, { ApiError } from './http';
import { Capacitor } from '@capacitor/core';
import { getApiBaseUrl } from '../config';
import type { Post, Comment, PaginatedResponse } from '../types';

/**
 * 原生 App 大文件上传闪退根因：
 * - WebView JS 堆 ~256MB，axios 默认经 CapacitorHttp 桥接会把 300MB File 序列化到 Native 层，
 *   桥接层 JSON/OkHttp 缓冲区二次拷贝直接 OOM 触发 SIGKILL（无 JS 异常、直接闪退）。
 * - 解决方案：原生平台走 window.fetch 直连（Vary: Origin 已放行 http://localhost），
 *   由 Chromium 网络栈流式发送，不经 JS 桥接；同时不手动设置 Content-Type（让浏览器自动生成 boundary）。
 *   失败时抛出的错误对象兼容 axios 的 err.response?.data?.error 读取。
 */
async function nativeFetchUpload<T>(
  path: string,
  formData: FormData,
  method: 'POST' | 'PUT' = 'POST'
): Promise<T> {
  const token = localStorage.getItem('k_token');
  const url = `${getApiBaseUrl()}${path}`;
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  // 关键：不要设置 Content-Type，fetch 会自动带 multipart/form-data; boundary=...
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: formData });
  } catch (e) {
    // 网络层直接崩溃（如 OOM 前的 Failed to fetch）转为可读错误
    throw new ApiError(e instanceof Error ? e.message : '网络异常，可能是文件过大导致内存不足', {
      data: { error: '上传失败：文件过大或内存不足，请尝试压缩后重传' },
    });
  }
  if (!res.ok) {
    try {
      const data = await res.json();
      throw new ApiError(`HTTP ${res.status}`, { data, status: res.status });
    } catch (parseErr) {
      if (parseErr instanceof ApiError) throw parseErr;
      throw new ApiError(`HTTP ${res.status}`, {
        data: { error: `上传失败（${res.status}）` },
        status: res.status,
      });
    }
  }
  return (await res.json()) as T;
}

export interface PostListResponse {
  posts: Post[];
  total: number;
  page: number;
  totalPages: number;
}

/** 信息流列表 */
export function listPosts(page = 1, limit = 20, opts?: { timeout?: number }): Promise<PostListResponse> {
  return api.get(`/posts`, { params: { page, limit }, timeout: opts?.timeout }).then((r) => r.data);
}

/** 搜索帖子（q=关键词模糊匹配；tag=话题精确匹配，优先于 q） */
export function searchPosts(q: string, page = 1, limit = 20, tag?: string): Promise<PostListResponse> {
  return api
    .get('/posts/search', { params: tag ? { tag, page, limit } : { q, page, limit } })
    .then((r) => r.data);
}

/** 帖子详情（含评论） */
export function getPost(postId: number): Promise<{ post: Post; comments: Comment[] }> {
  return api.get(`/posts/${postId}`).then((r) => r.data);
}

/** 收藏列表 */
export function myBookmarks(): Promise<{ posts: Post[] }> {
  return api.get('/posts/bookmarks/me').then((r) => r.data);
}

/** 转发列表 */
export function myReposts(): Promise<{ posts: Post[] }> {
  return api.get('/posts/reposts/me').then((r) => r.data);
}

/**
 * 创建图文帖子（multipart）
 * timeout: 0 — 图片最多9张×10MB，慢速网络上传可能超过全局15s超时；
 * 超时会让客户端误报失败，而服务端仍在处理并可能已入库（"发布失败但已发出"）。
 */
export function createImagePost(formData: FormData): Promise<Post> {
  if (Capacitor.isNativePlatform()) {
    return nativeFetchUpload<Post>('/posts', formData, 'POST');
  }
  return api
    .post('/posts', formData, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 0 })
    .then((r) => r.data);
}

/** 创建视频帖子（multipart）- 原生走 fetch 流式上传防闪退 */
export function createVideoPost(formData: FormData): Promise<Post> {
  if (Capacitor.isNativePlatform()) {
    return nativeFetchUpload<Post>('/posts/video', formData, 'POST');
  }
  return api
    .post('/posts/video', formData, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 0 })
    .then((r) => r.data);
}

/**
 * 原生大文件分片上传（>20MB 走此路径，5MB/片，避免单次 300M 全部进内存 OOM）
 * 先切片 POST /posts/video-chunk，再用 video_url 完成 POST /posts/video
 */
export async function createVideoPostChunked(
  videoFile: File,
  coverFile: File | null,
  description: string,
  closeComments: boolean,
  pinned: boolean,
  onProgress?: (pct: number) => void
): Promise<Post> {
  const CHUNK_SIZE = 5 * 1024 * 1024;
  const totalChunks = Math.ceil(videoFile.size / CHUNK_SIZE);
  // 生成与服务端一致的 temp 文件名（白名单校验）
  const rand = Math.floor(Math.random() * 1_000_000_000);
  const uploadId = `temp-${Date.now()}-${rand}.mp4`;
  try {
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, videoFile.size);
      const chunk = videoFile.slice(start, end);
      const fd = new FormData();
      fd.append('uploadId', uploadId);
      fd.append('chunkIndex', String(i));
      fd.append('totalChunks', String(totalChunks));
      fd.append('chunk', chunk, `chunk-${i}`);
      // 单片失败重试 2 次，避免弱网直接闪退式失败
      let lastErr: unknown = null;
      for (let retry = 0; retry < 3; retry++) {
        try {
          await nativeFetchUpload('/posts/video-chunk', fd, 'POST');
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          if (retry < 2) await new Promise((r) => setTimeout(r, 500 * (retry + 1)));
        }
      }
      if (lastErr) throw lastErr;
      onProgress?.(Math.round(((i + 1) / totalChunks) * 90)); // 90% 为分片阶段
    }
    // 分片完成后走现有 video_url 流程（服务端会移动并转码、生成封面）
    const finalFd = new FormData();
    finalFd.append('video_url', `/uploads/temp/${uploadId}`);
    if (coverFile) finalFd.append('cover', coverFile);
    finalFd.append('description', description);
    if (closeComments) finalFd.append('close_comments', '1');
    if (pinned) finalFd.append('pinned', '1');
    const post = await nativeFetchUpload<Post>('/posts/video', finalFd, 'POST');
    onProgress?.(100);
    return post;
  } catch (e) {
    // 失败时清理服务端半成品分片文件并释放上传会话，避免占用并发配额
    api.delete('/posts/video-temp', { data: { url: `/uploads/temp/${uploadId}` } }).catch(() => {});
    throw e;
  }
}

/** 上传临时视频（发布前预览）- 原生同样走 fetch */
export function uploadTempVideo(formData: FormData): Promise<{ url: string }> {
  if (Capacitor.isNativePlatform()) {
    return nativeFetchUpload<{ url: string }>('/posts/video-temp', formData, 'POST');
  }
  return api
    .post('/posts/video-temp', formData, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 0 })
    .then((r) => r.data);
}

/** 删除临时视频 */
export function deleteTempVideo(url: string): Promise<unknown> {
  return api.delete('/posts/video-temp', { data: { url } }).then((r) => r.data);
}

/** 编辑帖子（multipart，新增图片可能达9×10MB，同样禁用超时避免误报失败） */
export function updatePost(postId: number, formData: FormData): Promise<Post> {
  if (Capacitor.isNativePlatform()) {
    return nativeFetchUpload<Post>(`/posts/${postId}`, formData, 'PUT');
  }
  return api
    .put(`/posts/${postId}`, formData, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 0 })
    .then((r) => r.data);
}

/** 删除帖子 */
export function deletePost(postId: number): Promise<unknown> {
  return api.delete(`/posts/${postId}`).then((r) => r.data);
}

/** 点赞 */
export function likePost(postId: number): Promise<{ liked: boolean; like_count: number }> {
  return api.post(`/posts/${postId}/like`).then((r) => r.data);
}

/** 取消点赞 */
export function unlikePost(postId: number): Promise<{ liked: boolean; like_count: number }> {
  return api.delete(`/posts/${postId}/like`).then((r) => r.data);
}

/** 分享 */
export function sharePost(postId: number): Promise<{ share_count: number; shared: boolean }> {
  return api.post(`/posts/${postId}/share`).then((r) => r.data);
}

/** 收藏 */
export function bookmarkPost(postId: number): Promise<{ bookmarked: boolean }> {
  return api.post(`/posts/${postId}/bookmark`).then((r) => r.data);
}

/** 取消收藏 */
export function unbookmarkPost(postId: number): Promise<{ bookmarked: boolean }> {
  return api.delete(`/posts/${postId}/bookmark`).then((r) => r.data);
}

/** 转发 */
export function repostPost(postId: number): Promise<{ reposted: boolean; repost_count: number }> {
  return api.post(`/posts/${postId}/repost`).then((r) => r.data);
}

/** 取消转发 */
export function unrepostPost(postId: number): Promise<{ reposted: boolean; repost_count: number }> {
  return api.delete(`/posts/${postId}/repost`).then((r) => r.data);
}

/** 评论列表 */
export function listComments(postId: number): Promise<{ comments: Comment[] }> {
  return api.get(`/posts/${postId}/comments`).then((r) => r.data);
}

/** 发表评论 */
export function createComment(
  postId: number,
  body: { content: string; parentId?: number | null }
): Promise<Comment> {
  return api.post(`/posts/${postId}/comments`, body).then((r) => r.data);
}

/** 删除评论 */
export function deleteComment(commentId: number): Promise<{ message: string }> {
  return api.delete(`/posts/comments/${commentId}`).then((r) => r.data);
}

/** 点赞评论 */
export function likeComment(commentId: number): Promise<{ liked: boolean; like_count: number }> {
  return api.post(`/posts/comments/${commentId}/like`).then((r) => r.data);
}

/** 取消评论点赞 */
export function unlikeComment(commentId: number): Promise<{ liked: boolean; like_count: number }> {
  return api.delete(`/posts/comments/${commentId}/like`).then((r) => r.data);
}

// PaginatedResponse 引用保持向后兼容
export type { PaginatedResponse };
