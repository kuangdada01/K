/**
 * ============================================================
 * 语音每 IP 并发上限的 WS 级测试（P2-29）
 * ============================================================
 * 单测覆盖了计数语义，这里验证**真实握手路径**上的行为：
 * - 访客占满房间席位后，第 N+1 条连接收到明确错误 + **4004**（终止码，客户端不再重连）
 * - 被拒的连接**不消耗任何资源**：不分配访客 id（不留租约）、不进房间
 * - 关闭一条后立刻可以再接入（席位确实被归还）
 * - 认证连接与访客共用同一张按 IP 的表，但访客名额单独计算
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import Database from 'better-sqlite3';
import { WebSocket } from 'ws';
import { createMemoryDb } from './helpers/memdb';
import { setDbForTests, resetDbForTests } from '../src/db/connection';
import * as voiceRepo from '../src/repositories/voice.repo';
import { generateToken } from '../src/middleware/auth';
import { attachVoiceWs } from '../src/voice/ws';
import * as hub from '../src/voice/hub';
import { guestIds } from '../src/voice/guest-ids';
import { reset as resetIpConns, MAX_VOICE_GUEST_CONNECTIONS_PER_IP } from '../src/voice/ip-connections';

let db: InstanceType<typeof Database>;
let httpServer: http.Server;
let port = 0;
let roomId = 0;
let userToken = '';
let userId = 0;
const clients: WebSocket[] = [];

/** 测试侧给 socket 挂的消息收集数组（避免到处 as any，保持 server/test 的 any 存量不增长） */
type WsWithMsgs = WebSocket & { msgs: Record<string, unknown>[] };
const withMsgs = (ws: WebSocket): WsWithMsgs => ws as WsWithMsgs;

/** 建立访客连接（不带任何凭证），并把消息收集起来 */
function connectGuest(): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/voice/ws`);
  withMsgs(ws).msgs = [];
  ws.on('message', (raw) => {
    try {
      withMsgs(ws).msgs.push(JSON.parse(String(raw)) as Record<string, unknown>);
    } catch {
      /* 忽略非 JSON */
    }
  });
  ws.on('error', () => {});
  clients.push(ws);
  return ws;
}

const opened = (ws: WebSocket) =>
  new Promise<void>((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.on('open', () => resolve());
    ws.on('close', () => reject(new Error('连接在打开前被关闭')));
  });

const closed = (ws: WebSocket) =>
  new Promise<number>((resolve) => ws.on('close', (code: number) => resolve(code)));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  db = createMemoryDb();
  setDbForTests(db);
  const info = db
    .prepare("INSERT INTO users (username, email, password_hash) VALUES ('alice', 'alice@iplimit.test', 'x')")
    .run();
  userId = Number(info.lastInsertRowid);
  userToken = generateToken({ id: userId, username: 'alice' });
  roomId = voiceRepo.createRoom(userId, 'IP 上限房', '', { creatorName: 'alice' }).id;

  httpServer = http.createServer();
  attachVoiceWs(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  port = (httpServer.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const ws of clients) ws.close();
  await new Promise((r) => setTimeout(r, 100));
  if (httpServer) await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  resetDbForTests();
  db?.close();
});

beforeEach(() => {
  // 上一个用例可能留下登记的 IP 与访客租约：清零避免串味
  resetIpConns();
  guestIds.reset();
});

afterEach(async () => {
  // 关掉本用例的连接并等 hub 收敛：否则房间会被上一条用例的 10 个成员占满，
  // 后续用例的 join 会被「房间已满」挡掉（与上限无关的假失败）
  for (const ws of clients) {
    try {
      ws.close();
    } catch {
      /* 已关闭 */
    }
  }
  clients.length = 0;
  await sleep(200);
  expect(hub.getRoomCount(roomId)).toBe(0);
});

describe('访客连接上限', () => {
  it('★ 占满房间席位后，第 N+1 条访客连接被拒（错误消息 + 4004）', async () => {
    const accepted: WebSocket[] = [];
    for (let i = 0; i < MAX_VOICE_GUEST_CONNECTIONS_PER_IP; i++) {
      const ws = connectGuest();
      await opened(ws);
      accepted.push(ws);
    }

    const denied = connectGuest();
    const err = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('未收到拒绝消息')), 5000);
      const check = () => {
        const m = withMsgs(denied).msgs.find((x) => x.type === 'error');
        if (m) {
          clearTimeout(t);
          resolve(m);
        }
      };
      denied.on('message', check);
      check();
    });
    expect(String(err.message)).toContain('连接过多');
    await expect(closed(denied)).resolves.toBe(4004);

    // 前 N 条仍然在线（拒绝没有连坐）
    for (const ws of accepted) expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it('★ 被拒的连接不分配访客 id、不进房间（不留下任何租约）', async () => {
    for (let i = 0; i < MAX_VOICE_GUEST_CONNECTIONS_PER_IP; i++) {
      const ws = connectGuest();
      await opened(ws);
      ws.send(JSON.stringify({ type: 'join', roomId }));
    }
    await sleep(200);
    const before = guestIds.activeCount;
    const beforeRoom = hub.getRoomCount(roomId);

    const denied = connectGuest();
    await expect(closed(denied)).resolves.toBe(4004);
    await sleep(100);

    // 席位检查发生在消耗凭证之前：因此没有多出访客租约，也没有进房间
    expect(guestIds.activeCount).toBe(before);
    expect(hub.getRoomCount(roomId)).toBe(beforeRoom);
  });

  it('关闭一条后立即可以再接入（席位确实被归还）', async () => {
    const first = connectGuest();
    await opened(first);
    for (let i = 1; i < MAX_VOICE_GUEST_CONNECTIONS_PER_IP; i++) {
      const ws = connectGuest();
      await opened(ws);
    }
    // 到顶：再连被拒
    const deniedOnce = connectGuest();
    await expect(closed(deniedOnce)).resolves.toBe(4004);

    // 关掉一条 → 腾出席位
    const code = closed(first);
    first.close();
    await code;
    await sleep(100);

    const again = connectGuest();
    await expect(opened(again)).resolves.toBeUndefined();
  });

  it('认证连接不吃访客名额（NAT 后多人登录不受访客上限影响）', async () => {
    // 先用满访客席位
    for (let i = 0; i < MAX_VOICE_GUEST_CONNECTIONS_PER_IP; i++) {
      const ws = connectGuest();
      await opened(ws);
    }
    // 认证连接仍可建立（总上限 24 比访客上限宽）
    const auth = new WebSocket(`ws://127.0.0.1:${port}/api/voice/ws?token=${userToken}`);
    withMsgs(auth).msgs = [];
    auth.on('message', (raw) => {
      try {
        withMsgs(auth).msgs.push(JSON.parse(String(raw)) as Record<string, unknown>);
      } catch {
        /* 忽略 */
      }
    });
    auth.on('error', () => {});
    clients.push(auth);
    await expect(opened(auth)).resolves.toBeUndefined();

    auth.send(JSON.stringify({ type: 'join', roomId }));
    await new Promise((r) => setTimeout(r, 300));
    expect(hub.getMemberRoomId(userId)).toBe(roomId);
  });
});
