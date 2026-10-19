/**
 * ============================================================
 * 私信语音消息（2026-10-19）
 * ============================================================
 * 覆盖服务端对外契约：
 *  1. multipart `audio` + `durationMs` + `waveform` → 201，返回鉴权媒体地址、
 *     时长与**数组形式**的波形（库里是 JSON 字符串）；
 *  2. 时长过短 / 图片与语音同时上传 → 400，且已落盘文件被清理；
 *  3. `/media` 对语音返回 audio/mp4 且支持 Range（拖动进度依赖）；
 *  4. 撤回 / 清空会话会删除语音文件；
 *  5. 会话列表预览显示 `[语音]`；
 *  6. 转写：已缓存直接返回（不调上游）、非语音 404、非参与者 403。
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

/** 语音字节内容（不要求真能被解码：这里验证的是上传/下发/清理契约） */
const AUDIO_BYTES = Buffer.from('fake-m4a-audio-bytes-for-contract-test');

function countsInPrivateDir(prefix: string): number {
  if (!fs.existsSync(PATHS.uploadsPrivate)) return 0;
  return fs.readdirSync(PATHS.uploadsPrivate).filter((n) => n.startsWith(prefix)).length;
}

beforeAll(async () => {
  db = createMemoryDb();
  setDbForTests(db);

  const insertUser = db.prepare("INSERT INTO users (username, email, password_hash) VALUES (?, ?, 'x')");
  userA = Number(insertUser.run(`voice-a-${uniq}`, `voice-a-${uniq}@test.com`).lastInsertRowid);
  userB = Number(insertUser.run(`voice-b-${uniq}`, `voice-b-${uniq}@test.com`).lastInsertRowid);
  userC = Number(insertUser.run(`voice-c-${uniq}`, `voice-c-${uniq}@test.com`).lastInsertRowid);

  tokenA = generateToken({ id: userA, username: `voice-a-${uniq}` });
  tokenB = generateToken({ id: userB, username: `voice-b-${uniq}` });
  tokenC = generateToken({ id: userC, username: `voice-c-${uniq}` });

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

/** 发一条语音消息，返回响应 JSON */
async function sendVoice(opts: {
  token: string;
  receiverId: number;
  durationMs: number;
  waveform?: number[];
  filename?: string;
  extraImage?: boolean;
}): Promise<Response> {
  const form = new FormData();
  form.append('receiverId', String(opts.receiverId));
  form.append('durationMs', String(opts.durationMs));
  form.append('waveform', JSON.stringify(opts.waveform ?? [12, 40, 90, 30]));
  form.append(
    'audio',
    new Blob([AUDIO_BYTES], { type: 'audio/mp4' }),
    opts.filename ?? `voice-${uniq}-${Date.now()}.m4a`
  );
  if (opts.extraImage) {
    form.append(
      'image',
      new Blob([Buffer.from('fake-image')], { type: 'image/jpeg' }),
      `voice-extra-${uniq}-${Date.now()}.jpg`
    );
  }
  return fetch(`${base}/api/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.token}` },
    body: form,
  });
}

