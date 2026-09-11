/**
 * ============================================================
 * 轮播手势公共参数与纯函数（carouselGesture）
 * ============================================================
 * useTransformCarousel（帖子详情主轮播 / 全屏看图）与 useSwipeCarousel
 * （信息流卡片轮播）共用同一套「跟手 → 松手落位」的手感模型。
 *
 * ★ 模型选择：**分页器（pager）而不是滚动视图（scroll view）**
 * 苹果相册的左右滑动是「一次手势翻一张」的分页器语义：方向由
 * 「当前位置 + 松手速度外推」共同决定，动画时长随剩余距离变化，
 * 越界时有橡皮筋阻尼。这与浏览器原生滚动（可一次甩过好几屏、惯性滑行
 * 不受控）是两种不同的东西——原生 scroll-snap 更接近「相册列表」而不是
 * 「单张照片翻页」，因此这里按分页器建模（也与现有 DOM/事件架构一致）。
 *
 * 纯函数抽出来便于单测（DOM 绑定留在各 Hook）：
 * - projectEndpoint / resolveTargetIndex：松手落到哪一页
 * - settleDurationMs：落位动画时长（按剩余距离自适应）
 * - rubberBand / clampOffsetWithRubberBand：越界阻尼
 * - offsetFromMatrix：动画中途落指时读回「当前肉眼所见」的轨道偏移
 *
 * 速度语义：轨道 offset 增大 = 画面左移 = 下一张；
 * 手指左滑 → offset 增大；velocity 与 offset 同向（正 = 下一张）。
 * ============================================================
 */

/** 速度投影时长（ms）：松手时把当前速度外推这么久作为「意图终点」。
 *  这是分页器的核心手感——轻快一甩即使位移很小也能翻页（iOS UIScrollView 的
 *  paging 同样用「位置 + 速度投影」决定落点），慢慢拖则按位置就近落位。 */
export const PROJECTION_MS = 220;

/** 落位动画时长下限（ms）：即使是原地回弹也给足观感，不出现「瞬间跳回」 */
export const SETTLE_MIN_MS = 260;

/** 落位动画时长上限（ms）：跨多张（点箭头/指示点）也不会拖沓 */
export const SETTLE_MAX_MS = 520;

/** 每像素剩余距离折算的额外时长（ms/px）：近的快、远的稍慢，避免固定时长的机械感 */
export const SETTLE_MS_PER_PX = 0.5;

/** 越界阻尼系数（px）：越大越「软」。iOS 的橡皮筋是位移趋近饱和，
 *  这里用 x*K/(K+x)：拖 100px 实际走 ~76px，拖 373px（一整屏）只走 ~172px */
export const RUBBER_BAND_K = 320;

/** 落位曲线：起步柔和 → 中段推进 → 长尾缓停（合成器执行，不触发 layout） */
export const SLIDE_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)';

/** 速度采样窗口（ms）：取窗口内首末样本求平均，抗单帧抖动 */
export const VELOCITY_WINDOW_MS = 90;

export interface VelocityTracker {
  /** 记录一个位置样本（t 为 performance.now() 时间戳，单位 ms） */
  sample: (x: number, t: number) => void;
  /** 窗口内平均速度（px/ms，正值 = 手指向左 = 下一张）；样本不足时返回 0 */
  velocity: () => number;
  /** 清空样本（新手势开始时调用，避免上一次手势的速度残留） */
  reset: () => void;
}

/** 松手速度采样器：滑动窗口内的平均速度。
 *  用「首末样本平均」而不是「相邻两帧差分」：单帧抖动（触摸事件的
 *  时间戳抖动、坐标取整）会让相邻差分跳变，把一次轻点误判成甩动。 */
export function createVelocityTracker(windowMs = VELOCITY_WINDOW_MS): VelocityTracker {
  let samples: { x: number; t: number }[] = [];
  return {
    sample(x: number, t: number) {
      samples.push({ x, t });
      // 至少保留 2 个样本，保证 dt > 0
      while (samples.length > 2 && t - samples[0]!.t > windowMs) samples.shift();
    },
    velocity() {
      const first = samples[0];
      const last = samples[samples.length - 1];
      if (!first || !last || first === last) return 0;
      const dt = last.t - first.t;
      if (dt <= 0) return 0;
      return -(last.x - first.x) / dt;
    },
    reset() {
      samples = [];
    },
  };
}

/** 越界阻尼：把超出边界的位移压成趋近饱和的小位移（iOS 橡皮筋手感）。
 *  入参必须是非负越界量，返回非负阻尼位移。 */
