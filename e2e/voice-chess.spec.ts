/**
 * ============================================================
 * 语音房间对战象棋 E2E（双浏览器上下文全链路）
 * ============================================================
 * 覆盖方案文档 §9 的核心浏览器级流程：
 * 访客建房 → 两个访客（同 IP 独立负数 id）进房 → 成员卡发起对弈 →
 * 接受 → 双方棋盘同步渲染 → 双方各走一步（走子提示/合法落点）→
 * 认输（window.confirm）→ 双方看到终局横幅（胜/负视角文案）。
 *
 * 选择器只用文本与 data-testid（CSS Modules 类名哈希不可依赖；
 * 棋盘热区 testid 携带引擎坐标，与双方视角无关）。
 * 麦克风用 AudioContext 假流替代（同 p0-regressions 的做法，免权限弹窗）。
 */

import { test, expect, type Page } from '@playwright/test';

const roomName = `e2e-chess-${Date.now()}`;

/** 假 getUserMedia：立即可用的真实音频流（免权限弹窗，可正常建联） */
const MIC_INIT_SCRIPT = `
(() => {
  const ctx = new AudioContext();
  navigator.mediaDevices = navigator.mediaDevices || {};
  navigator.mediaDevices.getUserMedia = async () => ctx.createMediaStreamDestination().stream;
})();
`;

/**
 * 记录"实际发声的是谁"：BufferSource = 用户给的四个素材；
 * Oscillator = 合成音（**行内已删除**这一套，出现即回归）。
 *
 * 为什么要端到端盯这一条：线上 09-29 报过「web 端落子还是之前的声音，App 里是我给的音效」——
 * 当时素材取不到/解码失败/手势之前收到广播时会**静默**回落合成音，界面与听感都只是
 * "声音不对"，没有任何线索。单测（client/src/voice/chess/sounds.test.ts）盯逻辑，
 * 这里盯真实浏览器 + 真实 http 资源。
 */
const AUDIO_LOG_SCRIPT = `
(() => {
  const events = (window.__sndEvents = []);
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  const wrap = (name, tag) => {
    const orig = AC.prototype[name];
    if (!orig) return;
    AC.prototype[name] = function (...args) {
      const node = orig.apply(this, args);
      if (node && node.start) {
        const start = node.start.bind(node);
        node.start = (...a) => { events.push(tag); return start(...a); };
      }
      return node;
    };
  };
  wrap('createBufferSource', 'sample');   // 素材
  wrap('createOscillator', 'synth');      // 合成音（不该再出现）
  const of = window.fetch;
  window.fetch = function (input) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const p = of.apply(this, arguments);
    if (url.includes('/chess/sounds/')) {
      p.then((r) => { if (!r.ok) events.push('sample-http-' + r.status); }).catch(() => events.push('sample-http-err'));
    }
    return p;
  };
})();
`;

/** 进房并等到成员网格出现（麦克风假流 + 音频探针已注入） */
async function enterRoom(page: Page, name: string) {
  await page.addInitScript(MIC_INIT_SCRIPT);
  await page.addInitScript(AUDIO_LOG_SCRIPT);
  await page.goto('/voice');
  await page.getByText(name).first().click();
  await expect(page.locator('button[title="退出房间"]')).toBeVisible({ timeout: 15_000 });
}

/** 取该页记录到的发声事件 */
async function soundEvents(page: Page): Promise<string[]> {
  return page.evaluate(() => ((window as unknown as { __sndEvents?: string[] }).__sndEvents ?? []).slice());
}

