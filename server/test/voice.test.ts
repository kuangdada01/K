/**
 * ============================================================
 * 语音房间功能测试
 * ============================================================
 * 覆盖:
 * - voiceRepo 房间 CRUD（创建/列表联表/删除）
 * - WS 信令全链路: join → joined/peer-joined → signal 中转 → mute 广播
 *   → leave/断线 peer-left → 房间满/不存在拒绝 → 同账号重复连接顶替
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
import * as hub from '../src/voice/hub';
import { VOICE_MAX_ROOM_SIZE } from '@k/shared';

let db: InstanceType<typeof Database>;
let httpServer: http.Server;
let port = 0;
let aliceToken = '';
let bobToken = '';
let carolToken = '';
const clients: WebSocket[] = [];
let aliceId = 0;
let bobId = 0;
let carolId = 0;

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  setDbForTests(db);

  const insertUser = db.prepare("INSERT INTO users (username, email, password_hash) VALUES (?, ?, 'x')");
  aliceId = Number(insertUser.run('alice', 'alice@test.com').lastInsertRowid);
  bobId = Number(insertUser.run('bob', 'bob@test.com').lastInsertRowid);
  carolId = Number(insertUser.run('carol', 'carol@test.com').lastInsertRowid);
  aliceToken = generateToken({ id: aliceId, username: 'alice' });
  bobToken = generateToken({ id: bobId, username: 'bob' });
  carolToken = generateToken({ id: carolId, username: 'carol' });

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

/** 建立一条 WS 连接（open 前先挂收集器，避免消息先于监听到达的竞态） */
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

describe('voiceRepo 房间 CRUD', () => {
  it('创建房间并列表返回创建者快照', () => {
    const room = voiceRepo.createRoom(aliceId, '闲聊房', '随便聊聊', { creatorName: 'alice' });
    expect(room.name).toBe('闲聊房');
    // 行级：创建者信息为快照列（creator_username 是对外 VO 的映射字段）
    expect(room.creator_name).toBe('alice');

    const rooms = voiceRepo.listRooms();
    expect(rooms).toHaveLength(1);
    expect(rooms[0].creator_avatar).toBeNull();

    // 对外 VO：creator_name → creator_username，内部列 creator_ip 不泄露
    const vo = voiceRepo.toVoiceRoom(voiceRepo.getRoomById(room.id)!);
    expect(vo.creator_username).toBe('alice');
    expect('creator_ip' in vo).toBe(false);
  });

  it('删除房间', () => {
    const room = voiceRepo.createRoom(aliceId, '待删', '', { creatorName: 'alice' });
    expect(voiceRepo.deleteRoom(room.id)).toBe(true);
    expect(voiceRepo.getRoomById(room.id)).toBeUndefined();
    expect(voiceRepo.deleteRoom(room.id)).toBe(false);
  });
});

