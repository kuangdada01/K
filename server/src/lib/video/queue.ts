/**
 * ============================================================
 * 后台媒体任务队列（lib/video/queue，SQLite 持久化）
 * ============================================================
 * 串行执行——同一时间只跑一个任务（内存/CPU 占用有界），发布请求立即返回不阻塞。
 * 任务的 kind 决定执行体：
 *  - `transcode`：视频转码，完成后同 URL 原地替换内容
 *    （transcode.ts ensurePlayableVideo，对已可播文件是 no-op，可重复执行）；
 *  - `cleanup`：删除一个已无 DB 引用的媒体文件（**补偿路径**，P1-3.5）——
 *    DB 已提交、但磁盘删除失败时入队重试，避免孤儿文件只能靠人工清理。
 *
 * ## 持久化与租约（P1-3.4）
 * 任务落 `media_jobs` 表（迁移 032），状态机 queued → running → ready/failed：
 *  - **认领即事务**：`UPDATE ... WHERE id = (SELECT ... WHERE status='queued') RETURNING`
 *    原子取出下一个任务并置 running + 租约；
 *  - **重启恢复**：`initMediaJobRecovery()` 把租约过期的 running 任务重新排队
 *    （两类任务都可重复执行，不丢任务）；
 *  - **失败可见**：attempts 达到 max_attempts 落 failed 并保留 last_error，
 *    查询接口（/video-temp/status）据此返回明确的 failed，而不是无限 encoding。
 *  - 队列上限仍按内存计数（防刷），持久化行由完成/失败自然收敛。
 * ============================================================
 */

import fs from 'fs';
import path from 'path';
import { AppError } from '../../middleware/error';
import { logger } from '../logger';
import { getDb, stmt } from '../../db/connection';
import { ensurePlayableVideo } from './transcode';

/** 串行队列链：同一时间只执行一个转码任务 */
let transcodeQueue: Promise<unknown> = Promise.resolve();

/** 队列上限（含正在执行的一个）：防止无限刷入任务长期占用 ffmpeg */
const MAX_PENDING_TRANSCODES = 20;
let pendingTranscodes = 0;

/** 运行租约时长：覆盖单个大文件转码的最坏时长，超时视为持有者已死 */
const LEASE_MS = 30 * 60 * 1000;

interface JobRow {
  id: number;
  kind: 'transcode' | 'cleanup';
  file_path: string;
  display_name: string;
  attempts: number;
  max_attempts: number;
}

/** 事务认领下一个排队任务（没有则返回 null） */
function claimNextJob(): JobRow | null {
  const now = Date.now();
  const db = getDb();
  const claim = db.transaction(() => {
    const rows = stmt(
      `UPDATE media_jobs
         SET status = 'running', attempts = attempts + 1, lease_expires_at = ?, updated_at = ?
       WHERE id = (SELECT id FROM media_jobs WHERE status = 'queued' ORDER BY id LIMIT 1)
       RETURNING id, kind, file_path, display_name, attempts, max_attempts`
    ).get(now + LEASE_MS, now) as JobRow | undefined;
    return rows ?? null;
  });
  return claim();
}

/** 单个任务的执行：成功 → ready；失败 → 未达上限重排、达上限落 failed（保留原因） */
function runJob(job: JobRow): Promise<void> {
  const body =
    job.kind === 'cleanup'
      ? // 清理：文件已无 DB 引用，删除即可；不存在视为成功（幂等）
        fs.promises.unlink(job.file_path).catch((err) => {
          if ((err as { code?: string }).code !== 'ENOENT') throw err;
        })
      : ensurePlayableVideo(job.file_path, job.display_name);
  logger.info(`媒体任务开始(${job.kind}, 第 ${job.attempts} 次): ${job.display_name}`);
  return Promise.resolve(body)
    .then(() => {
      stmt(
        `UPDATE media_jobs SET status = 'ready', lease_expires_at = NULL, last_error = NULL, updated_at = ? WHERE id = ?`
      ).run(Date.now(), job.id);
      logger.info(`媒体任务结束(${job.kind}): ${job.display_name}`);
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (job.attempts < job.max_attempts) {
        stmt(
          `UPDATE media_jobs SET status = 'queued', lease_expires_at = NULL, last_error = ?, updated_at = ? WHERE id = ?`
        ).run(message, Date.now(), job.id);
        logger.warn({ err }, `媒体任务失败(将重试 ${job.attempts}/${job.max_attempts}): ${job.display_name}`);
      } else {
        stmt(
          `UPDATE media_jobs SET status = 'failed', lease_expires_at = NULL, last_error = ?, updated_at = ? WHERE id = ?`
        ).run(message, Date.now(), job.id);
        logger.error({ err }, `媒体任务最终失败(跳过): ${job.display_name}`);
      }
    });
}

