/**
 * ============================================================
 * 分片上传会话注册表（lib/chunkUploadRegistry）
 * ============================================================
 * 自 routes/posts/media.ts 拆出，行为不变。
 * 管理临时视频（分片上传 / 临时上传预览）的属主注册与 TTL 惰性清理，
 * media.ts 改为 import 使用。
 *
 * 资源护栏：除属主绑定外，自 v0.2.38 起还承担「每用户临时视频字节配额」
 * 的记账。此前 /video-temp 既无并发上限也无配额，单个账号按全局写限流
 * （120 次/分钟）连发数十个 300MB 上传即可写满磁盘；磁盘写满后
 * better-sqlite3 写入失败，整站不可用且需人工介入。
 * ============================================================
 */

import path from 'path';
import fs from 'fs';
import { MAX_VIDEO_BYTES, UPLOAD_CHUNK_BYTES } from '@k/shared';
import { PATHS } from '../config';
import { AppError } from '../middleware/error';

/** 临时视频文件名白名单: temp-{时间戳}-{随机数}.{视频扩展名} */
export const TEMP_VIDEO_NAME_RE = /^temp-\d+-\d+\.(mp4|mov|avi|webm|mkv|flv|wmv)$/;

/**
 * 分片上传总量上限与分片大小都来自 `@k/shared`（P2-23）：
 * 客户端按 `UPLOAD_CHUNK_BYTES` 切片、这里按同一常量换算分片数上限，
 * 两边各写一份时只要有人改一边，就会表现为「合法视频被 400」或「超限视频被放行」。
 */
export { MAX_VIDEO_BYTES };
/** 分片数上限 = 总量上限 / 客户端切片大小（multer 单片 6MB 仅作硬保护） */
export const MAX_TOTAL_CHUNKS = Math.ceil(MAX_VIDEO_BYTES / UPLOAD_CHUNK_BYTES);
/** 同一用户并发分片上传上限（防批量 uploadId 占满磁盘） */
const MAX_CONCURRENT_CHUNK_UPLOADS = 3;
/** 同一用户并发「临时预览上传」（POST /video-temp）上限 */
const MAX_CONCURRENT_TEMP_UPLOADS = 3;

/**
 * 每用户临时视频总字节配额（分片上传 + 临时预览共用）。
 * 取 1GB ≈ 3 个 300MB 文件：正常发布流程（选一个视频 → 预览 → 发布）
 * 只用到一个槽位，宽裕；而刷满配额需要至少 4 个未发布的 300MB 草稿。
 * 配额按「注册表记账的字节数」计算，不额外扫盘。
 */
export const MAX_TEMP_BYTES_PER_USER = 1024 * 1024 * 1024;

/** 上传会话 TTL（与临时文件 24h 清理周期一致） */
const CHUNK_UPLOAD_TTL = 24 * 3600 * 1000;

/** 一次上传会话的属主、建立时间与已占用字节数 */
export interface TempUploadEntry {
  userId: number;
  createdAt: number;
  /** 该会话当前占用的字节数（分片追加后由路由更新，供每用户配额统计） */
  bytes: number;
}

/**
 * 上传会话注册表：uploadId → 属主/时间/字节数
 * uploadId 由客户端生成、全局可猜，必须绑定属主，否则任意认证用户
 * 可向他人进行中的上传追加分片（污染视频内容）或无限追加写满磁盘。
 * 回收：POST /video 消费、DELETE /video-temp 放弃时显式删除；
 * 文件已不存在或超过 TTL 的条目在各请求前惰性清理。
 */
const chunkUploadOwners = new Map<string, TempUploadEntry>();

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
export function getChunkOwner(uploadId: string): TempUploadEntry | undefined {
  return chunkUploadOwners.get(uploadId);
}

/** 该用户当前在临时目录占用的字节数（配额统计） */
export function getTempBytesUsed(userId: number): number {
  let total = 0;
  for (const entry of chunkUploadOwners.values()) {
    if (entry.userId === userId) total += entry.bytes;
  }
  return total;
}

/** 该用户临时视频剩余可用字节数（可为 0） */
export function getTempQuotaRemaining(userId: number): number {
  return Math.max(0, MAX_TEMP_BYTES_PER_USER - getTempBytesUsed(userId));
}

/** 该用户是否还有「临时预览上传」并发槽位（POST /video-temp 用） */
export function hasTempUploadSlot(userId: number): boolean {
  let count = 0;
  for (const entry of chunkUploadOwners.values()) {
    if (entry.userId === userId) count++;
  }
  return count < MAX_CONCURRENT_TEMP_UPLOADS;
}

/**
 * 首片（chunkIndex === 0）会话获取：新建或重传
 * - 他人占用中的会话不可抢占：抛 403 '该上传已被其他用户占用'（与原行为一致）
 * - 无属主且该用户并发数已达上限：返回 false（调用方抛 400 '同时进行的上传任务过多，请稍后再试'）
 * - 成功（新建 / 本人重传刷新 TTL）：返回 true
 */
export function acquireChunkUpload(uploadId: string, userId: number, bytes = 0): boolean {
  const owner = chunkUploadOwners.get(uploadId);
  // 首片 = 新建/重传：他人占用中的会话不可抢占
  if (owner && owner.userId !== userId) {
    throw new AppError(403, '该上传已被其他用户占用');
  }
  const userUploads = [...chunkUploadOwners.values()].filter((e) => e.userId === userId).length;
  if (!owner && userUploads >= MAX_CONCURRENT_CHUNK_UPLOADS) {
    return false;
  }
  chunkUploadOwners.set(uploadId, { userId, createdAt: Date.now(), bytes });
  return true;
}

/**
 * 盲登记会话属主（POST /video-temp 发布前预览登记用）
 * 与原行为一致：不做并发/抢占校验，直接覆盖登记
 * （文件名由服务端随机生成，不存在他人占用问题）
 * @param bytes 已落盘字节数，计入该用户的临时目录配额
 */
export function registerChunkUpload(uploadId: string, userId: number, bytes = 0): void {
  chunkUploadOwners.set(uploadId, { userId, createdAt: Date.now(), bytes });
}

/**
 * 更新会话已占用字节数（分片追加成功后由路由以 stat.size 回填）。
 * 条目不存在时静默忽略：属主校验已在前置步骤完成，此处只做记账。
 */
export function setTempUploadBytes(uploadId: string, bytes: number): void {
  const entry = chunkUploadOwners.get(uploadId);
  if (entry) entry.bytes = bytes;
}

/** 释放会话（POST /video 消费、DELETE /video-temp 放弃时调用） */
export function releaseChunkUpload(uploadId: string): void {
  chunkUploadOwners.delete(uploadId);
}
