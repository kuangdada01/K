/**
 * ============================================================
 * 分片上传幂等与顺序校验测试（POST /api/posts/video-chunk + POST /video 完成校验）
 * ============================================================
 * 对应维护方案 P0-2.3。覆盖：
 * - 幂等重放：已确认分片同内容重发 → 原样确认，文件与配额字节数不增长
 * - 冲突拒绝：同片不同内容 409、乱序/跳片 409 且带 expectedChunkIndex
 * - 首片重放（已有进度时）不截断已写内容
 * - 并发重复提交同一分片 → 串行化，文件不损坏（长度 = 单片）
 * - 发布校验：片数未收齐 400（带 expectedChunkIndex）、
 *   实际大小与会话记账不符 400 且清理临时文件与会话、
 *   整文件摘要不符 400
 * - 会话丢失（模拟重启）后同 uploadId 重传：首片 'w' 截断重写，最终内容正确
 * ============================================================
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { createMemoryDb } from './helpers/memdb';
import { setDbForTests, resetDbForTests } from '../src/db/connection';
import { createApp } from '../src/app';
import { generateToken } from '../src/middleware/auth';
import { releaseChunkUpload, sha256Buffer } from '../src/lib/chunkUploadRegistry';
import { PATHS } from '../src/config';

let db: InstanceType<typeof Database>;
let server: http.Server;
let base = '';
let aliceToken = '';

const run = Date.now();
const id = (n: number) => `temp-${run}-${n}.mp4`;
const CHUNK_LEN = 1024;
/** 每片内容不同（fill = 片号），摘要才可区分 */
const chunkOf = (i: number) => Buffer.alloc(CHUNK_LEN, i + 1);
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

beforeAll(async () => {
  fs.mkdirSync(PATHS.uploadsTemp, { recursive: true });
  db = createMemoryDb();
  setDbForTests(db);
  const insertUser = db.prepare(
    "INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, 'x', 'user')"
  );
  const aliceId = Number(insertUser.run('alice', 'alice@test.com').lastInsertRowid);
  aliceToken = generateToken({ id: aliceId, username: 'alice' });

  const app = createApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  resetDbForTests();
  for (const p of fs.readdirSync(PATHS.uploadsTemp)) {
    if (p.startsWith(`temp-${run}-`)) fs.unlinkSync(path.join(PATHS.uploadsTemp, p));
  }
});

interface ChunkResponse {
  status: number;
  data: {
    ok?: boolean;
    received?: number;
    size?: number;
    replay?: boolean;
    error?: string;
    expectedChunkIndex?: number;
  } | null;
}

async function sendChunk(
  uploadId: string,
  chunkIndex: number,
  totalChunks: number,
  content: Buffer,
  opts?: { sha256?: string | null }
): Promise<ChunkResponse> {
  const form = new FormData();
  form.set('uploadId', uploadId);
  form.set('chunkIndex', String(chunkIndex));
  form.set('totalChunks', String(totalChunks));
  if (opts?.sha256 !== null) {
    form.set('sha256', opts?.sha256 ?? sha256Buffer(content));
  }
  form.set('chunk', new Blob([new Uint8Array(content)]), 'chunk.bin');
  const res = await fetch(`${base}/api/posts/video-chunk`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${aliceToken}` },
    body: form,
  });
  return { status: res.status, data: (await res.json().catch(() => null)) as ChunkResponse['data'] };
}

async function publish(
  uploadId: string,
  opts?: { videoBytes?: string | null; videoSha256?: string | null }
): Promise<{ status: number; data: { error?: string; expectedChunkIndex?: number } | null }> {
  const form = new FormData();
  form.set('video_url', `/uploads/temp/${uploadId}`);
  if (opts?.videoBytes != null) form.set('video_bytes', opts.videoBytes);
  if (opts?.videoSha256 != null) form.set('video_sha256', opts.videoSha256);
  const res = await fetch(`${base}/api/posts/video`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${aliceToken}` },
    body: form,
  });
  return {
    status: res.status,
    data: (await res.json().catch(() => null)) as { error?: string; expectedChunkIndex?: number } | null,
  };
}

function tempFile(uploadId: string) {
  return path.join(PATHS.uploadsTemp, uploadId);
}

function fileBytes(uploadId: string): Buffer {
  return fs.readFileSync(tempFile(uploadId));
}