/** 泵：只要队列计数未满且还有排队任务就继续取（串行） */
function pump(): void {
  while (pendingTranscodes < MAX_PENDING_TRANSCODES) {
    const job = claimNextJob();
    if (!job) return;
    pendingTranscodes++;
    transcodeQueue = transcodeQueue
      .then(() => runJob(job))
      .finally(() => {
        pendingTranscodes--;
        // 当前任务收敛后继续泵（可能有重排的任务或新入队的）
        pump();
      });
  }
}

/**
 * 入队一个视频转码任务（不阻塞调用方）。
 * 队列已满（pendingTranscodes >= MAX_PENDING_TRANSCODES）时抛 429，
 * 由调用方（routes/posts/media.ts）按业务错误响应。
 */
export function enqueueVideoTranscode(filePath: string, originalName: string): void {
  enqueueMediaJob('transcode', filePath, originalName);
}

/**
 * 入队一个文件清理补偿任务（P1-3.5）：DB 已提交、但磁盘删除失败时调用。
 * 任务幂等（文件不存在视为成功），失败自动重试，重试耗尽落 failed 保留原因。
 */
export function enqueueFileCleanup(filePath: string): void {
  enqueueMediaJob('cleanup', filePath, path.basename(filePath));
}

function enqueueMediaJob(kind: 'transcode' | 'cleanup', filePath: string, displayName: string): void {
  if (pendingTranscodes >= MAX_PENDING_TRANSCODES) {
    throw new AppError(429, '视频处理任务繁忙，请稍后再试');
  }
  const now = Date.now();
  stmt(
    `INSERT INTO media_jobs (kind, file_path, display_name, status, attempts, max_attempts, created_at, updated_at)
     VALUES (?, ?, ?, 'queued', 0, 3, ?, ?)`
  ).run(kind, filePath, displayName, now, now);
  pump();
}

/** 查询某文件最近一次转码任务的状态（查询接口用来把 failed 如实暴露） */
export function latestTranscodeJob(
  filePath: string
): { status: 'queued' | 'running' | 'ready' | 'failed'; lastError: string | null } | undefined {
  const row = stmt(
    'SELECT status, last_error AS lastError FROM media_jobs WHERE file_path = ? ORDER BY id DESC LIMIT 1'
  ).get(filePath) as
    { status: 'queued' | 'running' | 'ready' | 'failed'; lastError: string | null } | undefined;
  return row ?? undefined;
}

/**
 * 启动恢复：租约过期的 running 任务重新排队（进程重启 / 上一个持有者已死），
 * 然后立刻泵一次。**必须由装配层显式调用**（app.ts → initMediaJobRecovery()），
 * 不能在模块加载时执行 —— 测试在 setDbForTests 之前就会 import 本模块，
 * 模块级副作用会打到真实数据库。此后每 5 分钟巡检一次（定时器 unref）。
 */
export function recoverStuckMediaJobs(): number {
  const now = Date.now();
  const info = stmt(
    `UPDATE media_jobs SET status = 'queued', lease_expires_at = NULL, updated_at = ?
     WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < ?)`
  ).run(now, now);
  pump();
  return Number(info.changes);
}

let recoveryTimer: NodeJS.Timeout | null = null;

/** 装配期初始化（幂等）：恢复中断任务 + 启动周期巡检 */
export function initMediaJobRecovery(): void {
  const recovered = recoverStuckMediaJobs();
  if (recovered > 0) logger.info(`[media_jobs] 启动恢复：${recovered} 个中断的转码任务已重新排队`);
  if (recoveryTimer == null) {
    recoveryTimer = setInterval(
      () => {
        const n = recoverStuckMediaJobs();
        if (n > 0) logger.info(`[media_jobs] 巡检恢复：${n} 个租约过期的任务已重新排队`);
      },
      5 * 60 * 1000
    );
    recoveryTimer.unref();
  }
}
