/**
 * ============================================================
 * 粉丝/关注列表：服务端搜索 + 分页（契约测试）
 * ============================================================
 * 背景：弹窗此前是「接口最多返回 500 行 + 弹窗里本地过滤用户名」。
 * 粉丝超过上限的账号，那些粉丝**在搜索框里根本不存在**（搜不到 = 关注/取关不了）。
 *
 * 覆盖:
 * - 分页窗口（total / totalPages / has_more、两页不重叠）与排序（username ASC, id ASC）
 * - 服务端搜索：用户名模糊、ID 子串（弹窗原本只有用户名）
 * - `is_following` 仍按**查看者**计算（分页/搜索后不能退化成 0/1 常量）
 * - ★「不带 page/q 时仍是 { users, has_more }，且没有新增字段」
 * - 关注列表（/following）与粉丝列表（/followers）语义对称
 * - LIKE 通配符转义、脏参数不 500
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import Database from 'better-sqlite3';
import { createMemoryDb } from './helpers/memdb';
import { setDbForTests, resetDbForTests } from '../src/db/connection';
import { createApp } from '../src/app';
import { generateToken } from '../src/middleware/auth';
import { HARD_LIST_CAP } from '../src/lib/listLimits';

let db: InstanceType<typeof Database>;
let server: http.Server;
let base = '';
let starToken = '';
let viewerToken = '';
let starId = 0;
let viewerId = 0;
/** 25 个粉丝的名字：fan01..fan25（另有两个通配符账号与一个被 viewer 关注的账号） */
const FAN_COUNT = 25;

