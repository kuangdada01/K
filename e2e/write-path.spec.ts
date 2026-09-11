/**
 * ============================================================
 * E2E 真实写路径测试（注册 → 登录 → 发帖 → 点赞 → 评论）
 * ============================================================
 * 此前的 e2e 只覆盖公开只读流程（且用假 token + route mock），
 * 核心写路径（注册/发帖/互动）零覆盖。
 *
 * 数据隔离：
 * - playwright.config.ts 通过 DB_PATH 让服务端使用 e2e/.tmp/ 独立库，
 *   本文件直接对该库插入注册验证码（CI/本地均无 SMTP，send-code 接口会失败），
 *   注册本身走真实 UI + 服务端 bcrypt + zod 校验
 * - better-sqlite3 通过 createRequire 从 server/node_modules 加载
 *   （根目录 node_modules 无此依赖）
 */

import { test, expect } from '@playwright/test';
import type { Request } from '@playwright/test';
import { createRequire } from 'module';
import path from 'path';
import { DB_PATH } from './db-path';

// 锚定 server/package.json 解析 better-sqlite3（根目录 node_modules 无此原生依赖；
// 以 CJS require 加载，规避 Playwright TS 转译对 import.meta 的限制）
const require = createRequire(path.resolve('server/package.json'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试进程借用 server 的原生依赖
const Database = require('better-sqlite3') as any;

const stamp = Date.now();
const username = `e2e_${stamp}`;
const email = `e2e-${stamp}@test.local`;
const password = 'e2e-Passw0rd-123';
const code = String(100000 + (stamp % 900000)); // 6 位数字验证码
const postText = `e2e写路径全链路测试帖${stamp}`;

/** 1x1 PNG（合法图片，服务端 sharp 压缩可处理） */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

test('注册 → 登录态 → 发帖 → 点赞 → 评论 全链路', async ({ page }) => {
  // —— 种子：向独立测试库插入注册验证码（绕过无 SMTP 的 send-code）——
  const db = new Database(DB_PATH);
  db.prepare('INSERT INTO verification_codes (email, code, expires) VALUES (?, ?, ?)').run(
    email,
    code,
    new Date(Date.now() + 10 * 60 * 1000).toISOString()
  );
  db.close();

  // —— 打开登录/注册弹窗（侧边栏底部用户 chip → 菜单「登录」）——
  await page.goto('/');
  await page.getByRole('button').filter({ hasText: '登录后即可互动' }).first().click();
  await page.getByRole('menuitem', { name: '登录' }).click();

  // —— 切到注册模式并提交 ——
  await page.getByRole('button', { name: '注册', exact: true }).click();
  await page.getByPlaceholder('用户名').fill(username);
  await page.getByPlaceholder('邮箱').fill(email);
  await page.getByPlaceholder('密码', { exact: true }).fill(password);
  await page.getByPlaceholder('确认密码').fill(password);
  await page.getByPlaceholder('验证码').fill(code);
  await page.getByRole('button', { name: '注册', exact: true }).click();

  // 注册成功自动登录 → 侧边栏出现「分享」（发帖入口仅登录可见）
  const shareBtn = page.getByRole('button', { name: '分享' }).first();
  await expect(shareBtn).toBeVisible({ timeout: 10_000 });

  // —— 发帖（真实图片上传 multipart + 服务端压缩/入库）——
  // 注册后首页仍在重渲染（信息流/推荐位/SSE 接入），此时点击可能丢失 openCreate。
  // 此前用固定 `waitForTimeout(1500)` 规避：慢机上不保证够、快机上白等。
  // 改成**有界重试直到模态真的打开**（点击被吞掉就再点一次）。
  await expect(async () => {
    await shareBtn.click();
    await expect(page.getByText('选择照片/视频')).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15_000 });
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'e2e-post.png',
    mimeType: 'image/png',
    buffer: PNG,
  });
  // 步骤1（选媒体）→「继续」进入描述页
  await page.getByRole('button', { name: '继续' }).click();
  await page.locator('textarea').first().fill(postText);
  // 描述页提交按钮与侧边栏「分享」重名，取最后一个（模态框渲染在后）。
  // 拦截 POST /api/posts 确认 201；新帖 id 改直查独立测试库（更强地验证写库成功）。
  // 不能读响应体：发布成功后弹窗关闭会归还 history 条目（history.back），
  // Playwright 的响应体在导航后不可读（产品 UI 无感知，这是测试框架的限制）
  const postResponse = page.waitForResponse(
    (r) => r.url().includes('/api/posts') && r.request().method() === 'POST'
  );
  await page
    .getByRole('button', { name: /分享|发布中|上传中/ })
    .last()
    .click();
  const response = await postResponse;
  expect(response.status(), '发布接口应返回 201').toBe(201);

  const db2 = new Database(DB_PATH);
  const row = db2
    .prepare('SELECT id FROM posts WHERE description = ? ORDER BY id DESC LIMIT 1')
    .get(postText) as { id: number } | undefined;
  db2.close();
  expect(row?.id, '新帖应写入数据库').toBeGreaterThan(0);
  const postId = Number(row!.id);

  // 发布成功 → 信息流出现新帖（post:created 事件同步，无需手动刷新）
  await expect(page.getByText(postText).first()).toBeVisible({ timeout: 15_000 });

  // —— 进入帖子详情：走 /post/:id 分享链接路由 ——
  // 该路由 = 详情层覆盖在信息流之上：信息流按钮被覆盖收不到点击（actionability
  // 永远等待），详情层按钮在最上层。入场动画已被禁用，force 点击直击详情层。
  await page.goto(`/post/${postId}`);
  await page.addStyleTag({
    content:
      '*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; }',
  });
  // 详情层 = 同时包含「添加评论」输入框与「分享」按钮的最内层容器（信息流卡片不含评论框）。
  // 注意不能用「点赞」按钮做过滤条件：点赞后 aria-label 会翻转成「取消点赞」，容器会失配
  const detailPanel = page
    .locator('div')
    .filter({ has: page.getByPlaceholder('添加评论...') })
    .filter({ has: page.getByRole('button', { name: '分享' }) })
    .last();
  const likeBtn = detailPanel.getByRole('button', { name: '点赞', exact: true });
  await expect(likeBtn).toBeVisible({ timeout: 10_000 });

  // —— 点赞：详情层按钮点击后 aria-label 翻转为「取消点赞」（服务端失败会回滚）——
  // 此前是「点完等 1500ms，再断言按钮还亮着」—— 固定等待既慢又只是**猜**服务端已经往返完。
  // 改成等真实的点赞响应并断言 2xx：比等待更强（失败在这里直接红，而不是靠时间蒙）。
  const likeResponse = page.waitForResponse((r) =>
    /\/api\/posts\/\d+\/like$/.test(new URL(r.url()).pathname)
  );
  await likeBtn.click({ force: true });
  const unlikedBtn = detailPanel.getByRole('button', { name: '取消点赞', exact: true });
  await expect(unlikedBtn).toBeVisible({ timeout: 5_000 });
  expect((await likeResponse).ok(), '点赞请求应返回 2xx').toBe(true);
  await expect(unlikedBtn).toBeVisible();

  // —— A5 在途闸门：**快速双击只应发出一个请求**，最终停在「已点赞」——
  // 先取消点赞回到确定状态，再记录 like 请求序列。
  await unlikedBtn.click({ force: true });
  const relike = detailPanel.getByRole('button', { name: '点赞', exact: true });
  await expect(relike).toBeVisible({ timeout: 5_000 });

  const likeCalls: string[] = [];
  const trackLikes = (r: Request) => {
    if (/\/api\/posts\/\d+\/like$/.test(new URL(r.url()).pathname)) likeCalls.push(r.method());
  };
  page.on('request', trackLikes);
  try {
    await relike.dblclick({ force: true });
    await expect(detailPanel.getByRole('button', { name: '取消点赞', exact: true })).toBeVisible({
      timeout: 5_000,
    });
    // 「不该发生的事」需要一小段静默期才能确认：等首个请求结束后再看有没有第二个
    await page.waitForTimeout(400);
    expect(likeCalls, '双击只应发出一次点赞请求（在途闸门）').toEqual(['POST']);
    await expect(detailPanel.getByRole('button', { name: '取消点赞', exact: true })).toBeVisible();
  } finally {
    page.off('request', trackLikes);
  }

  // —— 评论：详情层评论框唯一；fill 需要稳定性，改 force 聚焦后用真实键盘输入 ——
  const commentText = `e2e评论${stamp}`;
  const composer = detailPanel.getByPlaceholder('添加评论...');
  await composer.click({ force: true });
  await page.keyboard.type(commentText);
  await expect(composer).toHaveValue(commentText);
  await detailPanel.getByRole('button', { name: '发送评论' }).click({ force: true });
  await expect(page.getByText(commentText).first()).toBeVisible({ timeout: 10_000 });
});

