/**
 * ============================================================
 * 分片上传会话注册表（lib/chunkUploadRegistry，SQLite 持久化）
 * ============================================================
 * 管理临时视频（分片上传 / 临时上传预览）的属主注册、顺序/幂等状态与 TTL 清理。
 *
 * ## 持久化（P1-3.4）
 * 会话与分片确认原先进内存 Map —— 服务重启即丢：属主无法判定（只能放行删除，
 * 等于任何人可删他人临时文件）、配额统计失真、重放幂等失效。现在全部落
 * `uploads` / `upload_chunks` 表（迁移 032）：
 *  - 属主与进度跨重启保持；配额按未消费会话求和；
 *  - `consumed_at` 标记已被 POST /video 消费的会话（保留行供追溯，不再计入配额）；
 *  - 部署前已存在的临时文件没有属主记录 —— 不凭文件名猜归属，按未知属主
 *    隔离处理（TTL 清理兜底，新请求不得接管）。
 *
 * ## 幂等与顺序（P0-2.3）
 * 会话记录 `totalChunks / nextChunk / receivedBytes` 与每片「长度 + SHA-256」：
 *  - 同片同内容重放 → 命中确认记录，不重复写盘/记账；
 *  - 同片不同内容 / 跳片乱序 → 拒绝并带 expectedChunkIndex 供客户端恢复；
 *  - 追加偏移取会话的 receivedBytes（固定偏移），配合 withChunkWriteLock
 *    的同会话串行写入，并发重试不会写出重复分片。
 * ============================================================
 */

import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { MAX_VIDEO_BYTES, UPLOAD_CHUNK_BYTES } from '@k/shared';
import { PATHS } from '../config';
import { getDb, stmt } from '../db/connection';
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
 * 取 3GB ≈ 3 个 1GB 文件：正常发布流程（选一个视频 → 预览 → 发布）
 * 只用到一个槽位，宽裕；而刷满配额需要至少 4 个未发布的 1GB 草稿。
 * 配额按「未消费会话记账的字节数」计算，不额外扫盘。
 */
export const MAX_TEMP_BYTES_PER_USER = 3 * 1024 * 1024 * 1024;

/** 上传会话 TTL（与临时文件 24h 清理周期一致） */
const CHUNK_UPLOAD_TTL = 24 * 3600 * 1000;

/** 一个已确认分片的长度与内容摘要（重放比对用） */
export interface ChunkAck {
  size: number;
  sha256: string;
}

/**
 * 一次上传会话的属主、建立时间、已占用字节数与分片进度。
 * `totalChunks < 0` 表示非分片会话（POST /video-temp 预览直传登记）。
 */
export interface TempUploadEntry {
  userId: number;
  createdAt: number;
  bytes: number;
  totalChunks: number;
  nextChunk: number;
  receivedBytes: number;
  chunks: Map<number, ChunkAck>;
}

interface UploadRow {
  upload_id: string;
  owner_id: number;
  total_chunks: number;
  next_chunk: number;
  received_bytes: number;
  bytes: number;
  created_at: number;
  consumed_at: number | null;
}

/** 行 → 会话对象（含分片确认表；单会话分片 ≤ 205，随取随载无压力） */
function toEntry(row: UploadRow): TempUploadEntry {
  const chunks = new Map<number, ChunkAck>();
  for (const c of stmt('SELECT chunk_index, size, sha256 FROM upload_chunks WHERE upload_id = ?').all(
    row.upload_id
  ) as { chunk_index: number; size: number; sha256: string }[]) {
    chunks.set(c.chunk_index, { size: c.size, sha256: c.sha256 });
  }
  return {
    userId: row.owner_id,
    createdAt: row.created_at,
    bytes: row.bytes,
    totalChunks: row.total_chunks,
    nextChunk: row.next_chunk,
    receivedBytes: row.received_bytes,
    chunks,
  };
}

/**
 * 惰性清理（各请求前调用）：
 *  - 超过 TTL 的会话（含已消费的追溯行）；
 *  - 对应临时文件已不存在的会话（文件被 TTL 清理先行删掉时，登记同步回收）。
 * 会话删除时分片确认记录一并删除。
 */
export function pruneChunkUploads(): void {
  const cutoff = Date.now() - CHUNK_UPLOAD_TTL;
  const expired = stmt(
    'SELECT upload_id FROM uploads WHERE (consumed_at IS NOT NULL AND consumed_at < ?) OR created_at < ?'
  ).all(cutoff, cutoff) as { upload_id: string }[];
  for (const row of expired) staleDelete(row.upload_id);

  for (const row of stmt('SELECT upload_id FROM uploads WHERE consumed_at IS NULL').all() as {
    upload_id: string;
  }[]) {
    if (!fs.existsSync(path.join(PATHS.uploadsTemp, row.upload_id))) staleDelete(row.upload_id);
  }
}

