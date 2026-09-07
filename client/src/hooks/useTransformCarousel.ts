/**
 * ============================================================
 * transform 轮播轨道 Hook（useTransformCarousel）
 * ============================================================
 * 自 client/src/components/post/PostMedia.tsx 拆出（纯拆分重构，行为不变）。
 * 每个轨道实例调用一次（PostMedia 中主轮播与全屏轮播各一次），
 * 各自持有 offsetRef / settledRef / transition 定时器，互不干扰；
 * animateTrackTo 按实例返回，替代原先用 setOffset === setMainOffset
 * 函数身份比较判别轨道的脆弱写法。
 *
 * 手势完全接管（WebView 原生惯性/scroll-snap 不可控，快速滑动会跨页）：
 * - touchmove 直接写 translate3d（合成器线程，60fps 丝滑）；
 * - 松手用 CSS transition 落位：400ms cubic-bezier(0.22, 1, 0.36, 1)，
 *   460ms 后移除 transition；
 * - 首次位移判定方向：横向主导才接管（+2px 余量），纵向主导交还浏览器滚动；
 * - 拖动超过视口宽度 ~1/8（0.12）翻一页（一次最多一页），否则回弹起点；
 * - mouse 指针任意位移即翻页（up 判定含 e.pointerType === 'mouse'）——原行为保留。
 *
 * 说明：原实现两轨道共用一份 transTimersRef（两轨道动画在时间上互斥，
 * 且另一轨道位于 overlay 之下不可见），拆为各实例独立定时器数组后
 * 无可观察行为差异。
 * ============================================================
 */

import { useCallback, useEffect, useMemo, useRef, RefObject } from 'react';

export interface TransformCarouselApi {
  /** 当前轨道像素偏移（0 = 第一张），手势跟手与动画共用 */
  offsetRef: RefObject<number>;
  /** 上次稳定停靠的图片索引：一次手势最多翻一页（防惯性一下跳过 2 张） */
  settledRef: RefObject<number>;
  /** 设置稳定停靠索引（调用方更新吸附基准；ref 归 hook 所有，避免外部直接写 .current） */
  setSettled: (index: number) => void;
  /** 直接写轨道偏移（无动画） */
  setOffset: (x: number) => void;
  /** 落位动画到 index（width = 当前视口宽度） */
  animateTrackTo: (index: number, width: number) => void;
  /** 绑定 pointer/touch 手势；返回解绑函数（viewport/track 缺失时为空操作） */
  attachGesture: (
    viewport: HTMLDivElement | null,
    track: HTMLDivElement | null,
    imageCount: number,
    onMove: (index: number) => void,
    onSettled?: (index: number) => void
  ) => () => void;
}

