/**
 * 回归验证：B1 无限滚动 / B2 拖拽上传顺序
 * 全部通过 page.route 拦截，不写入真实数据库。
 */

import { test, expect, Page, Route } from '@playwright/test';

// ============================================================
// 工具：构造一条帖子（PostCard 所需字段齐全）
// ============================================================
function makePost(id: number, desc: string): Record<string, unknown> {
  return {
    id,
    user_id: 1,
    image_url: '[]',
    title: `post-${id}`,
    description: desc,
    close_comments: 0,
    pinned: 0,
    video_url: null,
    video_cover: null,
    share_count: 0,
    repost_count: 0,
    created_at: '2026-09-01T00:00:00.000Z',
    username: 'tester',
    avatar: null,
    like_count: 0,
    comment_count: 0,
    liked: 0,
    shared: 0,
    reposted: 0,
  };
}

const PAGE1 = Array.from({ length: 20 }, (_, i) => makePost(i + 1, `feed-item-${i + 1}`));
const PAGE2 = Array.from({ length: 5 }, (_, i) => makePost(21 + i, `feed-item-${21 + i}`));

/** 拦截信息流分页接口（仅 GET /api/posts?page=…） */
async function mockFeed(page: Page) {
  await page.route('**/api/posts?*', (route: Route) => {
    const url = new URL(route.request().url());
    const pageNum = parseInt(url.searchParams.get('page') || '1', 10);
    const posts = pageNum >= 2 ? PAGE2 : PAGE1;
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ posts, total: 25, page: pageNum, totalPages: 2 }),
    });
  });
}

// ============================================================
// B1：首页信息流无限滚动——首屏 20 条，滚动到底加载第二页
// ============================================================
test('B1 首页无限滚动加载更多', async ({ page }) => {
  await mockFeed(page);
  await page.goto('/');

  // 等首屏 20 张卡片渲染（每张一个 aria-label=点赞 按钮）
  const likeBtns = page.locator('button[aria-label="点赞"]');
  await expect(likeBtns).toHaveCount(20, { timeout: 15000 });

  // 滚动到底部，哨兵触发 fetchNextPage → 加载第二页 5 条
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(likeBtns).toHaveCount(25, { timeout: 15000 });

  // 第二页内容确实出现
  await expect(page.locator('body')).toContainText('feed-item-21');
});

// ============================================================
// B2：CreatePost 拖拽排序 → 实际上传顺序一致
// ============================================================
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

async function mockLogin(page: Page) {
  // 注入假 token + mock /auth/me，让 App 认为已登录
  await page.addInitScript(() => {
    localStorage.setItem('k_token', 'fake-token');
  });
  await page.route('**/api/auth/me**', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 1,
        username: 'tester',
        email: 't@t.com',
        avatar: null,
        bio: '',
        role: 'user',
        created_at: '2026-01-01T00:00:00.000Z',
      }),
    })
  );
  // 其余后台轮询请求必须 mock 掉：真实服务器会对假 token 返回 401，
  // axios 拦截器会触发 auth:expired 把用户登出（登录态会被立刻清掉）
  await page.route('**/api/notifications**', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ notifications: [], unread_count: 0 }),
    })
  );
  await page.route('**/api/messages/conversations**', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ conversations: [] }),
    })
  );
  await page.route('**/api/announcements**', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ announcements: [], unread_count: 0 }),
    })
  );
  await page.route('**/api/friends/recommend**', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ users: [] }) })
  );
  // P8：登录后预取关注列表（GET /api/friends）—— 也必须 mock，否则真实服务器 401 → auth:expired 登出。
  // 注意：Playwright 后注册的路由优先匹配，本路由会先于上面的 recommend 命中；
  // 同时返回 users 字段，避免 recommend 拿不到 {users} 导致渲染崩溃。
  await page.route('**/api/friends**', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ friends: [], users: [] }),
    })
  );
}

test('B2 拖拽排序后按新顺序上传', async ({ page }) => {
  await mockLogin(page);

  // 拦截提交：记录 multipart 中 images 字段（文件）出现顺序
  let uploadedOrder: string[] = [];
  await page.route('**/api/posts', (route: Route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataBuffer();
      if (body) {
        // 解析 multipart：每个 part 的 Content-Disposition 有 name="images"; filename="x.png"
        const text = body.toString('latin1');
        const re = /name="images"; filename="([^"]+)"/g;
        let m: RegExpExecArray | null;
        const names: string[] = [];
        while ((m = re.exec(text)) !== null) names.push(m[1]);
        uploadedOrder = names;
      }
      route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ ...makePost(999, 'posted'), images: [] }),
      });
      return;
    }
    // 首页信息流也需要：返回空（避免 404 干扰）
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ posts: [], total: 0, page: 1, totalPages: 1 }),
    });
  });
  // 带 query 的信息流请求也拦掉
  await page.route('**/api/posts?*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ posts: [], total: 0, page: 1, totalPages: 1 }),
    })
  );

  await page.goto('/');
  // 打开"分享"（侧边栏，仅登录后可见）
  await page.getByRole('button', { name: '分享' }).first().click();

  // 上传两张图（a.png、b.png）
  const fileInput = page.locator('input[type="file"][accept^="image/jpeg"]').first();
  await fileInput.setInputFiles([
    { name: 'a.png', mimeType: 'image/png', buffer: PNG_1x1 },
    { name: 'b.png', mimeType: 'image/png', buffer: PNG_1x1 },
  ]);

  // 等网格出现两张图
  const gridImgs = page.locator('div[class*="gridItem"] img');
  await expect(gridImgs).toHaveCount(2, { timeout: 10000 });
  const srcBefore = await gridImgs.evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).src));

  // 拖拽：把第 1 张拖到第 2 张的位置（pointerdown → move → up）
  const first = gridImgs.nth(0);
  const second = gridImgs.nth(1);
  const b1 = (await first.boundingBox())!;
  const b2 = (await second.boundingBox())!;
  await page.mouse.move(b1.x + b1.width / 2, b1.y + b1.height / 2);
  await page.mouse.down();
  await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2, { steps: 5 });
  await page.mouse.up();

  // 网格顺序应已交换（blob URL 顺序反转）
  const srcAfter = await gridImgs.evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).src));
  expect(srcAfter).not.toEqual(srcBefore);

  // 下一步 → 分享（提交）。注意：侧边栏也有"分享"按钮，这里限定在弹窗内
  await page.getByRole('button', { name: '继续' }).click();
  const modalShare = page.locator('div[class*="overlay"]').getByRole('button', { name: '分享' });
  await modalShare.click();

  // 断言上传顺序与拖拽后网格顺序一致（b 先于 a）
  await expect.poll(() => uploadedOrder.length).toBe(2);
  expect(uploadedOrder).toEqual(['b.png', 'a.png']);
});
