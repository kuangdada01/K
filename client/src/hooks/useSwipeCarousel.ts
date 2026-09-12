/**
 * ============================================================
 * 帖子卡片手势轮播 Hook（useSwipeCarousel）
 * ============================================================
 * ★ 现在是**原生滚动分页**（snapScroll）：滚动容器自己做
 *   `overflow-x: auto` + `scroll-snap-type: x mandatory`，拖动/惯性/越界
 *   全交给浏览器合成器（线程化滚动），JS 不再逐帧写 transform ——
 *   这是 WebView 里唯一能拿到「跟手、不掉帧」的路径（详见 hooks/snapScroll）。
 *
 * 于是本 Hook 只剩下：
 * - 把索引写进滚动位置（animateTrackTo / setTrackOffset）；
 * - 把滚动位置读回来（offsetRef / getSlideWidth / settledRef）；
 * - 绑定停靠校正与索引上报（attachGesture → attachSnapScroll）。
 *
 * 与 useTransformCarousel（帖子详情/全屏看图）同源，两处手感一致。
 * ============================================================
 */

import { useCallback, useEffect, useMemo, useRef, RefObject } from 'react';
import { attachSnapScroll, scrollToPage, PROGRAMMATIC_SUPPRESS_MS } from './snapScroll';

export interface SwipeCarouselApi {
  /** 当前滚动偏移（0 = 第一张），与 scrollLeft 同步 */
  offsetRef: RefObject<number>;
  /** 上次稳定停靠的图片索引（一次手势最多翻一页） */
  settledRef: RefObject<number>;
  /** 设置稳定停靠索引（ref 归 hook 所有，避免外部直接写 .current） */
  setSettled: (index: number) => void;
  /** 直接写滚动位置（无动画） */
  setTrackOffset: (offset: number) => void;
  /** 平滑滚动到 index（合成器动画；距离过近时为无操作） */
  animateTrackTo: (index: number, durationMs?: number) => void;
  /** 绑定滚动监听 + 停靠校正；返回解绑函数（viewport/track 缺失时为空操作） */
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
  // 当前滚动偏移（0 = 第一张）
  const offsetRef = useRef(0);
  // 上次稳定停靠的图片索引
  const settledRef = useRef(0);
  // 程序化平滑滚动的抑制截止时间（期间不做停靠校正）
  const programmaticUntilRef = useRef(0);

  const setSettled = useCallback((index: number) => {
    settledRef.current = index;
  }, []);

  /** 直接写滚动位置（无动画）：原生容器同步生效，且会自动吸附到最近的页。
   *  标记为程序化：外部定位不应被「一次手势最多翻一页」钳制，也不该被停靠校正改写 */
  const setTrackOffset = useCallback(
    (offset: number) => {
      const track = trackRef.current;
      if (!track) return;
      programmaticUntilRef.current = performance.now() + PROGRAMMATIC_SUPPRESS_MS;
      offsetRef.current = offset;
      track.scrollLeft = offset;
    },
    [trackRef]
  );

  /** 单张图片实际渲染宽度：轨道首子元素 rect 宽（flex:0 0 100% 下等于轨道内容宽）。
   *  ★ 不能用 viewport clientWidth：clientWidth 取整，flex 布局下图片宽度可能是
   *  小数（如 95vw=373.34px），偏移按取整宽度计算会逐页累积偏差露出下一张边缘。
   *  jsdom 无布局时回退到 clientWidth，保证可测。 */
  const getSlideWidth = useCallback(() => {
    const track = trackRef.current;
    const first = track?.firstElementChild;
    const w = first ? first.getBoundingClientRect().width : track?.getBoundingClientRect().width;
    return w && w > 0 ? w : 0;
  }, [trackRef]);

  /** 平滑滚动到 index（原生 behavior:'smooth' 走合成器，不是 JS 逐帧动画）。
   *  durationMs 参数仅为兼容旧签名保留——时长由浏览器决定，不再自定义。 */
  const animateTrackTo = useCallback(
    (index: number, _durationMs?: number) => {
      const track = trackRef.current;
      if (!track) return;
      const width = getSlideWidth() || viewportRef.current?.clientWidth || 0;
      if (!(width > 0)) return;
      const target = width * index;
      if (Math.abs(track.scrollLeft - target) < 1) return;
      programmaticUntilRef.current = performance.now() + PROGRAMMATIC_SUPPRESS_MS;
      scrollToPage(track, index, width, true);
    },
    [trackRef, viewportRef, getSlideWidth]
  );

  const attachGesture = useCallback(
    (
      viewport: HTMLDivElement | null,
      track: HTMLDivElement | null,
      imageCount: number,
      onInteract: () => void,
      onIndexChange: (index: number) => void
    ) => {
      if (!viewport || !track) return () => {};
      // 初始停靠索引与滚动位置对齐（外部可能已设过 setSettled/首次渲染）
      offsetRef.current = track.scrollLeft;
      return attachSnapScroll({
        scroller: track,
        count: imageCount,
        getSlideWidth,
        offsetRef,
        settledRef,
        onInteract,
        onIndexChange,
        programmaticUntilRef,
      });
    },
    [getSlideWidth]
  );

  // 卸载时清掉可能残留的定时器（attachSnapScroll 的 detach 已处理；
  // 这里保留 effect 以维持「Hook 自身可安全卸载」的语义）
  useEffect(() => {
    return () => {
      programmaticUntilRef.current = 0;
    };
  }, []);

  return useMemo(
    () => ({ offsetRef, settledRef, setSettled, setTrackOffset, animateTrackTo, attachGesture }),
    [setSettled, setTrackOffset, animateTrackTo, attachGesture]
  );
}
