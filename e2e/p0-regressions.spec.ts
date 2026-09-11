/**
 * ============================================================
 * P0 缺陷的浏览器级回归（不是单测代餐）
 * ============================================================
 * 覆盖两个「真机上才会暴露」的 P0：
 *
 * 1. **P0-1 麦克风驻留 + 定时器永久泄漏**（A1 修复）
 *    在授权弹窗还没点、`getUserMedia` 还挂着的时候退出房间 —— 修复前：
 *    麦克风一直开着（系统指示灯常亮）、并泄漏一个永不停止的 100ms 说话检测轮询。
 *    这里用「延迟 resolve 的假 getUserMedia」把那一刻固定下来：
 *    建房 → 进房（getUserMedia 挂着）→ 退出 → 让迟到的流 resolve →
 *    断言 **轨道已 ended**（等于麦克风被关掉）且 **没有残留 100ms 定时器**。
 *
 * 2. **A5 乐观更新在途闸门**：双击点赞必须只发一次请求、最终状态是「已点赞」。
 *    （在 write-path 的详情层里补，那里数据确定。）
 *
 * 为什么不用 `--use-fake-device-for-media-stream`：那类启动参数依赖同一 worker 的
 * 浏览器实例，与其他 spec 共享时未必生效；这里直接给出一个**真实可 stop 的音频流**
 * （`AudioContext.createMediaStreamDestination()`），既不依赖权限，也不需要启动参数。
 */

import { test, expect } from '@playwright/test';

const roomName = `e2e-P0-1-${Date.now()}`;

/** 假 getUserMedia：延迟 N 毫秒才 resolve，并把流记到 window 上（可检查 readyState） */
const MIC_INIT_SCRIPT = `
(() => {
  const delayMs = 2500;
  window.__micStreams = [];
  const ctx = new AudioContext();
  navigator.mediaDevices = navigator.mediaDevices || {};
  navigator.mediaDevices.getUserMedia = async () => {
    const stream = ctx.createMediaStreamDestination().stream;
    window.__micStreams.push(stream);
    await new Promise((r) => setTimeout(r, delayMs));
    return stream;
  };
  // 统计存活的定时器（按周期）——说话检测轮询是 100ms
  window.__liveIntervals = new Map();
  const rawSet = window.setInterval.bind(window);
  const rawClear = window.clearInterval.bind(window);
  window.setInterval = (fn, ms, ...rest) => {
    const id = rawSet(fn, ms, ...rest);
    window.__liveIntervals.set(id, ms ?? 0);
    return id;
  };
  window.clearInterval = (id) => {
    window.__liveIntervals.delete(id);
    return rawClear(id);
  };
})();
`;

test('P0-1：授权弹窗期间退出房间 → 麦克风必须关闭、且不残留说话检测定时器', async ({ page, request }) => {
  // 访客建房（无需登录），拿到归属令牌以便收尾清理
  const created = await request.post('/api/voice/rooms', {
    data: { name: roomName, description: 'e2e P0-1 回归（临时房间）' },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { room, ownerToken } = (await created.json()) as {
    room: { id: number };
    ownerToken?: string;
  };
  expect(room.id).toBeGreaterThan(0);

  try {
    await page.addInitScript(MIC_INIT_SCRIPT);
    await page.goto('/voice');

    // 进入刚建的房间 → 触发 join() → getUserMedia 挂起 2.5s（等价于「授权弹窗还没点」）
    await page.getByText(roomName).first().click();
    const leaveBtn = page.locator('button[title="退出房间"]');
    await expect(leaveBtn).toBeVisible({ timeout: 10_000 });

    // ★ 就在这一刻退出（getUserMedia 尚未 resolve）
    await leaveBtn.click();

    // 让「迟到的授权结果」到达：修复前的代码会拿着这个流继续建图/开麦
    await page.waitForFunction(
      () => (window as never as { __micStreams: unknown[] }).__micStreams.length > 0,
      undefined,
      {
        timeout: 15_000,
      }
    );

    const read = () =>
      page.evaluate(() => {
        const w = window as never as {
          __micStreams: MediaStream[];
          __liveIntervals: Map<number, number>;
        };
        const tracks = w.__micStreams.flatMap((s) => s.getTracks().map((t) => t.readyState));
        const periods = [...w.__liveIntervals.values()];
        return { tracks, live100: periods.filter((p) => p === 100).length, liveTotal: periods.length };
      });

    // 有序等待「流被停掉」发生（有界轮询，不用固定 sleep）
    await expect
      .poll(async () => (await read()).tracks.every((s) => s === 'ended'), { timeout: 10_000 })
      .toBe(true);

    const state = await read();
    expect(state.tracks.length, '应当至少拿到一条麦克风轨道').toBeGreaterThan(0);
    expect(state.tracks, '退出后麦克风轨道必须全部 ended（修复前是 live）').toEqual(
      state.tracks.map(() => 'ended')
    );
    expect(state.live100, '退出后不得残留 100ms 说话检测定时器').toBe(0);
  } finally {
    // 收尾：用归属令牌删掉临时房间（顺带再验一次 P2-25 的令牌路径）
    const del = await request.delete(`/api/voice/rooms/${room.id}`, {
      headers: ownerToken ? { 'X-Voice-Owner-Token': ownerToken } : {},
    });
    expect(del.status(), '临时房间应能用归属令牌删除').toBe(200);
  }
});
