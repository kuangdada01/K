/**
 * ============================================================
 * 统一文件上传工厂（lib/upload）
 * ============================================================
 * 收敛 posts/users/messages 三处重复的 multer 配置，
 * 各路由只需声明目录/文件名规则/大小限制/过滤函数。
 */

import multer from 'multer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { PATHS } from '../config';

/** multer 文件名规则函数 */
export type FilenameFn = (file: Express.Multer.File) => string;

/** 文件名随机后缀（crypto 随机，避免 Math.random 可预测） */
function randomSuffix(): number {
  return crypto.randomInt(1, 1_000_000_000);
}

/** 通用文件名: {prefix}-{时间戳}-{随机数}.{原扩展名}（与历史 posts 规则一致） */
export function timestampFilename(prefix: string): FilenameFn {
  return (file) => {
    const uniqueSuffix = Date.now() + '-' + randomSuffix();
    const ext = path.extname(file.originalname);
    return `${prefix}-${uniqueSuffix}${ext}`;
  };
}

/** 消息图片文件名规则（与历史 messages 规则一致） */
export const messageFilename: FilenameFn = (file) => {
  const ext = path.extname(file.originalname);
  return `msg_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
};

/** 创建上传中间件 */
export function createUploader(options: {
  /** 保存目录（相对 server 根的 PATHS 常量或绝对路径） */
  dir: string;
  /** 文件名生成函数 */
  filename: FilenameFn;
  /** 单文件大小上限（字节） */
  maxSize: number;
  /** 文件类型过滤 */
  fileFilter: multer.Options['fileFilter'];
}): multer.Multer {
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
      if (!fs.existsSync(options.dir)) fs.mkdirSync(options.dir, { recursive: true });
      cb(null, options.dir);
    },
    filename: (_req, file, cb) => {
      cb(null, options.filename(file));
    },
  });
  return multer({
    storage,
    limits: { fileSize: options.maxSize },
    fileFilter: options.fileFilter,
  });
}

/** 预设：头像/私密图片上传（uploads/avatars/ 目录，avatar- 前缀，10MB） */
export function createAvatarUploader(fileFilter: multer.Options['fileFilter']): multer.Multer {
  return createUploader({
    dir: PATHS.avatars,
    filename: timestampFilename('avatar'),
    maxSize: 10 * 1024 * 1024,
    fileFilter,
  });
}
