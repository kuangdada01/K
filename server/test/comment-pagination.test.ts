/**
 * ============================================================
 * 评论分页测试（顶级评论为单位，回复随顶级返回）
 * ============================================================
 * 覆盖:
 * - GET /posts/:id?comment_limit → 第一页（顶级+回复）、总数、has_more
 * - GET /posts/:id/comments?after_id&limit → 游标续拉至末页
 * - 无参数调用保持旧契约（全量返回），旧客户端不受影响
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import Database from 'better-sqlite3';
import { createSchema } from '../src/db/schema';
import { setDbForTests, resetDbForTests } from '../src/db/connection';
import { createApp } from '../src/app';
import { generateToken } from '../src/middleware/auth';

let db: InstanceType<typeof Database>;
let server: http.Server;
let base = '';
let tokenA = '';
let tokenB = '';
let postId = 0;
const TOP_COUNT = 12;
const REPLY_COUNT = 3;

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  setDbForTests(db);

  const insertUser = db.prepare("INSERT INTO users (username, email, password_hash) VALUES (?, ?, 'x')");
  const userA = Number(insertUser.run('author-a', 'a@test.com').lastInsertRowid);
  const userB = Number(insertUser.run('commenter-b', 'b@test.com').lastInsertRowid);
  tokenA = generateToken({ id: userA, username: 'author-a' });
  tokenB = generateToken({ id: userB, username: 'commenter-b' });

  const insertPost = db.prepare(
    "INSERT INTO posts (user_id, image_url, title, description) VALUES (?, ?, '', 'p')"
  );
  postId = Number(insertPost.run(userA, '["/uploads/x.jpg"]').lastInsertRowid);

  const insertComment = db.prepare(
    'INSERT INTO comments (user_id, post_id, parent_id, content) VALUES (?, ?, ?, ?)'
  );
  let firstTopId = 0;
  for (let i = 1; i <= TOP_COUNT; i++) {
    const r = insertComment.run(userB, postId, null, `顶级评论${i}`);
    if (i === 1) firstTopId = Number(r.lastInsertRowid);
  }
  for (let i = 1; i <= REPLY_COUNT; i++) {
    // 回复挂在第 1 条顶级评论下
    insertComment.run(userA, postId, firstTopId, `回复${i}`);
  }

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

async function api(method: string, p: string, token?: string) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

describe('评论分页（向后兼容）', () => {
  it('comment_limit 返回第一页：5 条顶级 + 3 条回复，总数与 has_more 正确', async () => {
    const res = await api('GET', `/api/posts/${postId}?comment_limit=5`, tokenA);
    expect(res.status).toBe(200);
    const tops = res.data.comments.filter((c: { parent_id: number | null }) => c.parent_id === null);
    const replies = res.data.comments.filter((c: { parent_id: number | null }) => c.parent_id !== null);
    expect(tops.length).toBe(5);
    expect(replies.length).toBe(REPLY_COUNT);
    expect(res.data.comments_total).toBe(TOP_COUNT + REPLY_COUNT);
    expect(res.data.comments_has_more).toBe(true);
    // 回复随顶级携带，且带父评论信息
    expect(replies[0].parent_content).toBe('顶级评论1');
  });

  it('after_id 游标续拉到末页，has_more 收敛为 false', async () => {
    const page1 = await api('GET', `/api/posts/${postId}?comment_limit=5`, tokenA);
    const firstPageTops = page1.data.comments.filter(
      (c: { parent_id: number | null }) => c.parent_id === null
    );
    const cursor = firstPageTops[firstPageTops.length - 1].id;

    const page2 = await api('GET', `/api/posts/${postId}/comments?after_id=${cursor}&limit=5`, tokenB);
    expect(page2.status).toBe(200);
    expect(page2.data.comments.filter((c: { parent_id: number | null }) => c.parent_id === null).length).toBe(
      5
    );
    expect(page2.data.has_more).toBe(true);

    const page2Last = page2.data.comments
      .filter((c: { parent_id: number | null }) => c.parent_id === null)
      .slice(-1)[0];
    const page3 = await api('GET', `/api/posts/${postId}/comments?after_id=${page2Last.id}&limit=5`, tokenB);
    expect(page3.data.comments.filter((c: { parent_id: number | null }) => c.parent_id === null).length).toBe(
      2
    );
    expect(page3.data.has_more).toBe(false);
  });

  it('无参数调用保持旧契约：详情与评论端点均全量返回', async () => {
    const detail = await api('GET', `/api/posts/${postId}`, tokenA);
    expect(detail.data.comments.length).toBe(TOP_COUNT + REPLY_COUNT);
    expect(detail.data.comments_has_more).toBeUndefined();

    const comments = await api('GET', `/api/posts/${postId}/comments`, tokenB);
    expect(comments.data.comments.length).toBe(TOP_COUNT + REPLY_COUNT);
    expect(comments.data.has_more).toBeUndefined();
  });

  it('非法 comment_limit 回落全量而不是崩溃', async () => {
    const res = await api('GET', `/api/posts/${postId}?comment_limit=abc`, tokenA);
    expect(res.status).toBe(200);
    expect(res.data.comments.length).toBe(TOP_COUNT + REPLY_COUNT);
  });
});
