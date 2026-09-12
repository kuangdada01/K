/**
 * ============================================================
 * 原生滚动分页（snapScroll）
 * ============================================================
 * 把「左右滑动」的执行权交还给**浏览器合成器**：容器自己做
 * `overflow-x: auto` + `scroll-snap-type: x mandatory`，手指拖动与松手惯性
 * 全部由 Chromium 的线程化滚动处理（与网页纵向滚动同一条路径），
 * JS 不再逐帧写 transform。
 *
 * 为什么这样才可能接近原生（微信朋友圈/酷安/小红书/系统相册）：
 * - 原实现每帧都要「触摸 → JS → 回写 style.transform」，主线程任何抖动都掉帧；
 * - 原生滚动走合成器，手指与画面之间没有 JS 这一跳，惯性与越界回弹是浏览器
 *   自带的物理，和原生列表的手感同源。
 *
 * JS 只做两件事（都不参与逐帧动画，因此不影响顺滑度）：
 * 1. **停靠校正**：滚动停下后若没落在页边界（老 WebView 不支持 snap，
 *    或极快甩动时 snap-stop 未生效），平滑补一次 scrollTo 到最近页 ——
 *    这是「绝不停在两张图之间」的硬保证，不依赖浏览器 snap 是否可用；
 * 2. **一次手势最多翻一页**：以手势起点为基准钳 ±1（保住既有产品语义）。
 *
 * 纯函数抽出来单测：nearestPageIndex / clampPageStep。
 * ============================================================
 */

/** 多久没有 scroll 事件就算「滚动已停」（ms）。原生惯性一般 300~1500ms，
 *  但事件是连续的：最后一次事件之后再等这么久，运动必然结束 */
export const SETTLE_IDLE_MS = 110;

/** 判定「已经落在页边界」的容差（px）：原生滚动落点是亚像素的，留一点余量 */
export const SNAP_TOLERANCE_PX = 2;

/** 程序化平滑滚动（箭头/指示点/自动轮播）后，抑制停靠校正的时长（ms）。
 *  否则校正会把正在进行的平滑滚动当成「用户甩歪了」而中途改写目标 */
export const PROGRAMMATIC_SUPPRESS_MS = 600;

/** 由滚动偏移求最近的页索引（钳在 [0, count-1]） */
export function nearestPageIndex(offset: number, slideWidth: number, count: number): number {
  if (count <= 0) return 0;
  if (!(slideWidth > 0)) return 0;
  const raw = Math.round(offset / slideWidth);
  return Math.max(0, Math.min(count - 1, raw));
}

/** 一次手势最多翻 maxStep 页：把目标页钳在起点附近。
 *  现代 WebView 有 scroll-snap-stop: always 兜底，本函数是老内核与
 *  极端甩动的硬保证（产品语义：一甩一张）。 */
export function clampPageStep(target: number, startIndex: number, maxStep = 1): number {
  const step = Math.max(1, maxStep);
  return Math.max(startIndex - step, Math.min(startIndex + step, target));
}

export interface SnapScrollOptions {
  /** 滚动容器（自己就是 flex 轨道；子元素为各页） */
  scroller: HTMLElement;
  /** 页数 */
  count: number;
  /** 单页宽度（px）；返回 0 时退化为 scroller.clientWidth */
  getSlideWidth: () => number;
  /** 当前偏移（= scrollLeft），供消费方读取 */
  offsetRef: { current: number };
  /** 上次稳定停靠的页索引（ref 归 Hook 所有） */
  settledRef: { current: number };
  /** 用户开始触摸（信息流卡片用于停止自动轮播） */
  onInteract?: () => void;
  /** 停靠页变化（含首次校正后） */
  onIndexChange?: (index: number) => void;
  /** 放大态：位置锁定，不做任何校正也不上报（缩放 Hook 接管平移） */
  isZoomed?: () => boolean;
  /** 程序化平滑滚动的抑制截止时间（performance.now() 基准，读由 Hook 写入的 ref） */
  programmaticUntilRef?: { current: number };
}

