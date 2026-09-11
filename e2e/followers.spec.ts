/**
 * ============================================================
 * E2E：粉丝弹窗的服务端搜索 + 分页
 * ============================================================
 * 这是**前台**那条同类问题的验收：弹窗此前是「接口最多返回 500 行 +
 * 弹窗里本地过滤用户名」，粉丝超过上限的账号，那些粉丝在搜索框里根本不存在。
 *
 * 种子：一个明星账号（不发帖、只被关注）+ 25 个粉丝 + 1 个名字排序在最后的目标粉丝。
 * 接口按 `username ASC` 排序，所以目标粉丝一定落在第二页。
 *
 * 断言里包含「请求确实带了 page/limit」与「搜索带 q」——
 * 这两条正是客户端↔服务端的接缝，单元测试各自造假数据时看不出来。
 */

import { test, expect } from '@playwright/test';
import { createRequire } from 'module';
import path from 'path';
import { DB_PATH } from './db-path';

const require = createRequire(path.resolve('server/package.json'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试进程借用 server 的原生依赖
const Database = require('better-sqlite3') as any;

const stamp = Date.now();
const prefix = `zfan${stamp % 100000}`;
/** 目标粉丝：名字以 z 结尾排序 → 必然在第二页 */
const targetFan = `${prefix}-ztarget`;
const FAN_COUNT = 25;

test('粉丝弹窗：服务端分页可加载更多，服务端搜索能搜到不在第一页的粉丝', async ({ page, request }) => {
  const viewerEmail = `e2e-fanviewer-${stamp}@test.local`;
  const viewerUsername = `${prefix}viewer`;
  const code = String(100000 + (stamp % 900000));

  // —— 种子：明星 + 25 个粉丝 + 目标粉丝（全部直连 e2e 库）——
  const db = new Database(DB_PATH);
  db.prepare('INSERT INTO verification_codes (email, code, expires) VALUES (?, ?, ?)').run(
    viewerEmail,
    code,
    new Date(Date.now() + 10 * 60 * 1000).toISOString()
  );
  const insertUser = db.prepare(
    "INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, 'seed', 'user')"
  );
  const starId = Number(insertUser.run(`${prefix}star`, `${prefix}star@test.local`).lastInsertRowid);
  const follow = db.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)');
  for (let i = 1; i <= FAN_COUNT; i += 1) {
    const fanId = Number(
      insertUser.run(`${prefix}-f${String(i).padStart(2, '0')}`, `${prefix}-f${i}@test.local`).lastInsertRowid
    );
    follow.run(fanId, starId);
  }
  const targetFanId = Number(insertUser.run(targetFan, `${prefix}-ztarget@test.local`).lastInsertRowid);
  follow.run(targetFanId, starId);
  db.close();

  // —— 观众登录（真实注册接口；粉丝列表接口要求登录）——
  const reg = await request.post('/api/auth/register', {
    data: { username: viewerUsername, email: viewerEmail, password: 'e2e-Passw0rd-123', code },
  });
  expect(reg.status()).toBe(201);
  const { token } = (await reg.json()) as { token: string };
  await page.addInitScript((t) => localStorage.setItem('k_token', t), token);

  const followerResponse = (predicate: (url: string) => boolean) =>
    page.waitForResponse((r) => r.url().includes(`/api/friends/followers/${starId}?`) && predicate(r.url()));

  // —— 打开明星主页 → 点「粉丝」——
  await page.goto(`/profile/${starId}`);
  await expect(page.getByTestId('profile-followers-stat')).toBeVisible();

  const firstPage = followerResponse((url) => url.includes('page=1'));
  await page.getByTestId('profile-followers-stat').click();
  const firstResp = await firstPage;
  expect(firstResp.status()).toBe(200);
  const firstBody = (await firstResp.json()) as {
    users: { id: number; username: string }[];
    total: number;
    page: number;
    totalPages: number;
  };
  // 客户端必须带 page/limit（不带 page 服务端会退回老形状，分页就没了）
  expect(firstResp.url()).toContain('limit=20');
  expect(firstBody.page).toBe(1);
  expect(firstBody.users).toHaveLength(20);
  expect(firstBody.total).toBeGreaterThanOrEqual(FAN_COUNT + 1);
  expect(firstBody.totalPages).toBeGreaterThanOrEqual(2);
  // 目标粉丝不在第一页
  expect(firstBody.users.map((u) => u.username)).not.toContain(targetFan);

  const items = page.getByTestId('follower-item');
  await expect(items).toHaveCount(20);

  // —— 加载更多：按页追加，目标粉丝出现 ——
  const secondPage = followerResponse((url) => url.includes('page=2'));
  await page.getByTestId('followers-load-more').click();
  const secondResp = await secondPage;
  const secondBody = (await secondResp.json()) as { users: { username: string }[] };
  expect(secondBody.users.map((u) => u.username)).toContain(targetFan);
  await expect(items).toHaveCount(FAN_COUNT + 1); // 20 + 6
  await expect(page.getByText(targetFan)).toBeVisible();

  // —— 服务端搜索：输入只在第二页出现的用户名 ——
  const searchResp = followerResponse((url) => url.includes('q='));
  await page.getByTestId('followers-search').fill(targetFan);
  const found = await searchResp;
  const foundBody = (await found.json()) as {
    users: { username: string }[];
    total: number;
    totalPages: number;
  };
  expect(foundBody.total).toBe(1);
  expect(foundBody.users.map((u) => u.username)).toEqual([targetFan]);

  // 界面上只剩这一行（是替换而不是追加），且没有更多可加载
  await expect(items).toHaveCount(1);
  await expect(page.getByText(targetFan)).toBeVisible();
  await expect(page.getByTestId('followers-load-more')).toHaveCount(0);

  // —— 搜不到时给出空态文案 ——
  await page.getByTestId('followers-search').fill(`${prefix}-绝对没有这个粉丝`);
  await expect(page.getByText('未找到相关用户')).toBeVisible({ timeout: 10_000 });
});
