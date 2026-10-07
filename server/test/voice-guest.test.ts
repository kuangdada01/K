/**
 * ============================================================
 * 访客语音房间回归测试（同 IP 并发访客不再互踢）
 * ============================================================
 * 事故背景（2026-09 线上）：登录 token 过期后客户端静默降级成访客，
 * 而旧实现让**同一 IP 的所有连接共用一个负数 id** →
 * hub 里两条连接互相覆盖成员条目 + `ws.ts` 的「同账号单点在线」判定
 * → 同一 WiFi 下的浏览器与安卓 App 无限互踢（4002「该账号已在其他设备进入语音」）。
 *
 * 本文件锁死修正后的契约：
 * - 同一 IP 的两条访客连接都拿到独立 id、都能进房、都留在成员表里
 * - 访客**永不**因「同账号」被顶（负数 id 不是认证身份）
 * - 访客与登录用户即使同 IP 也互不干扰
 * - 顺序重进（先离开再进）仍复用原 id → 显示名「未登录-N」排名稳定
 * - 两种空 token 形态都按访客处理（已发布客户端发的是 `?token=`）
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import Database from 'better-sqlite3';
import { WebSocket } from 'ws';
import { createMemoryDb } from './helpers/memdb';
import { setDbForTests, resetDbForTests } from '../src/db/connection';
import * as voiceRepo from '../src/repositories/voice.repo';
import { generateToken } from '../src/middleware/auth';
import { attachVoiceWs } from '../src/voice/ws';
import * as hub from '../src/voice/hub';
import { guestIds } from '../src/voice/guest-ids';

let db: InstanceType<typeof Database>;
let httpServer: http.Server;
let port = 0;
const clients: WebSocket[] = [];
let ownerId = 0;
let userToken = '';

beforeAll(async () => {
  db = createMemoryDb();
  setDbForTests(db);

  ownerId = Number(
    db
      .prepare("INSERT INTO users (username, email, password_hash) VALUES ('owner', 'owner@g.test', 'x')")
      .run().lastInsertRowid
  );
  userToken = generateToken({ id: ownerId, username: 'owner' });

  httpServer = http.createServer();
  attachVoiceWs(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  port = (httpServer.address() as { port: number }).port;
});

afterAll(async () => {
  for (const ws of clients) ws.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  resetDbForTests();
  db.close();
});

beforeEach(() => {
  // 上一个用例的访客登记可能还在 10 分钟倒计时里：清零避免串味
  guestIds.reset();
});

/**
 * 建立一条 WS 连接。`token` 为 undefined 时不带 token 参数，
 * 为空串时发 `?token=`（已发布客户端在未登录时就是这种形态）。
 */
