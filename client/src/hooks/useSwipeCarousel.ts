/**
 * ============================================================
 * 帖子卡片手势轮播 Hook（useSwipeCarousel）
 * ============================================================
 * 自 client/src/components/post/PostCard.tsx 拆出（纯拆分重构，行为不变）。
 *
 * 与 useTransformCarousel（自 PostMedia 拆出）同源，但语义不同，保持独立实现：
 * - pointerdown 即回调 onInteract（PostCard 用于停止 3 秒自动轮播）；
 * - mouse 指针不享受「任意位移即翻页」：up 判定无 e.pointerType === 'mouse'
 *   分支，与触摸一样要求 > 视口宽 0.12 才翻页（PostCard 原行为，保留）；
 * - 单一 transitionTimerRef（新动画/手势开始时清理旧定时器），
 *   而非 useTransformCarousel 的定时器数组（PostMedia 原行为，保留）。
 *
 * 行为不变量（与 PostCard 原实现一致）：
 * - touchmove 直接写 translate3d（合成器线程，60fps 丝滑）；
 * - 松手 CSS transition 400ms cubic-bezier(0.22, 1, 0.36, 1)，460ms 后移除；
 * - 首次位移判定方向（横向主导才接管，+2px 余量），纵向主导交还浏览器滚动；
 * - 拖动超过视口宽 ~1/8（0.12）翻一页（一次最多一页），否则回弹起点；
 * - touchmove 以 { passive: false } 绑定以禁掉原生惯性滚动；
 * - 轨道位移基准：offset = index * 容器宽度。
 * ============================================================
 */

import { useCallback, useEffect, useMemo, useRef, RefObject } from 'react';

export interface SwipeCarouselApi {
  /** 当前轨道像素偏移（0 = 第一张），手势跟手与动画共用 */
  offsetRef: RefObject<number>;
  /** 上次稳定停靠的图片索引：手势完全接管分页（一次最多翻一页） */
  settledRef: RefObject<number>;
  /** 设置稳定停靠索引（ref 归 hook 所有，避免外部直接写 .current） */
  setSettled: (index: number) => void;
  /** 直接写轨道偏移（无动画） */
  setTrackOffset: (offset: number) => void;
  /** 落位动画到 index（宽度取自 viewportRef 当前 clientWidth） */
  animateTrackTo: (index: number) => void;
  /** 绑定 pointer/touch 手势；返回解绑函数（viewport/track 缺失时为空操作） */
  attachGesture: (
    viewport: HTMLDivElement | null,
    track: HTMLDivElement | null,
    imageCount: number,
    onInteract: () => void,
    onIndexChange: (index: number) => void
  ) => () => void;
}

export function useSwipeCarousel(
  trackRef: RefObject<HTMLDivElement | null>,
  viewportRef: RefObject<HTMLDivElement | null>
): SwipeCarouselApi {
  // 当前轨道像素偏移（0 = 第一张），供手势跟手与动画共用
  const offsetRef = useRef(0);
  // 上次稳定停靠的图片索引：手势完全接管分页（一次最多翻一页）
  const settledRef = useRef(0);
  const transitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setSettled = useCallback((index: number) => {
    settledRef.current = index;
  }, []);

  const setTrackOffset = useCallback(
    (offset: number) => {
      const track = trackRef.current;
      if (!track) return;
      offsetRef.current = offset;
      track.style.transform = `translate3d(${-offset}px, 0, 0)`;
    },
    [trackRef]
  );

  // 落位动画：CSS transition（合成器执行，帧率满格）
  const animateTrackTo = useCallback(
    (index: number) => {
      const track = trackRef.current;
      if (!track) return;
      const width = viewportRef.current?.clientWidth || 0;
      const target = width * index;
      if (Math.abs(offsetRef.current - target) < 1) return;
      if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current);
      track.style.transition = 'transform 400ms cubic-bezier(0.22, 1, 0.36, 1)';
      track.style.transform = `translate3d(${-target}px, 0, 0)`;
      offsetRef.current = target;
      transitionTimerRef.current = setTimeout(() => {
        if (trackRef.current) trackRef.current.style.transition = 'none';
      }, 460);
    },
    [trackRef, viewportRef]
  );

  // —— 手势完全接管（WebView 原生惯性/scroll-snap 不可控，快速滑动会跨页）——
  // transform 轨道驱动：touchmove 直接写 translate3d（合成器线程，不触发 layout，
  // 60fps 丝滑）；松手用 CSS transition（同样走合成器）落位。
  // 轨道位移基准：offset = index * 容器宽度。
  const attachGesture = useCallback(
    (
      viewport: HTMLDivElement | null,
      track: HTMLDivElement | null,
      imageCount: number,
      onInteract: () => void,
      onIndexChange: (index: number) => void
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
        onInteract(); // 手动触摸后停止自动轮播
        // 动画中途再次触摸：取消 transition，从当前位置继续跟手
        track.style.transition = 'none';
        if (transitionTimerRef.current) {
          clearTimeout(transitionTimerRef.current);
          transitionTimerRef.current = null;
        }
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
          setTrackOffset(startOffset - dx);
        };
        // passive:false 才能 preventDefault 禁掉原生惯性滚动
        viewport.addEventListener('touchmove', moveHandler, { passive: false });
      };

      const up = () => {
        if (!active) return;
        active = false;
        if (moveHandler) {
          viewport.removeEventListener('touchmove', moveHandler);
          moveHandler = null;
        }
        const dx = offsetRef.current - startOffset; // 正向 = 手指左滑（offset 增大）= 下一张
        const width = viewportRef.current?.clientWidth || 1;
        let target = startIndex;
        if (Math.abs(dx) > width * 0.12) {
          // 拖动超过 ~1/8 屏 → 翻一页（最多一页，绝不过 2 张）
          if (dx > 0) target = Math.min(imageCount - 1, startIndex + 1);
          else if (dx < 0) target = Math.max(0, startIndex - 1);
        } else {
          // 微动 → 回到起点
          target = startIndex;
        }
        settledRef.current = target;
        onIndexChange(target);
        animateTrackTo(target);
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
    [setTrackOffset, animateTrackTo, viewportRef]
  );

  // 卸载时清理 transition 定时器（原 PostCard 的卸载清理 effect）
  useEffect(() => {
    return () => {
      if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current);
    };
  }, []);

  // 稳定返回对象：消费方把它放进 effect 依赖不会造成每渲染重订阅
  return useMemo(
    () => ({ offsetRef, settledRef, setSettled, setTrackOffset, animateTrackTo, attachGesture }),
    [setSettled, setTrackOffset, animateTrackTo, attachGesture]
  );
}
