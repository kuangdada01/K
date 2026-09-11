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
 * - 松手 CSS transition 落位：整页 300ms / 回弹 200ms，cubic-bezier(0.22, 1, 0.36, 1)，
 *   时长 +60ms 后移除（参数与判定见 hooks/carouselGesture，与 useTransformCarousel 同源）；
 * - 首次位移判定方向（横向主导才接管，+2px 余量），纵向主导交还浏览器滚动；
 * - 拖动超过视口宽 ~1/8（0.12）翻一页，**快速甩动**（速度 ≥ 0.35px/ms 且位移
 *   ≥ 10px）即使不足 1/8 也翻一页（一次最多一页），否则回弹起点；
 * - touchmove 以 { passive: false } 绑定以禁掉原生惯性滚动；
 * - pointercancel（系统接管手势）一律回弹吸附基准，绝不翻页；
 * - 轨道位移基准：offset = index * 容器宽度。
 * ============================================================
 */

import { useCallback, useEffect, useMemo, useRef, RefObject } from 'react';
import {
  createVelocityTracker,
  decidePageFlip,
  settleDurationMs,
  SLIDE_EASING,
  SLIDE_SETTLE_MS,
} from './carouselGesture';

export interface SwipeCarouselApi {
  /** 当前轨道像素偏移（0 = 第一张），手势跟手与动画共用 */
  offsetRef: RefObject<number>;
  /** 上次稳定停靠的图片索引：手势完全接管分页（一次最多翻一页） */
  settledRef: RefObject<number>;
  /** 设置稳定停靠索引（ref 归 hook 所有，避免外部直接写 .current） */
  setSettled: (index: number) => void;
  /** 直接写轨道偏移（无动画） */
  setTrackOffset: (offset: number) => void;
  /** 落位动画到 index（宽度取自 viewportRef 当前 clientWidth）。
   *  durationMs 缺省为整页落位时长；回弹传更短的 settleDurationMs(false)。 */
  animateTrackTo: (index: number, durationMs?: number) => void;
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

  /** 单张图片实际渲染宽度：轨道首子元素 rect 宽（flex:0 0 100% 下等于轨道内容宽）。
   *  ★ 不能用 viewport clientWidth：clientWidth 取整，flex 布局下图片宽度可能是
   *  小数（如 95vw=373.34px），偏移按取整宽度计算会逐页累积偏差露出下一张边缘。 */
  const getSlideWidth = useCallback(() => {
    const track = trackRef.current;
    const first = track?.firstElementChild;
    const w = first ? first.getBoundingClientRect().width : track?.getBoundingClientRect().width;
    return w && w > 0 ? w : 0;
  }, [trackRef]);

  // 落位动画：CSS transition（合成器执行，帧率满格）
  const animateTrackTo = useCallback(
    (index: number, durationMs = SLIDE_SETTLE_MS) => {
      const track = trackRef.current;
      if (!track) return;
      const width = getSlideWidth() || viewportRef.current?.clientWidth || 0;
      const target = width * index;
      if (Math.abs(offsetRef.current - target) < 1) return;
      if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current);
      track.style.transition = `transform ${durationMs}ms ${SLIDE_EASING}`;
      track.style.transform = `translate3d(${-target}px, 0, 0)`;
      offsetRef.current = target;
      transitionTimerRef.current = setTimeout(() => {
        if (trackRef.current) trackRef.current.style.transition = 'none';
      }, durationMs + 60);
    },
    [trackRef, viewportRef, getSlideWidth]
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
      // 松手速度采样（快速甩动判定用）；每次手势起点清空，避免上一手势残留
      const velocity = createVelocityTracker();

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
        velocity.reset();
        velocity.sample(e.clientX, performance.now());
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
          velocity.sample(touch.clientX, performance.now());
          setTrackOffset(startOffset - dx);
        };
        // passive:false 才能 preventDefault 禁掉原生惯性滚动
        viewport.addEventListener('touchmove', moveHandler, { passive: false });
      };

      /** 手势收尾：allowFlip=false（系统取消手势）一律回弹吸附基准，绝不翻页
       *  （pointercancel 的 clientX 常为 0，照常算速度会得到假的极大甩动速度）。 */
      const finish = (e: PointerEvent, allowFlip: boolean) => {
        if (!active) return;
        active = false;
        if (moveHandler) {
          viewport.removeEventListener('touchmove', moveHandler);
          moveHandler = null;
        }
        const dx = offsetRef.current - startOffset; // 正向 = 手指左滑（offset 增大）= 下一张
        const width = viewportRef.current?.clientWidth || 1;
        if (!allowFlip) {
          animateTrackTo(startIndex, settleDurationMs(false));
          return;
        }
        // 速度取「松手事件」为最后一个样本：最后一次 touchmove 与 pointerup 之间
        // 可能已隔了几十毫秒，只用 touchmove 会低估甩动速度
        velocity.sample(e.clientX, performance.now());
        const dir = decidePageFlip({
          dx,
          viewportWidth: width,
          velocity: velocity.velocity(),
          // PostCard 原行为：鼠标与触摸同判（鼠标不享受「任意位移即翻页」）
          alwaysFlip: false,
        });
        // 一次手势最多翻一页（绝不过 2 张）
        let target = startIndex;
        if (dir > 0) target = Math.min(imageCount - 1, startIndex + 1);
        else if (dir < 0) target = Math.max(0, startIndex - 1);
        settledRef.current = target;
        onIndexChange(target);
        animateTrackTo(target, settleDurationMs(target !== startIndex));
      };

      const up = (e: PointerEvent) => finish(e, true);
      const cancel = (e: PointerEvent) => finish(e, false);

      viewport.addEventListener('pointerdown', down);
      viewport.addEventListener('pointerup', up);
      viewport.addEventListener('pointercancel', cancel);
      return () => {
        viewport.removeEventListener('pointerdown', down);
        viewport.removeEventListener('pointerup', up);
        viewport.removeEventListener('pointercancel', cancel);
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