/**
 * 未登录访客点赞 → 弹登录窗。
 *
 * 从 `smoke.spec.ts` 移过来：那边是只读公开流程，而 e2e 库每轮重置后**没有帖子**，
 * 原实现 `if (count === 0) return` 会在空库下静默"通过"（假绿）；改成 `test.skip`
 * 也只是把假绿改成"永远跳过"，覆盖依旧是零。
 * 放在这里：同一个文件的前一个用例刚创建了帖子，数据是确定的 —— 可以**硬断言**
 * 「点赞按钮必须存在」，再用一个全新的浏览器 context 模拟未登录访客。
 */
test('未登录访客点赞 → 弹出登录窗口（用前一个用例创建的帖子）', async ({ browser }) => {
  const db = new Database(DB_PATH);
  const post = db.prepare('SELECT id FROM posts ORDER BY id DESC LIMIT 1').get() as
    { id: number } | undefined;
  db.close();
  expect(post, '前一个用例应已创建帖子（本用例依赖它，不再静默跳过）').toBeTruthy();

  const guestContext = await browser.newContext({ locale: 'zh-CN' });
  try {
    const guest = await guestContext.newPage();
    await guest.goto('http://localhost:3200/');
    const likeBtn = guest.locator('button[aria-label="点赞"]').first();
    // 硬断言：库里有帖子，点赞按钮就必须出现（此前的写法在这里会静默 return）
    await expect(likeBtn).toBeVisible({ timeout: 15_000 });
    await likeBtn.click();
    await expect(guest.locator('input[placeholder="邮箱"]').first()).toBeVisible();
  } finally {
    await guestContext.close();
  }
});
