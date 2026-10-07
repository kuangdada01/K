/**
 * ============================================================
 * 类型化 API 层 - 帖子/评论（/api/posts）
 * ============================================================
 * 集中定义端点与参数类型，替代散落各处的字符串 URL 拼接。
 */

import api, { ApiError } from './http';
import { isNative } from '../lib/native';
import { UPLOAD_CHUNK_BYTES } from '@k/shared';
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
  /** P2-4.3：本页末行游标（任意模式都返回，客户端可随时切换到游标续拉） */
  next_cursor?: string | null;
  has_more?: boolean;
}

/** 信息流列表（页码模式，旧客户端兼容） */
export function listPosts(page = 1, limit = 20, opts?: { timeout?: number }): Promise<PostListResponse> {
  return api
    .get(`/posts`, {
      params: { page, limit },
      ...(opts?.timeout !== undefined ? { timeout: opts.timeout } : {}),
    })
    .then((r) => r.data);
}

/**
 * 信息流列表（游标模式，P2-4.3）：基于 (created_at, id) 的稳定游标，
 * 翻页期间的插入/删除不会移动边界（不跳不重），深页查询也不随偏移变慢。
 * @param cursor 上一页的 next_cursor；undefined = 第一页
 */
export function listPostsByCursor(
  cursor?: string | null,
  limit = 20,
  opts?: { timeout?: number }
): Promise<{ posts: Post[]; next_cursor: string | null; has_more: boolean }> {
  return api
    .get(`/posts`, {
      params: cursor ? { cursor, limit } : { limit },
      ...(opts?.timeout !== undefined ? { timeout: opts.timeout } : {}),
    })
    .then((r) => r.data);
}

/** 搜索帖子（q=关键词模糊匹配；tag=话题精确匹配，优先于 q） */
export function searchPosts(q: string, page = 1, limit = 20, tag?: string): Promise<PostListResponse> {
  return api
    .get('/posts/search', { params: tag ? { tag, page, limit } : { q, page, limit } })
    .then((r) => r.data);
}

export interface PostDetailResponse {
  post: Post;
  comments: Comment[];
  /** 分页模式（传 commentLimit）下的附加字段；全量模式为 undefined */
  comments_has_more?: boolean;
  comments_total?: number;
}

/** 帖子详情（commentLimit 缺省 = 全量评论，兼容旧契约；传入则按顶级评论分页） */
export function getPost(postId: number, opts?: { commentLimit?: number }): Promise<PostDetailResponse> {
  return api
    .get(`/posts/${postId}`, {
      params: opts?.commentLimit !== undefined ? { comment_limit: opts.commentLimit } : undefined,
    })
    .then((r) => r.data);
}

/** 评论分页续拉（顶级评论升序游标） */
export function listCommentsPaged(
  postId: number,
  opts: { afterId: number; limit?: number }
): Promise<{ comments: Comment[]; has_more: boolean; total: number }> {
  return api
    .get(`/posts/${postId}/comments`, { params: { after_id: opts.afterId, limit: opts.limit ?? 10 } })
    .then((r) => r.data);
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
  if (isNative()) {
    return nativeFetchUpload<Post>('/posts', formData, 'POST');
  }
  return api
    .post('/posts', formData, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 0 })
    .then((r) => r.data);
}

/** 创建视频帖子（multipart）- 原生走 fetch 流式上传防闪退 */
export function createVideoPost(formData: FormData): Promise<Post> {
  if (isNative()) {
    return nativeFetchUpload<Post>('/posts/video', formData, 'POST');
  }
  return api
    .post('/posts/video', formData, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 0 })
    .then((r) => r.data);
}

/**
 * 计算一段二进制内容的 SHA-256（hex 小写）。
 * 只用于 ≤5MB 的分片摘要 —— 整文件摘要需要把 1GB 读进内存，
 * 那正是分片上传要避免的 OOM 场景（内容完整性由逐片摘要 + 顺序 + 总大小保证）。
 */
