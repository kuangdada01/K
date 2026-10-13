/**
 * ============================================================
 * media_jobs 终态行收敛 + file_path 索引测试（迁移 036）
 * ============================================================
 * media_jobs 此前只增不减：每次上传各插一行，/video-temp/status 按
 * file_path 的轮询查询随历史累积退化为全表扫描（better-sqlite3 同步执行，
 * 扫表期间事件循环停摆）。修复：
 *  - 迁移 036：idx_media_jobs_file_path 索引；
 *  - pruneFinishedMediaJobs：只删 ready/failed 且超过保留期的行
 *    （queued/running 不动），由巡检定时器周期调用。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { createMemoryDb } from './helpers/memdb';
import { setDbForTests, resetDbForTests, getDb } from '../src/db/connection';
import { latestTranscodeJob, pruneFinishedMediaJobs } from '../src/lib/video/queue';
import { PATHS } from '../src/config';
import path from 'path';

let db: InstanceType<typeof Database>;

const DAY = 24 * 3600 * 1000;

/** 直接插入一行 media_jobs，返回其 file_path */
function insertJob(status: string, updatedAt: number): string {
  const filePath = path.join(PATHS.uploadsTemp, `temp-prune-${Math.random()}.mp4`);
  getDb()
    .prepare(
      `INSERT INTO media_jobs (kind, file_path, display_name, status, attempts, max_attempts, created_at, updated_at)
       VALUES ('transcode', ?, ?, ?, 1, 3, ?, ?)`
    )
    .run(filePath, path.basename(filePath), status, updatedAt, updatedAt);
  return filePath;
}

beforeAll(() => {
  db = createMemoryDb();
  setDbForTests(db);
});

afterAll(() => {
  resetDbForTests();
  db?.close();
});

describe('迁移 036：file_path 索引', () => {
  it('索引存在，status 查询走索引而非全表扫描', () => {
    const idx = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_media_jobs_file_path'")
      .get();
    expect(idx).toBeDefined();

    // latestTranscodeJob 的查询形状：WHERE file_path = ? ORDER BY id DESC LIMIT 1
    const plan = getDb()
      .prepare(
        'EXPLAIN QUERY PLAN SELECT status, last_error FROM media_jobs WHERE file_path = ? ORDER BY id DESC LIMIT 1'
      )
      .all('/x.mp4') as { detail: string }[];
    const detail = plan.map((p) => p.detail).join(' | ');
    expect(detail).toContain('idx_media_jobs_file_path');
  });
});

describe('pruneFinishedMediaJobs：终态行收敛', () => {
  it('只删超过保留期的 ready/failed 行，保留新鲜的与未完成的', () => {
    const now = Date.now();
    const oldReady = insertJob('ready', now - 8 * DAY);
    const oldFailed = insertJob('failed', now - 8 * DAY);
    const freshReady = insertJob('ready', now);
    const oldQueued = insertJob('queued', now - 8 * DAY);
    const oldRunning = insertJob('running', now - 8 * DAY);

    const removed = pruneFinishedMediaJobs(now);
    expect(removed).toBe(2);

    const exists = (fp: string) => getDb().prepare('SELECT 1 FROM media_jobs WHERE file_path = ?').get(fp);
    expect(exists(oldReady)).toBeUndefined();
    expect(exists(oldFailed)).toBeUndefined();
    expect(exists(freshReady)).toBeDefined();
    expect(exists(oldQueued)).toBeDefined();
    expect(exists(oldRunning)).toBeDefined();
  });

  it('清理后 latestTranscodeJob 对已删行返回 undefined（status 端点回落探测）', () => {
    const now = Date.now();
    const fp = insertJob('ready', now - 8 * DAY);
    expect(latestTranscodeJob(fp)).toBeDefined();
    pruneFinishedMediaJobs(now);
    expect(latestTranscodeJob(fp)).toBeUndefined();
  });
});
