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
