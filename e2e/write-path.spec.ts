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
import { createRequire } from 'module';
import path from 'path';

// 锚定 server/package.json 解析 better-sqlite3（根目录 node_modules 无此原生依赖；
// 以 CJS require 加载，规避 Playwright TS 转译对 import.meta 的限制）
const require = createRequire(path.resolve('server/package.json'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试进程借用 server 的原生依赖
const Database = require('better-sqlite3') as any;

const DB_PATH = path.resolve('e2e/.tmp/k-e2e.db');
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
  // 注册后首页仍在重渲染（信息流/推荐位/SSE 接入），立即点击会丢失 openCreate：
  // 等页面静默片刻再点（探针验证：延迟后点击模态稳定打开）
  await page.waitForTimeout(1500);

  // —— 发帖（真实图片上传 multipart + 服务端压缩/入库）——
  await shareBtn.click();
  await expect(page.getByText('选择照片/视频')).toBeVisible({ timeout: 10_000 });
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'e2e-post.png',
    mimeType: 'image/png',
    buffer: PNG,
  });
  // 步骤1（选媒体）→「继续」进入描述页
  await page.getByRole('button', { name: '继续' }).click();
  await page.locator('textarea').first().fill(postText);
  // 描述页提交按钮与侧边栏「分享」重名，取最后一个（模态框渲染在后）；
  // 同时拦截 POST /api/posts 的响应拿新帖 id（响应返回即已提交，无跨进程读库的时序问题）
  const postResponse = page.waitForResponse(
    (r) => r.url().includes('/api/posts') && r.request().method() === 'POST' && r.status() === 201
  );
  await page
    .getByRole('button', { name: /分享|发布中|上传中/ })
    .last()
    .click();
  const respJson = await (await postResponse).json();
  const postId = Number(respJson.id);
  expect(postId, '发布接口应返回新帖 id').toBeGreaterThan(0);

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
  await likeBtn.click({ force: true });
  const unlikedBtn = detailPanel.getByRole('button', { name: '取消点赞', exact: true });
  await expect(unlikedBtn).toBeVisible({ timeout: 5_000 });
  await page.waitForTimeout(1500); // 等服务端往返：失败会回滚回「点赞」
  await expect(unlikedBtn).toBeVisible();

  // —— 评论：详情层评论框唯一；fill 需要稳定性，改 force 聚焦后用真实键盘输入 ——
  const commentText = `e2e评论${stamp}`;
  const composer = detailPanel.getByPlaceholder('添加评论...');
  await composer.click({ force: true });
  await page.keyboard.type(commentText);
  await expect(composer).toHaveValue(commentText);
  await detailPanel.getByRole('button', { name: '发送评论' }).click({ force: true });
  await expect(page.getByText(commentText).first()).toBeVisible({ timeout: 10_000 });
});