/** 程序化滚动：索引 → 平滑 scrollTo（合成器动画，非 JS 逐帧） */
export function scrollToPage(scroller: HTMLElement, index: number, slideWidth: number, smooth = true): void {
  const left = Math.max(0, index * slideWidth);
  if (smooth && typeof scroller.scrollTo === 'function') {
    scroller.scrollTo({ left, behavior: 'smooth' });
  } else {
    scroller.scrollLeft = left;
  }
}

/**
 * 绑定原生滚动的辅助逻辑（停靠校正 + 手势起点记录 + 索引上报）。
 * 返回解绑函数。**不接管任何触摸移动**：拖动完全由浏览器滚动处理。
 */
export function attachSnapScroll(opts: SnapScrollOptions): () => void {
  const { scroller, offsetRef, settledRef } = opts;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let touching = false;
  let gestureStartIndex = 0;
  // 「一次手势最多翻一页」只对**用户手势**生效：点第 5 个指示点、代码里
  // setOffset 定位都应当允许直接跨多页，不能被钳回 ±1
  let clampNextSettle = false;

  const slideWidth = () => opts.getSlideWidth() || scroller.clientWidth || 0;

  const report = (index: number) => {
    if (index === settledRef.current) return;
    settledRef.current = index;
    opts.onIndexChange?.(index);
  };

  const settle = () => {
    idleTimer = null;
    const width = slideWidth();
    const offset = scroller.scrollLeft;
    offsetRef.current = offset;
    // 放大态：位置由缩放 Hook 锁定，不做校正也不上报
    if (opts.isZoomed?.()) return;
    // 程序化平滑滚动进行中：别把它当成「用户甩歪了」。
    // 同时清掉待生效的「一次一页」钳制——程序化跳转（点指示点/箭头/自动轮播）
    // 可能紧跟在一个用户手势之后，若不清掉会把这次跳转钳回起点附近。
    const until = opts.programmaticUntilRef?.current ?? 0;
    if (until > 0 && performance.now() < until) {
      clampNextSettle = false;
      return;
    }

    let target = nearestPageIndex(offset, width, opts.count);
    // 一次手势最多翻一页（snap-stop 生效时本就不会触发；这里是硬保证）。
    // 只在用户手势结束后的那次停靠生效 —— 程序化/外部定位可自由跨页。
    if (clampNextSettle) target = clampPageStep(target, gestureStartIndex);
    clampNextSettle = false;
    target = Math.max(0, Math.min(opts.count - 1, target));

    const targetOffset = target * width;
    if (Math.abs(offset - targetOffset) > SNAP_TOLERANCE_PX) {
      // 没落在页边界（snap 不可用 / 甩过头）→ 平滑补位
      if (opts.programmaticUntilRef) {
        opts.programmaticUntilRef.current = performance.now() + PROGRAMMATIC_SUPPRESS_MS;
      }
      scrollToPage(scroller, target, width, true);
    }
    report(target);
  };

  const scheduleSettle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(settle, SETTLE_IDLE_MS);
  };

  const onScroll = () => {
    offsetRef.current = scroller.scrollLeft;
    // 手指还按着时不停靠（原生相册同样不会在拖动中途吸附）
    if (touching) return;
    scheduleSettle();
  };

  const onPointerDown = () => {
    touching = true;
    gestureStartIndex = settledRef.current;
    clampNextSettle = true;
    // 用户接管：清除上一轮程序化抑制，避免刚点开就被当成程序化滚动
    if (opts.programmaticUntilRef) opts.programmaticUntilRef.current = 0;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    opts.onInteract?.();
  };

  const onPointerUp = () => {
    touching = false;
    // 抬手后开始计时：惯性结束后校正
    scheduleSettle();
  };

  scroller.addEventListener('scroll', onScroll, { passive: true });
  scroller.addEventListener('pointerdown', onPointerDown, { passive: true });
  scroller.addEventListener('pointerup', onPointerUp, { passive: true });
  scroller.addEventListener('pointercancel', onPointerUp, { passive: true });

  return () => {
    scroller.removeEventListener('scroll', onScroll);
    scroller.removeEventListener('pointerdown', onPointerDown);
    scroller.removeEventListener('pointerup', onPointerUp);
    scroller.removeEventListener('pointercancel', onPointerUp);
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    touching = false;
  };
}