describe('私信语音消息', () => {
  it('发送成功：返回媒体地址、时长与数组波形，content 为空', async () => {
    const res = await sendVoice({ token: tokenA, receiverId: userB, durationMs: 3210 });
    expect(res.status).toBe(201);

    const json = (await res.json()) as {
      id: number;
      content: string;
      audio_url: string | null;
      audio_duration_ms: number;
      audio_waveform: number[];
      image_url: string | null;
    };
    expect(json.content).toBe('');
    expect(json.image_url).toBeNull();
    expect(json.audio_url).toBe(`/api/messages/${json.id}/media`);
    expect(json.audio_duration_ms).toBe(3210);
    // 服务端会把波形洗净成 0–100 的整数数组
    expect(json.audio_waveform).toEqual([12, 40, 90, 30]);
  });

  it('时长不足 1 秒 → 400，且上传文件被清理', async () => {
    const before = countsInPrivateDir('msg_');
    const res = await sendVoice({ token: tokenA, receiverId: userB, durationMs: 500 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('语音太短');
    // 不新增孤儿文件（并发测试下只断言"没有变多"）
    expect(countsInPrivateDir('msg_')).toBeLessThanOrEqual(before);
  });

  it('图片与语音同时上传 → 400', async () => {
    const res = await sendVoice({
      token: tokenA,
      receiverId: userB,
      durationMs: 2000,
      extraImage: true,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('只能带图片或语音');
  });

  it('媒体下发：audio/mp4 + Range 206', async () => {
    const send = await sendVoice({ token: tokenA, receiverId: userB, durationMs: 2000 });
    const msg = (await send.json()) as { id: number; audio_url: string };

    const full = await fetch(`${base}${msg.audio_url}`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(full.status).toBe(200);
    expect(full.headers.get('content-type')).toContain('audio/mp4');
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.from(await full.arrayBuffer())).toEqual(AUDIO_BYTES);

    const ranged = await fetch(`${base}${msg.audio_url}`, {
      headers: { Authorization: `Bearer ${tokenB}`, Range: 'bytes=0-3' },
    });
    expect(ranged.status).toBe(206);
    expect(Buffer.from(await ranged.arrayBuffer()).toString()).toBe('fake');
  });

  it('会话列表预览显示 [语音]', async () => {
    // 确保最后一条是语音（上面几条都是 A→B）
    await sendVoice({ token: tokenA, receiverId: userB, durationMs: 1500 });
    const res = await fetch(`${base}/api/messages/conversations`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      conversations: { partner_id: number; last_message: string }[];
    };
    const conv = data.conversations.find((c) => c.partner_id === userA);
    expect(conv?.last_message).toBe('[语音]');
  });

  it('撤回会删除语音文件', async () => {
    const send = await sendVoice({
      token: tokenA,
      receiverId: userB,
      durationMs: 2000,
      filename: `voice-recall-${uniq}.m4a`,
    });
    const msg = (await send.json()) as { id: number };
    const filePath = path.join(PATHS.uploadsPrivate, `voice-recall-${uniq}.m4a`);
    // 说明：服务端按 multer 生成的 msg_ 文件名落盘，这里从 DB 取真实文件名
    const row = db.prepare('SELECT audio_url FROM messages WHERE id = ?').get(msg.id) as {
      audio_url: string;
    };
    const actual = path.join(PATHS.uploadsPrivate, row.audio_url);
    expect(fs.existsSync(actual)).toBe(true);

    const res = await fetch(`${base}/api/messages/single/${msg.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(res.status).toBe(200);
    expect(fs.existsSync(actual)).toBe(false);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath); // 原始上传名不存在，双保险
  });

  it('清空会话会删除语音文件', async () => {
    const send = await sendVoice({ token: tokenA, receiverId: userC, durationMs: 2000 });
    const msg = (await send.json()) as { id: number };
    const row = db.prepare('SELECT audio_url FROM messages WHERE id = ?').get(msg.id) as {
      audio_url: string;
    };
    const actual = path.join(PATHS.uploadsPrivate, row.audio_url);
    expect(fs.existsSync(actual)).toBe(true);

    const res = await fetch(`${base}/api/messages/${userC}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(res.status).toBe(200);
    expect(fs.existsSync(actual)).toBe(false);
  });

  it('转写：缓存命中直接返回，非语音 404，非参与者 403', async () => {
    // 1) 缓存命中
    const send = await sendVoice({ token: tokenA, receiverId: userB, durationMs: 2000 });
    const msg = (await send.json()) as { id: number };
    db.prepare("UPDATE messages SET audio_text = '你好呀' WHERE id = ?").run(msg.id);

    const cached = await fetch(`${base}/api/messages/${msg.id}/transcribe`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(cached.status).toBe(200);
    expect(((await cached.json()) as { text: string }).text).toBe('你好呀');

    // 2) 非语音消息
    const textMsg = db
      .prepare("INSERT INTO messages (sender_id, receiver_id, content) VALUES (?, ?, 'hi')")
      .run(userA, userB);
    const notVoice = await fetch(`${base}/api/messages/${textMsg.lastInsertRowid}/transcribe`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(notVoice.status).toBe(404);

    // 3) 非参与者
    const forbidden = await fetch(`${base}/api/messages/${msg.id}/transcribe`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenC}` },
    });
    expect(forbidden.status).toBe(403);
  });
});
