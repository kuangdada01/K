/**
 * ============================================================
 * 分片上传加固测试（POST /api/posts/video-chunk）
 * ============================================================
 * 覆盖（修复：原实现无总量上限、uploadId 不绑定用户）:
 * - 参数校验: 无效 uploadId、totalChunks 超上限（50 片 = 300MB）返回 400
 * - 会话归属: 无会话续片 400、他人抢占首片 403、他人续片 403
 * - 并发上限: 同一用户最多 3 个进行中的分片上传
 * - 会话回收: DELETE /video-temp 放弃后文件与会话同步释放，他人可复用 uploadId
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { createSchema } from '../src/db/schema';
import { setDbForTests, resetDbForTests } from '../src/db/connection';
import { createApp } from '../src/app';
import { generateToken } from '../src/middleware/auth';
import { PATHS } from '../src/config';

let db: InstanceType<typeof Database>;
let server: http.Server;
let base = '';
let aliceToken = '';
let bobToken = '';

/** 本轮测试的分片目标文件（temp- 时间戳-随机数.mp4，落在 gitignore 的 uploads/temp） */
const run = Date.now();
const ids = [
  `temp-${run}-101.mp4`,
  `temp-${run}-202.mp4`,
  `temp-${run}-301.mp4`,
  `temp-${run}-302.mp4`,
  `temp-${run}-303.mp4`,
  `temp-${run}-304.mp4`,
  `temp-${run}-401.mp4`,
];
const CHUNK = Buffer.alloc(1024, 1);

beforeAll(async () => {
  db = new Database(':memory:');
  createSchema(db);
  setDbForTests(db);

  const insertUser = db.prepare(
    "INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, 'x', 'user')"
  );
  const aliceId = Number(insertUser.run('alice', 'alice@test.com').lastInsertRowid);
  const bobId = Number(insertUser.run('bob', 'bob@test.com').lastInsertRowid);
  aliceToken = generateToken({ id: aliceId, username: 'alice' });
  bobToken = generateToken({ id: bobId, username: 'bob' });

  const app = createApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  resetDbForTests();
  db?.close();
  // 清理本轮可能残留的分片文件
  for (const id of ids) {
    const p = path.join(PATHS.uploadsTemp, id);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
});

/** 发送一个分片（multipart，与客户端切片上传同构） */
async function sendChunk(token: string, uploadId: string, chunkIndex: number, totalChunks: number) {
  const form = new FormData();
  form.set('uploadId', uploadId);
  form.set('chunkIndex', String(chunkIndex));
  form.set('totalChunks', String(totalChunks));
  form.set('chunk', new Blob([new Uint8Array(CHUNK)]), 'chunk.bin');
  const res = await fetch(`${base}/api/posts/video-chunk`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

function tempPath(id: string): string {
  return path.join(PATHS.uploadsTemp, id);
}

/** 放弃上传（DELETE /video-temp）：删文件 + 释放会话，用例间互不残留 */
async function abortUpload(token: string, uploadId: string) {
  const res = await fetch(`${base}/api/posts/video-temp`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: `/uploads/temp/${uploadId}` }),
  });
  expect(res.status).toBe(200);
}

describe('分片上传参数校验', () => {
  it('无效 uploadId 返回 400', async () => {
    const { status } = await sendChunk(aliceToken, 'temp-abc.mp4', 0, 3);
    expect(status).toBe(400);
  });

  it('totalChunks 超上限（60 片 = 300MB / 5MB 片）返回 400', async () => {
    const { status } = await sendChunk(aliceToken, ids[6], 0, 61);
    expect(status).toBe(400);
    expect(fs.existsSync(tempPath(ids[6]))).toBe(false);
  });
});

describe('分片上传会话归属', () => {
  it('无会话直接续片返回 400', async () => {
    const { status, data } = await sendChunk(aliceToken, ids[0], 1, 3);
    expect(status).toBe(400);
    expect(data.error).toBe('上传会话已失效，请重新上传');
  });

  it('他人不能抢占进行中的首片，也不能续片', async () => {
    expect((await sendChunk(aliceToken, ids[1], 0, 3)).status).toBe(200);
    expect((await sendChunk(bobToken, ids[1], 0, 3)).status).toBe(403);
    expect((await sendChunk(bobToken, ids[1], 1, 3)).status).toBe(403);
    // 属主本人正常续片，结束后释放会话
    expect((await sendChunk(aliceToken, ids[1], 1, 3)).status).toBe(200);
    await abortUpload(aliceToken, ids[1]);
    expect(fs.existsSync(tempPath(ids[1]))).toBe(false);
  });

  it('同一用户并发上传超过 3 个返回 400', async () => {
    for (const id of [ids[2], ids[3], ids[4]]) {
      expect((await sendChunk(aliceToken, id, 0, 3)).status).toBe(200);
    }
    const { status } = await sendChunk(aliceToken, ids[5], 0, 3);
    expect(status).toBe(400);
    // 释放全部会话，避免影响后续用例
    for (const id of [ids[2], ids[3], ids[4]]) await abortUpload(aliceToken, id);
  });
});

describe('分片上传与会话回收', () => {
  it('分片顺序落盘，放弃后文件与会话同步释放（他人可复用 uploadId）', async () => {
    const id = ids[6];
    expect((await sendChunk(aliceToken, id, 0, 3)).status).toBe(200);
    expect((await sendChunk(aliceToken, id, 1, 3)).status).toBe(200);
    expect((await sendChunk(aliceToken, id, 2, 3)).status).toBe(200);
    expect(fs.statSync(tempPath(id)).size).toBe(CHUNK.length * 3);

    // 放弃上传：文件删除 + 会话释放
    await abortUpload(aliceToken, id);
    expect(fs.existsSync(tempPath(id))).toBe(false);

    // 会话已释放：他人可从首片重新占用同一 uploadId
    expect((await sendChunk(bobToken, id, 0, 3)).status).toBe(200);
  });
});
