/**
 * ============================================================
 * 语音房间所有权测试（P2-25：IP 锚点 → 房间级令牌）
 * ============================================================
 * 修复前的行为：访客房间的所有权以**来源 IP** 为唯一锚点，于是
 * 1. 同一 NAT（同公网 IP）后的两个访客互相判定为「创建者」——**能删对方的房间**；
 * 2. 换个网络（切 WiFi / 重连拿到新 IP）就丢掉自己的房间。
 *
 * 现在：访客建房时签发**房间级令牌**（只在创建响应里回一次），删除/清聊天需带上。
 * 存量访客房间（026 迁移前、owner_token 为 NULL）回退 IP 判定，保证不倒退。
 *
 * 本文件全程用**同一个来源 IP**（测试进程都是 127.0.0.1）—— 这正是复现旧缺陷的条件。
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import Database from 'better-sqlite3';
import { createMemoryDb } from './helpers/memdb';
import { setDbForTests, resetDbForTests } from '../src/db/connection';
import * as voiceRepo from '../src/repositories/voice.repo';
import { generateToken } from '../src/middleware/auth';
import { createApp } from '../src/app';

let db: InstanceType<typeof Database>;
let server: http.Server;
let base = '';
let aliceId = 0;
let bobId = 0;
let aliceToken = '';
let bobToken = '';

interface ApiRes {
  status: number;
  data: Record<string, unknown>;
}

async function api(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<ApiRes> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...extraHeaders,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** 访客建房（不带 Authorization），返回房间与所有权令牌 */
async function createGuestRoom(name: string) {
  const res = await api('POST', '/api/voice/rooms', undefined, { name, description: '' });
  expect(res.status).toBe(201);
  const room = res.data.room as { id: number; name: string };
  return { room, ownerToken: res.data.ownerToken as string | undefined };
}