function connect(token?: string): Promise<WebSocket> {
  const query = token === undefined ? '' : `?token=${token}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/voice/ws${query}`);
    (ws as any).__msgs = [];
    ws.on('message', (raw) => {
      try {
        (ws as any).__msgs.push(JSON.parse(String(raw)));
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

/** 等待下一条满足条件的服务端消息（从缓冲区消费，兼顾已到达的消息） */
function waitFor(ws: WebSocket, predicate: (msg: any) => boolean, timeoutMs = 3000): Promise<any> {
  const msgs: any[] = (ws as any).__msgs ?? [];
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', check);
    };
    const check = () => {
      const idx = msgs.findIndex(predicate);
      if (idx >= 0) {
        cleanup();
        resolve(msgs.splice(idx, 1)[0]);
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

const send = (ws: WebSocket, msg: unknown) => ws.send(JSON.stringify(msg));

/** 该连接收到的全部错误消息（用于断言「没有被顶号/踢出」） */
const errorsOf = (ws: WebSocket): any[] => ((ws as any).__msgs ?? []).filter((m: any) => m.type === 'error');

/** 静置一小段时间，让异步的顶号/踢出（若有）有机会到达 */
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

describe('访客语音：同 IP 并发连接', () => {
  it('★ 同一 IP 两个访客都能进房且都留在成员表里（旧实现无限互踢）', async () => {
    const room = voiceRepo.createRoom(ownerId, '同IP访客房', '', { creatorName: 'owner' });

    // 两条连接来自同一个 127.0.0.1（测试环境 TRUST_PROXY 关闭 → 取 socket 对端）
    const web = await connect(); // 无 token 参数
    send(web, { type: 'join', roomId: room.id });
    const webJoined = await waitFor(web, (m) => m.type === 'joined');
    expect(webJoined.participants).toHaveLength(0);

    const app = await connect(''); // `?token=` 空串（已发布客户端的形态）
    send(app, { type: 'join', roomId: room.id });
    const appJoined = await waitFor(app, (m) => m.type === 'joined');

    // 后进者能看到先到者，说明先到者没有被覆盖成同一条成员
    expect(appJoined.participants).toHaveLength(1);

    await settle();

    // 关键断言：两条连接都在房间里、都没有收到顶号错误
    expect(hub.getRoomCount(room.id)).toBe(2);
    expect(errorsOf(web)).toEqual([]);
    expect(errorsOf(app)).toEqual([]);
    expect(web.readyState).toBe(WebSocket.OPEN);
    expect(app.readyState).toBe(WebSocket.OPEN);
  });

  it('并发访客拿到不同 id 与不同显示名（不共号）', async () => {
    const a = await connect('');
    const b = await connect('');
    const c = await connect('');

    expect(guestIds.activeCount).toBe(3);
    expect(guestIds.size).toBe(1); // 都是同一个 IP

    const room = voiceRepo.createRoom(ownerId, '访客命名房', '', { creatorName: 'owner' });
    send(a, { type: 'join', roomId: room.id });
    await waitFor(a, (m) => m.type === 'joined');
    send(b, { type: 'join', roomId: room.id });
    const bJoined = await waitFor(b, (m) => m.type === 'joined');
    send(c, { type: 'join', roomId: room.id });
    const cJoined = await waitFor(c, (m) => m.type === 'joined');

    // 每个用例前都 reset 过：三条并发连接应依次拿到 -1 / -2 / -3
    // （不是三条都叫「未登录-1」——那就是旧实现里互相覆盖的根因）
    for (const id of [-1, -2, -3]) {
      expect(hub.getMemberRoomId(id)).toBe(room.id);
    }
    const names = [-1, -2, -3].map((id) => hub.findMember(id)?.username);
    expect(names).toEqual(['未登录-1', '未登录-2', '未登录-3']);
    expect(new Set(names).size).toBe(3);

    // 后进者能看到全部先到者
    expect(bJoined.participants).toHaveLength(1);
    expect(cJoined.participants).toHaveLength(2);
    for (const p of cJoined.participants) {
      expect(p.userId).toBeLessThan(0);
      expect(p.username).toMatch(/^未登录-\d+$/);
    }
    expect(hub.getRoomCount(room.id)).toBe(3);
  });

  it('访客与登录用户同 IP 共存，登录用户的单点在线不受影响', async () => {
    const room = voiceRepo.createRoom(ownerId, '混合房', '', { creatorName: 'owner' });

    const guest = await connect('');
    send(guest, { type: 'join', roomId: room.id });
    await waitFor(guest, (m) => m.type === 'joined');

    const logged = await connect(userToken);
    send(logged, { type: 'join', roomId: room.id });
    const loggedJoined = await waitFor(logged, (m) => m.type === 'joined');
    expect(loggedJoined.participants).toHaveLength(1);

    await settle();
    expect(hub.getRoomCount(room.id)).toBe(2);
    expect(errorsOf(guest)).toEqual([]);
    expect(errorsOf(logged)).toEqual([]);

    // 登录用户真·重复连接仍然被顶掉（该保护不能被削弱）
    const kickedP = waitFor(logged, (m) => m.type === 'error');
    await connect(userToken);
    const kicked = await kickedP;
    expect(kicked.message).toContain('其他地方');
    expect(hub.getRoomCount(room.id)).toBe(2); // 仍然只有「访客 + 新登录连接」
  });

  it('顺序重进（离开后再进）复用原访客 id，显示名排名稳定', async () => {
    const room = voiceRepo.createRoom(ownerId, '重进房', '', { creatorName: 'owner' });

    const first = await connect('');
    send(first, { type: 'join', roomId: room.id });
    await waitFor(first, (m) => m.type === 'joined');
    // 本文件每个用例前都 reset 过：第一个访客必定是 -1
    expect(hub.getMemberRoomId(-1)).toBe(room.id);

    // 客户端退出流程：先 leave（退房广播），再关连接（归还访客租约）
    const closed = new Promise<void>((r) => first.on('close', () => r()));
    send(first, { type: 'leave' });
    first.close();
    await closed;
    await settle();

    const second = await connect('');
    send(second, { type: 'join', roomId: room.id });
    await waitFor(second, (m) => m.type === 'joined');

    // 同一 IP 的主 id 立即复用 → 「未登录-1」而不是「未登录-2」
    expect(guestIds.size).toBe(1);
    expect(hub.getMemberRoomId(-1)).toBe(room.id);
    expect(hub.findMember(-1)?.ws).toBeDefined();
    expect(hub.getRoomCount(room.id)).toBe(1);
  });

  it('访客断线后 id 进入倒计时、进程内不重复发号', async () => {
    const room = voiceRepo.createRoom(ownerId, '断线房', '', { creatorName: 'owner' });
    const ws = await connect('');
    send(ws, { type: 'join', roomId: room.id });
    await waitFor(ws, (m) => m.type === 'joined');

    const closed = new Promise<void>((r) => ws.on('close', () => r()));
    ws.close();
    await closed;
    await settle();

    // 连接断开：成员表清空、无活跃租约；登记仍保留（10 分钟倒计时内排名不变）
    expect(hub.getRoomCount(room.id)).toBe(0);
    expect(guestIds.activeCount).toBe(0);
    expect(guestIds.size).toBe(1);
    expect(guestIds.freeSize).toBe(0);
  });
});
