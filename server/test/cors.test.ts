/**
 * ============================================================
 * CORS 预检与白名单测试（原生宿主改造的配套门禁）
 * ============================================================
 * 背景：旧安卓包用 CapacitorHttp（原生网络栈），所有 API 请求**绕过 CORS**；
 * 换成自研原生宿主后请求全部走 WebView 网络栈，于是：
 * 1. 页面来源变成 `https://appassets.androidplatform.net`，必须在白名单里；
 * 2. 预检头白名单必须覆盖客户端**真实发送**的所有自定义头，否则预检失败
 *    （前端只看到"网络错误"，极难定位）：
 *    - `X-Voice-Owner-Token`（访客房间所有权令牌：删房 / 清空聊天）
 *    - `Cache-Control`（临时视频状态轮询显式 no-cache）
 *
 * 这两个头曾经"缺了也没事"，现在是**缺了就报错** —— 所以在这里钉死。
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import Database from 'better-sqlite3';
import { createMemoryDb } from './helpers/memdb';
import { setDbForTests, resetDbForTests } from '../src/db/connection';
import { createApp } from '../src/app';

/** 原生安卓宿主的页面来源（WebViewAssetLoader 官方资源域） */
const NATIVE_ORIGIN = 'https://appassets.androidplatform.net';

/**
 * 白名单必须由测试自己钉死，不能依赖开发者本机 `.env`（server 启动会 load dotenv）：
 * 否则「本机 .env 忘了加原生来源」会让这个门禁静默失效（或反过来在 CI 里假失败）。
 * `vi.hoisted` 会被提升到 import 之前执行 —— config.ts 是在模块加载期解析 env 的。
 */
vi.hoisted(() => {
  process.env.ALLOWED_ORIGINS =
    'http://localhost:5173,http://localhost,https://appassets.androidplatform.net';
});

let db: InstanceType<typeof Database>;
let server: http.Server;
let base = '';

async function preflight(origin: string, requestHeaders = 'content-type,authorization') {
  return fetch(`${base}/api/health`, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': requestHeaders,
    },
  });
}

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

describe('CORS：原生宿主来源', () => {
  it('允许原生宿主来源（appassets.androidplatform.net）', async () => {
    const res = await preflight(NATIVE_ORIGIN);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(NATIVE_ORIGIN);
    // 跨源响应必须 Vary: Origin，否则 CDN/代理会把某个来源的响应喂给另一个来源
    expect(res.headers.get('vary')).toContain('Origin');
  });

  it('白名单外的来源仍然 403（不放宽）', async () => {
    const res = await preflight('https://evil.example.com');
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('CORS：预检头白名单覆盖客户端真实使用的自定义头', () => {
  it('允许 X-Voice-Owner-Token（访客房主令牌：删房/清空聊天）', async () => {
    const res = await preflight(NATIVE_ORIGIN, 'x-voice-owner-token');
    const allowed = (res.headers.get('access-control-allow-headers') || '').toLowerCase();
    expect(allowed).toContain('x-voice-owner-token');
  });

  it('允许 Cache-Control（临时视频状态轮询显式 no-cache）', async () => {
    const res = await preflight(NATIVE_ORIGIN, 'cache-control');
    const allowed = (res.headers.get('access-control-allow-headers') || '').toLowerCase();
    expect(allowed).toContain('cache-control');
  });

  it('仍允许原有的 Content-Type / Authorization', async () => {
    const res = await preflight(NATIVE_ORIGIN);
    const allowed = (res.headers.get('access-control-allow-headers') || '').toLowerCase();
    expect(allowed).toContain('content-type');
    expect(allowed).toContain('authorization');
  });
});
