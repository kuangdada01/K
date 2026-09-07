/**
 * ============================================================
 * 帖子写入服务（services/post.service）
 * ============================================================
 * 自 routes/posts/crud.ts 的写路径编排拆出（创建图文帖 / 编辑帖 / 删除帖）。
 * 路由层仅保留 multer、认证、参数解析与响应映射；
 * 校验 → 压缩 → 入库 → syncPostTags → 失败清理全部收敛于此。
 *
 * §5.1 修复（随拆分带入 service 内）:
 * - keepImages 白名单: 保留项必须是本帖旧 image_url 数组的成员，否则 400
 * - 压缩失败孤儿文件: 任一张压缩失败即清理本次 multer 文件与已压缩产物再抛错
 * - DELETE 顺序: 先删 DB 行成功，再删磁盘文件（原实现反序）
 */

import path from 'path';
import { PATHS } from '../config';
import { AppError } from '../middleware/error';
import { compressImage } from '../lib/image';
import { safeDeleteFile, safeDeleteUpload, parseImageUrlArray, deletePostMediaFiles } from '../lib/file';
import { postTextSchema } from '@k/shared/schemas';
import { extractTags } from '@k/shared';
import * as postRepo from '../repositories/post.repo';

/** 图片压缩参数（帖子图片最大1920px，质量80） */
const POST_IMAGE_MAX = 1920;

/**
 * 压缩本次上传的图片（并行处理，减少响应等待；heic 会转成 jpg，以返回路径为准）。
 * §5.1 修复: 任一张失败时清理本次已落盘的所有 multer 文件与已压缩产物，
 * 再抛出原错误（原实现 Promise.all 失败会留下孤儿文件）。
 */
async function compressPostImages(files: Express.Multer.File[]): Promise<string[]> {
  const results = await Promise.allSettled(
    files.map((f) => compressImage(path.join(PATHS.uploads, f.filename), { maxWidth: POST_IMAGE_MAX }))
  );
  const urls: string[] = [];
  let firstError: unknown;
  for (const r of results) {
    if (r.status === 'rejected') {
      if (firstError === undefined) firstError = r.reason;
    } else {
      urls.push(`/uploads/${path.basename(r.value)}`);
    }
  }
  if (firstError !== undefined) {
    // 清理本次已落盘的所有 multer 文件与已压缩产物
    for (const f of files) safeDeleteUpload(f.path);
    for (const url of urls) safeDeleteFile(url);
    throw firstError;
  }
  return urls;
}

/** 清理本次 multer 已落盘的文件（校验失败等场景，避免孤儿文件） */
function cleanupUploadedFiles(files: Express.Multer.File[]): void {
  for (const f of files) safeDeleteUpload(f.path);
}

/**
 * 创建图文帖子（校验 → 压缩 → 入库 → syncPostTags；任一环节失败清理已落盘文件）
 *
 * 校验: 至少一张图片、标题/正文长度上限（multipart 文本字段，放在压缩副作用之前）
 */
export async function createPost(input: {
  userId: number;
  files: Express.Multer.File[];
  title: unknown;
  description: unknown;
  closeComments: number;
  pinned: number;
}): Promise<postRepo.PostWithUser> {
  const files = input.files;
  if (files.length === 0) {
    throw new AppError(400, '请选择图片');
  }

  // multipart 文本字段校验（标题/正文长度上限）：放在压缩等磁盘副作用之前，
  // 失败时清理 multer 已落盘的文件再返回 400，避免孤儿文件
  const parsedText = postTextSchema.safeParse({
    title: input.title || '',
    description: input.description || '',
  });
  if (!parsedText.success) {
    cleanupUploadedFiles(files);
    throw new AppError(400, parsedText.error.issues[0]?.message || '参数错误');
  }

  // 上传后压缩（并行处理；失败时清理已落盘文件与已压缩产物）
  const imageUrls = await compressPostImages(files);
  const imageUrl = JSON.stringify(imageUrls);

  const post = postRepo.createPost({
    userId: input.userId,
    imageUrl,
    title: parsedText.data.title,
    description: parsedText.data.description,
    closeComments: input.closeComments,
    pinned: input.pinned,
  });
  postRepo.syncPostTags(post.id, extractTags(parsedText.data.description));

  return post;
}

/**
 * 编辑自己的帖子
 * （keepImages 白名单 → 正文校验 → 压缩新图 → 合并 → 入库 → DB 成功后再删旧文件 → syncPostTags）
 */
