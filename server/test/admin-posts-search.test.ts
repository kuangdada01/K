/**
 * ============================================================
 * 管理端帖子列表：服务端搜索（契约测试）
 * ============================================================
 * 覆盖:
 * - `q` 为空时与改动前**逐字相同**（响应键集合不变、total 不变）—— 本接口
 *   本来就是分页的，`q` 只是纯新增参数，不能顺手改形状
 * - 搜索语义与客户端**原本地过滤**一致：作者用户名模糊 + 作者 ID 子串（「或」）
 * - 搜索与分页叠加时 total 是「命中数」；排序仍是 created_at DESC, id DESC
 * - LIKE 通配符必须转义（搜 `a_b` 不能命中 `axb`）
 * - 脏参数（超长 q、q 传数组）不 500
 *
 * 这些断言是**契约**：谁把 `q` 去掉让客户端回去本地过滤（本地只有当前页 20 行，
 * 搜不到别的页的帖子）、谁漏了转义、谁改了排序，这里必须红。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import Database from 'better-sqlite3';
import { createMemoryDb } from './helpers/memdb';
import { setDbForTests, resetDbForTests } from '../src/db/connection';
import { createApp } from '../src/app';
import { generateToken } from '../src/middleware/auth';

let db: InstanceType<typeof Database>;
let server: http.Server;
let base = '';
let adminToken = '';
let aliceId = 0;
let bobId = 0;

interface PostsShape {
  posts: { id: number; user_id: number; username: string; created_at: string; images: string[] }[];
  total: number;
  page: number;
  totalPages: number;
}

async function api(p: string) {
  const res = await fetch(`${base}${p}`, { headers: { Authorization: `Bearer ${adminToken}` } });
  return {
    status: res.status,
    data: (await res.json().catch(() => null)) as Record<string, unknown> | null,
  };
}

function makeUser(username: string, email: string): number {
  const info = db
    .prepare("INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, 'x', 'user')")
    .run(username, email);
  return Number(info.lastInsertRowid);
}

/** 造一篇帖子；createdAt 显式给值才能稳定验排序 */
function makePost(userId: number, description: string, createdAt: string): number {
  const info = db
    .prepare("INSERT INTO posts (user_id, image_url, description, created_at) VALUES (?, '[]', ?, ?)")
    .run(userId, description, createdAt);
  return Number(info.lastInsertRowid);
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

  aliceId = makeUser('alice', 'alice@test.com');
  bobId = makeUser('bob', 'bob@test.com');

  // alice 3 篇（时间递增），bob 22 篇（较旧）→ 总计 25 篇、两页
  for (let i = 1; i <= 3; i += 1) {
    makePost(aliceId, `alice-post-${i}`, `2026-03-0${i}T00:00:00.000Z`);
  }
  for (let i = 1; i <= 22; i += 1) {
    makePost(bobId, `bob-post-${i}`, `2026-01-${String(i).padStart(2, '0')}T00:00:00.000Z`);
  }

  // 通配符转义专用：两个作者各一篇，用户名只差 `_` / `x`
  const underId = makeUser('a_b', 'under@test.com');
  const xId = makeUser('axb', 'x2@test.com');
  makePost(underId, 'under-post', '2026-02-01T00:00:00.000Z');
  makePost(xId, 'x-post', '2026-02-02T00:00:00.000Z');

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

describe('不带 q：行为与改动前一致', () => {
  it('响应键集合不变（posts/total/page/totalPages），第一页 20 行、两页', async () => {
    const { status, data } = await api('/api/admin/posts?page=1');
    expect(status).toBe(200);
    const page = data as unknown as PostsShape;
    expect(Object.keys(data!).sort()).toEqual(['page', 'posts', 'total', 'totalPages']);
    expect(page.posts).toHaveLength(20);
    expect(page.total).toBe(27); // 3 alice + 22 bob + 2 通配符作者
    expect(page.page).toBe(1);
    expect(page.totalPages).toBe(2);
  });

  it('每行都带 images 数组（withImages 解析仍在）', async () => {
    const { data } = await api('/api/admin/posts?page=1');
    const page = data as unknown as PostsShape;
    expect(Array.isArray(page.posts[0]?.images)).toBe(true);
  });

  it('排序仍是 created_at DESC, id DESC（最新在最前）', async () => {
    const { data } = await api('/api/admin/posts?page=1&limit=5');
    const page = data as unknown as PostsShape;
    const times = page.posts.map((p) => p.created_at);
    expect([...times].sort().reverse()).toEqual(times);
  });
});

describe('服务端搜索', () => {
  it('按作者用户名搜索：只返回该作者的帖子，total 是命中数', async () => {
    const { data } = await api('/api/admin/posts?page=1&q=alice');
    const page = data as unknown as PostsShape;
    expect(page.total).toBe(3);
    expect(page.posts.every((p) => p.username === 'alice')).toBe(true);
    expect(page.totalPages).toBe(1);
  });

  it('按作者 ID 子串搜索（等价于原客户端 String(user_id).includes）', async () => {
    const { data } = await api(`/api/admin/posts?page=1&q=${bobId}&limit=50`);
    const page = data as unknown as PostsShape;
    // bob 的 id 是数字，用它搜应命中 bob 的 22 篇
    expect(page.total).toBe(22);
    expect(page.posts.every((p) => p.user_id === bobId)).toBe(true);
  });

  it('搜索叠加分页：命中 22 条时按 limit 切页，且第二页是剩下的 2 条', async () => {
    const p1 = (await api('/api/admin/posts?page=1&limit=20&q=bob')).data as unknown as PostsShape;
    const p2 = (await api('/api/admin/posts?page=2&limit=20&q=bob')).data as unknown as PostsShape;
    expect(p1.total).toBe(22);
    expect(p1.totalPages).toBe(2);
    expect(p1.posts).toHaveLength(20);
    expect(p2.posts).toHaveLength(2);
    const ids1 = p1.posts.map((p) => p.id);
    expect(ids1.filter((id) => p2.posts.some((p) => p.id === id))).toEqual([]);
  });

  it('没有命中时返回空列表与 total=0 / totalPages=0', async () => {
    const { data } = await api('/api/admin/posts?page=1&q=zzz-nobody');
    const page = data as unknown as PostsShape;
    expect(page.posts).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.totalPages).toBe(0);
  });

  it('★ LIKE 通配符被转义：搜 a_b 不会命中 axb 的帖子', async () => {
    const { data } = await api('/api/admin/posts?page=1&q=a_b');
    const page = data as unknown as PostsShape;
    expect(page.posts.map((p) => p.username)).toEqual(['a_b']);
  });

  it('搜索关键词只有空白视作不过滤', async () => {
    const { data } = await api('/api/admin/posts?page=1&q=%20');
    const page = data as unknown as PostsShape;
    expect(page.total).toBe(27);
  });

  it('超长关键词与数组形态的 q 都不报错', async () => {
    const long = await api(`/api/admin/posts?page=1&q=${'x'.repeat(200)}`);
    expect(long.status).toBe(200);
    expect((long.data as unknown as PostsShape).total).toBe(0);

    const arr = await api('/api/admin/posts?page=1&q=a&q=b');
    expect(arr.status).toBe(200);
    // 数组 → searchQuerySchema 退化成空串 → 不过滤
    expect((arr.data as unknown as PostsShape).total).toBe(27);
  });
});
