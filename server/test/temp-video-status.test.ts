/**
 * ============================================================
 * 临时视频转码状态接口测试（GET /api/posts/video-temp/status）
 * ============================================================
 * 覆盖：
 * - 未登录 401 / 无效引用 400
 * - 属主校验：他人会话 403（状态暴露属隐私，与 DELETE /video-temp 一致）
 * - 文件不存在 → missing
 * - 文件存在但非 H.264（含本机无 ffprobe 时探测失败）→ encoding
 * （done 分支依赖真 H.264 文件 + ffprobe，属服务器环境行为，线上验证）
 * ============================================================
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
import {
  registerChunkUpload,
  releaseChunkUpload,
} from '../src/lib/chunkUploadRegistry';
import { PATHS } from '../src/config';

let db: InstanceType<typeof Database>;
let server: http.Server;
let base = '';
let aliceToken = '';
let bobToken = '';

const run = Date.now();
const NAME = `temp-${run}-123.mp4`;

async function getStatus(
  url: string,
  token: string
): Promise<{ code: number; body: { error?: string; status?: string }; cacheControl: string | null }> {
  const res = await fetch(`${base}/api/posts/video-temp/status?url=${encodeURIComponent(url)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return {
    code: res.status,
    body: (await res.json()) as { error?: string; status?: string },
    cacheControl: res.headers.get('cache-control'),
  };
}

beforeAll(async () => {
  fs.mkdirSync(path.join(PATHS.uploadsTemp), { recursive: true });
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
  server?.close();
  resetDbForTests();
  const p = path.join(PATHS.uploadsTemp, NAME);
  if (fs.existsSync(p)) fs.unlinkSync(p);
});

describe('GET /api/posts/video-temp/status', () => {
  it('未登录返回 401', async () => {
    const { code } = await getStatus(`/uploads/temp/${NAME}`, '');
    expect(code).toBe(401);
  });

  it('无效引用格式返回 400', async () => {
    const { code } = await getStatus('/uploads/temp/evil.bin', aliceToken);
    expect(code).toBe(400);
  });

  it('他人上传会话（属主存在且非本人）返回 403', async () => {
    registerChunkUpload(NAME, 9999); // 属主为不存在的 bob-db 之外的用户
    try {
      const { code } = await getStatus(`/uploads/temp/${NAME}`, aliceToken);
      expect(code).toBe(403);
    } finally {
      releaseChunkUpload(NAME);
    }
  });

  it('文件不存在返回 missing', async () => {
    const { code, body } = await getStatus(`/uploads/temp/${NAME}`, aliceToken);
    expect(code).toBe(200);
    expect(body.status).toBe('missing');
  });

  it('文件存在但非 H.264（含本机无 ffprobe）返回 encoding', async () => {
    // 写入假视频内容（非 h264；本机若无 ffprobe，probe 返回 null 同样落入 encoding）
    fs.writeFileSync(path.join(PATHS.uploadsTemp, NAME), Buffer.from('not a real video file'));
    const { code, body } = await getStatus(`/uploads/temp/${NAME}`, aliceToken);
    expect(code).toBe(200);
    expect(body.status).toBe('encoding');
  });

  it('响应禁止缓存（Cache-Control: no-store）——轮询接口必须每次读到最新状态', async () => {
    fs.writeFileSync(path.join(PATHS.uploadsTemp, NAME), Buffer.from('not a real video file'));
    const { cacheControl } = await getStatus(`/uploads/temp/${NAME}`, aliceToken);
    expect(cacheControl).toBe('no-store');
  });
});