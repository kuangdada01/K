/**
 * ============================================================
 * 进程级 ffmpeg 并发闸门（lib/video/ffmpegGate）
 * ============================================================
 * 背景（2026-08-28 事故复盘）：4K HEVC 转码吃光内存、%iowait 飙到 90%+，
 * 整机瘫痪 8 小时。transcode.ts 已用「输出封顶 1080p + -threads 2 + nice」
 * 降低单进程开销，queue.ts 保证**转码**同一时间只跑一个 —— 但
 * POST /video 里的封面截帧（generateVideoCover）在请求处理器内直接起
 * ffmpeg，既不在队列里，也没有任何进程数上限：并发发视频时
 * 「一个转码 + N 个截帧」仍能把 CPU 打满。
 *
 * 本模块给出唯一的进程级上限：无论转码还是截帧，起 ffmpeg 前都要先拿到
 * 一个槽位，同一时间最多 MAX_CONCURRENT_FFMPEG 个 ffmpeg 进程。
 * 槽位是「直接移交」而非「先释放后抢占」，因此不存在释放瞬间被新请求
 * 插队导致超额准入的窗口。
 * ============================================================
 */

/**
 * 进程级 ffmpeg 并发上限。
 * 转码与截帧各占一个槽位即满：允许「1 转码 + 1 截帧」并行（截帧只有
 * -vframes 1 / 单档 5s，与转码并行的额外内存开销可忽略），但 2 个转码
 * 不会同时出现（queue.ts 已串行化转码）。
 */
const MAX_CONCURRENT_FFMPEG = 2;

/** 当前占用中的槽位数 */
let active = 0;
/** 排队等待槽位的唤醒函数（FIFO，保证先到先得、不饿死） */
const waiters: (() => void)[] = [];

/**
 * 在 ffmpeg 并发闸门内执行 fn。
 * @param fn 真正启动 ffmpeg 的操作（内部 await execFile）
 * @returns fn 的结果，异常原样抛出（闸门账目在 finally 中归还）
 */
export async function withFfmpegSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT_FFMPEG) {
    // 槽位由释放方在 finally 中直接移交，active 保持不变，此处不再自增
    await new Promise<void>((resolve) => waiters.push(resolve));
  } else {
    active++;
  }
  try {
    return await fn();
  } finally {
    const next = waiters.shift();
    if (next)
      next(); // 槽位移交下一个等待者（active 保持）
    else active--; // 无人等待：归还槽位
  }
}

/** 仅供测试：当前占用槽位数与等待者数量 */
export function ffmpegGateStats(): { active: number; waiting: number } {
  return { active, waiting: waiters.length };
}
