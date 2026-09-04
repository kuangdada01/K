/**
 * ============================================================
 * 语音房间文字聊天测试
 * ============================================================
 * 覆盖:
 * - WS chat 协议: 成员收发广播（含发送者本人）、消息入库；
 *   非成员/空内容/超长/纯控制字符拒绝；400ms 防刷屏节流；控制字符剔除
 * - 访客聊天: 无 token 连接以负数 id 入房发送，服务端回传真实身份
 * - REST 历史: GET /rooms/:id/messages 首屏最近 N 条 + before_id 向上翻页
 *   + after_id 增量追拉 + limit 截断/上限 + has_more；房间不存在 404
 * - REST 清空: DELETE /rooms/:id/messages —— 房主/访客房主/管理员成功并
 *   向在线成员广播 chat-cleared；他人 403；无效 token 401（不作访客处理）
 * - 房主判定: isCreator 按访问者计算（登录=creator_id，访客=IP 锚点），
 *   任何响应不泄露 creator_ip；删除房间级联删除聊天记录
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import Database from 'better-sqlite3';
import { WebSocket } from 'ws';
import { createSchema } from '../src/db/schema';
import { setDbForTests, resetDbForTests } from '../src/db/connection';
import { createApp } from '../src/app';
import { attachVoiceWs } from '../src/voice/ws';
import * as voiceRepo from '../src/repositories/voice.repo';
import * as voiceChatRepo from '../src/repositories/voice-chat.repo';
import { generateToken } from '../src/middleware/auth';

let db: InstanceType<typeof Database>;
let server: http.Server;
let base = '';
let aliceId = 0;
let aliceToken = '';
let bobId = 0;
let bobToken = '';
let adminId = 0;
let adminToken = '';
const clients: WebSocket[] = [];

beforeAll(async () => {
  db = new Database(':memory:');
  // 注意：与生产一致不开启 foreign_keys（voice_rooms.creator_id 允许负数=访客，
  // 房间删除时聊天记录由 deleteRoom 手动级联清理）
  createSchema(db);
  setDbForTests(db);

  const insertUser = db.prepare(
    "INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, 'x', ?)"
  );
  aliceId = Number(insertUser.run('alice', 'alice@test.com', 'user').lastInsertRowid);
  bobId = Number(insertUser.run('bob', 'bob@test.com', 'user').lastInsertRowid);
  adminId = Number(insertUser.run('admin', 'admin@test.com', 'admin').lastInsertRowid);
  aliceToken = generateToken({ id: aliceId, username: 'alice' });
  bobToken = generateToken({ id: bobId, username: 'bob' });
  adminToken = generateToken({ id: adminId, username: 'admin' });

  // 与生产一致：同一 HTTP 服务器上挂 Express + 语音 WS
  const app = createApp();
  server = http.createServer(app);
  attachVoiceWs(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  for (const ws of clients) ws.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  resetDbForTests();
  db.close();
});

/** REST 请求辅助（token 可选：无 token = 访客） */
async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = {};
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  return { status: res.status, data };
}

/** 建一条 WS 连接（token 缺省 = 访客连接） */
function connect(token?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const url = token
      ? `ws://127.0.0.1:${server.address()!.port}/api/voice/ws?token=${token}`
      : `ws://127.0.0.1:${server.address()!.port}/api/voice/ws`;
    const ws = new WebSocket(url);
    (ws as any).__msgs = [];
    ws.on('message', (raw) => {
      try { (ws as any).__msgs.push(JSON.parse(String(raw))); } catch { /* 忽略非 JSON */ }
    });
    ws.on('open', () => { clients.push(ws); resolve(ws); });
    ws.on('error', reject);
  });
}

/** 等待下一条满足条件的服务端消息（从缓冲区消费，兼顾已到达的消息） */
function waitFor(ws: WebSocket, predicate: (msg: any) => boolean, timeoutMs = 3000): Promise<any> {
  const msgs: any[] = (ws as any).__msgs ?? [];
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); ws.off('message', check); };
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

/** 某房间的消息条数（DB 直查） */
function countMessages(roomId: number): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM voice_room_messages WHERE room_id = ?').get(roomId) as { c: number };
  return row.c;
}

