/**
 * ============================================================
 * 管理端用户列表：服务端搜索 + 分页（契约测试）
 * ============================================================
 * 覆盖:
 * - 分页窗口正确（20 行/页、total、totalPages、has_more、两页不重叠）
 * - 搜索语义与客户端**原本地过滤**一致：用户名/邮箱模糊 + ID 子串
 * - 搜索与分页叠加时 total 是「命中数」而不是全表数
 * - LIKE 通配符必须转义（搜 `a_b` 不能命中 `axb`；搜 `%` 不能命中所有人）
 * - **老客户端形状不变**：不带 page/q 时仍是 `{ users, has_more }`，
 *   不多不少 —— 已安装的 APK 靠本地过滤这份列表，换形状会让它的搜索失效
 * - 非法参数（page=abc / limit=1000 / 超长关键词）不 500、不整页报错
 *
 * 这些断言是**契约**：谁把老的 `{users, has_more}` 形状改掉、把搜索挪回
 * 客户端、或者忘了转义 LIKE，这里必须红。
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
let adminToken = '';

/** 造一个用户并返回 id（给定用户名/邮箱，便于按名字搜索） */
function makeUser(username: string, email: string): number {
  const info = db
    .prepare("INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, 'x', 'user')")
    .run(username, email);
  return Number(info.lastInsertRowid);
}

function makePost(userId: number): void {
  db.prepare("INSERT INTO posts (user_id, image_url, description) VALUES (?, '[]', 'p')").run(userId);
}

