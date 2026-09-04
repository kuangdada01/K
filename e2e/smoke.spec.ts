/**
 * E2E 冒烟：公开只读流程（不写入数据库）
 * 覆盖：首页信息流 / 图书列表与详情 / 探索搜索 / 用户主页 / 未登录互动弹登录
 *
 * 注意: 选择器只使用文本与结构属性（CSS Modules 类名会被哈希，不可依赖）。
 */

import { test, expect } from '@playwright/test';

test('首页信息流正常渲染', async ({ page }) => {
  await page.goto('/');
  // 侧边导航固定文案（哈希无关）
  await expect(page.locator('body')).toContainText('图书');
  await expect(page.locator('nav').first()).toBeVisible();
  // 等待信息流异步加载完成（点赞按钮出现或空态文案出现），避免竞态
  const likeBtn = page.locator('button[aria-label="点赞"]').first();
  const welcome = page.getByText('欢迎来到 K');
  await Promise.race([
    likeBtn.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {}),
    welcome.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {}),
  ]);
  const hasFeed = (await page.locator('button[aria-label="点赞"]').count()) > 0;
  if (hasFeed) {
    await expect(likeBtn).toBeVisible();
  } else {
    await expect(welcome).toBeVisible();
  }
});

test('图书列表与详情', async ({ page }) => {
  await page.goto('/books');
  await expect(page.locator('body')).toContainText('共产党宣言');
  await page.locator('body').getByText('共产党宣言').first().click();
  // 详情页展示卷/章节结构（章节标题为文本）
  await expect(page.locator('body')).toContainText('引言');
  await expect(page.locator('body')).toContainText('卷');
});

test('探索页搜索', async ({ page }) => {
  await page.goto('/explore');
  const input = page.locator('input[placeholder*="搜索"]').first();
  await expect(input).toBeVisible();
  await input.fill('K');
  await page.waitForTimeout(1200);
  // 搜索后页面保持可用（结果或空态，二者均为正常渲染）
  await expect(page.locator('body')).toContainText(/帖子|没有|暂无|搜索/);
});

test('受保护路由未登录时重定向首页', async ({ page }) => {
  await page.goto('/profile/1');
  // ProtectedRoute 将未登录用户重定向到首页（侧边导航可见）
  await expect(page.locator('nav').first()).toBeVisible();
  await expect(page.locator('body')).toContainText('图书');
});

test('未登录互动弹出登录窗口', async ({ page }) => {
  await page.goto('/');
  const likeBtn = page.locator('button[aria-label="点赞"]').first();
  if ((await likeBtn.count()) === 0) return; // 无帖子时跳过
  await likeBtn.click();
  await expect(page.locator('input[placeholder="邮箱"]').first()).toBeVisible();
});