beforeAll(async () => {
  db = createMemoryDb();
  setDbForTests(db);
  const insert = db.prepare("INSERT INTO users (username, email, password_hash) VALUES (?, ?, 'x')");
  aliceId = Number(insert.run('alice', 'alice@owner.test').lastInsertRowid);
  bobId = Number(insert.run('bob', 'bob@owner.test').lastInsertRowid);
  aliceToken = generateToken({ id: aliceId, username: 'alice' });
  bobToken = generateToken({ id: bobId, username: 'bob' });

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

beforeEach(() => {
  // 访客建房有「每 IP 5 间」的上限：清掉上一个用例留下的访客房间，
  // 否则后面的用例会拿到 429（是测试互相干扰，不是产品问题）
  db.prepare(
    'DELETE FROM voice_room_messages WHERE room_id IN (SELECT id FROM voice_rooms WHERE creator_id = 0)'
  ).run();
  db.prepare('DELETE FROM voice_rooms WHERE creator_id = 0').run();
});

describe('访客房间：令牌签发与不下发', () => {
  it('访客建房返回 ownerToken；房间 VO 里不含该字段', async () => {
    const { room, ownerToken } = await createGuestRoom('令牌房');
    expect(ownerToken).toMatch(/^[0-9a-f]{48}$/);
    expect(room as unknown as { owner_token?: string }).not.toHaveProperty('owner_token');
  });

  it('★ 房间列表不下发 owner_token，也不泄露 creator_ip', async () => {
    await createGuestRoom('列表房');
    const res = await api('GET', '/api/voice/rooms');
    expect(res.status).toBe(200);
    const rooms = res.data.rooms as Record<string, unknown>[];
    expect(rooms.length).toBeGreaterThan(0);
    for (const r of rooms) {
      expect(r).not.toHaveProperty('owner_token');
      expect(r).not.toHaveProperty('creator_ip');
    }
  });

  it('登录用户建房不签发令牌（按 creator_id 判定即可）', async () => {
    const res = await api('POST', '/api/voice/rooms', aliceToken, { name: '登录房', description: '' });
    expect(res.status).toBe(201);
    expect(res.data.ownerToken).toBeUndefined();
  });

  it('★ 带令牌的访客房间：服务端不再按 IP 声称 isCreator', async () => {
    await createGuestRoom('不声称房');
    const res = await api('GET', '/api/voice/rooms');
    const rooms = res.data.rooms as { id: number; isCreator: boolean }[];
    // 建房者本人（同 IP 的访客）看到的 isCreator 也应是 false ——
    // 客户端用本地保存的令牌自行判定，服务端不再给出可能误导的 IP 结论
    expect(rooms.length).toBeGreaterThan(0);
    expect(rooms.every((r) => r.isCreator === false)).toBe(true);
  });
});

describe('访客房间：删除需要令牌（同一 NAT 也不再互删）', () => {
  it('★ 同 IP 的另一访客不带令牌 → 403（旧实现下这里会 200，正是缺陷本身）', async () => {
    const { room } = await createGuestRoom('他人不可删');
    const res = await api('DELETE', `/api/voice/rooms/${room.id}`);
    expect(res.status).toBe(403);
    // 房间仍在
    expect(voiceRepo.getRoomById(room.id)).toBeDefined();
  });

  it('★ 带正确令牌 → 200 且房间真的被删', async () => {
    const { room, ownerToken } = await createGuestRoom('本人可删');
    const res = await api('DELETE', `/api/voice/rooms/${room.id}`, undefined, undefined, {
      'X-Voice-Owner-Token': ownerToken!,
    });
    expect(res.status).toBe(200);
    expect(voiceRepo.getRoomById(room.id)).toBeUndefined();
  });

  it('令牌错误 → 403（不会因为「长度对」或前缀相同而放行）', async () => {
    const { room, ownerToken } = await createGuestRoom('错令牌');
    const wrong = 'f'.repeat(ownerToken!.length);
    const res = await api('DELETE', `/api/voice/rooms/${room.id}`, undefined, undefined, {
      'X-Voice-Owner-Token': wrong,
    });
    expect(res.status).toBe(403);
    expect(voiceRepo.getRoomById(room.id)).toBeDefined();
  });

  it('登录用户删别人的房间 → 403；删自己的 → 200', async () => {
    const created = await api('POST', '/api/voice/rooms', aliceToken, { name: 'alice房', description: '' });
    const aliceRoomId = (created.data.room as { id: number }).id;

    expect((await api('DELETE', `/api/voice/rooms/${aliceRoomId}`, bobToken)).status).toBe(403);
    expect((await api('DELETE', `/api/voice/rooms/${aliceRoomId}`, aliceToken)).status).toBe(200);
  });
});

describe('清空聊天：与删除同一套所有权规则', () => {
  it('★ 不带令牌的访客清不掉别人的房间聊天；带令牌可以', async () => {
    const { room, ownerToken } = await createGuestRoom('聊天房');
    // 先塞一条消息，确认清空真的发生（列名是 sender_id，不是 user_id）
    db.prepare(
      'INSERT INTO voice_room_messages (room_id, sender_id, username, content) VALUES (?, ?, ?, ?)'
    ).run(room.id, -1, '未登录-1', 'hello');
    const count = () =>
      (
        db.prepare('SELECT COUNT(*) AS c FROM voice_room_messages WHERE room_id = ?').get(room.id) as {
          c: number;
        }
      ).c;
    expect(count()).toBe(1);

    expect((await api('DELETE', `/api/voice/rooms/${room.id}/messages`)).status).toBe(403);
    expect(count()).toBe(1);

    const ok = await api('DELETE', `/api/voice/rooms/${room.id}/messages`, undefined, undefined, {
      'X-Voice-Owner-Token': ownerToken!,
    });
    expect(ok.status).toBe(200);
    expect(count()).toBe(0);
  });
});

describe('存量访客房间（无令牌）回退 IP 判定', () => {
  it('★ owner_token 为 NULL 的房间仍按来源 IP 放行（不倒退既有行为）', async () => {
    // 直接构造 026 迁移前的形态：有 creator_ip、没有 owner_token
    const legacy = voiceRepo.createRoom(0, '老访客房', '', {
      creatorName: '未登录-1',
      creatorIp: '127.0.0.1',
    });
    db.prepare('UPDATE voice_rooms SET owner_token = NULL WHERE id = ?').run(legacy.id);

    const res = await api('DELETE', `/api/voice/rooms/${legacy.id}`);
    expect(res.status).toBe(200);
    expect(voiceRepo.getRoomById(legacy.id)).toBeUndefined();
  });

  it('无令牌且 IP 不匹配 → 403（回退不等于放开）', async () => {
    const legacy = voiceRepo.createRoom(0, '别的IP房', '', {
      creatorName: '未登录-1',
      creatorIp: '203.0.113.7',
    });
    db.prepare('UPDATE voice_rooms SET owner_token = NULL WHERE id = ?').run(legacy.id);

    expect((await api('DELETE', `/api/voice/rooms/${legacy.id}`)).status).toBe(403);
  });
});