async function api(p: string) {
  const res = await fetch(`${base}${p}`, { headers: { Authorization: `Bearer ${adminToken}` } });
  return { status: res.status, data: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

interface PageShape {
  users: { id: number; username: string; email: string; post_count: number }[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  has_more: boolean;
}

/** 25 个普通用户，命名为 u01..u25（id 从 2 开始，1 是管理员） */
beforeAll(async () => {
  db = createMemoryDb();
  setDbForTests(db);

  const adminId = Number(
    db
      .prepare(
        "INSERT INTO users (username, email, password_hash, role) VALUES ('boss', 'boss@test.com', 'x', 'admin')"
      )
      .run().lastInsertRowid
  );
  adminToken = generateToken({ id: adminId, username: 'boss' });

  for (let i = 1; i <= 25; i += 1) {
    const uid = makeUser(`u${String(i).padStart(2, '0')}`, `u${String(i).padStart(2, '0')}@example.com`);
    // 前 3 个用户各带一篇帖子，用于验证 post_count 仍然算得出来
    if (i <= 3) makePost(uid);
  }

  // 通配符转义专用账号：搜 `a_b` 只能命中字面量 a_b，不能命中 axb
  makeUser('a_b', 'under@test.com');
  makeUser('axb', 'x@test.com');
  makeUser('100%real', 'pct@test.com');
  makeUser('100Xreal', 'pct2@test.com');

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

describe('服务端分页', () => {
  it('第一页 20 行、total=30、totalPages=2、has_more=true', async () => {
    const { status, data } = await api('/api/admin/users?page=1');
    expect(status).toBe(200);
    const page = data as unknown as PageShape;
    expect(page.users).toHaveLength(20);
    expect(page.total).toBe(30); // 1 管理员 + 25 u* + 4 通配符账号
    expect(page.page).toBe(1);
    expect(page.limit).toBe(20);
    expect(page.totalPages).toBe(2);
    expect(page.has_more).toBe(true);
  });

  it('第二页只剩 10 行、has_more=false，且两页 id 不重叠', async () => {
    const p1 = (await api('/api/admin/users?page=1')).data as unknown as PageShape;
    const p2 = (await api('/api/admin/users?page=2')).data as unknown as PageShape;
    expect(p2.users).toHaveLength(10);
    expect(p2.has_more).toBe(false);
    const ids1 = p1.users.map((u) => u.id);
    const ids2 = p2.users.map((u) => u.id);
    expect(ids1.filter((id) => ids2.includes(id))).toEqual([]);
    expect(new Set([...ids1, ...ids2]).size).toBe(30);
  });

  it('limit 可调；post_count 在分页模式下仍然正确', async () => {
    const { data } = await api('/api/admin/users?page=1&limit=5');
    const page = data as unknown as PageShape;
    expect(page.users).toHaveLength(5);
    expect(page.totalPages).toBe(6); // ceil(30/5)

    const first = page.users[0];
    expect(first?.username).toBe('boss'); // 按 id 升序，管理员在最前
    const withPosts = page.users.filter((u) => u.post_count > 0);
    expect(withPosts.length).toBeGreaterThan(0);
  });

  it('越界页码返回空列表而不是报错', async () => {
    const { status, data } = await api('/api/admin/users?page=99');
    const page = data as unknown as PageShape;
    expect(status).toBe(200);
    expect(page.users).toEqual([]);
    expect(page.has_more).toBe(false);
  });
});

describe('服务端搜索', () => {
  it('用户名精确命中：只返回该用户，total 是命中数', async () => {
    const { data } = await api('/api/admin/users?page=1&q=u07');
    const page = data as unknown as PageShape;
    expect(page.users).toHaveLength(1);
    expect(page.users[0]?.username).toBe('u07');
    expect(page.total).toBe(1);
    expect(page.totalPages).toBe(1);
  });

  it('用户名模糊命中多个（u0 开头），且 total 只算命中的行', async () => {
    const { data } = await api('/api/admin/users?page=1&q=u0');
    const page = data as unknown as PageShape;
    expect(page.total).toBe(9); // u01..u09
    expect(page.users.map((u) => u.username).every((n) => n.startsWith('u0'))).toBe(true);
  });

  it('邮箱也能搜到（与客户端原本地过滤的字段一致）', async () => {
    const { data } = await api('/api/admin/users?page=1&q=example.com&limit=50');
    const page = data as unknown as PageShape;
    expect(page.total).toBe(25);
    expect(page.users.every((u) => u.email.endsWith('@example.com'))).toBe(true);
  });

  it('ID 子串匹配（等价于原客户端的 String(id).includes）—— 三字段是「或」的关系', async () => {
    const { data } = await api('/api/admin/users?page=1&q=1&limit=50');
    const page = data as unknown as PageShape;
    expect(page.total).toBeGreaterThan(0);
    // 每一行至少命中三个字段之一（字段集合与客户端原本地过滤完全一致）
    expect(
      page.users.every((u) => u.username.includes('1') || u.email.includes('1') || String(u.id).includes('1'))
    ).toBe(true);
    // admin 的 id=1 而用户名/邮箱都不含 1 —— 它只能靠 ID 分支命中，
    // 所以这一行是「ID 子串匹配确实生效」的证据
    expect(page.users.map((u) => u.username)).toContain('boss');
  });

  it('搜索叠加分页：命中 25 行时按 limit 切页', async () => {
    const { data } = await api('/api/admin/users?page=3&limit=10&q=example.com');
    const page = data as unknown as PageShape;
    expect(page.total).toBe(25);
    expect(page.totalPages).toBe(3);
    expect(page.users).toHaveLength(5); // 第三页剩 5 行
    expect(page.has_more).toBe(false);
  });

  it('没有命中时返回空列表与 total=0', async () => {
    const { data } = await api('/api/admin/users?page=1&q=zzz-nobody');
    const page = data as unknown as PageShape;
    expect(page.users).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.totalPages).toBe(0);
  });

  it('★ LIKE 通配符被转义：搜 a_b 不会命中 axb', async () => {
    const { data } = await api('/api/admin/users?page=1&q=a_b');
    const page = data as unknown as PageShape;
    expect(page.users.map((u) => u.username)).toEqual(['a_b']);
  });

  it('★ LIKE 通配符被转义：搜 % 不会命中所有人', async () => {
    const { data } = await api('/api/admin/users?page=1&q=%25'); // %25 = 字面 %
    const page = data as unknown as PageShape;
    expect(page.users.map((u) => u.username)).toEqual(['100%real']);
  });

  it('搜索关键词只有空白视作不过滤', async () => {
    const { data } = await api('/api/admin/users?page=1&q=%20%20');
    const page = data as unknown as PageShape;
    expect(page.total).toBe(30);
  });
});

describe('参数健壮性（不因脏参数白屏或 500）', () => {
  it('page=abc 回落第 1 页；limit=1000 被限到 50', async () => {
    const bad = await api('/api/admin/users?page=abc');
    expect(bad.status).toBe(200);
    expect((bad.data as unknown as PageShape).page).toBe(1);

    const big = await api('/api/admin/users?page=1&limit=1000');
    const page = big.data as unknown as PageShape;
    expect(big.status).toBe(200);
    expect(page.users.length).toBeLessThanOrEqual(50);
    expect(page.limit).toBeLessThanOrEqual(50);
  });

  it('q 是数组/超长都不报错（截断成 50 字符内）', async () => {
    const arr = await api('/api/admin/users?page=1&q=a&q=b');
    expect(arr.status).toBe(200);

    const long = await api(`/api/admin/users?page=1&q=${'x'.repeat(200)}`);
    expect(long.status).toBe(200);
    expect((long.data as unknown as PageShape).total).toBe(0);
  });
});

describe('★ 老客户端形状不变（只增不改）', () => {
  it('不带 page/q 时仍是 { users, has_more }，且没有新增字段', async () => {
    const { status, data } = await api('/api/admin/users');
    expect(status).toBe(200);
    expect(Array.isArray(data!.users)).toBe(true);
    expect(typeof data!.has_more).toBe('boolean');
    // 老形状里不该冒出 total / totalPages —— 老代码不读它们，但契约要保持干净
    expect('total' in data!).toBe(false);
    expect('totalPages' in data!).toBe(false);
    expect((data!.users as unknown[]).length).toBeLessThanOrEqual(HARD_LIST_CAP);
  });
});