export async function updatePost(input: {
  postId: number;
  userId: number;
  files: Express.Multer.File[];
  keepImages: unknown;
  description: string | undefined;
  closeComments: number;
  pinned: number;
}): Promise<postRepo.PostWithUser> {
  const post = postRepo.findOwnPost(input.postId, input.userId);

  if (!post) {
    throw new AppError(404, '帖子不存在或无权编辑');
  }

  // keepImages 解析：multipart 客户端传 JSON 字符串；JSON 客户端可能直接传数组。
  // 不能 JSON.parse(array)——数组会被 String() 成裸串再解析失败，
  // 或历史行为下拆成单字符数组写脏 image_url
  let keepImages: string[] = [];
  if (input.keepImages) {
    try {
      const raw = typeof input.keepImages === 'string' ? JSON.parse(input.keepImages) : input.keepImages;
      if (!Array.isArray(raw) || raw.some((u) => typeof u !== 'string')) {
        throw new Error('keepImages 必须是字符串数组');
      }
      keepImages = raw as string[];
    } catch {
      cleanupUploadedFiles(input.files);
      throw new AppError(400, 'keepImages 格式错误');
    }
  }

  // §5.1 keepImages 白名单：每一项必须是本帖子旧 image_url 数组的成员，
  // 否则整体拒绝（视频帖 image_url 为 '[]' → 旧数组为空 → keepImages 必须为空数组）。
  // 新图片 URL 只允许来自本次 multer 压缩产物（由下方 newFiles 构造天然保证）。
  const oldImages = parseImageUrlArray(post.image_url);
  if (keepImages.some((url) => !oldImages.includes(url))) {
    cleanupUploadedFiles(input.files);
    throw new AppError(400, 'keepImages 包含无效图片');
  }

  // 正文长度校验（编辑不涉及标题），失败清理 multer 已落盘文件后返回 400
  const parsedText = postTextSchema.pick({ description: true }).safeParse({
    description: input.description ?? '',
  });
  if (!parsedText.success) {
    cleanupUploadedFiles(input.files);
    throw new AppError(400, parsedText.error.issues[0]?.message || '参数错误');
  }

  // 合并保留的图片和新上传的图片（新图先压缩，heic 转 jpg 后以返回路径为准）
  const newFiles = await compressPostImages(input.files);
  const allImages = [...keepImages, ...newFiles];

  // 视频帖子允许空图片（image_url 为 '[]'），仅图文帖子要求至少一张
  const isVideoPost = !!post.video_url;
  if (allImages.length === 0 && !isVideoPost) {
    // 清理本次新上传的文件，避免孤儿文件
    for (const url of newFiles) {
      safeDeleteFile(url);
    }
    throw new AppError(400, '至少需要一张图片');
  }

  // 待删除的旧图列表：推迟到 DB 更新成功后再物理删除。
  // 否则后续校验/更新失败时，DB 仍指向已删除的文件，帖子图片将永久丢失。
  const removedOldImages = oldImages.filter((url) => !keepImages.includes(url));

  // 视频帖子保持 image_url 为 '[]'，避免存成 '["[]"]' 这种脏数据
  const finalImageUrl = isVideoPost && allImages.length === 0 ? '[]' : JSON.stringify(allImages);

  const updated = postRepo.updatePost({
    postId: input.postId,
    userId: input.userId,
    imageUrl: finalImageUrl,
    description: input.description || '',
    closeComments: input.closeComments,
    pinned: input.pinned,
  });

  if (!updated) {
    for (const url of newFiles) {
      safeDeleteFile(url);
    }
    throw new AppError(404, '帖子不存在或无权编辑');
  }

  // DB 更新成功后再删旧文件（removedOldImages 计算与删除时序与原有正确逻辑一致）
  for (const url of removedOldImages) {
    safeDeleteFile(url);
  }
  postRepo.syncPostTags(input.postId, extractTags(updated.description));

  return updated;
}

/**
 * 删除自己的帖子
 *
 * §5.1 DELETE 顺序：先收集全部媒体文件引用 → deletePost（DB）成功 → 再删磁盘文件
 * （原实现先删文件后删库：删库失败会留下指向已删文件的死链）
 */
export function deletePost(postId: number, userId: number): void {
  // 先收集全部媒体文件引用（行只保留在内存；删库后无从查起）
  const post = postRepo.findOwnPost(postId, userId);

  if (!post) {
    throw new AppError(404, '帖子不存在或无权删除');
  }

  // 删 DB 行成功（外键级联自动删除评论、点赞、通知等）
  postRepo.deletePost(postId);

  // 再删磁盘文件（图片/视频/封面）
  deletePostMediaFiles(post);
}
