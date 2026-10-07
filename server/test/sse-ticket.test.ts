/**
 * ============================================================
 * SSE 票据认证测试（POST /events/ticket → GET /events?ticket=）
 * ============================================================
 * 覆盖:
 * - 票据端点需要 Bearer 认证
 * - 票据一次性消费：连接成功后重放同一票据 → 401
 * - 无效票据 → 401
 * - 旧客户端 token 直连契约保持可用
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import Database from 'better-sqlite3';
import { createMemoryDb } from './helpers/memdb';
import { setDbForTests, resetDbForTests } from '../src/db/connection';
import { createApp } from '../src/app';
import { generateToken } from '../src/middleware/auth';

let db: InstanceType<typeof Database>;
let server: http.Server;
let base = '';
let token = '';

beforeAll(async () => {
  db = createMemoryDb();
  setDbForTests(db);

  const userId = Number(
    db.prepare("INSERT INTO users (username, email, password_hash) VALUES ('sse', 'sse@test.com', 'x')").run()
      .lastInsertRowid
  );
  token = generateToken({ id: userId, username: 'sse' });

  const app = createApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  resetDbForTests();
  db.close();
});

/** 建立 SSE 连接并读取首块数据后立即断开 */
async function openSseAndReadFirstChunk(url: string): Promise<{ status: number; body: string }> {
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal });
  const reader = res.body!.getReader();
  const { value } = await reader.read();
  controller.abort();
  return { status: res.status, body: new TextDecoder().decode(value ?? new Uint8Array()) };
}

describe('SSE 一次性票据认证', () => {
  it('票据端点需要 Bearer 认证', async () => {
    const res = await fetch(`${base}/api/events/ticket`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('认证后换取票据并成功建立 SSE；票据一次性，重放被拒', async () => {
    const issue = await fetch(`${base}/api/events/ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(issue.status).toBe(200);
    const { ticket } = (await issue.json()) as { ticket: string };
    expect(ticket).toMatch(/^[0-9a-f]{48}$/);

    const conn = await openSseAndReadFirstChunk(`${base}/api/events?ticket=${ticket}`);
    expect(conn.status).toBe(200);
    expect(conn.body).toContain(': connected');

    // 同一票据重放 → 401（读后即删）
    const replay = await fetch(`${base}/api/events?ticket=${ticket}`);
    expect(replay.status).toBe(401);
  });

  it('无效票据 → 401', async () => {
    const res = await fetch(`${base}/api/events?ticket=${'0'.repeat(48)}`);
    expect(res.status).toBe(401);
  });

  it('旧客户端 token 直连契约保持可用', async () => {
    const conn = await openSseAndReadFirstChunk(`${base}/api/events?token=${token}`);
    expect(conn.status).toBe(200);
    expect(conn.body).toContain(': connected');
  });
});
