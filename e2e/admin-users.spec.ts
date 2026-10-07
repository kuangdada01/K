/**
 * ============================================================
 * E2E：管理端用户列表的服务端搜索与分页
 * ============================================================
 * 为什么值得一条 e2e：这条链路的**接缝**（客户端发什么参数、服务端回什么字段、
 * 客户端怎么解析）在单元测试里两侧都是各自造的假数据 —— 参数名写成 `keyword`、
 * 或服务端返回 `total_pages`，两边单测都会绿，界面上却是空表格。
 *
 * 覆盖的正是「改成服务端搜索」要解决的问题：
 * 目标用户**不在第一页**（排在 30 个种子用户之后），本地过滤时代根本搜不到，
 * 现在输入用户名应能直接搜出来，并且必须观察到是**服务端请求**带回了它。
 *
 * 数据隔离：与 write-path.spec.ts 同一套路 —— 直连 e2e 独立库造验证码，
 * 注册走真实接口；管理员身份由 `UPDATE users SET role='admin'` 就地提升，
 * 因此客户端 `/auth/me` 拿到的就是真实的管理员，全程无需 mock。
 */

import { test, expect } from '@playwright/test';
import { createRequire } from 'module';
import path from 'path';
import { DB_PATH } from './db-path';

// 锚定 server/package.json 解析 better-sqlite3（根目录 node_modules 无此原生依赖）
const require = createRequire(path.resolve('server/package.json'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试进程借用 server 的原生依赖
const Database = require('better-sqlite3') as any;

const stamp = Date.now();
const prefix = `zadm${stamp % 100000}`;
const adminUsername = `${prefix}admin`;
const adminEmail = `e2e-admin-${stamp}@test.local`;
const password = 'e2e-Passw0rd-123';
const code = String(100000 + (stamp % 900000));
/** 种子用户数：>20 才能造出第二页 */
const SEED_COUNT = 30;
/** 搜索目标：编号最大的那个，必然落在最后一页，绝不会出现在第一页 */
const targetUsername = `${prefix}-${String(SEED_COUNT).padStart(2, '0')}`;

test('管理端用户列表：服务端分页可达第二页，服务端搜索能找到不在第一页的用户', async ({ page, request }) => {
  // —— 种子：验证码 + 30 个用户（后 10 个必然在第二页）——
  const db = new Database(DB_PATH);
  db.prepare('INSERT INTO verification_codes (email, code, expires) VALUES (?, ?, ?)').run(
    adminEmail,
    code,
    new Date(Date.now() + 10 * 60 * 1000).toISOString()
  );
  const insertUser = db.prepare(
    "INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, 'seed', 'user')"
  );
  for (let i = 1; i <= SEED_COUNT; i += 1) {
    insertUser.run(`${prefix}-${String(i).padStart(2, '0')}`, `${prefix}-${i}@test.local`);
  }
  db.close();

  // —— 管理员账号：真实注册接口拿 token，再就地提升为 admin ——
  const reg = await request.post('/api/auth/register', {
    data: { username: adminUsername, email: adminEmail, password, code },
  });
  expect(reg.status()).toBe(201);
  const { token } = (await reg.json()) as { token: string };

  const db2 = new Database(DB_PATH);
  db2.prepare("UPDATE users SET role = 'admin' WHERE email = ?").run(adminEmail);
  db2.close();

  // —— 注入真实 token（客户端从 localStorage 的 k_token 读取）——
  await page.addInitScript((t) => localStorage.setItem('k_token', t), token);

  const usersResponse = (predicate: (url: string) => boolean) =>
    page.waitForResponse((r) => r.url().includes('/api/admin/users?') && predicate(r.url()));

  // —— 第一页 ——
  const firstPage = usersResponse((url) => url.includes('page=1'));
  await page.goto('/admin');
  const firstResp = await firstPage;
  expect(firstResp.status()).toBe(200);
  const firstBody = (await firstResp.json()) as {
    users: { username: string }[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
  // 客户端必须带上分页参数（否则服务端会退回老形状，分页就没了）
  expect(firstResp.url()).toContain('limit=20');
  expect(firstBody.page).toBe(1);
  expect(firstBody.users).toHaveLength(20);
  expect(firstBody.total).toBeGreaterThanOrEqual(SEED_COUNT);
  expect(firstBody.totalPages).toBeGreaterThanOrEqual(2);
  // 目标用户不在第一页 —— 这正是「本地过滤搜不到」的前提
  expect(firstBody.users.map((u) => u.username)).not.toContain(targetUsername);

  const rows = page.getByTestId('admin-users-table').locator('tbody tr');
  await expect(rows).toHaveCount(20);
  await expect(page.getByTestId('admin-users-page')).toHaveText(new RegExp(`^1 / ${firstBody.totalPages}$`));
  await expect(page.getByTestId('admin-users-prev')).toBeDisabled();

  // —— 翻到第二页（唯一能做到「看到目标用户」的方式，本地过滤时代不存在）——
  const secondPage = usersResponse((url) => url.includes('page=2'));
  await page.getByTestId('admin-users-next').click();
  const secondResp = await secondPage;
  expect(secondResp.status()).toBe(200);
  const secondBody = (await secondResp.json()) as { users: { username: string }[] };
  expect(secondBody.users.map((u) => u.username)).toContain(targetUsername);
  await expect(page.getByTestId('admin-users-page')).toHaveText(new RegExp(`^2 / ${firstBody.totalPages}$`));
  await expect(page.getByTestId('admin-users-prev')).toBeEnabled();

  // —— 服务端搜索：输入仅存在于后面页的用户名 ——
  const searchResp = usersResponse((url) => url.includes('q='));
  await page.getByTestId('admin-user-search').fill(targetUsername);
  const found = await searchResp;
  expect(found.status()).toBe(200);
  const foundBody = (await found.json()) as {
    users: { username: string }[];
    total: number;
    totalPages: number;
  };
  expect(foundBody.total).toBe(1);
  expect(foundBody.users.map((u) => u.username)).toEqual([targetUsername]);

  // 界面上只剩这一行，且搜索把页码重置回第 1 页（只有一页 → 分页控件消失）
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(targetUsername);
  await expect(page.getByTestId('admin-users-page')).toHaveCount(0);

  // —— 清空搜索词 → 回到完整的第一页 ——
  const cleared = usersResponse((url) => url.includes('page=1') && !url.includes('q='));
  await page.getByTestId('admin-user-search').fill('');
  await cleared;
  await expect(rows).toHaveCount(20);
});
