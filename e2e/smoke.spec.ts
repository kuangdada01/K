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
  // 搜索一个必然无结果的关键词：断言空态文案真实出现
  // （旧断言 body 包含 /帖子|没有|暂无|搜索/ 会被搜索框自身 placeholder 满足，恒真无保护力）
  await input.fill(`zzx-no-match-${Date.now()}`);
  await expect(page.getByText('未找到相关帖子')).toBeVisible({ timeout: 10_000 });
});

test('受保护路由未登录时重定向首页', async ({ page }) => {
  await page.goto('/profile/1');
  // ★ 关键断言是 **URL 回到首页**：此前只断「侧边栏可见 + 有『图书』」，
  //   而侧边栏在任何页面都存在 —— 重定向一旦坏掉（`/profile/1` 正常渲染），
  //   这条用例照样是绿的，等于没验。用 poll 做有界等待，不靠固定 sleep。
  await expect.poll(() => new URL(page.url()).pathname).toBe('/');
  await expect(page.locator('nav').first()).toBeVisible();
  await expect(page.locator('body')).toContainText('图书');
});

// 「未登录点赞 → 弹登录窗」不在这里：本文件是**只读公开流程**，而 e2e 库每轮重置，
// 无帖时那条断言只能跳过/空过（等于假绿）。它已移到 write-path.spec.ts ——
// 那里同一个文件先创建了帖子，数据是确定的，可以硬断言。