describe('WS 文字聊天协议', () => {
  it('成员发送 chat: 广播全房间（含发送者本人）+ 服务端权威 id/时间 + 入库', async () => {
    const room = voiceRepo.createRoom(aliceId, '聊天测试房', '', { creatorName: 'alice' });
    const alice = await connect(aliceToken);
    send(alice, { type: 'join', roomId: room.id });
    await waitFor(alice, (m) => m.type === 'joined');

    const bob = await connect(bobToken);
    const bobChatP = waitFor(bob, (m) => m.type === 'chat');
    const aliceChatP = waitFor(alice, (m) => m.type === 'chat');
    send(bob, { type: 'join', roomId: room.id });
    await waitFor(bob, (m) => m.type === 'joined');

    send(bob, { type: 'chat', content: '  大家好，这里是文字聊天  ' });
    const msgToAlice = await aliceChatP;
    const msgToBob = await bobChatP;
    expect(msgToAlice.message).toMatchObject({
      room_id: room.id,
      sender_id: bobId,
      username: 'bob',
      avatar: null,
      content: '大家好，这里是文字聊天',
    });
    expect(msgToAlice.message.id).toBeGreaterThan(0);
    expect(typeof msgToAlice.message.created_at).toBe('string');
    // 同一消息广播给全房间（发送者本人也收到，客户端按 id 去重回显）
    expect(msgToBob.message.id).toBe(msgToAlice.message.id);

    // 已入库，REST 可拉取
    const hist = await api('GET', `/api/voice/rooms/${room.id}/messages`);
    expect(hist.status).toBe(200);
    expect(hist.data.messages).toHaveLength(1);
    expect(hist.data.messages[0].content).toBe('大家好，这里是文字聊天');

    send(alice, { type: 'leave' });
    send(bob, { type: 'leave' });
  });

  it('校验: 非成员静默拒绝；空/超长/纯控制字符不入库；控制字符被剔除', async () => {
    const room = voiceRepo.createRoom(aliceId, '校验房', '', { creatorName: 'alice' });
    const alice = await connect(aliceToken);
    send(alice, { type: 'join', roomId: room.id });
    await waitFor(alice, (m) => m.type === 'joined');

    // 未 join 的连接发消息：静默忽略（无广播、无入库）
    const outsider = await connect(bobToken);
    send(outsider, { type: 'chat', content: '我不在房间' });
    await waitFor(outsider, (m) => m.type === 'chat', 250).catch(() => {});

    // 空内容 / 纯空白 / 501 字超长 / 纯控制字符：全部丢弃
    send(alice, { type: 'chat', content: '   ' });
    send(alice, { type: 'chat', content: 'x'.repeat(501) });
    send(alice, { type: 'chat', content: '\u0001\u0002' });
    await waitFor(alice, (m) => m.type === 'chat', 300).catch(() => {});
    expect(countMessages(room.id)).toBe(0);

    // 控制字符剔除后入库（保留 \n）："\u0001你好\n世界\u0002" → "你好\n世界"
    // 注：纯控制字符消息已触发节流时间戳，先等窗口过去
    await new Promise((r) => setTimeout(r, 500));
    send(alice, { type: 'chat', content: '\u0001你好\n世界\u0002' });
    const got = await waitFor(alice, (m) => m.type === 'chat');
    expect(got.message.content).toBe('你好\n世界');

    send(alice, { type: 'leave' });
    send(outsider, { type: 'leave' });
  });

  it('节流: 同一连接 400ms 内第二条被丢弃', async () => {
    const room = voiceRepo.createRoom(aliceId, '节流房', '', { creatorName: 'alice' });
    const alice = await connect(aliceToken);
    send(alice, { type: 'join', roomId: room.id });
    await waitFor(alice, (m) => m.type === 'joined');

    send(alice, { type: 'chat', content: '第一条' });
    await waitFor(alice, (m) => m.type === 'chat');
    send(alice, { type: 'chat', content: '第二条（应被丢弃）' });
    await waitFor(alice, (m) => m.type === 'chat', 200).catch(() => {});
    expect(countMessages(room.id)).toBe(1);

    // 节流窗口过后可再发
    await new Promise((r) => setTimeout(r, 500));
    send(alice, { type: 'chat', content: '第三条（窗口后）' });
    const got = await waitFor(alice, (m) => m.type === 'chat');
    expect(got.message.content).toBe('第三条（窗口后）');

    send(alice, { type: 'leave' });
  });

  it('访客（无 token）可进房发消息，以负数 id 入库并回传身份', async () => {
    const room = voiceRepo.createRoom(aliceId, '访客房', '', { creatorName: 'alice' });
    const alice = await connect(aliceToken);
    send(alice, { type: 'join', roomId: room.id });
    await waitFor(alice, (m) => m.type === 'joined');

    const guest = await connect();
    const aliceChatP = waitFor(alice, (m) => m.type === 'chat');
    const guestChatP = waitFor(guest, (m) => m.type === 'chat');
    send(guest, { type: 'join', roomId: room.id });
    const joined = await waitFor(guest, (m) => m.type === 'joined');
    const guestUserId = joined.self.userId as number;
    expect(guestUserId).toBeLessThan(0);

    send(guest, { type: 'chat', content: '访客的问候' });
    const msg = await aliceChatP;
    await guestChatP;
    expect(msg.message.sender_id).toBe(guestUserId);
    expect(msg.message.username).toBe(`未登录-${-guestUserId}`);

    send(alice, { type: 'leave' });
    send(guest, { type: 'leave' });
  });
});