export function rubberBand(overshoot: number): number {
  const d = Math.max(0, overshoot);
  return (d * RUBBER_BAND_K) / (d + RUBBER_BAND_K);
}

/** 轨道偏移钳制 + 越界阻尼：常规区间原样返回，越界部分按 rubberBand 压缩。
 *  minOffset = 0（第一张），maxOffset = (count-1) * slideWidth（最后一张）。 */
export function clampOffsetWithRubberBand(offset: number, minOffset: number, maxOffset: number): number {
  if (offset < minOffset) return minOffset - rubberBand(minOffset - offset);
  if (offset > maxOffset) return maxOffset + rubberBand(offset - maxOffset);
  return offset;
}

/** 速度投影终点：offset + v * PROJECTION_MS（同向叠加） */
export function projectEndpoint(offset: number, velocity: number, projectionMs = PROJECTION_MS): number {
  return offset + velocity * projectionMs;
}

/**
 * 松手后落到第几页（分页器语义）：
 * 1. 用「当前位置 + 速度投影」得到意图终点，取最近的页；
 * 2. 一次手势最多翻一页（苹果相册：一甩一张），以 startIndex 为基准钳在 ±1；
 * 3. 再钳到 [0, count-1]。
 * 位置主导 + 速度主导两种情形由同一个式子统一表达：慢拖到半屏以上才翻页，
 * 快速轻甩即使位移很小也翻页。
 */
export function resolveTargetIndex(opts: {
  /** 松手时轨道偏移（px，正 = 下一张） */
  offset: number;
  /** 松手速度（px/ms，与 offset 同向） */
  velocity: number;
  /** 单页宽度（px） */
  slideWidth: number;
  /** 手势开始时已停靠的页（「最多翻一页」的基准） */
  startIndex: number;
  /** 总页数 */
  count: number;
  /** 鼠标指针：任意位移即翻页（历史行为，桌面端无甩动语义） */
  alwaysFlip?: boolean;
  /** alwaysFlip 生效所需的最小位移（px） */
  flipSlopPx?: number;
}): number {
  const { offset, velocity, slideWidth, startIndex, count, alwaysFlip, flipSlopPx = 4 } = opts;
  if (count <= 0) return 0;
  const last = count - 1;
  if (slideWidth <= 0) return Math.max(0, Math.min(last, startIndex));
  if (alwaysFlip) {
    const dx = offset - startIndex * slideWidth;
    if (dx >= flipSlopPx) return Math.min(last, startIndex + 1);
    if (dx <= -flipSlopPx) return Math.max(0, startIndex - 1);
    return startIndex;
  }
  const projected = projectEndpoint(offset, velocity);
  const raw = Math.round(projected / slideWidth);
  const clampedOnePage = Math.max(startIndex - 1, Math.min(startIndex + 1, raw));
  return Math.max(0, Math.min(last, clampedOnePage));
}

/** 落位时长：剩余距离越远越久，钳在 [SETTLE_MIN_MS, SETTLE_MAX_MS]。
 *  固定时长是「机械感」的来源——短距离回弹慢吞吞、长距离又太抢；
 *  按距离给时长后，短回弹轻快、远距离从容，接近原生翻页的节奏。 */
export function settleDurationMs(distancePx: number): number {
  const d = Math.abs(distancePx);
  const ms = SETTLE_MIN_MS + d * SETTLE_MS_PER_PX;
  return Math.round(Math.min(SETTLE_MAX_MS, Math.max(SETTLE_MIN_MS, ms)));
}

/**
 * 从 getComputedStyle(track).transform 读回当前轨道偏移（px）。
 * 用于「落位动画进行中再次落指」：从肉眼所见位置继续跟手，而不是硬跳到动画终点
 * （原实现直接置 transition:none，轨道的计算值会瞬间跳到目标值 = 跳一下）。
 * 我们只写 translate3d(-offset,0,0)，其计算值为 matrix(1,0,0,1,-offset,0)；
 * 无法解析（none / matrix3d / NaN）时返回 null，调用方保持原值。
 */
export function offsetFromMatrix(matrix: string | null | undefined): number | null {
  if (!matrix) return null;
  const m = /^matrix\(([^)]+)\)$/.exec(matrix.trim());
  if (!m) return null;
  const parts = m[1]!.split(',').map((v) => Number(v.trim()));
  if (parts.length !== 6 || parts.some((n) => !Number.isFinite(n))) return null;
  // -0 归一成 0（避免下游 Object.is/-0 比较与显示出现 "0 但符号为负" 的怪状态）
  const offset = -parts[4]!;
  return offset === 0 ? 0 : offset;
}