function staleDelete(uploadId: string): void {
  getDb().transaction(() => {
    stmt('DELETE FROM upload_chunks WHERE upload_id = ?').run(uploadId);
    stmt('DELETE FROM uploads WHERE upload_id = ?').run(uploadId);
  })();
}

/** 查询会话属主与进度（已消费/不存在 → undefined） */
export function getChunkOwner(uploadId: string): TempUploadEntry | undefined {
  const row = stmt('SELECT * FROM uploads WHERE upload_id = ? AND consumed_at IS NULL').get(uploadId) as
    UploadRow | undefined;
  return row ? toEntry(row) : undefined;
}

/** 该用户当前在临时目录占用的字节数（配额统计：未消费会话求和） */
export function getTempBytesUsed(userId: number): number {
  const r = stmt(
    'SELECT COALESCE(SUM(bytes), 0) AS used FROM uploads WHERE owner_id = ? AND consumed_at IS NULL'
  ).get(userId) as { used: number };
  return r.used;
}

/** 该用户临时视频剩余可用字节数（可为 0） */
export function getTempQuotaRemaining(userId: number): number {
  return Math.max(0, MAX_TEMP_BYTES_PER_USER - getTempBytesUsed(userId));
}

/** 该用户是否还有「临时预览上传」并发槽位（POST /video-temp 用） */
export function hasTempUploadSlot(userId: number): boolean {
  const r = stmt('SELECT COUNT(*) AS n FROM uploads WHERE owner_id = ? AND consumed_at IS NULL').get(
    userId
  ) as { n: number };
  return r.n < MAX_CONCURRENT_TEMP_UPLOADS;
}

/**
 * 首片无会话时的会话获取（新建）
 * - 他人占用中的会话不可抢占：抛 403 '该上传已被其他用户占用'
 * - 无属主且该用户并发数已达上限：返回 false（调用方抛 400 '同时进行的上传任务过多，请稍后再试'）
 * 仅在「该 uploadId 尚无会话」时调用；已有本人会话的首片重放不走这里
 * （进度重置会破坏幂等，见 media.ts 路由内的说明）。
 */
export function acquireChunkUpload(uploadId: string, userId: number, totalChunks: number): boolean {
  const db = getDb();
  const existing = stmt('SELECT owner_id FROM uploads WHERE upload_id = ?').get(uploadId) as
    { owner_id: number } | undefined;
  if (existing && existing.owner_id !== userId) {
    throw new AppError(403, '该上传已被其他用户占用');
  }
  const userUploads = (
    stmt('SELECT COUNT(*) AS n FROM uploads WHERE owner_id = ? AND consumed_at IS NULL').get(userId) as {
      n: number;
    }
  ).n;
  if (!existing && userUploads >= MAX_CONCURRENT_CHUNK_UPLOADS) {
    return false;
  }
  const now = Date.now();
  db.transaction(() => {
    stmt('DELETE FROM upload_chunks WHERE upload_id = ?').run(uploadId);
    stmt(
      `INSERT INTO uploads (upload_id, owner_id, total_chunks, next_chunk, received_bytes, bytes, created_at, updated_at, consumed_at)
       VALUES (?, ?, ?, 0, 0, 0, ?, ?, NULL)
       ON CONFLICT(upload_id) DO UPDATE SET
         owner_id = excluded.owner_id,
         total_chunks = excluded.total_chunks,
         next_chunk = 0, received_bytes = 0, bytes = 0,
         created_at = excluded.created_at, updated_at = excluded.updated_at, consumed_at = NULL`
    ).run(uploadId, userId, totalChunks, now, now);
  })();
  return true;
}

/**
 * 盲登记会话属主（POST /video-temp 发布前预览登记用）
 * 不做并发/抢占校验，直接覆盖登记（文件名由服务端随机生成，不存在他人占用问题）
 * @param bytes 已落盘字节数，计入该用户的临时目录配额
 */
