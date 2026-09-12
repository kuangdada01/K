/**
 * snapScroll 单测（原生滚动分页）：
 * 纯函数：nearestPageIndex / clampPageStep
 * DOM 逻辑（jsdom）：停靠校正、一次手势最多翻一页、手指按住时不吸附、
 *                    程序化滚动期间不校正、放大态不校正、索引上报
 *
 * jsdom 没有布局：clientWidth 与 scrollLeft 需要打桩（否则页宽退化成 0）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachSnapScroll,
  clampPageStep,
  nearestPageIndex,
  PROGRAMMATIC_SUPPRESS_MS,
  SETTLE_IDLE_MS,
  SNAP_TOLERANCE_PX,
} from './snapScroll';

const W = 400;
const COUNT = 5;

describe('nearestPageIndex', () => {
  it('四舍五入到最近页并钳在 [0, count-1]', () => {
    expect(nearestPageIndex(0, W, COUNT)).toBe(0);
    expect(nearestPageIndex(W * 0.49, W, COUNT)).toBe(0);
    expect(nearestPageIndex(W * 0.51, W, COUNT)).toBe(1);
    expect(nearestPageIndex(W * 2, W, COUNT)).toBe(2);
    expect(nearestPageIndex(-999, W, COUNT)).toBe(0);
    expect(nearestPageIndex(W * 99, W, COUNT)).toBe(COUNT - 1);
  });

  it('页宽 0 / 页数 0 不崩', () => {
    expect(nearestPageIndex(100, 0, COUNT)).toBe(0);
    expect(nearestPageIndex(100, W, 0)).toBe(0);
  });
});

describe('clampPageStep', () => {
  it('一次手势最多翻一页', () => {
    expect(clampPageStep(3, 0)).toBe(1);
    expect(clampPageStep(-3, 0)).toBe(-1);
    expect(clampPageStep(1, 0)).toBe(1);
    expect(clampPageStep(0, 0)).toBe(0);
  });

  it('以起点为中心，双向都能翻一页', () => {
    expect(clampPageStep(5, 3)).toBe(4);
    expect(clampPageStep(0, 3)).toBe(2);
    expect(clampPageStep(3, 3)).toBe(3);
  });

  it('maxStep 可放宽', () => {
    expect(clampPageStep(4, 0, 3)).toBe(3);
  });
});

describe('attachSnapScroll（jsdom）', () => {
  let scroller: HTMLDivElement;
  let scrollToCalls: Array<number | ScrollToOptions>;
  let offsetRef: { current: number };
  let settledRef: { current: number };
  let programmaticUntilRef: { current: number };
  let indexes: number[];
  let detach: () => void;
  let isZoomed: boolean;

  const attach = (count = COUNT) => {
    detach = attachSnapScroll({
      scroller,
      count,
      getSlideWidth: () => W,
      offsetRef,
      settledRef,
      onIndexChange: (i) => indexes.push(i),
      isZoomed: () => isZoomed,
      programmaticUntilRef,
    });
  };

  const scrollTo = (left: number) => {
    scroller.scrollLeft = left;
    scroller.dispatchEvent(new Event('scroll'));
  };
  const pointer = (type: 'pointerdown' | 'pointerup') =>
    scroller.dispatchEvent(new Event(type, { bubbles: true }));

  beforeEach(() => {
    vi.useFakeTimers();
    scroller = document.createElement('div');
    document.body.appendChild(scroller);
    Object.defineProperty(scroller, 'clientWidth', { value: W, configurable: true });
    scrollToCalls = [];
    scroller.scrollTo = ((arg: number | ScrollToOptions) => {
      scrollToCalls.push(arg);
      if (typeof arg === 'object' && typeof arg.left === 'number') scroller.scrollLeft = arg.left;
    }) as typeof scroller.scrollTo;
    offsetRef = { current: 0 };
    settledRef = { current: 0 };
    programmaticUntilRef = { current: 0 };
    indexes = [];
    isZoomed = false;
  });

  afterEach(() => {
    detach?.();
    scroller.remove();
    vi.useRealTimers();
  });

  const settle = () => vi.advanceTimersByTime(SETTLE_IDLE_MS + 10);

  it('停在页边界：不做校正；索引如实上报（消费方据此更新指示点）', () => {
    attach();
    scrollTo(W * 2);
    settle();
    expect(scrollToCalls).toEqual([]);
    expect(indexes).toEqual([2]);
    expect(settledRef.current).toBe(2);
  });

  it('程序化/外部定位可自由跨多页，不被「一次一页」钳制', () => {
    attach();
    // 没有 pointerdown（例如点第 5 个指示点、代码 setOffset）：直接到第 4 页
    scrollTo(W * 4);
    settle();
    expect(scrollToCalls).toEqual([]);
    expect(indexes).toEqual([4]);
    expect(settledRef.current).toBe(4);
  });

  it('停在两页之间：平滑补位到最近页（浏览器的 snap 不可用时也保证不露半张）', () => {
    attach();
    // 手势从第 0 页开始，甩到 ~1.2 页后停住
    pointer('pointerdown');
    scrollTo(W * 1.2);
    pointer('pointerup');
    settle();
    expect(scrollToCalls).toEqual([{ left: W, behavior: 'smooth' }]);
    expect(indexes).toEqual([1]);
    expect(settledRef.current).toBe(1);
  });

  it('一次手势最多翻一页：甩到第 3 页也拉回第 1 页', () => {
    attach();
    pointer('pointerdown'); // 起点 = settledRef = 0
    scrollTo(W * 3);
    pointer('pointerup');
    settle();
    expect(scrollToCalls).toEqual([{ left: W, behavior: 'smooth' }]);
    expect(indexes).toEqual([1]);
  });

  it('手指按住时不吸附（原生相册也不会在拖动中途吸附）', () => {
    attach();
    pointer('pointerdown');
    scrollTo(W * 1.3);
    settle(); // 还按着
    expect(scrollToCalls).toEqual([]);
    expect(indexes).toEqual([]);
    pointer('pointerup');
    settle();
    expect(scrollToCalls).toEqual([{ left: W, behavior: 'smooth' }]);
    expect(indexes).toEqual([1]);
  });

  it('程序化平滑滚动期间不校正（否则会把动画中的滚动当成甩歪）', () => {
    attach();
    programmaticUntilRef.current = performance.now() + PROGRAMMATIC_SUPPRESS_MS;
    scrollTo(W * 1.6);
    settle();
    expect(scrollToCalls).toEqual([]);
    expect(indexes).toEqual([]);
  });

  it('放大态：位置锁定，不校正也不上报', () => {
    attach();
    isZoomed = true;
    scrollTo(W * 1.6);
    settle();
    expect(scrollToCalls).toEqual([]);
    expect(indexes).toEqual([]);
  });

  it('已对齐但页变化时也会上报（例如外部 setOffset 定位）', () => {
    attach();
    scrollTo(W * 3); // 精确第 3 页（非手势 → 不钳制）
    settle();
    expect(scrollToCalls).toEqual([]);
    expect(indexes).toEqual([3]);
  });

  it('小幅误差在容差内不补位（避免亚像素抖动引起的往复）', () => {
    attach();
    pointer('pointerdown');
    scrollTo(W + SNAP_TOLERANCE_PX - 0.5);
    pointer('pointerup');
    settle();
    expect(scrollToCalls).toEqual([]);
  });

  it('offsetRef 始终跟随滚动位置（消费方读它做同步）', () => {
    attach();
    scrollTo(123);
    expect(offsetRef.current).toBe(123);
  });

  it('程序化跳转不受「一次手势最多翻一页」钳制（钳制标记会被清除）', () => {
    attach();
    pointer('pointerdown'); // 标记本次停靠需要钳制
    programmaticUntilRef.current = performance.now() + PROGRAMMATIC_SUPPRESS_MS;
    scrollTo(W * 4); // 例如点了第 5 个指示点
    pointer('pointerup');
    settle();
    expect(scrollToCalls).toEqual([]); // 程序化期间不校正
    // 抑制窗口过后再次停靠：应停在第 4 页，而不是被钳回第 1 页
    programmaticUntilRef.current = 0;
    scrollTo(W * 4);
    settle();
    expect(scrollToCalls).toEqual([]);
    expect(indexes).toEqual([4]);
    expect(settledRef.current).toBe(4);
  });

  it('解绑后不再响应滚动', () => {
    attach();
    detach();
    scrollTo(W * 2);
    settle();
    expect(indexes).toEqual([]);
    expect(scrollToCalls).toEqual([]);
  });
});
