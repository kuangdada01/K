/**
 * nativeImageViewer 单测（网页侧契约）：
 * 原生查看器依赖网页层给出的坐标与能力判断，这里把契约钉死：
 * - 网页端/桌面 → 不可用、openNativeViewer 返回 null（调用方据此回退 Web 查看器）
 * - rectOf 必须返回**物理像素**（CSS px × devicePixelRatio），
 *   原生侧不再做任何缩放换算（早期版本用 WebView.getScale() 猜，会从错误位置放大）
 * - k_viewer_hero=off 时不给 Hero 矩形（真机应急开关）
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isNativeViewerAvailable, openNativeViewer, rectOf } from './nativeImageViewer';

/** 造一个带 rect 的假元素 */
function fakeEl(rect: { left: number; top: number; width: number; height: number }) {
  const el = document.createElement('div');
  el.getBoundingClientRect = () =>
    ({
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    }) as DOMRect;
  return el;
}

function setDpr(v: number) {
  Object.defineProperty(window, 'devicePixelRatio', { value: v, configurable: true });
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  setDpr(1);
});

describe('isNativeViewerAvailable', () => {
  it('网页端/桌面为 false（jsdom 非原生平台）', () => {
    expect(isNativeViewerAvailable()).toBe(false);
  });
});

describe('openNativeViewer', () => {
  it('不可用时返回 null —— 调用方据此回退 Web 查看器（看图能力不会整体失效）', async () => {
    await expect(openNativeViewer({ images: ['a.jpg'], index: 0 })).resolves.toBeNull();
  });
});

describe('rectOf（Hero 起点矩形）', () => {
  it('返回物理像素：CSS px × devicePixelRatio', () => {
    setDpr(3);
    const r = rectOf(fakeEl({ left: 10, top: 20, width: 100, height: 200 }));
    expect(r).toEqual({ x: 30, y: 60, width: 300, height: 600 });
  });

  it('devicePixelRatio 缺失时按 1 处理（不产生 NaN）', () => {
    Object.defineProperty(window, 'devicePixelRatio', { value: undefined, configurable: true });
    const r = rectOf(fakeEl({ left: 5, top: 5, width: 10, height: 10 }));
    expect(r).toEqual({ x: 5, y: 5, width: 10, height: 10 });
  });

  it('元素为空或尺寸为 0 → undefined（原生侧退化为淡入）', () => {
    expect(rectOf(null)).toBeUndefined();
    expect(rectOf(fakeEl({ left: 0, top: 0, width: 0, height: 0 }))).toBeUndefined();
  });

  it('k_viewer_hero=off 时不返回矩形（真机应急关 Hero 的开关）', () => {
    localStorage.setItem('k_viewer_hero', 'off');
    expect(rectOf(fakeEl({ left: 1, top: 1, width: 10, height: 10 }))).toBeUndefined();
  });

  it('其它取值不影响 Hero（只有 off 才关）', () => {
    localStorage.setItem('k_viewer_hero', 'on');
    expect(rectOf(fakeEl({ left: 1, top: 1, width: 10, height: 10 }))).toBeDefined();
  });
});