describe('WS 信令全链路', () => {
  it('join → joined / peer-joined，signal 定向中转，mute 广播，leave → peer-left', async () => {
    const room = voiceRepo.createRoom(aliceId, '测试房', '', { creatorName: 'alice' });

    const alice = await connect(aliceToken);
    send(alice, { type: 'join', roomId: room.id });
    const joined1 = await waitFor(alice, (m) => m.type === 'joined');
    expect(joined1.participants).toEqual([]);

    const bob = await connect(bobToken);
    const bobJoinedP = waitFor(bob, (m) => m.type === 'joined');
    const alicePeerJoinedP = waitFor(alice, (m) => m.type === 'peer-joined');
    send(bob, { type: 'join', roomId: room.id });
    const bobJoined = await bobJoinedP;
    expect(bobJoined.participants).toHaveLength(1);
    expect(bobJoined.participants[0].username).toBe('alice');
    const peerJoined = await alicePeerJoinedP;
    expect(peerJoined.participant.username).toBe('bob');

    // offer/answer/candidate 统一走 signal 定向转发
    const bobSignalP = waitFor(bob, (m) => m.type === 'signal');
    send(alice, { type: 'signal', to: bobId, data: { sdp: 'fake-offer' } });
    const signal = await bobSignalP;
    expect(signal.from).toBe(aliceId);
    expect(signal.data).toEqual({ sdp: 'fake-offer' });

    // 静音状态广播
    const aliceMuteP = waitFor(alice, (m) => m.type === 'mute-changed');
    send(bob, { type: 'mute', muted: true });
    const mute = await aliceMuteP;
    expect(mute).toMatchObject({ userId: bobId, muted: true });

    // 退出广播 peer-left
    const aliceLeftP = waitFor(alice, (m) => m.type === 'peer-left');
    send(bob, { type: 'leave' });
    const left = await aliceLeftP;
    expect(left.userId).toBe(bobId);
    expect(hub.getRoomCount(room.id)).toBe(1);

    // 清场
    send(alice, { type: 'leave' });
    await waitFor(alice, () => false, 100).catch(() => {});
  });

  it('加入不存在的房间被拒绝', async () => {
    const ws = await connect(aliceToken);
    send(ws, { type: 'join', roomId: 99999 });
    const err = await waitFor(ws, (m) => m.type === 'error');
    expect(err.message).toContain('房间不存在');
  });

  it('无效 token 连接被拒绝（error 消息 + 4001 关闭）', async () => {
    const ws = await connect('bad-token');
    const err = await waitFor(ws, (m) => m.type === 'error');
    expect(err.message).toBeTruthy();
    const closed = new Promise<number | undefined>((resolve) => ws.on('close', (code) => resolve(code)));
    expect(await closed).toBe(4001);
  });

  it('同账号重复连接顶替旧连接', async () => {
    const room = voiceRepo.createRoom(aliceId, '顶替房', '', { creatorName: 'alice' });
    const first = await connect(aliceToken);
    send(first, { type: 'join', roomId: room.id });
    await waitFor(first, (m) => m.type === 'joined');

    const firstKickedP = waitFor(first, (m) => m.type === 'error');
    const second = await connect(aliceToken);
    const kicked = await firstKickedP;
    expect(kicked.message).toContain('其他地方');

    // 新连接仍可正常加入
    send(second, { type: 'join', roomId: room.id });
    await waitFor(second, (m) => m.type === 'joined');
    expect(hub.getRoomCount(room.id)).toBe(1);
    send(second, { type: 'leave' });
  });

  it(`房间满（${VOICE_MAX_ROOM_SIZE}人）后拒绝新加入`, async () => {
    const room = voiceRepo.createRoom(aliceId, '满员房', '', { creatorName: 'alice' });
    const tokens = [aliceToken, bobToken, carolToken];
    const fill = VOICE_MAX_ROOM_SIZE - tokens.length;
    // 补足人数的临时用户
    for (let i = 0; i < fill; i++) {
      const info = db
        .prepare("INSERT INTO users (username, email, password_hash) VALUES (?, ?, 'x')")
        .run(`filler${i}`, `filler${i}@test.com`);
      tokens.push(generateToken({ id: Number(info.lastInsertRowid), username: `filler${i}` }));
    }

    for (const token of tokens) {
      const ws = await connect(token);
      send(ws, { type: 'join', roomId: room.id });
      await waitFor(ws, (m) => m.type === 'joined');
    }
    expect(hub.getRoomCount(room.id)).toBe(VOICE_MAX_ROOM_SIZE);

    // 第 11 人（新用户）被拒绝
    const info = db
      .prepare("INSERT INTO users (username, email, password_hash) VALUES (?, ?, 'x')")
      .run('dave', 'dave@test.com');
    const dave = await connect(generateToken({ id: Number(info.lastInsertRowid), username: 'dave' }));
    send(dave, { type: 'join', roomId: room.id });
    const err = await waitFor(dave, (m) => m.type === 'error');
    expect(err.message).toContain('房间已满');

    // 清场：直接关闭所有连接，等 hub 收敛
    for (const ws of clients) ws.close();
    await new Promise((r) => setTimeout(r, 200));
    expect(hub.getRoomCount(room.id)).toBe(0);
  });
});