interface ListShape {
  users: { id: number; username: string; is_following: number }[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  has_more: boolean;
}

async function api(p: string, token: string) {
  const res = await fetch(`${base}${p}`, { headers: { Authorization: `Bearer ${token}` } });
  return {
    status: res.status,
    data: (await res.json().catch(() => null)) as Record<string, unknown> | null,
  };
}

function makeUser(username: string, email: string): number {
  return Number(
    db
      .prepare("INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, 'x', 'user')")
      .run(username, email).lastInsertRowid
  );
}

beforeAll(async () => {
  db = createMemoryDb();
  setDbForTests(db);

  starId = makeUser('star', 'star@test.com');
  viewerId = makeUser('viewer', 'viewer@test.com');
  starToken = generateToken({ id: starId, username: 'star' });
  viewerToken = generateToken({ id: viewerId, username: 'viewer' });

  const follow = db.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)');
  for (let i = 1; i <= FAN_COUNT; i += 1) {
    const fanId = makeUser(`fan${String(i).padStart(2, '0')}`, `fan${i}@test.com`);
    follow.run(fanId, starId); // 这些人是 star 的粉丝
  }
  // 通配符账号：a_b 与 axb 都关注 star
  follow.run(makeUser('a_b', 'under@test.com'), starId);
  follow.run(makeUser('axb', 'x@test.com'), starId);
  // viewer 关注了 fan01 → 粉丝列表里 fan01 必须标记为「已关注」
  const fan01 = (db.prepare("SELECT id FROM users WHERE username = 'fan01'").get() as { id: number }).id;
  follow.run(viewerId, fan01);
  // star 自己关注了一个人（用于 /following）
  const followed = makeUser('zfollowed', 'zfollowed@test.com');
  follow.run(starId, followed);

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

describe('粉丝列表：服务端分页', () => {
  it('第一页 20 行、total=27、两页、has_more=true', async () => {
    const { status, data } = await api(`/api/friends/followers/${starId}?page=1`, starToken);
    expect(status).toBe(200);
    const page = data as unknown as ListShape;
    expect(page.users).toHaveLength(20);
    expect(page.total).toBe(27); // 25 fan* + a_b + axb
    expect(page.page).toBe(1);
    expect(page.limit).toBe(20);
    expect(page.totalPages).toBe(2);
    expect(page.has_more).toBe(true);
    // 排序按用户名升序（与老实现一致）
    const names = page.users.map((u) => u.username);
    expect([...names].sort()).toEqual(names);
  });

  it('第二页 7 行、has_more=false，两页 id 不重叠', async () => {
    const p1 = (await api(`/api/friends/followers/${starId}?page=1`, starToken)).data as unknown as ListShape;
    const p2 = (await api(`/api/friends/followers/${starId}?page=2`, starToken)).data as unknown as ListShape;
    expect(p2.users).toHaveLength(7);
    expect(p2.has_more).toBe(false);
    const ids1 = p1.users.map((u) => u.id);
    expect(ids1.filter((id) => p2.users.some((u) => u.id === id))).toEqual([]);
    expect(new Set([...ids1, ...p2.users.map((u) => u.id)]).size).toBe(27);
  });

  it('★ is_following 仍按查看者计算（分页后这一点最容易退化）', async () => {
    const asViewer = (await api(`/api/friends/followers/${starId}?page=1`, viewerToken))
      .data as unknown as ListShape;
    const fan01AsViewer = asViewer.users.find((u) => u.username === 'fan01');
    expect(fan01AsViewer?.is_following).toBe(1);

    // star 自己没关注 fan01 → 同一行对 star 应显示未关注
    const asStar = (await api(`/api/friends/followers/${starId}?page=1`, starToken))
      .data as unknown as ListShape;
    expect(asStar.users.find((u) => u.username === 'fan01')?.is_following).toBe(0);
  });
});

describe('粉丝列表：服务端搜索', () => {
  it('用户名精确命中：只返回该用户，total 是命中数', async () => {
    const { data } = await api(`/api/friends/followers/${starId}?page=1&q=fan07`, starToken);
    const page = data as unknown as ListShape;
    expect(page.total).toBe(1);
    expect(page.users.map((u) => u.username)).toEqual(['fan07']);
    expect(page.totalPages).toBe(1);
  });

  it('用户名模糊命中多个（fan0 开头 9 个）', async () => {
    const { data } = await api(`/api/friends/followers/${starId}?page=1&q=fan0`, starToken);
    const page = data as unknown as ListShape;
    expect(page.total).toBe(9);
    expect(page.users.every((u) => u.username.startsWith('fan0'))).toBe(true);
  });

  it('搜索叠加分页：命中 25 条时按 limit 切页', async () => {
    const p1 = (await api(`/api/friends/followers/${starId}?page=1&limit=10&q=fan`, starToken))
      .data as unknown as ListShape;
    const p3 = (await api(`/api/friends/followers/${starId}?page=3&limit=10&q=fan`, starToken))
      .data as unknown as ListShape;
    expect(p1.total).toBe(25);
    expect(p1.totalPages).toBe(3);
    expect(p3.users).toHaveLength(5);
    expect(p3.has_more).toBe(false);
  });

  it('搜不到时不报错，返回空列表与 total=0', async () => {
    const { status, data } = await api(`/api/friends/followers/${starId}?page=1&q=nobody-zzz`, starToken);
    expect(status).toBe(200);
    expect((data as unknown as ListShape).users).toEqual([]);
    expect((data as unknown as ListShape).total).toBe(0);
  });

  it('★ LIKE 通配符被转义：搜 a_b 不会命中 axb', async () => {
    const { data } = await api(`/api/friends/followers/${starId}?page=1&q=a_b`, starToken);
    expect((data as unknown as ListShape).users.map((u) => u.username)).toEqual(['a_b']);
  });
});

describe('关注列表：与粉丝列表对称', () => {
  it('分页与搜索都可用（star 只关注了 1 个人）', async () => {
    const all = (await api(`/api/friends/following/${starId}?page=1`, starToken))
      .data as unknown as ListShape;
    expect(all.total).toBe(1);
    expect(all.users.map((u) => u.username)).toEqual(['zfollowed']);

    const hit = (await api(`/api/friends/following/${starId}?page=1&q=zfol`, starToken))
      .data as unknown as ListShape;
    expect(hit.total).toBe(1);

    const miss = (await api(`/api/friends/following/${starId}?page=1&q=fan01`, starToken))
      .data as unknown as ListShape;
    expect(miss.total).toBe(0); // fan01 关注了 star，但 star 没关注 fan01
  });
});

describe('参数健壮性', () => {
  it('超长关键词与数组形态的 q 都不报错', async () => {
    const long = await api(`/api/friends/followers/${starId}?page=1&q=${'x'.repeat(200)}`, starToken);
    expect(long.status).toBe(200);
    expect((long.data as unknown as ListShape).total).toBe(0);

    const arr = await api(`/api/friends/followers/${starId}?page=1&q=a&q=b`, starToken);
    expect(arr.status).toBe(200);
    // 数组 → 空串 → 不过滤
    expect((arr.data as unknown as ListShape).total).toBe(27);
  });

  it('page=abc 回落第 1 页；limit=1000 被限到 50', async () => {
    const bad = await api(`/api/friends/followers/${starId}?page=abc`, starToken);
    expect((bad.data as unknown as ListShape).page).toBe(1);

    const big = await api(`/api/friends/followers/${starId}?page=1&limit=1000`, starToken);
    expect((big.data as unknown as ListShape).users.length).toBeLessThanOrEqual(50);
  });
});

describe('★ 老客户端形状不变（只增不改）', () => {
  it('不带 page/q 时仍是 { users, has_more }，且没有新增字段', async () => {
    for (const path of [`/api/friends/followers/${starId}`, `/api/friends/following/${starId}`]) {
      const { status, data } = await api(path, starToken);
      expect(status).toBe(200);
      expect(Array.isArray(data!.users)).toBe(true);
      expect(typeof data!.has_more).toBe('boolean');
      expect('total' in data!).toBe(false);
      expect('totalPages' in data!).toBe(false);
      expect((data!.users as unknown[]).length).toBeLessThanOrEqual(HARD_LIST_CAP);
    }
  });
});
