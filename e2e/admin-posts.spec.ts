/**
 * ============================================================
 * E2E：管理端帖子列表的服务端搜索
 * ============================================================
 * 与 admin-users.spec.ts 同一个接缝风险（客户端参数名、服务端响应字段），
 * 但这里要证的是**换页才有**的那部分：目标帖子排在 25 篇种子之后，
 * 本地过滤时代（客户端只拿当前页 20 行）根本搜不到。
 *
 * 种子策略：所有种子帖子的 `created_at` 都写成 **2020/2021**（列表是
 * created_at DESC, id DESC），于是它们排在真实帖子之后 —— 既保证目标帖子
 * 落在第二页，也不会挤占首页信息流的第一页（其它规格会断言首屏内容）。
 * 帖子的 `image_url` 用 '[]'，管理端表格里的缩略图会 404，但不影响断言。
 *
 * 唯一戳记 + 只按自己的作者名断言：CI 上 retries=1，重试会再种一批，
 * 上一批的残留不会被这次搜到（用户名不同）。
 */

import { test, expect } from '@playwright/test';
import { createRequire } from 'module';
import path from 'path';
import { DB_PATH } from './db-path';

const require = createRequire(path.resolve('server/package.json'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试进程借用 server 的原生依赖
const Database = require('better-sqlite3') as any;

const stamp = Date.now();
const prefix = `zpost${stamp % 100000}`;
/** 搜索目标作者：只有 1 篇帖子，且时间最旧 → 必然在最后一页 */
const targetAuthor = `${prefix}target`;
const targetText = `${prefix}-目标帖子-仅此一篇`;
/** 填充作者：25 篇，保证总页数 ≥ 2 */
const fillerAuthor = `${prefix}filler`;
const FILLER_COUNT = 25;

test('管理端帖子列表：服务端搜索能搜到不在第一页的帖子', async ({ page, request }) => {
  // —— 已安装的 APK 走老路径，这里同样用「真实注册」拿管理员 token ——
  const adminEmail = `e2e-adminpost-${stamp}@test.local`;
  const adminUsername = `${prefix}admin`;
  const code = String(100000 + (stamp % 900000));

  const db = new Database(DB_PATH);
  db.prepare('INSERT INTO verification_codes (email, code, expires) VALUES (?, ?, ?)').run(
    adminEmail,
    code,
    new Date(Date.now() + 10 * 60 * 1000).toISOString()
  );
  const insertUser = db.prepare(
    "INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, 'seed', ?)"
  );
  const targetId = Number(insertUser.run(targetAuthor, `${targetAuthor}@test.local`, 'user').lastInsertRowid);
  const fillerId = Number(insertUser.run(fillerAuthor, `${fillerAuthor}@test.local`, 'user').lastInsertRowid);

  const insertPost = db.prepare(
    "INSERT INTO posts (user_id, image_url, description, created_at) VALUES (?, '[]', ?, ?)"
  );
  // 目标帖：最旧（2020）→ 排在所有帖子之后
  const targetPostId = Number(
    insertPost.run(targetId, targetText, '2020-01-01T00:00:00.000Z').lastInsertRowid
  );
  for (let i = 1; i <= FILLER_COUNT; i += 1) {
    insertPost.run(
      fillerId,
      `${prefix}-填充帖-${i}`,
      `2021-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`
    );
  }
  db.close();

  const reg = await request.post('/api/auth/register', {
    data: { username: adminUsername, email: adminEmail, password: 'e2e-Passw0rd-123', code },
  });
  expect(reg.status()).toBe(201);
  const { token } = (await reg.json()) as { token: string };

  const db2 = new Database(DB_PATH);
  db2.prepare("UPDATE users SET role = 'admin' WHERE email = ?").run(adminEmail);
  db2.close();

  await page.addInitScript((t) => localStorage.setItem('k_token', t), token);

  const postsResponse = (predicate: (url: string) => boolean) =>
    page.waitForResponse((r) => r.url().includes('/api/admin/posts?') && predicate(r.url()));

  // —— 进入后台（默认是「用户管理」tab，所以帖子请求要等切 tab 之后才发）——
  await page.goto('/admin');
  await expect(page.getByTestId('admin-users-table')).toBeVisible();

  const firstPage = postsResponse((url) => url.includes('page=1'));
  await page.getByRole('button', { name: /帖子管理/ }).click();
  const firstResp = await firstPage;
  expect(firstResp.status()).toBe(200);
  const firstBody = (await firstResp.json()) as {
    posts: { id: number; username: string }[];
    total: number;
    page: number;
    totalPages: number;
  };
  expect(firstResp.url()).toContain('limit=20');
  expect(firstBody.page).toBe(1);
  expect(firstBody.posts).toHaveLength(20);
  expect(firstBody.totalPages).toBeGreaterThanOrEqual(2);
  // 目标帖子不在第一页 —— 这正是本地过滤搜不到的根因
  expect(firstBody.posts.map((p) => p.id)).not.toContain(targetPostId);

  const rows = page.getByTestId('admin-posts-table').locator('tbody tr');
  await expect(rows).toHaveCount(20);
  await expect(page.getByTestId('admin-posts-prev')).toBeDisabled();

  // —— 服务端搜索：输入只在最后一页出现的作者名 ——
  const searchResp = postsResponse((url) => url.includes('q='));
  await page.getByTestId('admin-post-search').fill(targetAuthor);
  const found = await searchResp;
  expect(found.status()).toBe(200);
  const foundBody = (await found.json()) as {
    posts: { id: number; username: string }[];
    total: number;
    totalPages: number;
  };
  expect(foundBody.total).toBe(1);
  expect(foundBody.posts[0]?.id).toBe(targetPostId);

  // 界面上只剩这一行，且搜索把页码重置回第 1 页（只有一页 → 分页控件消失）
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(targetText);
  await expect(page.getByTestId('admin-posts-page')).toHaveCount(0);

  // —— 搜不到时给出空态而不是空白表格 ——
  const missResp = postsResponse((url) => url.includes('q='));
  await page.getByTestId('admin-post-search').fill(`${prefix}-绝对没有这个作者`);
  await missResp;
  await expect(page.getByTestId('admin-posts-empty')).toHaveText('没有匹配的帖子');

  // —— 清空搜索词 → 回到完整的第一页 ——
  const cleared = postsResponse((url) => url.includes('page=1') && !url.includes('q='));
  await page.getByTestId('admin-post-search').fill('');
  await cleared;
  await expect(rows).toHaveCount(20);
});
