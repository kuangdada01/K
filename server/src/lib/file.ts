/**
 * ============================================================
 * 文件系统工具（lib/file）
 * ============================================================
 * 上传文件的安全删除逻辑（自 utils.ts 拆分而来，行为保持不变）。
 */

import path from 'path';
import fs from 'fs';
import { SERVER_ROOT } from '../config';
import { logger } from './logger';

/**
 * 解析 posts.image_url（JSON 数组；旧格式单个 URL 字符串兜底为单元素数组）
 */
export function parseImageUrlArray(imageUrl: string): string[] {
  try {
    return JSON.parse(imageUrl);
  } catch {
    return [imageUrl];
  }
}

/**
 * 删除帖子关联的媒体文件（图片列表/视频/封面）
 * 用户端删帖（crud.ts）与管理端删帖/删用户（admin.ts）共用
 */
export function deletePostMediaFiles(post: {
  image_url: string;
  video_url?: string | null;
  video_cover?: string | null;
}): void {
  for (const url of parseImageUrlArray(post.image_url)) {
    safeDeleteFile(url);
  }
  if (post.video_url) safeDeleteFile(post.video_url);
  if (post.video_cover) safeDeleteFile(post.video_cover);
}

/**
 * 安全删除上传的文件
 * 验证文件路径在允许的目录内，防止路径遍历攻击
 *
 * @param fileUrl - 文件的相对路径（如 /uploads/image.jpg）
 * @param allowedSubdir - 允许的子目录（如 'uploads' 或 'uploads/avatars'）
 * @returns 是否成功删除
 */
export function safeDeleteFile(fileUrl: string, allowedSubdir: string = 'uploads'): boolean {
  try {
    // 构建完整路径（去掉开头的 /，否则 path.join 会当作绝对路径）
    // 基准目录固定为 server 根（PATHS 基于 __dirname，tsx 开发与 dist 编译产物行为一致）
    const relativeUrl = fileUrl.startsWith('/') ? fileUrl.slice(1) : fileUrl;
    const fullPath = path.join(SERVER_ROOT, relativeUrl);

    // 规范化路径，防止 ../ 遍历
    const normalizedPath = path.normalize(fullPath);
    const uploadsDir = path.join(SERVER_ROOT, allowedSubdir);

    // 验证路径是否在允许的目录内（追加分隔符，防止 uploads-evil 这类兄弟目录撞前缀）
    if (!normalizedPath.startsWith(uploadsDir + path.sep) && normalizedPath !== uploadsDir) {
      logger.warn(`Path traversal attempt blocked: ${fileUrl}`);
      return false;
    }

    // 检查文件是否存在并删除
    if (fs.existsSync(normalizedPath)) {
      fs.unlinkSync(normalizedPath);
      return true;
    }
    return false;
  } catch (err) {
    logger.error({ err }, `Failed to delete file ${fileUrl}`);
    return false;
  }
}

/**
 * 按 multer 落盘的绝对路径安全删除（validate 中间件用）
 *
 * multer 的 destination 由各路由自行配置（uploads / uploads_private），
 * validate 层无法预知子目录，这里从绝对路径反推出相对 URL，
 * 首段目录必须是 uploads 或 uploads_private 才允许删除。
 */
export function safeDeleteUpload(absPath: string): boolean {
  const rel = path.relative(SERVER_ROOT, absPath).split(path.sep).join('/');
  const top = rel.split('/')[0];
  if (top !== 'uploads' && top !== 'uploads_private') {
    logger.warn(`Path traversal attempt blocked: ${absPath}`);
    return false;
  }
  return safeDeleteFile(`/${rel}`, top);
}
