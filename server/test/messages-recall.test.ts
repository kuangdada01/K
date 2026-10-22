/**
 * ============================================================
 * 私信撤回「留痕」契约（2026-10-22）
 * ============================================================
 * 背景：撤回以前是 DELETE 行 —— 重进会话看不到、对方那边也没有任何痕迹。
 * 用户要求「撤回重新进消息对话不显示，对方撤回两边都应该知道」，即 QQ/微信的行为。
 *
 * 现在撤回 = 保留行 + 写 recalled_at + 清空内容/媒体（文件仍删）。
 * 本测试锁住对外契约：
 *  1. 双方历史里都能查到这条，带 recalled_at，正文/媒体为 null；
 *  2. 会话列表最后一条显示「你/对方 撤回了一条消息」；
 *  3. 引用已撤回消息的历史展示被屏蔽成「[消息已撤回]」，且不能新引用它；
 *  4. 重复撤回幂等、非发送者 403、撤回后不再算未读。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { createMemoryDb } from './helpers/memdb';
import { setDbForTests, resetDbForTests } from '../src/db/connection';
import { createApp } from '../src/app';
import { generateToken } from '../src/middleware/auth';
import { PATHS } from '../src/config';

let db: InstanceType<typeof Database>;
let server: http.Server;
let base = '';
let userA = 0;
let userB = 0;
let userC = 0;
let tokenA = '';
let tokenB = '';
let tokenC = '';

const uniq = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

type MsgJson = {
  id: number;
  content: string;
  image_url: string | null;
  audio_url: string | null;
  recalled_at: string | null;
  quoted_message_id: number | null;
  quoted_content: string | null;
  quoted_image_url: string | null;
};

beforeAll(async () => {
  db = createMemoryDb();
  setDbForTests(db);

  const insertUser = db.prepare("INSERT INTO users (username, email, password_hash) VALUES (?, ?, 'x')");
  userA = Number(insertUser.run(`recall-a-${uniq}`, `recall-a-${uniq}@test.com`).lastInsertRowid);
  userB = Number(insertUser.run(`recall-b-${uniq}`, `recall-b-${uniq}@test.com`).lastInsertRowid);
  userC = Number(insertUser.run(`recall-c-${uniq}`, `recall-c-${uniq}@test.com`).lastInsertRowid);

  tokenA = generateToken({ id: userA, username: `recall-a-${uniq}` });
  tokenB = generateToken({ id: userB, username: `recall-b-${uniq}` });
  tokenC = generateToken({ id: userC, username: `recall-c-${uniq}` });

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

function insertMessage(opts: {
  senderId: number;
  receiverId: number;
  content: string;
  imageUrl?: string | null;
  quotedMessageId?: number | null;
}): number {
  const r = db
    .prepare(
      'INSERT INTO messages (sender_id, receiver_id, content, image_url, quoted_message_id) VALUES (?, ?, ?, ?, ?)'
    )
    .run(opts.senderId, opts.receiverId, opts.content, opts.imageUrl ?? null, opts.quotedMessageId ?? null);
  return Number(r.lastInsertRowid);
}

async function recall(token: string, id: number): Promise<Response> {
  return fetch(`${base}/api/messages/single/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function history(token: string, otherId: number): Promise<MsgJson[]> {
  const res = await fetch(`${base}/api/messages/${otherId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { messages: MsgJson[] };
  return data.messages;
}

async function conversations(
  token: string
): Promise<{ partner_id: number; last_message: string; unread_count: number }[]> {
  const res = await fetch(`${base}/api/messages/conversations`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as {
    conversations: { partner_id: number; last_message: string; unread_count: number }[];
  };
  return data.conversations;
}

describe('撤回留痕', () => {
  it('撤回后双方历史里都能看到这条（recalled_at），正文/图片清空、文件删除', async () => {
    fs.mkdirSync(PATHS.uploadsPrivate, { recursive: true });
    const file = `recall-${uniq}-1.jpg`;
    fs.writeFileSync(path.join(PATHS.uploadsPrivate, file), 'x');

    const id = insertMessage({
      senderId: userA,
      receiverId: userB,
      content: '这句会被撤回',
      imageUrl: file,
    });

    const res = await recall(tokenA, id);
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(PATHS.uploadsPrivate, file))).toBe(false);

    for (const [token, other] of [
      [tokenA, userB],
      [tokenB, userA],
    ] as const) {
      const list = await history(token, other);
      const row = list.find((m) => m.id === id);
      expect(row).toBeTruthy();
      expect(row!.recalled_at).toBeTruthy();
      expect(row!.content).toBe('');
      expect(row!.image_url).toBeNull();
      expect(row!.audio_url).toBeNull();
    }
  });

  it('会话列表最后一条：自己看是「你撤回了一条消息」，对方看是「对方撤回了一条消息」', async () => {
    const id = insertMessage({ senderId: userA, receiverId: userC, content: '最后一条' });
    expect((await recall(tokenA, id)).status).toBe(200);

    const mine = (await conversations(tokenA)).find((c) => c.partner_id === userC);
    const theirs = (await conversations(tokenC)).find((c) => c.partner_id === userA);
    expect(mine?.last_message).toBe('你撤回了一条消息');
    expect(theirs?.last_message).toBe('对方撤回了一条消息');
  });

  it('撤回后的消息不再算未读（角标不为一句话的撤回计数）', async () => {
    const id = insertMessage({ senderId: userA, receiverId: userB, content: '未读会被撤回' });
    const before = (await conversations(tokenB)).find((c) => c.partner_id === userA);
    expect(before!.unread_count).toBeGreaterThan(0);

    expect((await recall(tokenA, id)).status).toBe(200);

    const after = (await conversations(tokenB)).find((c) => c.partner_id === userA);
    expect(after!.unread_count).toBe(0);
  });

  it('引用已撤回的消息：历史里屏蔽成「[消息已撤回]」，且不能新引用它', async () => {
    const original = insertMessage({
      senderId: userA,
      receiverId: userB,
      content: '被引用的原文',
      imageUrl: null,
    });
    const quoting = insertMessage({
      senderId: userB,
      receiverId: userA,
      content: '我引用你',
      quotedMessageId: original,
    });

    expect((await recall(tokenA, original)).status).toBe(200);

    const list = await history(tokenA, userB);
    const quotedRow = list.find((m) => m.id === quoting);
    expect(quotedRow?.quoted_content).toBe('[消息已撤回]');
    expect(quotedRow?.quoted_image_url).toBeNull();

    // 新消息再引用它：服务端校验会丢弃 quotedMessageId（不能引用已撤回的）
    const send = await fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenB}` },
      body: JSON.stringify({ receiverId: userA, content: '还想引用', quotedMessageId: original }),
    });
    expect(send.status).toBe(201);
    const sent = (await send.json()) as MsgJson;
    expect(sent.quoted_message_id).toBeNull();
  });

  it('重复撤回幂等；非发送者撤回 403', async () => {
    const id = insertMessage({ senderId: userA, receiverId: userB, content: '撤两次' });
    expect((await recall(tokenA, id)).status).toBe(200);
    expect((await recall(tokenA, id)).status).toBe(200);

    const other = insertMessage({ senderId: userA, receiverId: userB, content: '别人不能撤' });
    const res = await recall(tokenB, other);
    expect(res.status).toBe(403);
    const list = await history(tokenA, userB);
    expect(list.find((m) => m.id === other)?.recalled_at).toBeNull();
  });
});
