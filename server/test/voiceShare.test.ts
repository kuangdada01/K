/**
 * ============================================================
 * 语音房间屏幕共享状态测试
 * ============================================================
 * 覆盖:
 * - share-start 广播 share-changed(active=true) + 参与者 sharing 标记
 * - 抢占：第二人共享时旧共享者收到 share-force-stop，状态广播先停旧后启新
 * - 共享者主动停止 / 离开房间 / 断线：广播 share-changed(active=false)
 * - 重复 share-start（幂等，不产生重复广播）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import Database from 'better-sqlite3';
import { WebSocket } from 'ws';
import { createSchema } from '../src/db/schema';
import { setDbForTests, resetDbForTests } from '../src/db/connection';
import * as voiceRepo from '../src/repositories/voice.repo';
import { generateToken } from '../src/middleware/auth';
import { attachVoiceWs } from '../src/voice/ws';

let db: InstanceType<typeof Database>;
let httpServer: http.Server;
let port = 0;
let aliceToken = '';
let bobToken = '';
const clients: WebSocket[] = [];
let aliceId = 0;
let bobId = 0;

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  setDbForTests(db);

  const insertUser = db.prepare("INSERT INTO users (username, email, password_hash) VALUES (?, ?, 'x')");
  aliceId = Number(insertUser.run('alice', 'alice@test.com').lastInsertRowid);
  bobId = Number(insertUser.run('bob', 'bob@test.com').lastInsertRowid);
  aliceToken = generateToken({ id: aliceId, username: 'alice' });
  bobToken = generateToken({ id: bobId, username: 'bob' });

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

function connect(token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/voice/ws?token=${token}`);
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

async function setupRoom(): Promise<{ roomId: number; alice: WebSocket; bob: WebSocket }> {
  const room = voiceRepo.createRoom(aliceId, '共享测试房', '', { creatorName: 'alice' });
  const alice = await connect(aliceToken);
  const bob = await connect(bobToken);
  send(alice, { type: 'join', roomId: room.id });
  await waitFor(alice, (m) => m.type === 'joined');
  send(bob, { type: 'join', roomId: room.id });
  await waitFor(bob, (m) => m.type === 'joined');
  // bob 加入只有 alice 收 peer-joined（bob 的既有成员在 joined 载荷里），消化掉保证缓冲干净
  await waitFor(alice, (m) => m.type === 'peer-joined');
  return { roomId: room.id, alice, bob };
}

describe('语音房间屏幕共享', () => {
  it('share-start 广播 share-changed(active=true)，参与者带 sharing 标记', async () => {
    const { roomId, alice, bob } = await setupRoom();

    send(alice, { type: 'share-start', audio: true });
    const bobSeen = await waitFor(bob, (m) => m.type === 'share-changed');
    expect(bobSeen.userId).toBe(aliceId);
    expect(bobSeen.active).toBe(true);
    expect(bobSeen.audio).toBe(true);

    // bob 重进房间：joined.participants 里的 alice 带 sharing 标记（全量序列化路径）
    send(bob, { type: 'leave' });
    await waitFor(alice, (m) => m.type === 'peer-left' && m.userId === bobId);
    const bob2 = await connect(bobToken);
    send(bob2, { type: 'join', roomId });
    const joined = await waitFor(bob2, (m) => m.type === 'joined');
    const aliceInfo = joined.participants.find((p: any) => p.userId === aliceId);
    expect(aliceInfo.sharing).toBe(true);
    clients.push(bob2);

    await waitFor(alice, (m) => m.type === 'peer-joined' && m.participant.userId === bobId);
    send(alice, { type: 'share-stop' });
    await waitFor(bob2, (m) => m.type === 'share-changed' && m.userId === aliceId && m.active === false);
    bob2.close();
  });

  it('抢占：第二人共享 → 旧共享者收到 share-force-stop，状态先停旧后启新', async () => {
    const { alice, bob } = await setupRoom();

    send(alice, { type: 'share-start', audio: false });
    await waitFor(bob, (m) => m.type === 'share-changed' && m.active === true);
    // 广播含发送者自己：消化 alice 收到的自身共享开启副本，避免污染后续断言
    await waitFor(alice, (m) => m.type === 'share-changed' && m.active === true);

    send(bob, { type: 'share-start', audio: true });
    // 旧共享者 alice：先收到强制停止通知
    const forced = await waitFor(alice, (m) => m.type === 'share-force-stop');
    expect(forced.type).toBe('share-force-stop');
    // alice 收到两条 share-changed：自己停、bob 开（顺序保证）
    const off = await waitFor(alice, (m) => m.type === 'share-changed' && m.active === false);
    expect(off.userId).toBe(aliceId);
    const on = await waitFor(alice, (m) => m.type === 'share-changed' && m.active === true);
    expect(on.userId).toBe(bobId);

    // 幂等：bob 重复 share-start 不产生第二条 active 广播
    await waitFor(bob, (m) => m.type === 'share-changed' && m.active === true && m.userId === bobId);
    const bobBuffer: any[] = (bob as any).__msgs;
    const activeCountBefore = bobBuffer.filter(
      (m) => m.type === 'share-changed' && m.active === true && m.userId === bobId
    ).length;
    send(bob, { type: 'share-start', audio: true });
    await new Promise((r) => setTimeout(r, 150));
    const activeCountAfter = bobBuffer.filter(
      (m) => m.type === 'share-changed' && m.active === true && m.userId === bobId
    ).length;
    expect(activeCountAfter).toBe(activeCountBefore);

    send(bob, { type: 'share-stop' });
    await waitFor(alice, (m) => m.type === 'share-changed' && m.userId === bobId && m.active === false);
  });

  it('共享者直接断线：广播 share-changed(active=false)', async () => {
    const { roomId, alice, bob } = await setupRoom();

    send(bob, { type: 'share-start', audio: false });
    await waitFor(alice, (m) => m.type === 'share-changed' && m.active === true);

    bob.close(); // 模拟断线（不 send share-stop）
    const off = await waitFor(alice, (m) => m.type === 'share-changed' && m.active === false);
    expect(off.userId).toBe(bobId);

    // bob 状态已清：重新连入后房间无人共享
    const bob2 = await connect(bobToken);
    send(bob2, { type: 'join', roomId });
    const joined = await waitFor(bob2, (m) => m.type === 'joined');
    expect(joined.participants.some((p: any) => p.sharing)).toBe(false);
    bob2.close();
  });
});