test('双人对弈全流程：邀请→开局→走子同步→认输终局', async ({ browser, request }) => {
  const created = await request.post('/api/voice/rooms', {
    data: { name: roomName, description: 'e2e 象棋对局（临时房间）' },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { room, ownerToken } = (await created.json()) as { room: { id: number }; ownerToken?: string };

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  try {
    await enterRoom(pageA, roomName);
    await enterRoom(pageB, roomName);

    // A 侧成员卡上出现"对弈"入口（B 的卡，非本人；A 自己的卡没有）
    const inviteBtnA = pageA.getByRole('button', { name: '对弈' }).first();
    await expect(inviteBtnA).toBeVisible({ timeout: 10_000 });
    await expect(pageA.getByRole('button', { name: '对弈' })).toHaveCount(1);
    await inviteBtnA.click();

    // A：等待应答横幅；B：收到邀请横幅并接受
    await expect(pageA.getByText('等待应答')).toBeVisible({ timeout: 10_000 });
    const inviteBanner = pageB.getByTestId('chess-invite');
    await expect(inviteBanner).toBeVisible({ timeout: 10_000 });
    await inviteBanner.getByRole('button', { name: '接受' }).click();

    // 双方棋盘出现，初始 32 子，状态条显示"轮到你走"（A 执红先行）
    const boardA = pageA.getByTestId('chess-board');
    const boardB = pageB.getByTestId('chess-board');
    await expect(boardA).toBeVisible({ timeout: 10_000 });
    await expect(boardB).toBeVisible();
    await expect(pageA.getByText('轮到你走')).toBeVisible();
    await expect(pageB.getByText('轮到红方')).toBeVisible();
    await expect
      .poll(() => boardA.locator('[data-testid^="chess-piece-"]').count(), { timeout: 10_000 })
      .toBe(32);
    await expect
      .poll(() => boardB.locator('[data-testid^="chess-piece-"]').count(), { timeout: 10_000 })
      .toBe(32);

    // A 走"炮二平五"：(7,2)→(4,2)。热区 testid 携带引擎坐标，与视角无关
    await pageA.getByTestId('chess-hot-7-2').click();
    // 合法落点提示出现后点击目标
    await pageA.getByTestId('chess-hot-4-2').click();

    // B 的棋盘同步：炮消失于 (7,2)、出现在 (4,2)
    await expect(pageB.getByTestId('chess-piece-7-2')).toHaveCount(0, { timeout: 10_000 });
    await expect(pageB.getByTestId('chess-piece-4-2')).toHaveCount(1);
    // B 变为轮到己方
    await expect(pageB.getByText('轮到你走')).toBeVisible({ timeout: 10_000 });

    /*
     * 落子音必须真的播用户给的素材（BufferSource），而不是合成音（Oscillator）。
     * 存量坑：素材没就位时老实现会**静默**改播合成音 —— 用户听到的只是"声音不对"
     * （线上 09-29："web 端落子还是之前的声音"）。双方都要响，且都不能是合成音。
     */
    await expect.poll(async () => (await soundEvents(pageA)).length, { timeout: 5_000 }).toBeGreaterThan(0);
    const sndA = await soundEvents(pageA);
    const sndB = await soundEvents(pageB);
    expect(sndA, `A 端应播素材：${sndA.join(',')}`).toContain('sample');
    expect(sndB, `B 端应播素材：${sndB.join(',')}`).toContain('sample');
    expect(
      sndA.filter((e) => e === 'synth'),
      'A 端不该回落合成音'
    ).toHaveLength(0);
    expect(
      sndB.filter((e) => e === 'synth'),
      'B 端不该回落合成音'
    ).toHaveLength(0);
    expect(
      sndA.filter((e) => e.startsWith('sample-http')),
      '素材必须取得到'
    ).toHaveLength(0);

    // B 应一手：黑马 (1,9)→(2,7)（马走日，蹩腿位 (1,8) 为空，合法）
    await pageB.getByTestId('chess-hot-1-9').click();
    await pageB.getByTestId('chess-hot-2-7').click();
    await expect(pageA.getByTestId('chess-piece-1-9')).toHaveCount(0, { timeout: 10_000 });
    await expect(pageA.getByTestId('chess-piece-2-7')).toHaveCount(1);
    // A 的上一步标记出现（B 的马落点）
    await expect(pageA.getByTestId('chess-board').locator('[class*="lastMoveMark"]')).toHaveCount(2);

    // A 认输（confirm 弹窗需显式接受）
    pageA.on('dialog', (d) => d.accept());
    await pageA.getByRole('button', { name: '认输' }).click();

    // 双方终局横幅：A 输、B 赢（A 执红 → red-win 归 B）
    await expect(pageA.getByTestId('chess-ended')).toBeVisible({ timeout: 10_000 });
    await expect(pageA.getByText('你输了')).toBeVisible();
    await expect(pageB.getByTestId('chess-ended')).toBeVisible();
    await expect(pageB.getByText('你赢了')).toBeVisible();

    // 三期：终局横幅"复盘"直达回放；⏭ 跳到终局；记谱可见
    await pageA.getByRole('button', { name: '复盘' }).click();
    const review = pageA.getByTestId('chess-review');
    await expect(review).toBeVisible({ timeout: 10_000 });
    const reviewBoard = review.getByTestId('chess-board');
    await expect(reviewBoard).toBeVisible();
    await pageA.getByRole('button', { name: '跳到终局' }).click();
    await expect(review.getByText('马8进7')).toBeVisible();
    // 返回列表能看到该局，再点回回放
    await pageA.getByRole('button', { name: '返回列表' }).click();
    await expect(review.getByText('未登录-1（红） vs 未登录-2（黑）')).toBeVisible();
    await review.locator('button', { hasText: '未登录-1（红） vs 未登录-2（黑）' }).click();
    await expect(review.getByTestId('chess-board')).toBeVisible();
    await pageA.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(pageA.getByTestId('chess-review')).toHaveCount(0);

    // 音效开关：**两态**（开 / 关）。素材就位后标题说明是哪四个音；
    // 素材加载中/失败会另外点明（见 sounds.ts 的素材状态）。
    // 曾经是"经典 / 合成 / 关"三态循环 + 一套合成备用音效，09-29 连出两次事故后整体删除。
    const soundToggle = pageA.getByTestId('chess-sound-toggle');
    await expect(soundToggle).toHaveAttribute('title', '音效：开（落子 / 吃子 / 将军 / 绝杀）');
    await soundToggle.click();
    await expect(soundToggle).toHaveAttribute('title', '音效：关（点击开启）');
    await soundToggle.click();
    await expect(soundToggle).toHaveAttribute('title', '音效：开（落子 / 吃子 / 将军 / 绝杀）');

    // 三期四：再来一局（双向点击直开）——A 刷新后横幅仍在（快照恢复），
    // A 点"再来一局"转等待态，B 的按钮转"点击开始"，B 点击即开新局
    await pageA.reload();
    // 访客刷新后不会自动回房（自动回房仅登录用户），需重新点击进入
    await pageA.getByText(roomName).first().click();
    await expect(pageA.getByTestId('chess-ended')).toBeVisible({ timeout: 10_000 });
    await pageA.getByTestId('chess-rematch').click();
    await expect(pageA.getByTestId('chess-rematch')).toHaveText('等待对方再来一局…');
    await expect(pageB.getByTestId('chess-rematch')).toHaveText('对方想再来一局 · 点击开始', {
      timeout: 10_000,
    });
    await pageB.getByTestId('chess-rematch').click();
    await expect(pageA.getByTestId('chess-board')).toBeVisible({ timeout: 10_000 });
    await expect(pageB.getByTestId('chess-board')).toBeVisible();
    await expect
      .poll(() => pageA.getByTestId('chess-board').locator('[data-testid^="chess-piece-"]').count())
      .toBe(32);

    // 重开后是新的一局（进行中）：终局横幅/收起按钮随新局消失，面板回到对局态
    await expect(pageA.getByTestId('chess-ended')).toHaveCount(0);
    await expect(pageB.getByTestId('chess-ended')).toHaveCount(0);
  } finally {
    await contextA.close();
    await contextB.close();
    const del = await request.delete(`/api/voice/rooms/${room.id}`, {
      headers: ownerToken ? { 'X-Voice-Owner-Token': ownerToken } : {},
    });
    expect(del.status(), '临时房间应能用归属令牌删除').toBe(200);
  }
});
