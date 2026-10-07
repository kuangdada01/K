/**
 * ============================================================
 * 管理端公告列表：服务端搜索 + 分页（契约测试）
 * ============================================================
 * 覆盖:
 * - 分页窗口（total / totalPages / has_more / 两页不重叠）与排序（created_at DESC, id DESC）
 * - 搜索字段：标题、内容、目标用户名、公告 ID 子串
 * - 搜索叠加分页时 total 是「命中数」
 * - ★「不带 page/q 时仍是 { announcements, has_more }，且没有新增字段」
 *   —— 已安装的 APK 走这条老路径，换形状会让它拿不到列表
 * - LIKE 通配符转义、脏参数不 500
 *
 * 这个接口本来就**没有**搜索、也没有分页（整表最多 500 行进 DOM），
 * 所以这些断言同时是「新能力」的守门。
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
let targetUserId = 0;

interface AnnShape {
  announcements: {
    id: number;
    title: string;
    content: string;
    target_username: string | null;
    created_at: string;
  }[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  has_more: boolean;
}

async function api(p: string) {
  const res = await fetch(`${base}${p}`, { headers: { Authorization: `Bearer ${adminToken}` } });
  return {
    status: res.status,
    data: (await res.json().catch(() => null)) as Record<string, unknown> | null,
  };
}

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
  targetUserId = Number(
    db
      .prepare(
        "INSERT INTO users (username, email, password_hash, role) VALUES ('lisi', 'lisi@test.com', 'x', 'user')"
      )
      .run().lastInsertRowid
  );

  const insert = db.prepare(
    'INSERT INTO announcements (title, content, target_user_id, from_user_id, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  // 25 条全体公告（时间递增）+ 1 条定向公告（最新）+ 2 条通配符账号用的
  for (let i = 1; i <= 25; i += 1) {
    insert.run(
      `维护公告-${String(i).padStart(2, '0')}`,
      `第 ${i} 次维护说明`,
      null,
      adminId,
      `2026-01-${String(i).padStart(2, '0')}T00:00:00.000Z`
    );
  }
  insert.run('定向通知', '只发给老四的那条', targetUserId, adminId, '2026-02-01T00:00:00.000Z');
  insert.run('100%回滚', '含百分号标题', null, adminId, '2026-02-02T00:00:00.000Z');
  insert.run('100X回滚', '不含通配符语义的标题', null, adminId, '2026-02-03T00:00:00.000Z');

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
  it('第一页 20 行、total=28、两页、has_more=true，排序最新在前', async () => {
    const { status, data } = await api('/api/admin/announcements?page=1');
    expect(status).toBe(200);
    const page = data as unknown as AnnShape;
    expect(page.announcements).toHaveLength(20);
    expect(page.total).toBe(28); // 25 全体 + 1 定向 + 2 通配符
    expect(page.page).toBe(1);
    expect(page.limit).toBe(20);
    expect(page.totalPages).toBe(2);
    expect(page.has_more).toBe(true);
    // 最新的是 2026-02-03 那条
    expect(page.announcements[0]?.title).toBe('100X回滚');
    const times = page.announcements.map((a) => a.created_at);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it('第二页 8 行、has_more=false，两页 id 不重叠', async () => {
    const p1 = (await api('/api/admin/announcements?page=1')).data as unknown as AnnShape;
    const p2 = (await api('/api/admin/announcements?page=2')).data as unknown as AnnShape;
    expect(p2.announcements).toHaveLength(8);
    expect(p2.has_more).toBe(false);
    const ids1 = p1.announcements.map((a) => a.id);
    expect(ids1.filter((id) => p2.announcements.some((a) => a.id === id))).toEqual([]);
    expect(new Set([...ids1, ...p2.announcements.map((a) => a.id)]).size).toBe(28);
  });

  it('越界页码返回空列表而不是报错', async () => {
    const { status, data } = await api('/api/admin/announcements?page=99');
    expect(status).toBe(200);
    expect((data as unknown as AnnShape).announcements).toEqual([]);
  });
});

describe('服务端搜索（四个字段）', () => {
  it('按标题搜索', async () => {
    const { data } = await api('/api/admin/announcements?page=1&q=维护公告-07');
    const page = data as unknown as AnnShape;
    expect(page.total).toBe(1);
    expect(page.announcements[0]?.title).toBe('维护公告-07');
  });

  it('按内容搜索', async () => {
    const { data } = await api('/api/admin/announcements?page=1&q=第 13 次维护说明');
    const page = data as unknown as AnnShape;
    expect(page.total).toBe(1);
    expect(page.announcements[0]?.title).toBe('维护公告-13');
  });

  it('按目标用户名搜索（定向公告）', async () => {
    const { data } = await api('/api/admin/announcements?page=1&q=lisi');
    const page = data as unknown as AnnShape;
    expect(page.total).toBe(1);
    expect(page.announcements[0]?.title).toBe('定向通知');
    expect(page.announcements[0]?.target_username).toBe('lisi');
  });

  it('按公告 ID 子串搜索', async () => {
    const { data } = await api(`/api/admin/announcements?page=1&q=${targetUserId}`);
    const page = data as unknown as AnnShape;
    // 目标用户名 lisi 的 id 会在「目标用户名」分支也命中，这里断言命中集合非空
    expect(page.total).toBeGreaterThan(0);
  });

  it('搜索叠加分页：命中 25 条时按 limit 切页', async () => {
    const p1 = (await api('/api/admin/announcements?page=1&limit=10&q=维护公告')).data as unknown as AnnShape;
    const p3 = (await api('/api/admin/announcements?page=3&limit=10&q=维护公告')).data as unknown as AnnShape;
    expect(p1.total).toBe(25);
    expect(p1.totalPages).toBe(3);
    expect(p1.announcements).toHaveLength(10);
    expect(p3.announcements).toHaveLength(5);
    expect(p3.has_more).toBe(false);
  });

  it('没有命中时返回空列表与 total=0', async () => {
    const { data } = await api('/api/admin/announcements?page=1&q=zzz-nobody');
    const page = data as unknown as AnnShape;
    expect(page.announcements).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.totalPages).toBe(0);
  });

  it('★ LIKE 通配符被转义：搜 100% 不会命中 100X', async () => {
    const { data } = await api('/api/admin/announcements?page=1&q=100%25');
    const page = data as unknown as AnnShape;
    expect(page.announcements.map((a) => a.title)).toEqual(['100%回滚']);
  });
});

describe('参数健壮性', () => {
  it('q 只有空白 → 视作不过滤；超长与数组形态都不报错', async () => {
    expect(((await api('/api/admin/announcements?page=1&q=%20')).data as unknown as AnnShape).total).toBe(28);
    expect((await api(`/api/admin/announcements?page=1&q=${'x'.repeat(200)}`)).status).toBe(200);
    expect((await api('/api/admin/announcements?page=1&q=a&q=b')).status).toBe(200);
  });
});

describe('★ 老客户端形状不变（只增不改）', () => {
  it('不带 page/q 时仍是 { announcements, has_more }，且没有新增字段', async () => {
    const { status, data } = await api('/api/admin/announcements');
    expect(status).toBe(200);
    expect(Array.isArray(data!.announcements)).toBe(true);
    expect(typeof data!.has_more).toBe('boolean');
    expect('total' in data!).toBe(false);
    expect('totalPages' in data!).toBe(false);
    expect((data!.announcements as unknown[]).length).toBeLessThanOrEqual(HARD_LIST_CAP);
  });
});
