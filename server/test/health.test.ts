/**
 * ============================================================
 * 健康检查数据库探针测试（GET /api/health）
 * ============================================================
 * 覆盖:
 * - 数据库正常 → 200 { status: 'ok' }（既有契约不变）
 * - 数据库不可用 → 503 { status: 'error', database: 'unavailable' }
 *   且响应体不泄露内部错误细节
 *
 * 背景：getDb() 是惰性代理，建库/迁移错误只在第一次真实查询时暴露。
 * 探针缺失时 k.db 损坏也返回 200，Docker HEALTHCHECK 与部署后校验全部误判通过。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import Database from 'better-sqlite3';
import { createMemoryDb } from './helpers/memdb';
import { setDbForTests, resetDbForTests } from '../src/db/connection';
import { createApp } from '../src/app';

let db: InstanceType<typeof Database>;
let server: http.Server;
let base = '';

beforeAll(async () => {
  db = createMemoryDb();
  setDbForTests(db);

  const app = createApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  resetDbForTests();
  db?.close();
});

describe('GET /api/health 数据库探针', () => {
  it('数据库正常时返回 200 与既有响应形状', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; timestamp: string };
    expect(body.status).toBe('ok');
    expect(typeof body.timestamp).toBe('string');
    // 健康响应不得因为加了探针而多出字段
    expect(Object.keys(body).sort()).toEqual(['status', 'timestamp']);
  });

  it('数据库不可用时返回 503，且不泄露内部错误细节', async () => {
    db.close(); // 关闭底层连接：后续 prepare/get 必然失败

    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; database: string; error?: string };
    expect(body.status).toBe('error');
    expect(body.database).toBe('unavailable');
    // 内部错误文案（如 "The database connection is not open"）不得下发
    expect(body.error).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/database connection|SQLITE|better-sqlite3/i);

    // 重新打开内存库，避免影响其他用例（afterAll 会再关一次，重复 close 无害）
    db = createMemoryDb();
    setDbForTests(db);
  });
});
