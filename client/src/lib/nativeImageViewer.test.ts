/**
 * nativeImageViewer 单测（网页侧契约）：
 * 原生查看器依赖网页层给出的坐标与能力判断，这里把契约钉死：
 * - 网页端/桌面 → 不可用、openNativeViewer 返回 null（调用方据此回退 Web 查看器）
 * - rectOf 必须返回**物理像素**（CSS px × devicePixelRatio），
 *   原生侧不再做任何缩放换算（早期版本用 WebView.getScale() 猜，会从错误位置放大）
 * - rectsOfTrack：每张图各自的缩略图矩形，且**没滚到视口的页要换算**
 *   （退场反向 Hero 靠它飞回「当前这一张」）
 * - k_viewer_hero=off 时不给 Hero 矩形（真机应急开关）
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isNativeViewerAvailable,
  openNativeViewer,
  rectOf,
  rectsOfElements,
  rectsOfTrack,
} from './nativeImageViewer';

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

describe('onNativeViewerWillClose（网页端）', () => {
  it('原生不可用时不注册、退订也不报错（网页端不该碰插件）', async () => {
    const { onNativeViewerWillClose } = await import('./nativeImageViewer');
    const cb = vi.fn();
    const off = onNativeViewerWillClose(cb);
    expect(typeof off).toBe('function');
    expect(() => off()).not.toThrow();
    expect(cb).not.toHaveBeenCalled();
  });
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

describe('rectsOfTrack（退场反向 Hero 的目标位置）', () => {
  /** 造一个横向轨道：n 页，页宽 W，每页矩形按 i×W 排开（模拟 flex 布局） */
  function makeTrack(pages: number, w: number, scrollLeft = 0) {
    const track = document.createElement('div');
    for (let i = 0; i < pages; i++) {
      const el = document.createElement('img');
      el.getBoundingClientRect = () =>
        ({
          left: i * w - scrollLeft,
          top: 50,
          width: w,
          height: 400,
          right: i * w - scrollLeft + w,
          bottom: 450,
          x: i * w - scrollLeft,
          y: 50,
          toJSON: () => ({}),
        }) as DOMRect;
      track.appendChild(el);
    }
    Object.defineProperty(track, 'scrollLeft', { value: scrollLeft, writable: true, configurable: true });
    return track;
  }

  it('每页都换算到「该页滚到视口时」的矩形（与当前滚动位置无关）', () => {
    // 停在第 0 页：第 2 张的原始 left 是 2×300，换算后应等于轨道左边界
    expect(rectsOfTrack(makeTrack(3, 300))).toEqual([
      { x: 0, y: 50, width: 300, height: 400 },
      { x: 0, y: 50, width: 300, height: 400 },
      { x: 0, y: 50, width: 300, height: 400 },
    ]);
  });

  it('停在第 2 页时同样成立（同一页换算结果不随滚动位置漂移）', () => {
    const rects = rectsOfTrack(makeTrack(3, 300, 600));
    expect(rects[2]).toEqual({ x: 0, y: 50, width: 300, height: 400 });
    // 第 0 页此时在左侧屏幕外：换算后也应回到轨道左边界
    expect(rects[0]).toEqual({ x: 0, y: 50, width: 300, height: 400 });
  });

  it('单页不做换算（普通 `<img>` 容器也能用）', () => {
    expect(rectsOfTrack(makeTrack(1, 300, 0))[0]).toEqual({ x: 0, y: 50, width: 300, height: 400 });
  });

  it('尺寸为 0 的页 → null（原生侧该张不做 Hero）', () => {
    const track = makeTrack(2, 300);
    const second = track.children[1];
    expect(second).toBeDefined();
    if (second) second.getBoundingClientRect = () => ({ width: 0, height: 0 }) as DOMRect;
    expect(rectsOfTrack(track)[1]).toBeNull();
  });

  it('空轨道 / null → 空数组；k_viewer_hero=off → 空数组（与 rectOf 同一个开关）', () => {
    expect(rectsOfTrack(null)).toEqual([]);
    expect(rectsOfTrack(document.createElement('div'))).toEqual([]);
    localStorage.setItem('k_viewer_hero', 'off');
    expect(rectsOfTrack(makeTrack(3, 300))).toEqual([]);
  });

  it('devicePixelRatio 参与换算（物理像素）', () => {
    setDpr(2);
    expect(rectsOfTrack(makeTrack(2, 300)).map((r) => r?.width)).toEqual([600, 600]);
  });
});

describe('rectsOfElements（网格缩略图，不做分页换算）', () => {
  it('逐个返回物理像素矩形，缺失的位为 null', () => {
    setDpr(2);
    const els = [fakeEl({ left: 10, top: 20, width: 50, height: 50 }), null];
    expect(rectsOfElements(els)).toEqual([{ x: 20, y: 40, width: 100, height: 100 }, null]);
  });

  it('k_viewer_hero=off → 空数组', () => {
    localStorage.setItem('k_viewer_hero', 'off');
    expect(rectsOfElements([fakeEl({ left: 0, top: 0, width: 5, height: 5 })])).toEqual([]);
  });
});
