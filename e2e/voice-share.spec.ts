/**
 * ============================================================
 * 屏幕共享 · 观看端画框比例跟随（2026-10-15）
 * ============================================================
 * 场景：共享端画面尺寸**中途变化**（手机上最典型：转去横屏游戏）时，观看端的画框比例
 * 必须跟着走 —— 否则横屏画面会被 contain 进一个竖屏比例的大框里、只在中间显示一小条
 * （用户实测："竖屏是全屏效果，但是横屏只有中间显示"）。
 *
 * 与象棋 spec 同一套设施：访客建房 → 双浏览器上下文进房；共享端的 `getDisplayMedia`
 * 用页面内一块可控 canvas 顶替（免系统选择器），先竖屏 360×640，中途改成横屏 640×360，
 * 断言观看端舞台的 `--share-aspect` 跟着从 0.5625 变到 1.7778。
 */

import { test, expect, type Page } from '@playwright/test';

const roomName = `e2e-share-${Date.now()}`;

/** 假 getUserMedia：立即可用的真实音频流（免权限弹窗，可正常建联） */
const MIC_INIT_SCRIPT = `
(() => {
  const ctx = new AudioContext();
  navigator.mediaDevices = navigator.mediaDevices || {};
  navigator.mediaDevices.getUserMedia = async () => ctx.createMediaStreamDestination().stream;
})();
`;

/**
 * 假 getDisplayMedia：页面内一块可控 canvas 出流。
 * `setInterval` 持续重绘 = 持续产帧（captureStream 只在画布有改动时产帧）；
 * 测试中途改 `canvas.width/height` 即可模拟"共享端旋转方向"。
 */
const FAKE_DISPLAY_MEDIA = `
(() => {
  const canvas = document.createElement('canvas');
  canvas.width = 360;
  canvas.height = 640;
  const g = canvas.getContext('2d');
  const paint = () => { g.fillStyle = '#2f6b4f'; g.fillRect(0, 0, canvas.width, canvas.height); };
  paint();
  setInterval(paint, 250);
  const stream = canvas.captureStream(15);
  window.__shareCanvas = canvas;
  navigator.mediaDevices.getDisplayMedia = async () => stream;
})();
`;

/** 进房并等到房间页就绪（麦克风假流可用） */
async function enterRoom(page: Page, name: string) {
  await page.addInitScript(MIC_INIT_SCRIPT);
  await page.goto('/voice');
  await page.getByText(name).first().click();
  await expect(page.locator('button[title="退出房间"]')).toBeVisible({ timeout: 15_000 });
}

/** 读观看端舞台上的比例变量（未写入时按 0） */
async function readStageAspect(page: Page): Promise<number> {
  const raw = await page
    .locator('div[style*="--share-aspect"]')
    .first()
    .evaluate((el) => (el as HTMLElement).style.getPropertyValue('--share-aspect'));
  return Number(raw) || 0;
}

/** 观看端页面里是否存在"比例符合"的 canvas（舞台画面就是一块 canvas；内部尺寸 = 解码尺寸） */
function hasCanvasRatio(page: Page, ratio: number, tolerance = 0.06) {
  return page.evaluate(
    ([r, tol]) =>
      Array.from(document.querySelectorAll('canvas')).some(
        (c) => c.width > 0 && c.height > 0 && Math.abs(c.width / c.height - r) < tol
      ),
    [ratio, tolerance]
  );
}

// 双上下文 + WebRTC 重配置，慢机上有余量；与象棋 spec 同口径放宽
test.setTimeout(150_000);

test('共享画面中途变尺寸（旋转）→ 观看端画框比例跟随', async ({ browser, request }) => {
  const created = await request.post('/api/voice/rooms', {
    data: { name: roomName, description: 'e2e 共享画框跟随（临时房间）' },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { room, ownerToken } = (await created.json()) as { room: { id: number }; ownerToken?: string };

  const contextA = await browser.newContext(); // 共享端（冒充"手机"：竖屏→横屏）
  const contextB = await browser.newContext(); // 观看端（web 端）
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  try {
    await pageA.addInitScript(FAKE_DISPLAY_MEDIA);
    await enterRoom(pageA, roomName);
    await enterRoom(pageB, roomName);

    // A 开始共享（假 getDisplayMedia：竖屏 360×640）
    await pageA.getByRole('button', { name: '共享屏幕' }).click();
    // 共享中会有两处「停止共享」（舞台控件 + 底部控制条），取第一个即可
    await expect(pageA.getByRole('button', { name: '停止共享' }).first()).toBeVisible({ timeout: 15_000 });

    // B 出现共享舞台，并收到竖屏画面（注意：断言**比例**而不是像素 ——
    // 无头环境的带宽估计会触发编码器自适应降分辨率，例如 360×640 → 180×320，
    // 比例不变；而"比例"才是本条测试要盯的东西）
    await expect(pageB.getByText(/正在共享/)).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() => hasCanvasRatio(pageB, 360 / 640), { message: '观看端应收到竖屏画面', timeout: 20_000 })
      .toBe(true);
    await expect
      .poll(() => readStageAspect(pageB), { message: '竖屏画框比例', timeout: 10_000 })
      .toBeCloseTo(360 / 640, 2);

    // ★ A 把画面转成横屏（模拟手机转去横屏游戏）：换尺寸，持续重绘会把新尺寸帧带过去
    await pageA.evaluate(() => {
      const c = (window as unknown as { __shareCanvas: HTMLCanvasElement }).__shareCanvas;
      c.width = 640;
      c.height = 360;
    });

    // B 的画框比例必须跟着变成横屏
    // （修复前：停在 0.5625 —— 横屏画面被 contain 进竖框里，只在中间显示一小条）
    await expect
      .poll(() => readStageAspect(pageB), { message: '横屏画框比例应跟随', timeout: 20_000 })
      .toBeCloseTo(640 / 360, 2);
    await expect
      .poll(() => hasCanvasRatio(pageB, 640 / 360), { message: '观看端应收到横屏画面', timeout: 20_000 })
      .toBe(true);
  } finally {
    await contextA.close();
    await contextB.close();
    const del = await request.delete(`/api/voice/rooms/${room.id}`, {
      headers: ownerToken ? { 'X-Voice-Owner-Token': ownerToken } : {},
    });
    expect(del.status(), '临时房间应能用归属令牌删除').toBe(200);
  }
});
