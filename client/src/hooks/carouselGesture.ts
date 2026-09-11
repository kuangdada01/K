/**
 * ============================================================
 * 轮播手势公共参数与纯函数（carouselGesture）
 * ============================================================
 * useTransformCarousel（帖子详情主轮播 / 全屏看图）与 useSwipeCarousel
 * （信息流卡片轮播）共用同一套「松手如何落位」的手感参数——
 * 此前两处各写一套 400ms，调速率要改两遍，且容易调出不一致的手感。
 *
 * 纯函数抽出来（可单测），DOM 绑定仍留在各自的 Hook：
 * - decidePageFlip：松手后翻页方向（位移阈值 ∪ 速度阈值）
 * - createVelocityTracker：松手速度采样（滑动窗口平均，抗单帧抖动）
 *
 * 速度语义（两个 Hook 的轨道位移方向一致）：
 *   轨道 offset 增大 = 画面左移 = 下一张；
 *   手指左滑 → offset 增大 → dx > 0 → 「下一张」。
 *   velocity 与 dx 同向（正值 = 下一张），便于直接比较。
 * ============================================================
 */

/** 翻页位移阈值：拖动超过视口宽的 ~1/8 才翻页（与历史行为一致） */
export const PAGE_FLIP_THRESHOLD_RATIO = 0.12;

/** 快速甩动判定：松手速度下限（px/ms，750 px/s）。
 *  低于此速度且位移不足 1/8 屏 → 回弹原地。
 *  别调太松：0.35px/ms（350px/s）时一次随手小幅快滑就会整页翻走，
 *  手感「太快、太跳」（用户反馈「滑动太快了」即指此）。 */
export const FLING_VELOCITY_PX_PER_MS = 0.75;

/** 甩动翻页的最小位移（px）：再快也要真的划过一段距离才翻页。
 *  10px 太松（按下时的手抖就能凑够），提高到 32px 让「甩」成为明确意图 */
export const FLING_MIN_DISTANCE_PX = 32;

/** 整页落位动画时长（ms）。
 *  300ms 偏「抢」（手指刚停、画面已到站，反而显得跳），
 *  420ms 接近原生相册的翻页节奏：跟手结束 → 平稳滑到位 */
export const SLIDE_SETTLE_MS = 420;

/** 微动回弹时长（ms）：位移不足一页时画面只是回到原位，
 *  用整页的时长会显得「慢半拍」，给更短的 260ms */
export const SLIDE_REBOUND_MS = 260;

/** 落位曲线：起步柔和 → 中段推进 → 长尾缓停（合成器执行，不触发 layout）。
 *  原 easeOutQuint（cubic-bezier(0.22,1,0.36,1)）前 20% 时间吃掉约 60% 位移，
 *  配合短时长就是「嗖一下到站」，是「太快/太生硬」的主要来源 */
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

/**
 * 松手后翻页方向：-1 = 上一张，0 = 回弹原地，1 = 下一张。
 * 翻页需要满足以下任一（一次手势最多翻一页由调用方钳制）：
 * - 位移超过视口宽 PAGE_FLIP_THRESHOLD_RATIO；
 * - 快速甩动：速度 ≥ FLING_VELOCITY_PX_PER_MS 且位移 ≥ FLING_MIN_DISTANCE_PX
 *   （手指快甩时位移常常不足 1/8 屏，只按位移判定会「甩不动」；
 *    两个阈值都取得较严，避免小幅快滑把整页甩走）；
 * - mouse 指针：任意位移即翻页（历史行为，桌面端无需甩动语义）。
 */
export function decidePageFlip(opts: {
  /** 轨道位移：正 = 手指左滑 = 下一张 */
  dx: number;
  /** 视口宽度（手指位移的感知基准） */
  viewportWidth: number;
  /** 松手速度（px/ms，与 dx 同向） */
  velocity: number;
  /** 是否鼠标指针（鼠标任意位移即翻页） */
  alwaysFlip?: boolean;
}): -1 | 0 | 1 {
  const { dx, viewportWidth, velocity, alwaysFlip } = opts;
  if (alwaysFlip) return dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const movedPastThreshold = Math.abs(dx) > viewportWidth * PAGE_FLIP_THRESHOLD_RATIO;
  const flung = Math.abs(velocity) >= FLING_VELOCITY_PX_PER_MS && Math.abs(dx) >= FLING_MIN_DISTANCE_PX;
  if (!movedPastThreshold && !flung) return 0;
  return dx > 0 ? 1 : dx < 0 ? -1 : 0;
}

/** 落位时长：翻页用 SLIDE_SETTLE_MS，回弹用更短的 SLIDE_REBOUND_MS */
export function settleDurationMs(flipped: boolean): number {
  return flipped ? SLIDE_SETTLE_MS : SLIDE_REBOUND_MS;
}
