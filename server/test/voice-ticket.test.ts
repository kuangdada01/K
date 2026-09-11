/**
 * ============================================================
 * 语音一次性连接票据测试（POST /api/voice/ticket + WS ?ticket=）
 * ============================================================
 * 背景：浏览器 WebSocket 无法自定义请求头，语音信令此前把 JWT 放在
 * `/api/voice/ws?token=<JWT>` 的查询串里 —— 它会进 nginx access log
 * （SSE 早已改为一次性票据，语音没跟上）。现在对齐票据方案，同时**保留**
 * `?token=` 兼容已发布的 APK 与缓存网页。
 *
 * 覆盖:
 * - 票据单元语义：单次消费、过期失效、存储之间互不通用
 * - POST /api/voice/ticket：未认证 401、无效 token 401、正常签发
 * - WS 用票据建连：认证为**真实用户**（不是访客）、票据只能用一次、
 *   伪造/过期票据 → 4001
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import Database from 'better-sqlite3';
import { WebSocket } from 'ws';
import { createMemoryDb } from './helpers/memdb';
import { setDbForTests, resetDbForTests } from '../src/db/connection';
import * as voiceRepo from '../src/repositories/voice.repo';
import { generateToken } from '../src/middleware/auth';
import { createApp } from '../src/app';
import { attachVoiceWs } from '../src/voice/ws';
import { createOneTimeTicketStore } from '../src/lib/oneTimeTicket';

let db: InstanceType<typeof Database>;
let server: http.Server;
let base = '';
let wsBase = '';
let aliceId = 0;
let aliceToken = '';
let roomId = 0;
const clients: WebSocket[] = [];

/** 建立一条 WS 连接（query 为完整查询串，如 'ticket=xxx' / 'token=xxx' / ''） */
function connectWs(query: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}${query ? `?${query}` : ''}`);
    (ws as unknown as { msgs: unknown[] }).msgs = [];
    ws.on('message', (raw) => {
      try {
        (ws as unknown as { msgs: unknown[] }).msgs.push(JSON.parse(String(raw)));
      } catch {
        /* 忽略非 JSON */
      }
    });
    ws.on('open', () => {
      clients.push(ws);
      resolve(ws);
    });
    ws.on('error', reject);
  });
}

/** 等待下一条满足条件的服务端消息 */
function waitFor(ws: WebSocket, predicate: (m: Record<string, unknown>) => boolean, timeoutMs = 3000) {
  const msgs = (ws as unknown as { msgs: Record<string, unknown>[] }).msgs ?? [];
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', check);
    };
    const check = () => {
      const idx = msgs.findIndex(predicate);
      if (idx >= 0) {
        cleanup();
        resolve(msgs.splice(idx, 1)[0]!);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('等待服务端消息超时'));
    }, timeoutMs);
    ws.on('message', check);
    check();
  });
}

/** 等连接关闭，返回关闭码 */
function closeCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.on('close', (code) => resolve(code)));
}

async function postTicket(token?: string) {
  const res = await fetch(`${base}/api/voice/ticket`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as { ticket?: string } };
}

beforeAll(async () => {
  db = createMemoryDb();
  setDbForTests(db);

  const insertUser = db.prepare("INSERT INTO users (username, email, password_hash) VALUES (?, ?, 'x')");
  aliceId = Number(insertUser.run('alice', 'alice@ticket.test').lastInsertRowid);
  aliceToken = generateToken({ id: aliceId, username: 'alice' });
  roomId = voiceRepo.createRoom(aliceId, '票据房', '', { creatorName: 'alice' }).id;

  const app = createApp();
  server = http.createServer(app);
  attachVoiceWs(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}/api/voice/ws`;
});

afterAll(async () => {
  for (const ws of clients) ws.close();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  resetDbForTests();
  db?.close();
});

afterEach(() => {
  /* 各用例自行清理连接 */
});