export function useTransformCarousel(trackRef: RefObject<HTMLDivElement | null>): TransformCarouselApi {
  // 当前轨道像素偏移（0 = 第一张），手势跟手与动画共用
  const offsetRef = useRef(0);
  // 上次稳定停靠的图片索引：一次手势最多翻一页（防惯性一下跳过 2 张）
  const settledRef = useRef(0);
  // transition 结束后的清理定时器
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimers = useCallback(() => {
    timersRef.current.forEach((t) => clearTimeout(t));
    timersRef.current = [];
  }, []);

  /** 轨道位移（transform 驱动，合成器线程，不触发 layout） */
  const setOffset = useCallback(
    (x: number) => {
      offsetRef.current = x;
      if (trackRef.current) {
        trackRef.current.style.transform = `translate3d(${-x}px, 0, 0)`;
      }
    },
    [trackRef]
  );

  const setSettled = useCallback((index: number) => {
    settledRef.current = index;
  }, []);

  /** 轨道落位动画：CSS transition（合成器执行，帧率满格） */
  const animateTrackTo = useCallback(
    (index: number, width: number) => {
      const track = trackRef.current;
      if (!track) return;
      const target = width * index;
      if (Math.abs(offsetRef.current - target) < 1) return;
      track.style.transition = 'transform 400ms cubic-bezier(0.22, 1, 0.36, 1)';
      setOffset(target);
      const t = setTimeout(() => {
        if (track) track.style.transition = 'none';
      }, 460);
      timersRef.current.push(t);
    },
    [trackRef, setOffset]
  );

  // —— 手势完全接管（WebView 原生惯性/scroll-snap 不可控，快速滑动会跨页）——
  // transform 轨道驱动：touchmove 直接写 translate3d（合成器线程，60fps 丝滑）；
  // 松手用 CSS transition 落位。纵向主导的手势交还浏览器滚动页面。
  const attachGesture = useCallback(
    (
      viewport: HTMLDivElement | null,
      track: HTMLDivElement | null,
      imageCount: number,
      onMove: (index: number) => void,
      onSettled?: (index: number) => void
    ) => {
      if (!viewport || !track) return () => {};
      let startX = 0;
      let startY = 0;
      let startOffset = 0;
      let startIndex = 0;
      let active = false;
      let horizontal = false; // 是否已判定为横向手势（横向主导才接管滚动）
      let moveHandler: ((e: TouchEvent) => void) | null = null;

      const down = (e: PointerEvent) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        // 动画中途再次触摸：取消 transition，从当前位置继续跟手，无缝衔接
        track.style.transition = 'none';
        clearTimers();
        active = true;
        horizontal = false;
        startX = e.clientX;
        startY = e.clientY;
        startOffset = offsetRef.current;
        startIndex = settledRef.current;
        moveHandler = (te: TouchEvent) => {
          if (!active || te.touches.length !== 1) return;
          const touch = te.touches[0]!;
          const dx = touch.clientX - startX;
          const dy = touch.clientY - startY;
          if (!horizontal) {
            // 首次位移判定方向：横向主导才接管，纵向主导（浏览页面）立即放手
            if (Math.abs(dx) > Math.abs(dy) + 2) {
              horizontal = true;
            } else if (Math.abs(dy) > Math.abs(dx) + 2) {
              active = false; // 交给浏览器纵向滚动页面
              if (moveHandler) {
                viewport.removeEventListener('touchmove', moveHandler);
                moveHandler = null;
              }
              return;
            } else {
              return; // 位移太小，继续观察
            }
          }
          te.preventDefault();
          setOffset(startOffset - dx);
        };
        // passive:false 才能 preventDefault 禁掉原生惯性滚动
        viewport.addEventListener('touchmove', moveHandler, { passive: false });
      };

      const up = (e: PointerEvent) => {
        if (!active) return;
        active = false;
        if (moveHandler) {
          viewport.removeEventListener('touchmove', moveHandler);
          moveHandler = null;
        }
        const dx = offsetRef.current - startOffset; // 正向 = 手指左滑（offset 增大）= 下一张
        const width = viewport.clientWidth || 1;
        const total = imageCount;
        let target = startIndex;
        if (Math.abs(dx) > width * 0.12 || e.pointerType === 'mouse') {
          // 拖动超过 ~1/8 屏 → 翻一页（最多一页，绝不过 2 张）
          if (dx > 0) target = Math.min(total - 1, startIndex + 1);
          else if (dx < 0) target = Math.max(0, startIndex - 1);
        } else {
          // 微动 → 回到起点
          target = startIndex;
        }
        settledRef.current = target;
        if (onSettled) onSettled(target);
        onMove(target);
        animateTrackTo(target, width);
      };

      viewport.addEventListener('pointerdown', down);
      viewport.addEventListener('pointerup', up);
      viewport.addEventListener('pointercancel', up);
      return () => {
        viewport.removeEventListener('pointerdown', down);
        viewport.removeEventListener('pointerup', up);
        viewport.removeEventListener('pointercancel', up);
        if (moveHandler) viewport.removeEventListener('touchmove', moveHandler);
      };
    },
    [setOffset, animateTrackTo, clearTimers]
  );

  // 卸载时清理 transition 定时器（原 PostMedia 的卸载清理 effect）
  useEffect(() => {
    return () => clearTimers();
  }, [clearTimers]);

  // 稳定返回对象：消费方把它放进 effect 依赖不会造成每渲染重订阅
  return useMemo(
    () => ({ offsetRef, settledRef, setSettled, setOffset, animateTrackTo, attachGesture }),
    [setSettled, setOffset, animateTrackTo, attachGesture]
  );
}
