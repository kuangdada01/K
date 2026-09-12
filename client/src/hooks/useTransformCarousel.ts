/**
 * ============================================================
 * transform 轮播轨道 Hook（useTransformCarousel）
 * ============================================================
 * 帖子详情主轮播与全屏看图共用；每个轨道实例调用一次。
 *
 * ★ 现在与 useSwipeCarousel 同源：**原生滚动分页**（hooks/snapScroll）。
 *   轨道（.imageTrack / .zoomTrack）自己就是滚动容器：
 *   `overflow-x: auto` + `scroll-snap-type: x mandatory` + 每页
 *   `scroll-snap-align: start / scroll-snap-stop: always`，
 *   拖动、松手惯性、越界回弹全部由浏览器合成器执行（线程化滚动），
 *   JS 不再逐帧写 transform —— 这是 WebView 内能拿到的最接近原生的手感。
 *
 * 为什么改：原实现每帧「触摸 → JS → 回写 style.transform」，主线程抖动直接掉帧，
 * 与原生列表/相册的手感差距主要来自这里。
 *
 * 本 Hook 负责：
 * - 索引 ↔ 滚动位置互转（animateTrackTo / setOffset / getSlideWidth / settledRef）；
 * - 绑定停靠校正（滚动停下后若没落在页边界则平滑补位，不依赖浏览器 snap 是否可用）
 *   与索引上报（attachGesture → attachSnapScroll）。
 *
 * 说明：原实现两轨道共用一份 transTimersRef，拆为各实例独立后又有定时器数组；
 * 现无自绘动画，定时器全部移除。
 * ============================================================
 */

import { useCallback, useMemo, useRef, RefObject } from 'react';
import { attachSnapScroll, scrollToPage, PROGRAMMATIC_SUPPRESS_MS } from './snapScroll';

export interface TransformCarouselApi {
  /** 当前滚动偏移（0 = 第一张） */
  offsetRef: RefObject<number>;
  /** 上次稳定停靠的图片索引（一次手势最多翻一页） */
  settledRef: RefObject<number>;
  /** 设置稳定停靠索引（ref 归 hook 所有，避免外部直接写 .current） */
  setSettled: (index: number) => void;
  /** 直接写滚动位置（无动画） */
  setOffset: (x: number) => void;
  /**
   * 单张图片的实际渲染宽度（轨道首子元素的 rect 宽）。
   * ★ 不能用 viewport.clientWidth 代替：clientWidth 取整，而 flex 布局下
   * 图片宽度可能是小数（如 95vw=373.34px），偏移按取整宽度计算会逐页累积
   * 偏差，右边缘露出下一张图片。
   */
  getSlideWidth: () => number;
  /** 平滑滚动到 index（原生合成器动画）。width 传 getSlideWidth()；
   *  durationMs 仅为兼容旧签名保留（时长由浏览器决定）。 */
  animateTrackTo: (index: number, width: number, durationMs?: number) => void;
  /** 绑定滚动监听 + 停靠校正；返回解绑函数（viewport/track 缺失时为空操作）。
   *  isZoomed: 返回 true 时位置锁定（放大态平移交给缩放 Hook） */
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
  // 当前滚动偏移（0 = 第一张）
  const offsetRef = useRef(0);
  // 上次稳定停靠的图片索引
  const settledRef = useRef(0);
  // 程序化平滑滚动的抑制截止时间（期间不做停靠校正）
  const programmaticUntilRef = useRef(0);

  const setSettled = useCallback((index: number) => {
    settledRef.current = index;
  }, []);

  /** 直接写滚动位置（无动画，原生容器同步生效并自动吸附最近页）。
   *  标记为程序化：外部定位（进入全屏定位、主轮播同步跟随）不应参与
   *  「一次手势最多翻一页」的钳制，也不该被停靠校正改写目标。 */
  const setOffset = useCallback(
    (x: number) => {
      const track = trackRef.current;
      if (!track) return;
      programmaticUntilRef.current = performance.now() + PROGRAMMATIC_SUPPRESS_MS;
      offsetRef.current = x;
      track.scrollLeft = x;
    },
    [trackRef]
  );

  /** 单张图片实际渲染宽度：轨道首子元素 rect 宽（flex:0 0 100% 下等于轨道内容宽）。
   *  退化用轨道 clientWidth，仅在首子元素缺失时兜底。 */
  const getSlideWidth = useCallback(() => {
    const track = trackRef.current;
    const first = track?.firstElementChild;
    const w = first ? first.getBoundingClientRect().width : track?.getBoundingClientRect().width;
    return w && w > 0 ? w : 0;
  }, [trackRef]);

  /** 平滑滚动到 index：原生 behavior:'smooth'（合成器动画，不占主线程逐帧） */
  const animateTrackTo = useCallback(
    (index: number, width: number, _durationMs?: number) => {
      const track = trackRef.current;
      if (!track || !(width > 0)) return;
      const target = width * index;
      if (Math.abs(track.scrollLeft - target) < 1) return;
      programmaticUntilRef.current = performance.now() + PROGRAMMATIC_SUPPRESS_MS;
      scrollToPage(track, index, width, true);
    },
    [trackRef]
  );

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
      offsetRef.current = track.scrollLeft;
      return attachSnapScroll({
        scroller: track,
        count: imageCount,
        getSlideWidth,
        offsetRef,
        settledRef,
        onIndexChange: (index) => {
          onSettled?.(index);
          onMove(index);
        },
        // exactOptionalPropertyTypes：可选属性不能显式传 undefined，条件展开
        ...(isZoomed ? { isZoomed } : {}),
        programmaticUntilRef,
      });
    },
    [getSlideWidth]
  );

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
