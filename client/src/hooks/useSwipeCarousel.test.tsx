/**
 * useSwipeCarousel 手势集成测试（jsdom）：
 * 直接驱动真实 Hook 的事件处理，锁定「分页器手感」的关键行为——
 * 1. 跟手：touchmove 位移 1:1 写到轨道 transform；
 * 2. 越界阻尼：第一张继续右拖时位移被压缩，松手弹回第 0 页；
 * 3. 速度投影：快速轻甩（位移小、速度快）也翻页；
 * 4. 慢拖：位移过小、速度近 0 → 原地回弹；
 * 5. 一次手势最多翻一页（拖 1.7 屏也只翻 1 页）。
 *
 * jsdom 没有布局，slide 宽度与 viewport 宽度需要打桩（否则页宽退化成 1px）。
 */
import { useCallback, useEffect, useRef } from 'react';
import { render, screen, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSwipeCarousel } from './useSwipeCarousel';

const SLIDE_W = 400;
const COUNT = 5;

function Harness({ onIndex }: { onIndex: (i: number) => void }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const carousel = useSwipeCarousel(trackRef, viewportRef);
  const onInteract = useCallback(() => {}, []);
  useEffect(() => {
    // 打桩：slide 实际渲染宽度（jsdom 无布局，getBoundingClientRect 恒为 0）
    const track = trackRef.current!;
    const first = track.firstElementChild as HTMLElement;
    first.getBoundingClientRect = () =>
      ({ width: SLIDE_W, height: 100, left: 0, top: 0, right: SLIDE_W, bottom: 100, x: 0, y: 0 }) as DOMRect;
    Object.defineProperty(viewportRef.current!, 'clientWidth', { value: SLIDE_W, configurable: true });
    return carousel.attachGesture(viewportRef.current, track, COUNT, onInteract, onIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div ref={viewportRef} data-testid="viewport">
      <div ref={trackRef} data-testid="track">
        {Array.from({ length: COUNT }).map((_, i) => (
          <div key={i} data-testid={`slide-${i}`} />
        ))}
      </div>
    </div>
  );
}

/** 合成 pointer/touch 事件（jsdom 没有 PointerEvent/TouchEvent 构造参数） */
function firePointer(el: HTMLElement, type: 'pointerdown' | 'pointerup', clientX: number) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, { pointerType: 'touch', button: 0, clientX, clientY: 100 });
  el.dispatchEvent(e);
}
function fireTouchMove(el: HTMLElement, clientX: number) {
  const e = new Event('touchmove', { bubbles: true, cancelable: true });
  Object.assign(e, { touches: [{ clientX, clientY: 100 }] });
  el.dispatchEvent(e);
}

const trackTransform = () => screen.getByTestId('track').style.transform;

describe('useSwipeCarousel 手势', () => {
  let clock = 0;

  beforeEach(() => {
    clock = 0;
    // 每个速度样本前进固定时间，速度可控（velocity = Δx / Δt）
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('跟手：位移 1:1 写到轨道 transform', () => {
    render(<Harness onIndex={() => {}} />);
    const viewport = screen.getByTestId('viewport');
    act(() => {
      firePointer(viewport, 'pointerdown', 300);
      fireTouchMove(viewport, 200); // 手指左滑 100px
    });
    expect(trackTransform()).toBe('translate3d(-100px, 0, 0)');
  });

  it('越界阻尼：第一张继续右拖位移被压缩，松手弹回第 0 页', () => {
    const indexes: number[] = [];
    render(<Harness onIndex={(i) => indexes.push(i)} />);
    const viewport = screen.getByTestId('viewport');
    act(() => {
      firePointer(viewport, 'pointerdown', 200);
      fireTouchMove(viewport, 400); // 右拖 200px（第 0 页已到边界）
    });
    // transform 的 x = -offset：右拖时轨道向正方向移动，但被阻尼压缩
    const transformX = Number(/translate3d\((-?[\d.]+)px/.exec(trackTransform())?.[1]);
    expect(transformX).toBeGreaterThan(0); // 确实跟手移动了
    expect(transformX).toBeLessThan(200); // 但远小于手指位移 200px
    expect(transformX).toBeGreaterThan(200 * 0.4); // 阻尼不等于不动
    act(() => {
      clock += 400; // 慢速松手
      firePointer(viewport, 'pointerup', 400);
    });
    expect(trackTransform()).toBe('translate3d(0px, 0, 0)'); // 弹回第一张
    expect(indexes[indexes.length - 1]).toBe(0);
  });

  it('速度投影：快速轻甩（位移小）也翻页', () => {
    const indexes: number[] = [];
    render(<Harness onIndex={(i) => indexes.push(i)} />);
    const viewport = screen.getByTestId('viewport');
    act(() => {
      firePointer(viewport, 'pointerdown', 300);
      clock += 20;
      fireTouchMove(viewport, 260); // 只滑 40px
      clock += 20; // 20ms 走 40px = 2px/ms 的甩动
      firePointer(viewport, 'pointerup', 260);
    });
    expect(trackTransform()).toBe('translate3d(-400px, 0, 0)'); // 落到第 1 页
    expect(indexes[indexes.length - 1]).toBe(1);
  });

  it('慢拖且位移很小：原地回弹，不翻页', () => {
    const indexes: number[] = [];
    render(<Harness onIndex={(i) => indexes.push(i)} />);
    const viewport = screen.getByTestId('viewport');
    act(() => {
      firePointer(viewport, 'pointerdown', 300);
      clock += 600;
      fireTouchMove(viewport, 260); // 40px / 600ms ≈ 0.07px/ms
      clock += 600;
      firePointer(viewport, 'pointerup', 260);
    });
    expect(trackTransform()).toBe('translate3d(0px, 0, 0)');
    expect(indexes[indexes.length - 1]).toBe(0);
  });

  it('一次手势最多翻一页：拖 1.7 屏也只翻 1 页', () => {
    const indexes: number[] = [];
    render(<Harness onIndex={(i) => indexes.push(i)} />);
    const viewport = screen.getByTestId('viewport');
    act(() => {
      firePointer(viewport, 'pointerdown', 900);
      clock += 20;
      fireTouchMove(viewport, 900 - 680); // 左滑 680px ≈ 1.7 页
      clock += 20;
      firePointer(viewport, 'pointerup', 220);
    });
    expect(trackTransform()).toBe('translate3d(-400px, 0, 0)');
    expect(indexes[indexes.length - 1]).toBe(1);
  });

  it('慢拖过半屏：按位置就近翻页（无速度也翻）', () => {
    const indexes: number[] = [];
    render(<Harness onIndex={(i) => indexes.push(i)} />);
    const viewport = screen.getByTestId('viewport');
    act(() => {
      firePointer(viewport, 'pointerdown', 300);
      clock += 500;
      fireTouchMove(viewport, 300 - 220); // 220px = 0.55 页
      clock += 500;
      firePointer(viewport, 'pointerup', 80);
    });
    expect(trackTransform()).toBe('translate3d(-400px, 0, 0)');
    expect(indexes[indexes.length - 1]).toBe(1);
  });
});
