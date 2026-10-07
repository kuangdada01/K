/**
 * ============================================================
 * E2E：管理端公告列表的服务端搜索 + 分页
 * ============================================================
 * 公告列表此前**既没有搜索也没有分页**：一次返回最多 500 行、整表进 DOM，
 * 管理员找不到某条公告时只能一路滚。这条 e2e 证的是新能力真的在页面上生效：
 * - 第一页 20 行（请求确实带了 page/limit）
 * - 目标公告排在 25 条种子之后 → 本地时代不存在，现在能搜到
 * - 搜不到时是空态文案，不是白屏
 *
 * 种子全部写成 2021 年以前的 `created_at`（列表按时间倒序），这样目标公告
 * 落在最后一页，也不会影响其它规格（公告不在首页信息流里，风险更低）。
 * 唯一戳记 + 只按自己的标题断言：CI 上 retries=1，重试再种一批也不会互相命中。
 */

import { test, expect } from '@playwright/test';
import { createRequire } from 'module';
import path from 'path';
import { DB_PATH } from './db-path';

const require = createRequire(path.resolve('server/package.json'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试进程借用 server 的原生依赖
const Database = require('better-sqlite3') as any;

const stamp = Date.now();
const prefix = `zann${stamp % 100000}`;
const targetTitle = `${prefix}-目标公告-仅此一条`;
const FILLER_COUNT = 25;

test('管理端公告列表：服务端分页可达第二页，服务端搜索能搜到不在第一页的公告', async ({ page, request }) => {
  const adminEmail = `e2e-adminann-${stamp}@test.local`;
  const adminUsername = `${prefix}admin`;
  const code = String(100000 + (stamp % 900000));

  const db = new Database(DB_PATH);
  db.prepare('INSERT INTO verification_codes (email, code, expires) VALUES (?, ?, ?)').run(
    adminEmail,
    code,
    new Date(Date.now() + 10 * 60 * 1000).toISOString()
  );
  db.close();

  // —— 管理员身份走真实链路：先注册拿 token，再在库里提权（与其它规格同一套路）——
  const reg = await request.post('/api/auth/register', {
    data: { username: adminUsername, email: adminEmail, password: 'e2e-Passw0rd-123', code },
  });
  expect(reg.status()).toBe(201);
  const { token, user } = (await reg.json()) as { token: string; user: { id: number } };

  const db2 = new Database(DB_PATH);
  db2.prepare("UPDATE users SET role = 'admin' WHERE email = ?").run(adminEmail);
  const insertAnn = db2.prepare(
    'INSERT INTO announcements (title, content, target_user_id, from_user_id, created_at) VALUES (?, ?, NULL, ?, ?)'
  );
  // 目标公告：最旧（2020）→ 排在所有公告之后
  const targetAnnId = Number(
    insertAnn.run(targetTitle, '这条只在最后一页', user.id, '2020-01-01T00:00:00.000Z').lastInsertRowid
  );
  for (let i = 1; i <= FILLER_COUNT; i += 1) {
    insertAnn.run(
      `${prefix}-填充公告-${i}`,
      `填充内容 ${i}`,
      user.id,
      `2021-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`
    );
  }
  db2.close();

  await page.addInitScript((t) => localStorage.setItem('k_token', t), token);

  const annResponse = (predicate: (url: string) => boolean) =>
    page.waitForResponse((r) => r.url().includes('/api/admin/announcements?') && predicate(r.url()));

  await page.goto('/admin');
  await expect(page.getByTestId('admin-users-table')).toBeVisible();

  const firstPage = annResponse((url) => url.includes('page=1'));
  await page.getByRole('button', { name: /公告管理/ }).click();
  const firstResp = await firstPage;
  expect(firstResp.status()).toBe(200);
  const firstBody = (await firstResp.json()) as {
    announcements: { id: number; title: string }[];
    total: number;
    page: number;
    totalPages: number;
  };
  expect(firstResp.url()).toContain('limit=20');
  expect(firstBody.page).toBe(1);
  expect(firstBody.announcements).toHaveLength(20);
  expect(firstBody.totalPages).toBeGreaterThanOrEqual(2);
  // 目标公告不在第一页 —— 这正是「本地时代找不到」的根因
  expect(firstBody.announcements.map((a) => a.id)).not.toContain(targetAnnId);

  const rows = page.getByTestId('admin-ann-table').locator('tbody tr');
  await expect(rows).toHaveCount(20);
  await expect(page.getByTestId('admin-ann-prev')).toBeDisabled();

  // —— 翻到第二页：目标公告在里面 ——
  const secondPage = annResponse((url) => url.includes('page=2'));
  await page.getByTestId('admin-ann-next').click();
  const secondResp = await secondPage;
  const secondBody = (await secondResp.json()) as { announcements: { id: number }[] };
  expect(secondBody.announcements.map((a) => a.id)).toContain(targetAnnId);

  // —— 服务端搜索：输入只在第二页出现的标题 ——
  const searchResp = annResponse((url) => url.includes('q='));
  await page.getByTestId('admin-ann-search').fill(targetTitle);
  const found = await searchResp;
  const foundBody = (await found.json()) as {
    announcements: { id: number; title: string }[];
    total: number;
  };
  expect(foundBody.total).toBe(1);
  expect(foundBody.announcements.map((a) => a.title)).toEqual([targetTitle]);

  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(targetTitle);
  // 只剩一页 → 分页控件消失
  await expect(page.getByTestId('admin-ann-page')).toHaveCount(0);

  // —— 搜不到时是空态文案 ——
  const missResp = annResponse((url) => url.includes('q='));
  await page.getByTestId('admin-ann-search').fill(`${prefix}-绝对没有这条公告`);
  await missResp;
  await expect(page.getByTestId('admin-ann-empty')).toHaveText('没有匹配的公告');

  // —— 清空 → 回到第一页 ——
  const cleared = annResponse((url) => url.includes('page=1') && !url.includes('q='));
  await page.getByTestId('admin-ann-search').fill('');
  await cleared;
  await expect(rows).toHaveCount(20);
});
