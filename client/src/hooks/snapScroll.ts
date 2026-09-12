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
 * 2. **索引上报**：把停靠到的页索引告诉消费方（指示点跟随、主轮播同步）。
 *    拖动过程中也上报，所以手指还没松开、点就已经跟着走了。
 *
 * 纯函数抽出来单测：nearestPageIndex（clampPageStep 已停用，保留以便回退）。
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
 *  ★ 现已停用（保留纯函数与测试以便需要时可回退）。
 *
 *  为什么停用：真机反馈「首页/详情页不能连续翻，再翻会自己滚回去」——
 *  连续两次快滑时，第二次手势开始时上一次的停靠还没结算，钳制基准
 *  仍是更早的那一页，于是把用户实际滑到的第 2 页硬拉回第 1 页。
 *  现代 WebView 有 `scroll-snap-stop: always` 保证「一次手势最多翻一张」，
 *  多次手势本来就该能连续翻，不需要这层硬钳制。 */
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
  /** 用户是否正按着手指：attachSnapScroll 会写它；Hook 的 animateTrackTo 读它
   *  来避免「拖动中被程序化滚动抢走」（指示点跟随手指时就靠这个不打架） */
  touchingRef?: { current: boolean };
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

  /**
   * ★ 触摸状态必须按来源分开跟踪，不能共用一个布尔量。
   *
   * Chromium 一旦把手势判定为原生滚动，会**立刻**补发 pointercancel
   * （此时手指还按在屏幕上，touchend 尚未到达）。若 pointercancel 就把
   * 「按着手指」清掉，拖动中途会被判成已抬手：
   * - `animateTrackTo` 失去「拖动中不程序化滚动」的保护，消费方一旦上报
   *   索引就会回写滚动位置，把用户正在拖的这一页拽走；
   * - 停靠校正也会在拖动中途插进去。
   * 真机表现正是「连续翻页时自己滚回去、一次只能翻一页」。
   *
   * 所以：touch 与 pointer 各记一份，任一为真即视为按着；只有两者都结束
   * 才认为手势结束（`parent > scroller` 的层级关系保证事件都能冒泡到这里）。
   */
  let touchActive = false;
  let pointerActive = false;
  const isTouching = () => touchActive || pointerActive;
  const syncTouching = () => {
    if (opts.touchingRef) opts.touchingRef.current = isTouching();
  };

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

    // 程序化平滑滚动进行中：既不做校正，**也不上报中间帧** ——
    // 否则消费方会把「动画途经的页」当成用户选择，重新发起一次滚动，
    // 表现为动画一顿一顿地跳
    const until = opts.programmaticUntilRef?.current ?? 0;
    if (until > 0 && performance.now() < until) return;

    const target = nearestPageIndex(offset, width, opts.count);
    // ★ 用户手势（包括拖动中）都要上报：指示点/主轮播同步全靠它。
    //   曾经把它放在 touching 判断之后，pointer 状态机一旦没清干净，
    //   上报就永久断掉 —— 现象正是「滑动后下面的点不跟随」。
    report(target);

    // 手指还按着时不做吸附校正（原生相册也不会在拖动中途吸附）
    if (isTouching()) return;

    const targetOffset = target * width;
    if (Math.abs(offset - targetOffset) > SNAP_TOLERANCE_PX) {
      // 没落在页边界（snap 不可用 / 甩过头）→ 平滑补位
      if (opts.programmaticUntilRef) {
        opts.programmaticUntilRef.current = performance.now() + PROGRAMMATIC_SUPPRESS_MS;
      }
      scrollToPage(scroller, target, width, true);
    }
  };

  const scheduleSettle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(settle, SETTLE_IDLE_MS);
  };

  const onScroll = () => {
    offsetRef.current = scroller.scrollLeft;
    // 每次滚动都重新计时：滚动停下（含惯性结束）后必然有一次 settle，
    // 索引上报与停靠校正都不会因为触摸状态而丢失
    scheduleSettle();
  };

  /** 用户开始触摸：停掉待执行的 settle，并清除上一轮程序化抑制。
   *  只在「从没按着变为按着」时做一次（touchstart 与 pointerdown 会成对到达） */
  const beginTouch = () => {
    if (isTouching()) return;
    if (opts.programmaticUntilRef) opts.programmaticUntilRef.current = 0;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    opts.onInteract?.();
  };

  /** 抬手/系统取消：两个来源都结束了才开始计时，等惯性结束后做一次停靠校正 */
  const endTouch = () => {
    syncTouching();
    if (!isTouching()) scheduleSettle();
  };

  const onTouchStart = () => {
    touchActive = true;
    syncTouching();
    beginTouch();
  };
  const onTouchEnd = () => {
    touchActive = false;
    endTouch();
  };
  const onPointerDown = () => {
    pointerActive = true;
    syncTouching();
    beginTouch();
  };
  const onPointerUp = () => {
    pointerActive = false;
    endTouch();
  };

  scroller.addEventListener('scroll', onScroll, { passive: true });
  scroller.addEventListener('pointerdown', onPointerDown, { passive: true });
  scroller.addEventListener('pointerup', onPointerUp, { passive: true });
  scroller.addEventListener('pointercancel', onPointerUp, { passive: true });
  // touch 事件与 pointer 事件并存：Chromium 把手势交给原生滚动后会立刻发
  // pointercancel（见上面的注释），此时必须靠 touchstart/touchend 继续维持
  // 「按着手指」这个事实，否则拖动中途就会失去保护
  scroller.addEventListener('touchstart', onTouchStart, { passive: true });
  scroller.addEventListener('touchend', onTouchEnd, { passive: true });
  scroller.addEventListener('touchcancel', onTouchEnd, { passive: true });

  return () => {
    scroller.removeEventListener('scroll', onScroll);
    scroller.removeEventListener('pointerdown', onPointerDown);
    scroller.removeEventListener('pointerup', onPointerUp);
    scroller.removeEventListener('pointercancel', onPointerUp);
    scroller.removeEventListener('touchstart', onTouchStart);
    scroller.removeEventListener('touchend', onTouchEnd);
    scroller.removeEventListener('touchcancel', onTouchEnd);
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    touchActive = false;
    pointerActive = false;
    syncTouching();
  };
}