describe('createOneTimeTicketStore 单元语义', () => {
  it('签发后可消费一次，返回 userId；再次消费为 undefined（读后即删）', () => {
    const store = createOneTimeTicketStore();
    const ticket = store.issue(42);
    expect(ticket).toMatch(/^[0-9a-f]{48}$/);
    expect(store.consume(ticket)).toBe(42);
    expect(store.consume(ticket)).toBeUndefined();
  });

  it('过期票据无效（TTL 之外）', () => {
    const store = createOneTimeTicketStore(1000);
    const ticket = store.issue(7);
    const realNow = Date.now;
    Date.now = () => realNow() + 1001; // 越过 TTL
    try {
      expect(store.consume(ticket)).toBeUndefined();
    } finally {
      Date.now = realNow;
    }
  });

  it('无效票据串返回 undefined', () => {
    const store = createOneTimeTicketStore();
    expect(store.consume('not-a-ticket')).toBeUndefined();
    expect(store.consume('')).toBeUndefined();
  });

  it('不同存储实例互不通用（语音票据不能当 SSE 票据用）', () => {
    const a = createOneTimeTicketStore();
    const b = createOneTimeTicketStore();
    const ticket = a.issue(1);
    expect(b.consume(ticket)).toBeUndefined();
    expect(a.consume(ticket)).toBe(1);
  });
});

describe('POST /api/voice/ticket', () => {
  it('未认证 → 401', async () => {
    const res = await postTicket();
    expect(res.status).toBe(401);
    expect(res.body.ticket).toBeUndefined();
  });

  it('无效 token → 401', async () => {
    const res = await postTicket('bad-token');
    expect(res.status).toBe(401);
  });

  it('登录用户 → 200 + 票据', async () => {
    const res = await postTicket(aliceToken);
    expect(res.status).toBe(200);
    expect(res.body.ticket).toMatch(/^[0-9a-f]{48}$/);
  });
});

describe('WS 用一次性票据建连', () => {
  it('★ 票据建连后是**真实用户**（不是访客），joined.self 为真实 id', async () => {
    const { body } = await postTicket(aliceToken);
    const ws = await connectWs(`ticket=${body.ticket}`);
    ws.send(JSON.stringify({ type: 'join', roomId }));
    const joined = await waitFor(ws, (m) => m.type === 'joined');
    const self = joined.self as { userId: number; username: string };
    expect(self.userId).toBe(aliceId);
    expect(self.username).toBe('alice');
    expect(self.userId).toBeGreaterThan(0); // 不是负数访客 id
    ws.close();
  });

  it('★ 票据只能用一次：第二次建连被 4001 拒绝', async () => {
    const { body } = await postTicket(aliceToken);
    const first = await connectWs(`ticket=${body.ticket}`);
    first.close();
    await new Promise((r) => setTimeout(r, 50));

    const second = await connectWs(`ticket=${body.ticket}`);
    const err = await waitFor(second, (m) => m.type === 'error');
    expect(String(err.message)).toBeTruthy();
    await expect(closeCode(second)).resolves.toBe(4001);
  });

  it('伪造票据 → 4001', async () => {
    const ws = await connectWs(`ticket=${'f'.repeat(48)}`);
    await expect(closeCode(ws)).resolves.toBe(4001);
  });

  it('过期票据 → 4001', async () => {
    const { body } = await postTicket(aliceToken);
    const realNow = Date.now;
    Date.now = () => realNow() + 31_000; // 越过 30s TTL
    try {
      const ws = await connectWs(`ticket=${body.ticket}`);
      await expect(closeCode(ws)).resolves.toBe(4001);
    } finally {
      Date.now = realNow;
    }
  });

  it('兼容：旧客户端的 ?token= 仍可建连（已发布 APK / 缓存网页）', async () => {
    const ws = await connectWs(`token=${aliceToken}`);
    ws.send(JSON.stringify({ type: 'join', roomId }));
    const joined = await waitFor(ws, (m) => m.type === 'joined');
    expect((joined.self as { userId: number }).userId).toBe(aliceId);
    ws.close();
  });

  it('兼容：无效 ?token= 仍按 4001 拒绝（不降级成访客）', async () => {
    const ws = await connectWs('token=bad-token');
    await expect(closeCode(ws)).resolves.toBe(4001);
  });
});