export function registerChunkUpload(uploadId: string, userId: number, bytes = 0): void {
  const now = Date.now();
  getDb().transaction(() => {
    stmt('DELETE FROM upload_chunks WHERE upload_id = ?').run(uploadId);
    stmt(
      `INSERT INTO uploads (upload_id, owner_id, total_chunks, next_chunk, received_bytes, bytes, created_at, updated_at, consumed_at)
         VALUES (?, ?, -1, 0, 0, ?, ?, ?, NULL)
         ON CONFLICT(upload_id) DO UPDATE SET
           owner_id = excluded.owner_id, total_chunks = -1,
           next_chunk = 0, received_bytes = 0, bytes = excluded.bytes,
           created_at = excluded.created_at, updated_at = excluded.updated_at, consumed_at = NULL`
    ).run(uploadId, userId, bytes, now, now);
  })();
}

/**
 * 记录一个分片的确认结果（必须在文件写入成功后调用）：
 * 保存长度与摘要、推进 nextChunk/receivedBytes，并同步配额记账。
 * 进度推进按「next_chunk = chunk_index + 1」写死 —— 只有顺序写入才会走到这里
 * （乱序在路由层已被 409 拒绝），配合写锁天然防倒退。
 */
export function recordChunkAck(uploadId: string, chunkIndex: number, ack: ChunkAck): void {
  const entry = getChunkOwner(uploadId);
  if (!entry) return;
  const nextChunk = chunkIndex + 1;
  const receivedBytes = entry.receivedBytes + ack.size;
  getDb().transaction(() => {
    stmt(
      `INSERT INTO upload_chunks (upload_id, chunk_index, size, sha256) VALUES (?, ?, ?, ?)
         ON CONFLICT(upload_id, chunk_index) DO UPDATE SET size = excluded.size, sha256 = excluded.sha256`
    ).run(uploadId, chunkIndex, ack.size, ack.sha256);
    stmt(
      'UPDATE uploads SET next_chunk = ?, received_bytes = ?, bytes = ?, updated_at = ? WHERE upload_id = ?'
    ).run(nextChunk, receivedBytes, receivedBytes, Date.now(), uploadId);
  })();
}

/**
 * 更新会话已占用字节数（非分片路径的兼容入口；分片路径由 recordChunkAck 一并维护）。
 * 条目不存在时静默忽略：属主校验已在前置步骤完成，此处只做记账。
 */
export function setTempUploadBytes(uploadId: string, bytes: number): void {
  stmt('UPDATE uploads SET bytes = ?, updated_at = ? WHERE upload_id = ?').run(bytes, Date.now(), uploadId);
}

/** 标记会话已被 POST /video 消费（文件移入正式目录）：保留行供追溯，退出配额与活跃判定 */
export function markChunkUploadConsumed(uploadId: string): void {
  stmt('UPDATE uploads SET consumed_at = ?, updated_at = ? WHERE upload_id = ?').run(
    Date.now(),
    Date.now(),
    uploadId
  );
}

/** 释放会话（DELETE /video-temp 放弃、超限作废时调用）：行与分片确认一并删除 */
export function releaseChunkUpload(uploadId: string): void {
  staleDelete(uploadId);
  chunkWriteLocks.delete(uploadId);
}

// -------------------------------------------------------------------
// 同会话串行写入：同一 uploadId 的分片写入必须串行，
// 否则并发重试的两次「读偏移 → 定位写」会交错，文件内容损坏。
// （写锁仍在内存：它只保护单进程内的文件写入顺序；重启后进程内
//   本就不存在并发旧请求，无需跨进程锁。）
// -------------------------------------------------------------------

const chunkWriteLocks = new Map<string, Promise<void>>();

/**
 * 串行执行 fn：同一 uploadId 的操作按提交顺序逐个运行；前序失败不阻断后续。
 * 返回 fn 本身的结果（错误原样抛给调用方）；链尾自清理，Map 不随会话数泄漏。
 */
export function withChunkWriteLock<T>(uploadId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chunkWriteLocks.get(uploadId) ?? Promise.resolve();
  const op = prev.then(fn);
  const tail = op.then(
    () => {},
    () => {}
  );
  chunkWriteLocks.set(uploadId, tail);
  void tail.then(() => {
    if (chunkWriteLocks.get(uploadId) === tail) chunkWriteLocks.delete(uploadId);
  });
  return op;
}

// -------------------------------------------------------------------
// 摘要工具：分片幂等比对（内存 buffer）和发布前完整性校验（流式读文件）
// -------------------------------------------------------------------

/** 计算内存分片内容的 SHA-256（hex 小写）。服务端总是自行计算，客户端字段仅作交叉校验。 */
export function sha256Buffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 流式计算文件 SHA-256（hex 小写）。1GB 文件也不整体进内存。 */
export async function sha256File(p: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(p, { highWaterMark: 1024 * 1024 });
  for await (const piece of stream) hash.update(piece as Buffer);
  return hash.digest('hex');
}
