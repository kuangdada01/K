/**
 * ============================================================
 * 移动端发布模态框可滚动性回归测试
 * ============================================================
 * 问题：移动端（窄/矮视口）发布界面固定 100dvh，内容超出时被裁切且无法滚动：
 * - 步骤1（8图网格）：网格作为 flex 子项被压缩（行重叠/底部裁切）且无可滚动容器
 * - 步骤2（视频封面）：右侧面板 flex-shrink:0 只按内容撑高，超出即被整体裁掉
 * 修复后要求：
 * - gridWrapper 自身可滚动（网格 flex-shrink:0 自撑）
 * - coverRight 占满剩余高度并内部滚动
 * 测量：强制滚动所有祖先滚动容器后，目标元素底边应落在容器可视区内。
 */

import { test, expect } from '@playwright/test';
import { createRequire } from 'module';
import path from 'path';

// 与 write-path.spec.ts 相同：锚定 server/package.json 解析 better-sqlite3
const require = createRequire(path.resolve('server/package.json'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Database = require('better-sqlite3') as any;

const DB_PATH = path.resolve('e2e/.tmp/k-e2e.db');
const stamp = Date.now();
const username = `scroll_${stamp}`;
const email = `scroll-${stamp}@test.local`;
const password = 'e2e-Passw0rd-123';
const code = String(100000 + (stamp % 900000));

/** 1x1 PNG（封面图） */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
/** 竖版 PNG（24x96，步骤3 左侧预览需要高度才会压缩编辑栏） */
function solidPng(width: number, height: number) {
  const zlib = require('zlib');
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
    return Buffer.concat([len, typeBuf, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const o = y * (1 + width * 3) + 1 + x * 3;
      raw[o] = 180;
      raw[o + 1] = 190;
      raw[o + 2] = 210;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const PORTRAIT_PNG = solidPng(24, 96);
/** 假 mp4（仅 ftyp box，浏览器/服务端都无法解码 → 封面步骤的兜底面板） */
const FAKE_MP4 = Buffer.from('000000186674797069736f6d0000000069736f6d69736f6d', 'hex');

/**
 * 滚动可达性检查：
 * 1. 记录容器/目标的几何与容器 scrollHeight/clientHeight
 * 2. 从目标一路向上把所有祖先（含容器）scrollTop 拉到最大值
 * 3. 返回目标底边是否 <= 容器底边且 <= 视口高度
 */
async function dialogCoversViewport(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const d = document.querySelector('[class*="dialog"]') as HTMLElement | null;
    if (!d) return { ok: false, reason: 'dialog missing' };
    const r = d.getBoundingClientRect();
    return {
      ok: Math.abs(r.top) < 1 && Math.abs(r.bottom - window.innerHeight) < 1,
      top: +r.top.toFixed(1),
      bottom: +r.bottom.toFixed(1),
      viewportH: window.innerHeight,
    };
  });
}
async function scrollCheck(page: import('@playwright/test').Page, containerCls: string, targetCls: string) {
  return page.evaluate(
    ({ containerCls, targetCls }) => {
      const c = document.querySelector(`[class*="${containerCls}"]`) as HTMLElement | null;
      const t = document.querySelector(`[class*="${targetCls}"]`) as HTMLElement | null;
      if (!c || !t) return { ok: false, reason: `${containerCls}/${targetCls} missing` };
      const rect = (el: HTMLElement) => {
        const r = el.getBoundingClientRect();
        return { top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1) };
      };
      const out: Record<string, unknown> = { ok: true, container: rect(c), target: rect(t) };
      out.containerScroll = { clientH: c.clientHeight, scrollH: c.scrollHeight, scrollTop: c.scrollTop };
      out.viewportH = window.innerHeight;
      // 从目标向上把所有祖先（含容器）scrollTop 拉到最大
      let el: HTMLElement | null = t;
      while (el) {
        el.scrollTop = el.scrollHeight;
        if (el === c) break;
        el = el.parentElement;
      }
      out.after = {
        container: rect(c),
        target: rect(t),
        containerScrollTop: c.scrollTop,
      };
      out.reachable = rect(t).bottom <= rect(c).bottom + 1 && rect(t).bottom <= window.innerHeight + 1;
      out.scrolled = c.scrollTop > 0;
      out.overflow = c.scrollHeight > c.clientHeight;
      return out;
    },
    { containerCls, targetCls }
  );
}

test('移动端窄视口：发布模态框三步内容均可滚动到底部', async ({ page }) => {
  // —— 种子注册验证码 ——
  const db = new Database(DB_PATH);
  db.prepare('INSERT INTO verification_codes (email, code, expires) VALUES (?, ?, ?)').run(
    email,
    code,
    new Date(Date.now() + 10 * 60 * 1000).toISOString()
  );
  db.close();

  await page.goto('/');
  await page.addStyleTag({
    content:
      '*, *::before, *::after { animation-duration: 0.01s !important; transition-duration: 0s !important; }',
  });

  // —— 桌面宽度注册/登录，再打开发布模态框 ——
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('button').filter({ hasText: '登录后即可互动' }).first().click();
  await page.getByRole('menuitem', { name: '登录' }).click();
  await page.getByRole('button', { name: '注册', exact: true }).click();
  await page.getByPlaceholder('用户名').fill(username);
  await page.getByPlaceholder('邮箱').fill(email);
  await page.getByPlaceholder('密码', { exact: true }).fill(password);
  await page.getByPlaceholder('确认密码').fill(password);
  await page.getByPlaceholder('验证码').fill(code);
  await page.getByRole('button', { name: '注册', exact: true }).click();
  await expect(page.getByRole('button', { name: '分享', exact: true }).first()).toBeVisible({
    timeout: 10_000,
  });
  await page.waitForTimeout(1500); // 等首页重渲染静默，避免 openCreate 事件丢失

  await page.getByRole('button', { name: '分享', exact: true }).first().click();
  await expect(page.getByText('选择照片/视频')).toBeVisible({ timeout: 10_000 });

  // ===== 步骤 1：8 图 + 添加格 = 3 行网格；横屏矮视口下必超出（目标：+ 添加格子） =====
  await page.setViewportSize({ width: 568, height: 320 });
  // 移动端弹层必须严丝合缝全屏（不露背景页；Chrome 安卓 dvh 与 fixed 容器
  // 高度不一致曾导致顶部露出页面）。先等 scale-in 动画结束（0.95 缩放会
  // 让 getBoundingClientRect 偏小），再测量。
  await page.waitForTimeout(150);
  let fs = await dialogCoversViewport(page);
  expect(fs.ok, `步骤1视口：弹层应全屏覆盖（${JSON.stringify(fs)}）`).toBe(true);
  const files = Array.from({ length: 8 }, (_, i) => ({
    name: `p${i}.png`,
    mimeType: 'image/png',
    buffer: PORTRAIT_PNG,
  }));
  await page.locator('input[type="file"]').first().setInputFiles(files as never);
  await expect(page.locator('[class*="gridItem"]')).toHaveCount(8);

  let m = await scrollCheck(page, 'gridWrapper', 'gridAdd');
  console.log('[step1 gridWrapper]', JSON.stringify(m));
  expect(m.ok, 'gridAdd 元素应存在').toBe(true);
  expect(m.overflow, '步骤1：短视口下网格应超出容器').toBe(true);
  expect(m.scrolled, '步骤1：gridWrapper 应可滚动').toBe(true);
  expect(m.reachable, '步骤1：添加格子应可通过滚动到达').toBe(true);

  // ===== 步骤 2：视频封面（目标：截帧滑块） =====
  await page.setViewportSize({ width: 330, height: 440 });
  await page.waitForTimeout(150); // 等 scale-in 动画结束再测量
  fs = await dialogCoversViewport(page);
  expect(fs.ok, `步骤2视口：弹层应全屏覆盖（${JSON.stringify(fs)}）`).toBe(true);
  await page
    .locator('input[type="file"]')
    .nth(1)
    .setInputFiles({ name: 'v.mp4', mimeType: 'video/mp4', buffer: FAKE_MP4 });
  await expect(page.getByText('选择封面')).toBeVisible({ timeout: 10_000 });
  // 上传一张封面图，撑高右侧面板内容（重现"内容超出一屏被裁掉"）
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'cover.png',
    mimeType: 'image/png',
    buffer: PNG,
  });
  await expect(page.locator('[class*="coverImage"]')).toBeVisible();
  m = await scrollCheck(page, 'coverRight', 'coverSliderRow');
  console.log('[step2 coverRight]', JSON.stringify(m));
  expect(m.ok, 'coverRight 与滑块行应存在').toBe(true);
  expect(m.overflow, '步骤2：封面面板内容应超出容器').toBe(true);
  expect(m.scrolled, '步骤2：coverRight 应可滚动').toBe(true);
  expect(m.reachable, '步骤2：截帧滑块应可通过滚动到达').toBe(true);

  // ===== 步骤 3：编辑分享（目标：高级设置按钮） =====
  await page.getByRole('button', { name: '下一步' }).click();
  await expect(page.getByText('编辑', { exact: true })).toBeVisible({ timeout: 10_000 });
  m = await scrollCheck(page, 'editRight', 'advancedToggle');
  console.log('[step3 editRight]', JSON.stringify(m));
  expect(m.ok, 'editRight 与高级设置按钮应存在').toBe(true);
  expect(m.overflow, '步骤3：编辑栏内容应超出容器').toBe(true);
  expect(m.reachable, '步骤3：高级设置按钮应可通过滚动到达').toBe(true);
});