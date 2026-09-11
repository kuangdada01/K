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
 * - 松手用 CSS transition 落位：整页 300ms / 回弹 200ms，cubic-bezier(0.22, 1, 0.36, 1)，
 *   时长 +60ms 后移除 transition（参数与判定见 hooks/carouselGesture）；
 * - 首次位移判定方向：横向主导才接管（+2px 余量），纵向主导交还浏览器滚动；
 * - 拖动超过视口宽度 ~1/8（0.12）翻一页，**快速甩动**（速度 ≥ 0.35px/ms 且位移
 *   ≥ 10px）即使不足 1/8 也翻一页（一次最多一页），否则回弹起点；
 * - mouse 指针任意位移即翻页（up 判定含 e.pointerType === 'mouse'）——原行为保留。
 *
 * 说明：原实现两轨道共用一份 transTimersRef（两轨道动画在时间上互斥，
 * 且另一轨道位于 overlay 之下不可见），拆为各实例独立定时器数组后
 * 无可观察行为差异。
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

export interface TransformCarouselApi {
  /** 当前轨道像素偏移（0 = 第一张），手势跟手与动画共用 */
  offsetRef: RefObject<number>;
  /** 上次稳定停靠的图片索引：一次手势最多翻一页（防惯性一下跳过 2 张） */
  settledRef: RefObject<number>;
  /** 设置稳定停靠索引（调用方更新吸附基准；ref 归 hook 所有，避免外部直接写 .current） */
  setSettled: (index: number) => void;
  /** 直接写轨道偏移（无动画） */
  setOffset: (x: number) => void;
  /**
   * 单张图片的实际渲染宽度（轨道首子元素的 rect 宽）。
   * ★ 不能用 viewport.clientWidth 代替：clientWidth 取整，而 flex 布局下
   * 图片宽度可能是小数（如 95vw=373.34px），偏移按取整宽度计算会逐页累积
   * 偏差，右边缘露出下一张图片（用户反馈"全屏后右边缘显示下一张"的根因）。
   */
  getSlideWidth: () => number;
  /** 落位动画到 index（width = 单张图片实际宽度，传 getSlideWidth()）。
   *  durationMs 缺省为整页落位时长；回弹传更短的 settleDurationMs(false)。 */
  animateTrackTo: (index: number, width: number, durationMs?: number) => void;
  /** 绑定 pointer/touch 手势；返回解绑函数（viewport/track 缺失时为空操作）
   *  isZoomed: 可选——返回 true 时手势完全失效（放大态平移交给缩放 Hook，
   *  防止单指拖动被当成翻页） */
  attachGesture: (
    viewport: HTMLDivElement | null,
    track: HTMLDivElement | null,
    imageCount: number,
    onMove: (index: number) => void,
    onSettled?: (index: number) => void,
    isZoomed?: () => boolean
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

  /** 单张图片实际渲染宽度：轨道首子元素 rect 宽（flex:0 0 100% 下等于轨道内容宽）。
   *  退化用 viewport clientWidth（取整），仅在轨道/首子元素缺失时兜底。 */
  const getSlideWidth = useCallback(() => {
    const track = trackRef.current;
    const first = track?.firstElementChild;
    const w = first ? first.getBoundingClientRect().width : track?.getBoundingClientRect().width;
    return w && w > 0 ? w : 0;
  }, [trackRef]);

  /** 轨道落位动画：CSS transition（合成器执行，帧率满格） */
  const animateTrackTo = useCallback(
    (index: number, width: number, durationMs = SLIDE_SETTLE_MS) => {
      const track = trackRef.current;
      if (!track) return;
      const target = width * index;
      if (Math.abs(offsetRef.current - target) < 1) return;
      track.style.transition = `transform ${durationMs}ms ${SLIDE_EASING}`;
      setOffset(target);
      const t = setTimeout(() => {
        if (track) track.style.transition = 'none';
      }, durationMs + 60);
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
      onSettled?: (index: number) => void,
      isZoomed?: () => boolean
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
        // 放大态：轮播手势失效（平移由缩放 Hook 接管）
        if (isZoomed?.()) return;
        // 已有拖拽进行中再落一指（捏合起始）：取消拖拽，交还缩放 Hook 处理。
        // 否则松手时 dx 会把捏合误判成翻页；同时把半途的轨道落回吸附基准，
        // 防止停在两图之间露出下一张的边缘
        if (active) {
          active = false;
          if (moveHandler) {
            viewport.removeEventListener('touchmove', moveHandler);
            moveHandler = null;
          }
          animateTrackTo(startIndex, getSlideWidth() || viewport.clientWidth || 1);
          return;
        }
        // 动画中途再次触摸：取消 transition，从当前位置继续跟手，无缝衔接
        track.style.transition = 'none';
        clearTimers();
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
          setOffset(startOffset - dx);
        };
        // passive:false 才能 preventDefault 禁掉原生惯性滚动
        viewport.addEventListener('touchmove', moveHandler, { passive: false });
      };

      /** 手势收尾：allowFlip=false（系统取消，如 pointercancel —— 其
       *  clientX 常为 0，若照常算速度会得到一个假的极大甩动速度）一律回弹吸附基准，
       *  绝不翻页。 */
      const finish = (e: PointerEvent, allowFlip: boolean) => {
        if (!active) return;
        active = false;
        if (moveHandler) {
          viewport.removeEventListener('touchmove', moveHandler);
          moveHandler = null;
        }
        // 放大态：松手不翻页（缩放 Hook 负责后续）；但若此前已在跟手滑动
        // （先单指拖动再落第二指捏合），轨道停在半途，需落回起点吸附基准
        if (isZoomed?.()) {
          animateTrackTo(startIndex, getSlideWidth() || viewport.clientWidth || 1);
          return;
        }
        const dx = offsetRef.current - startOffset; // 正向 = 手指左滑（offset 增大）= 下一张
        // 翻页阈值按视口宽度判定（手指位移的感知基准）；
        // 落位偏移必须按图片实际渲染宽度（clientWidth 取整会导致逐页偏差露边）
        const thresholdW = viewport.clientWidth || 1;
        const slideW = getSlideWidth() || thresholdW;
        const total = imageCount;
        if (!allowFlip) {
          animateTrackTo(startIndex, slideW, settleDurationMs(false));
          return;
        }
        // 速度取「松手事件」为最后一个样本：最后一次 touchmove 与 pointerup 之间
        // 可能已隔了几十毫秒，只用 touchmove 会低估甩动速度
        velocity.sample(e.clientX, performance.now());
        const dir = decidePageFlip({
          dx,
          viewportWidth: thresholdW,
          velocity: velocity.velocity(),
          alwaysFlip: e.pointerType === 'mouse',
        });
        // 一次手势最多翻一页（绝不过 2 张）
        let target = startIndex;
        if (dir > 0) target = Math.min(total - 1, startIndex + 1);
        else if (dir < 0) target = Math.max(0, startIndex - 1);
        settledRef.current = target;
        if (onSettled) onSettled(target);
        onMove(target);
        animateTrackTo(target, slideW, settleDurationMs(target !== startIndex));
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
    [setOffset, animateTrackTo, clearTimers, getSlideWidth]
  );

  // 卸载时清理 transition 定时器（原 PostMedia 的卸载清理 effect）
  useEffect(() => {
    return () => clearTimers();
  }, [clearTimers]);

  // 稳定返回对象：消费方把它放进 effect 依赖不会造成每渲染重订阅
  return useMemo(
    () => ({
      offsetRef,
      settledRef,
      setSettled,
      setOffset,
      getSlideWidth,
      animateTrackTo,
      attachGesture,
    }),
    [setSettled, setOffset, getSlideWidth, animateTrackTo, attachGesture]
  );
}
