/**
 * ============================================================
 * 分片上传会话注册表（lib/chunkUploadRegistry）
 * ============================================================
 * 自 routes/posts/media.ts 拆出，行为不变。
 * 管理临时视频（分片上传 / 临时上传预览）的属主注册与 TTL 惰性清理，
 * media.ts 改为 import 使用。
 */

import path from 'path';
import fs from 'fs';
import { PATHS } from '../config';
import { AppError } from '../middleware/error';

/** 临时视频文件名白名单: temp-{时间戳}-{随机数}.{视频扩展名} */
export const TEMP_VIDEO_NAME_RE = /^temp-\d+-\d+\.(mp4|mov|avi|webm|mkv|flv|wmv)$/;

/** 分片上传总量上限（与单次上传 300MB 对齐，追加时校验） */
export const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
/** 分片数上限 = 总量上限 / 客户端切片大小 5MB（multer 单片 6MB 仅作硬保护） */
export const MAX_TOTAL_CHUNKS = Math.ceil(MAX_VIDEO_BYTES / (5 * 1024 * 1024));
/** 同一用户并发分片上传上限（防批量 uploadId 占满磁盘） */
const MAX_CONCURRENT_CHUNK_UPLOADS = 3;
/** 上传会话 TTL（与临时文件 24h 清理周期一致） */
const CHUNK_UPLOAD_TTL = 24 * 3600 * 1000;

/**
 * 分片上传会话注册表：uploadId → 属主与创建时间
 * uploadId 由客户端生成、全局可猜，必须绑定属主，否则任意认证用户
 * 可向他人进行中的上传追加分片（污染视频内容）或无限追加写满磁盘。
 * 回收：POST /video 消费、DELETE /video-temp 放弃时显式删除；
 * 文件已不存在或超过 TTL 的条目在各请求前惰性清理。
 */
const chunkUploadOwners = new Map<string, { userId: number; createdAt: number }>();

/** 惰性清理：超过 TTL 或对应临时文件已不存在的会话（各请求前调用） */
export function pruneChunkUploads(): void {
  const cutoff = Date.now() - CHUNK_UPLOAD_TTL;
  for (const [id, entry] of chunkUploadOwners) {
    if (entry.createdAt < cutoff || !fs.existsSync(path.join(PATHS.uploadsTemp, id))) {
      chunkUploadOwners.delete(id);
    }
  }
}

/** 查询会话属主（无会话返回 undefined） */
export function getChunkOwner(uploadId: string): { userId: number; createdAt: number } | undefined {
  return chunkUploadOwners.get(uploadId);
}

/**
 * 首片（chunkIndex === 0）会话获取：新建或重传
 * - 他人占用中的会话不可抢占：抛 403 '该上传已被其他用户占用'（与原行为一致）
 * - 无属主且该用户并发数已达上限：返回 false（调用方抛 400 '同时进行的上传任务过多，请稍后再试'）
 * - 成功（新建 / 本人重传刷新 TTL）：返回 true
 */
export function acquireChunkUpload(uploadId: string, userId: number): boolean {
  const owner = chunkUploadOwners.get(uploadId);
  // 首片 = 新建/重传：他人占用中的会话不可抢占
  if (owner && owner.userId !== userId) {
    throw new AppError(403, '该上传已被其他用户占用');
  }
  const userUploads = [...chunkUploadOwners.values()].filter((e) => e.userId === userId).length;
  if (!owner && userUploads >= MAX_CONCURRENT_CHUNK_UPLOADS) {
    return false;
  }
  chunkUploadOwners.set(uploadId, { userId, createdAt: Date.now() });
  return true;
}

/**
 * 盲登记会话属主（POST /video-temp 发布前预览登记用）
 * 与原行为一致：不做并发/抢占校验，直接覆盖登记
 * （文件名由服务端随机生成，不存在他人占用问题）
 */
export function registerChunkUpload(uploadId: string, userId: number): void {
  chunkUploadOwners.set(uploadId, { userId, createdAt: Date.now() });
}

/** 释放会话（POST /video 消费、DELETE /video-temp 放弃时调用） */
export function releaseChunkUpload(uploadId: string): void {
  chunkUploadOwners.delete(uploadId);
}