describe('REST 聊天历史与清空权限', () => {
  it('访客可创建房间；列表 isCreator 按访问者计算且不泄露 creator_ip', async () => {
    const created = await api('POST', '/api/voice/rooms', { body: { name: '访客房主房', description: '测试' } });
    expect(created.status).toBe(201);
    const roomId = created.data.room.id;
    expect(JSON.stringify(created)).not.toContain('creator_ip');

    // 访客视角（同一 IP）：isCreator = true
    const guestList = await api('GET', '/api/voice/rooms');
    const gRoom = guestList.data.rooms.find((r: any) => r.id === roomId);
    expect(gRoom.isCreator).toBe(true);
    expect(gRoom.creator_ip).toBeUndefined();

    // 登录用户视角：isCreator = false
    const aliceList = await api('GET', '/api/voice/rooms', { token: aliceToken });
    const aRoom = aliceList.data.rooms.find((r: any) => r.id === roomId);
    expect(aRoom.isCreator).toBe(false);

    // 登录用户创建的房间：本人 true、访客 false
    const created2 = await api('POST', '/api/voice/rooms', { token: aliceToken, body: { name: '艾丽丝房' } });
    const aliceView = (await api('GET', '/api/voice/rooms', { token: aliceToken }))
      .data.rooms.find((r: any) => r.id === created2.data.room.id);
    expect(aliceView.isCreator).toBe(true);
    const guestView = (await api('GET', '/api/voice/rooms'))
      .data.rooms.find((r: any) => r.id === created2.data.room.id);
    expect(guestView.isCreator).toBe(false);
  });

  it('历史分页: 首屏最近 N 条 + has_more；before_id 翻旧；after_id 追新；limit 收口', async () => {
    const room = voiceRepo.createRoom(aliceId, '分页房', '', { creatorName: 'alice' });
    // 直接入库 8 条（跳过 WS，集中测分页）
    for (let i = 0; i < 8; i++) {
      voiceChatRepo.insertVoiceChatMessage({
        roomId: room.id, senderId: aliceId, username: 'alice', avatar: null, content: `消息${i + 1}`,
      });
    }

    // 首屏默认 50 → 全部 8 条，按时间正序
    const all = await api('GET', `/api/voice/rooms/${room.id}/messages`);
    expect(all.status).toBe(200);
    expect(all.data.messages).toHaveLength(8);
    expect(all.data.has_more).toBe(false);
    expect(all.data.messages[0].content).toBe('消息1');
    expect(all.data.messages[7].content).toBe('消息8');

    // limit=3 → 最近 3 条 + has_more=true
    const page = await api('GET', `/api/voice/rooms/${room.id}/messages?limit=3`);
    expect(page.data.messages.map((m: any) => m.content)).toEqual(['消息6', '消息7', '消息8']);
    expect(page.data.has_more).toBe(true);

    // before_id=消息6 → 更早 3 条
    const six = page.data.messages[0];
    const older = await api('GET', `/api/voice/rooms/${room.id}/messages?before_id=${six.id}&limit=3`);
    expect(older.data.messages.map((m: any) => m.content)).toEqual(['消息3', '消息4', '消息5']);
    expect(older.data.has_more).toBe(true);

    // 翻到最早一页后 has_more=false
    const oldest = await api('GET', `/api/voice/rooms/${room.id}/messages?before_id=${older.data.messages[0].id}&limit=3`);
    expect(oldest.data.messages.map((m: any) => m.content)).toEqual(['消息1', '消息2']);
    expect(oldest.data.has_more).toBe(false);

    // after_id=消息2 → 之后的全部
    const late = await api('GET', `/api/voice/rooms/${room.id}/messages?after_id=${oldest.data.messages[1].id}`);
    expect(late.data.messages.map((m: any) => m.content)).toEqual(['消息3', '消息4', '消息5', '消息6', '消息7', '消息8']);

    // limit 非法 → 回落 50；超上限 → 收口 100
    const badLimit = await api('GET', `/api/voice/rooms/${room.id}/messages?limit=abc`);
    expect(badLimit.status).toBe(200);
    expect(badLimit.data.messages).toHaveLength(8);
    const hugeLimit = await api('GET', `/api/voice/rooms/${room.id}/messages?limit=9999`);
    expect(hugeLimit.data.messages).toHaveLength(8);
  });

  it('消息端点: 房间不存在 404', async () => {
    const hist = await api('GET', '/api/voice/rooms/99999/messages');
    expect(hist.status).toBe(404);
    expect(hist.data.error).toBe('房间不存在');
    const del = await api('DELETE', '/api/voice/rooms/99999/messages', { token: aliceToken });
    expect(del.status).toBe(404);
  });

  it('清空聊天: 房主/管理员成功并广播 chat-cleared；非房主 403；无效 token 401', async () => {
    const room = voiceRepo.createRoom(aliceId, '清空房', '', { creatorName: 'alice' });
    voiceChatRepo.insertVoiceChatMessage({
      roomId: room.id, senderId: aliceId, username: 'alice', avatar: null, content: '旧消息',
    });

    // 普通用户（非房主）→ 403
    const denied = await api('DELETE', `/api/voice/rooms/${room.id}/messages`, { token: bobToken });
    expect(denied.status).toBe(403);
    expect(countMessages(room.id)).toBe(1);

    // 在线成员在清空时收到 chat-cleared 广播
    const alice = await connect(aliceToken);
    send(alice, { type: 'join', roomId: room.id });
    await waitFor(alice, (m) => m.type === 'joined');
    const clearedP = waitFor(alice, (m) => m.type === 'chat-cleared');
    const ok = await api('DELETE', `/api/voice/rooms/${room.id}/messages`, { token: aliceToken });
    expect(ok.status).toBe(200);
    expect(ok.data.success).toBe(true);
    await clearedP;
    expect(countMessages(room.id)).toBe(0);
    const hist = await api('GET', `/api/voice/rooms/${room.id}/messages`);
    expect(hist.data.messages).toHaveLength(0);
    send(alice, { type: 'leave' });

    // 管理员也可清
    voiceChatRepo.insertVoiceChatMessage({
      roomId: room.id, senderId: aliceId, username: 'alice', avatar: null, content: '又一条',
    });
    const byAdmin = await api('DELETE', `/api/voice/rooms/${room.id}/messages`, { token: adminToken });
    expect(byAdmin.status).toBe(200);
    expect(countMessages(room.id)).toBe(0);

    // 无效 token 的写请求按 401 拒绝（不作访客处理）
    const badToken = await api('DELETE', `/api/voice/rooms/${room.id}/messages`, { token: 'bad-token' });
    expect(badToken.status).toBe(401);
  });

  it('访客房主按 IP 锚点可清空；其他归属的访客 403', async () => {
    // 模拟"别的 IP"创建的访客房（测试环境所有请求都来自 127.0.0.1）
    const foreign = voiceRepo.createRoom(-999, '他人访客房', '', {
      creatorName: '未登录-999', creatorIp: '203.0.113.9',
    });
    const denied = await api('DELETE', `/api/voice/rooms/${foreign.id}/messages`);
    expect(denied.status).toBe(403);
    expect(denied.data.error).toContain('只有房间创建者或管理员');

    // 本机 IP 归属的访客房主可清空
    const mine = await api('POST', '/api/voice/rooms', { body: { name: '本机访客房' } });
    const roomId = mine.data.room.id;
    const ok = await api('DELETE', `/api/voice/rooms/${roomId}/messages`);
    expect(ok.status).toBe(200);
    expect(ok.data.success).toBe(true);
  });

  it('删除房间级联删除其聊天记录', async () => {
    const room = voiceRepo.createRoom(aliceId, '级联房', '', { creatorName: 'alice' });
    voiceChatRepo.insertVoiceChatMessage({
      roomId: room.id, senderId: aliceId, username: 'alice', avatar: null, content: '随房销毁',
    });
    const del = await api('DELETE', `/api/voice/rooms/${room.id}`, { token: aliceToken });
    expect(del.status).toBe(200);
    expect(countMessages(room.id)).toBe(0);
    const hist = await api('GET', `/api/voice/rooms/${room.id}/messages`);
    expect(hist.status).toBe(404);
  });
});