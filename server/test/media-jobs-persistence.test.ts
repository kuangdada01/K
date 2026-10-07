/**
 * ============================================================
 * 上传会话与转码任务持久化测试（P1-3.4）
 * ============================================================
 * 会话/任务全部落 SQLite（迁移 032）——重启后属主、配额、任务状态保持：
 * - 消费后的会话退出配额与活跃判定，行保留（追溯）
 * - 转码任务：成功 → ready；连续失败至重试上限 → failed（保留原因）；
 *   查询接口对 failed 返回明确的 failed，不再无限 encoding
 * - 租约恢复：running 且租约过期 → recoverStuckMediaJobs 重排并执行
 * - 未知属主隔离：无登记的临时文件不能被 DELETE /video-temp 或 POST /video 接管
 *
 * 转码实现（ffmpeg）用 vi.mock 替身：真实转码属环境行为。
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { createMemoryDb } from './helpers/memdb';
import { setDbForTests, resetDbForTests, getDb } from '../src/db/connection';
import { createApp } from '../src/app';
import { generateToken } from '../src/middleware/auth';
import { PATHS } from '../src/config';
import {
  getChunkOwner,
  getTempBytesUsed,
  registerChunkUpload,
  releaseChunkUpload,
} from '../src/lib/chunkUploadRegistry';
import { initMediaJobRecovery, latestTranscodeJob, recoverStuckMediaJobs } from '../src/lib/video/queue';

const { transcodeCalls, transcodeBehavior } = vi.hoisted(() => ({
  transcodeCalls: [] as string[],
  transcodeBehavior: { fail: false },
}));

vi.mock('../src/lib/video/transcode', () => ({
  ensurePlayableVideo: async (filePath: string, name: string) => {
    transcodeCalls.push(name);
    if (transcodeBehavior.fail) throw new Error('模拟 ffmpeg 失败');
    return name;
  },
  // media.ts 也从该模块导入；本文件不消费封面/探测分支，给最小可用替身
  generateVideoCover: async () => null,
  isPlayableVideoStream: () => false,
}));

let db: InstanceType<typeof Database>;
let server: http.Server;
let base = '';
let aliceToken = '';
let aliceId = 0;

const run = Date.now();
const created: string[] = [];

beforeAll(async () => {
  db = createMemoryDb();
  setDbForTests(db);
  const insertUser = db.prepare(
    "INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, 'x', 'user')"
  );
  aliceId = Number(insertUser.run('alice', 'alice@test.com').lastInsertRowid);
  aliceToken = generateToken({ id: aliceId, username: 'alice' });

  const app = createApp(); // 内部会 initMediaJobRecovery（真实队列 + 替身转码）
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  resetDbForTests();
  db?.close();
  for (const p of created) if (fs.existsSync(p)) fs.unlinkSync(p);
});

beforeEach(() => {
  transcodeCalls.length = 0;
  transcodeBehavior.fail = false;
});

/** 直接向 media_jobs 插一行（构造租约场景用） */
function insertJob(status: string, leaseExpiresAt: number | null, attempts = 1) {
  const name = `temp-${run}-${Math.floor(Math.random() * 1_000_000)}.mp4`;
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO media_jobs (kind, file_path, display_name, status, attempts, max_attempts, lease_expires_at, created_at, updated_at)
       VALUES ('transcode', ?, ?, ?, ?, 3, ?, ?, ?)`
    )
    .run(path.join(PATHS.uploadsTemp, name), name, status, attempts, leaseExpiresAt, now, now);
  return name;
}

describe('上传会话持久化（uploads 表）', () => {
  it('消费后的会话退出活跃判定与配额，行保留供追溯', async () => {
    const id = `temp-${run}-c1.mp4`;
    const abs = path.join(PATHS.uploadsTemp, id);
    fs.writeFileSync(abs, Buffer.alloc(1024, 1));
    created.push(abs);
    registerChunkUpload(id, aliceId, 1024);

    const before = getTempBytesUsed(aliceId);
    expect(getChunkOwner(id)?.userId).toBe(aliceId);

    // 模拟 POST /video 消费路径的关键一步（路由内是 markChunkUploadConsumed）
    const { markChunkUploadConsumed } = await import('../src/lib/chunkUploadRegistry');
    markChunkUploadConsumed(id);

    expect(getChunkOwner(id)).toBeUndefined(); // 活跃判定退出
    expect(getTempBytesUsed(aliceId)).toBe(before - 1024); // 配额不再计
    const row = getDb().prepare('SELECT consumed_at FROM uploads WHERE upload_id = ?').get(id) as {
      consumed_at: number | null;
    };
    expect(row.consumed_at).not.toBeNull(); // 行保留（追溯）
    releaseChunkUpload(id);
  });

  it('会话登记落在数据库里（重启模拟：不经任何内存缓存直接读表）', () => {
    const id = `temp-${run}-c2.mp4`;
    const abs = path.join(PATHS.uploadsTemp, id);
    fs.writeFileSync(abs, 'x');
    created.push(abs);
    registerChunkUpload(id, aliceId, 5);

    const row = getDb().prepare('SELECT owner_id, bytes FROM uploads WHERE upload_id = ?').get(id) as {
      owner_id: number;
      bytes: number;
    };
    expect(row.owner_id).toBe(aliceId);
    expect(row.bytes).toBe(5);
    releaseChunkUpload(id);
  });
});

describe('转码任务持久化（media_jobs 表）', () => {
  it('任务成功 → ready', async () => {
    const name = insertJob('queued', null, 0);
    recoverStuckMediaJobs(); // 泵一次（queued 任务被认领执行）
    await vi.waitFor(() => {
      expect(latestTranscodeJob(path.join(PATHS.uploadsTemp, name))?.status).toBe('ready');
    });
    expect(transcodeCalls).toContain(name);
  });

  it('连续失败至重试上限 → failed，保留原因（查询接口不再无限 encoding）', async () => {
    transcodeBehavior.fail = true;
    const name = insertJob('queued', null, 0);
    recoverStuckMediaJobs();
    await vi.waitFor(() => {
      expect(latestTranscodeJob(path.join(PATHS.uploadsTemp, name))?.status).toBe('failed');
    });
    const job = latestTranscodeJob(path.join(PATHS.uploadsTemp, name));
    expect(job?.lastError).toContain('模拟 ffmpeg 失败');
    // attempts = 3（1 次初始认领 + 2 次重排重试），之后不再重试
    const attempts = (
      getDb().prepare('SELECT attempts FROM media_jobs WHERE display_name = ?').get(name) as {
        attempts: number;
      }
    ).attempts;
    expect(attempts).toBe(3);
    expect(transcodeCalls.filter((c) => c === name).length).toBe(3);
  });

  it('租约过期的 running 任务被恢复重排并执行（重启场景）', async () => {
    const name = insertJob('running', Date.now() - 1000, 1);
    const recovered = recoverStuckMediaJobs();
    expect(recovered).toBeGreaterThanOrEqual(1);
    await vi.waitFor(() => {
      expect(latestTranscodeJob(path.join(PATHS.uploadsTemp, name))?.status).toBe('ready');
    });
  });

  it('租约未过期的 running 任务本轮不动（视为持有者仍在）', () => {
    const name = insertJob('running', Date.now() + 10 * 60 * 1000, 1);
    const recovered = recoverStuckMediaJobs();
    expect(recovered).toBe(0);
    expect(latestTranscodeJob(path.join(PATHS.uploadsTemp, name))?.status).toBe('running');
    // 清理：直接置 failed 结束这行，避免影响后续用例的泵
    getDb().prepare('UPDATE media_jobs SET status = ? WHERE display_name = ?').run('failed', name);
  });

  it('initMediaJobRecovery 幂等（重复调用不产生多余副作用）', () => {
    initMediaJobRecovery();
    initMediaJobRecovery();
  });
});

describe('未知属主隔离（无登记的临时文件不能被接管）', () => {
  it('DELETE /video-temp：无登记 → 403，文件隔离等待 TTL', async () => {
    const id = `temp-${run}-801.mp4`;
    const abs = path.join(PATHS.uploadsTemp, id);
    fs.writeFileSync(abs, 'orphan');
    created.push(abs);

    const res = await fetch(`${base}/api/posts/video-temp`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `/uploads/temp/${id}` }),
    });
    expect(res.status).toBe(403);
    expect(fs.existsSync(abs)).toBe(true); // 隔离而非删除
  });

  it('POST /video：无登记 → 拒绝使用（403）', async () => {
    const id = `temp-${run}-802.mp4`;
    const abs = path.join(PATHS.uploadsTemp, id);
    fs.writeFileSync(abs, Buffer.alloc(2048, 2));
    created.push(abs);

    const form = new FormData();
    form.set('video_url', `/uploads/temp/${id}`);
    form.set('description', '未知属主');
    const res = await fetch(`${base}/api/posts/video`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${aliceToken}` },
      body: form,
    });
    expect(res.status).toBe(403);
    expect(fs.existsSync(abs)).toBe(true);
  });
});