async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 从上传错误中提取服务端给出的期望分片号（分片顺序冲突时用于恢复续传） */
function expectedChunkIndexFrom(err: unknown): number | null {
  const data = (
    err instanceof ApiError ? err.response.data : (err as { response?: { data?: unknown } })?.response?.data
  ) as { expectedChunkIndex?: unknown } | undefined;
  const v = data?.expectedChunkIndex;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

/**
 * 原生大文件分片上传（>20MB 走此路径，5MB/片，避免单次 1G 全部进内存 OOM）
 * 先切片 POST /posts/video-chunk，再用 video_url 完成 POST /posts/video
 *
 * 幂等与恢复（与服务端 P0 修复配套）：
 * - 每片带 sha256 摘要：服务端「已写入但响应丢失」后的重试会命中已确认记录，
 *   原样返回确认，不会重复追加；同片不同内容会被 409 拒绝。
 * - 服务端拒绝乱序时返回 expectedChunkIndex，这里据此跳回正确片号续传，
 *   不再从第 0 片重头再来。
 */
export async function createVideoPostChunked(
  videoFile: File,
  coverFile: File | null,
  description: string,
  closeComments: boolean,
  pinned: boolean,
  onProgress?: (pct: number) => void
): Promise<Post> {
  // 分片大小必须与服务端一致（服务端按同一常量换算 MAX_TOTAL_CHUNKS 做校验）
  const CHUNK_SIZE = UPLOAD_CHUNK_BYTES;
  const totalChunks = Math.ceil(videoFile.size / CHUNK_SIZE);
  // 生成与服务端一致的 temp 文件名（白名单校验）
  const rand = Math.floor(Math.random() * 1_000_000_000);
  const uploadId = `temp-${Date.now()}-${rand}.mp4`;
  /** 发送一个分片（带内容摘要），返回服务端确认的连续进度 received */
  const sendChunk = async (index: number): Promise<number> => {
    const start = index * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, videoFile.size);
    const chunk = videoFile.slice(start, end);
    const fd = new FormData();
    fd.append('uploadId', uploadId);
    fd.append('chunkIndex', String(index));
    fd.append('totalChunks', String(totalChunks));
    fd.append('sha256', await sha256Hex(await chunk.arrayBuffer()));
    fd.append('chunk', chunk, `chunk-${index}`);
    const r = await nativeFetchUpload<{ received?: number }>('/posts/video-chunk', fd, 'POST');
    return typeof r.received === 'number' ? r.received : index + 1;
  };
  try {
    // 可恢复的进度循环：nextIndex 以服务端确认值（received）为准推进。
    // 网络失败指数退避重试；顺序冲突按服务端 expectedChunkIndex 跳转续传。
    // 连续失败上限防服务端反复回绕导致死循环。
    let nextIndex = 0;
    let failures = 0;
    const maxFailures = totalChunks * 2 + 3;
    while (nextIndex < totalChunks) {
      try {
        const received = await sendChunk(nextIndex);
        if (received <= nextIndex) throw new Error('服务端未确认分片进度');
        nextIndex = received;
        failures = 0;
        onProgress?.(Math.round((nextIndex / totalChunks) * 90)); // 90% 为分片阶段
      } catch (e) {
        const expected = expectedChunkIndexFrom(e);
        if (expected != null && expected !== nextIndex) {
          nextIndex = expected;
          continue;
        }
        if (++failures >= maxFailures) throw e;
        await new Promise((r) => setTimeout(r, Math.min(500 * failures, 3000)));
      }
    }
    // 分片完成后走现有 video_url 流程（服务端会校验片数与总大小，再移动并转码、生成封面）
    const finalFd = new FormData();
    finalFd.append('video_url', `/uploads/temp/${uploadId}`);
    finalFd.append('video_bytes', String(videoFile.size));
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
  if (isNative()) {
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

/**
 * 查询临时视频转码状态。
 * - done: 已是可播 H.264 → 客户端可加载预览
 * - encoding: 排队中/转码中
 * - failed: 转码任务重试耗尽后**最终失败**（P1-3.4 起如实暴露，不再无限归入 encoding；
 *   客户端应提示重新选择视频，而不是轮询到超时）
 * - missing: 文件不存在（上传未完成或已被 TTL 清理）
 * 轮询接口：请求显式 no-cache，防止浏览器把状态响应当静态资源缓存
 * （服务端已发 Cache-Control: no-store，此处双保险） */
export function getTempVideoStatus(
  url: string
): Promise<{ status: 'done' | 'encoding' | 'failed' | 'missing'; error?: string }> {
  return api
    .get('/posts/video-temp/status', {
      params: { url },
      headers: { 'Cache-Control': 'no-cache' },
    })
    .then((r) => r.data);
}

/**
 * 用已上传的临时视频发布（POST /posts/video 的 video_url 分支）：
 * 预览通道上传过的文件由服务端直接移动到正式目录并转码，不二次上传。
 * 与 createVideoPost 相同的 native/web 双通道。
 */
export async function createVideoPostFromTempUrl(
  videoUrl: string,
  coverFile: File | null,
  description: string,
  closeComments: boolean,
  pinned: boolean
): Promise<Post> {
  const fd = new FormData();
  fd.append('video_url', videoUrl);
  if (coverFile) fd.append('cover', coverFile);
  fd.append('description', description);
  if (closeComments) fd.append('close_comments', '1');
  if (pinned) fd.append('pinned', '1');
  if (isNative()) {
    return nativeFetchUpload<Post>('/posts/video', fd, 'POST');
  }
  return api
    .post('/posts/video', fd, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 0 })
    .then((r) => r.data);
}

/** 编辑帖子（multipart，新增图片可能达9×10MB，同样禁用超时避免误报失败） */
export function updatePost(postId: number, formData: FormData): Promise<Post> {
  if (isNative()) {
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