describe('分片上传幂等与顺序', () => {
  it('同片同内容重放返回原确认，文件与记账字节数不增长（丢响应重试场景）', async () => {
    const up = id(1);
    try {
      const first = await sendChunk(up, 0, 3, chunkOf(0));
      expect(first.status).toBe(200);
      expect(first.data?.size).toBe(CHUNK_LEN);
      const replay = await sendChunk(up, 0, 3, chunkOf(0));
      expect(replay.status).toBe(200);
      expect(replay.data?.replay).toBe(true);
      expect(replay.data?.received).toBe(1);
      expect(replay.data?.size).toBe(CHUNK_LEN);
      expect(fileBytes(up).length).toBe(CHUNK_LEN);
    } finally {
      releaseChunkUpload(up);
      fs.rmSync(tempFile(up), { force: true });
    }
  });

  it('同片不同内容返回 409 并带期望片号', async () => {
    const up = id(2);
    try {
      await sendChunk(up, 0, 3, chunkOf(0));
      const conflict = await sendChunk(up, 0, 3, chunkOf(9));
      expect(conflict.status).toBe(409);
      expect(conflict.data?.expectedChunkIndex).toBe(1);
      expect(fileBytes(up).length).toBe(CHUNK_LEN);
    } finally {
      releaseChunkUpload(up);
      fs.rmSync(tempFile(up), { force: true });
    }
  });

  it('乱序/跳片返回 409 并带期望片号供恢复', async () => {
    const up = id(3);
    try {
      await sendChunk(up, 0, 3, chunkOf(0));
      const bad = await sendChunk(up, 2, 3, chunkOf(2));
      expect(bad.status).toBe(409);
      expect(bad.data?.expectedChunkIndex).toBe(1);
      // 按期望片号恢复后正常推进
      const ok = await sendChunk(up, 1, 3, chunkOf(1));
      expect(ok.status).toBe(200);
      expect(ok.data?.received).toBe(2);
    } finally {
      releaseChunkUpload(up);
      fs.rmSync(tempFile(up), { force: true });
    }
  });

  it('首片重放不截断已写内容（received 进度保留）', async () => {
    const up = id(4);
    try {
      await sendChunk(up, 0, 3, chunkOf(0));
      await sendChunk(up, 1, 3, chunkOf(1));
      const replay0 = await sendChunk(up, 0, 3, chunkOf(0));
      expect(replay0.status).toBe(200);
      expect(replay0.data?.received).toBe(2);
      expect(fileBytes(up).length).toBe(CHUNK_LEN * 2);
    } finally {
      releaseChunkUpload(up);
      fs.rmSync(tempFile(up), { force: true });
    }
  });

  it('并发重复提交同一分片：串行化后文件长度仍为单片', async () => {
    const up = id(5);
    try {
      await sendChunk(up, 0, 3, chunkOf(0));
      // 双发第 1 片（模拟响应丢失后的重试与原请求同时在途）
      const [a, b] = await Promise.all([sendChunk(up, 1, 3, chunkOf(1)), sendChunk(up, 1, 3, chunkOf(1))]);
      expect([a.status, b.status].sort()).toEqual([200, 200]);
      expect(fileBytes(up).length).toBe(CHUNK_LEN * 2);
      expect(sha(fileBytes(up))).toBe(sha(Buffer.concat([chunkOf(0), chunkOf(1)])));
    } finally {
      releaseChunkUpload(up);
      fs.rmSync(tempFile(up), { force: true });
    }
  });

  it('客户端分片摘要不匹配返回 400（传输截断按损坏拒绝）', async () => {
    const up = id(6);
    try {
      const r = await sendChunk(up, 0, 3, chunkOf(0), { sha256: sha(chunkOf(7)) });
      expect(r.status).toBe(400);
    } finally {
      releaseChunkUpload(up);
      fs.rmSync(tempFile(up), { force: true });
    }
  });

  it('会话丢失（模拟重启）后同 uploadId 从首片重传：截断重写，最终摘要正确', async () => {
    const up = id(7);
    try {
      await sendChunk(up, 0, 3, chunkOf(0));
      await sendChunk(up, 1, 3, chunkOf(1));
      // 模拟服务重启：会话登记丢失（文件残留）
      releaseChunkUpload(up);
      for (let i = 0; i < 3; i++) {
        const r = await sendChunk(up, i, 3, chunkOf(i));
        expect(r.status).toBe(200);
      }
      expect(sha(fileBytes(up))).toBe(sha(Buffer.concat([chunkOf(0), chunkOf(1), chunkOf(2)])));
    } finally {
      releaseChunkUpload(up);
      fs.rmSync(tempFile(up), { force: true });
    }
  });
});

describe('发布前完整性校验（POST /video video_url 分支）', () => {
  it('片数未收齐返回 400 并带 expectedChunkIndex', async () => {
    const up = id(8);
    try {
      await sendChunk(up, 0, 3, chunkOf(0));
      const r = await publish(up);
      expect(r.status).toBe(400);
      expect(r.data?.expectedChunkIndex).toBe(1);
    } finally {
      releaseChunkUpload(up);
      fs.rmSync(tempFile(up), { force: true });
    }
  });

  it('实际大小与会话记账不符：400、临时文件与会话一并清理', async () => {
    const up = id(9);
    try {
      for (let i = 0; i < 3; i++) await sendChunk(up, i, 3, chunkOf(i));
      // 直接向临时文件尾追加重复字节（模拟“已写、未确认”窗口落盘的脏数据）
      fs.appendFileSync(tempFile(up), chunkOf(0));
      const r = await publish(up);
      expect(r.status).toBe(400);
      expect(fs.existsSync(tempFile(up))).toBe(false);
    } finally {
      releaseChunkUpload(up);
      fs.rmSync(tempFile(up), { force: true });
    }
  });

  it('整文件摘要不符：400、临时文件与会话一并清理', async () => {
    const up = id(10);
    try {
      for (let i = 0; i < 3; i++) await sendChunk(up, i, 3, chunkOf(i));
      const r = await publish(up, { videoSha256: sha(chunkOf(0)) });
      expect(r.status).toBe(400);
      expect(fs.existsSync(tempFile(up))).toBe(false);
    } finally {
      releaseChunkUpload(up);
      fs.rmSync(tempFile(up), { force: true });
    }
  });
});
