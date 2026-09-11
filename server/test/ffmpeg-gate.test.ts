/**
 * ============================================================
 * ffmpeg 并发闸门单测（lib/video/ffmpegGate）
 * ============================================================
 * 覆盖：并发上限、异常归还、槽位直接移交（释放瞬间不超额准入）、FIFO。
 * ============================================================
 */

import { describe, it, expect } from 'vitest';
import { withFfmpegSlot, ffmpegGateStats } from '../src/lib/video/ffmpegGate';

/** 记录峰值并发地跑一个「占槽」任务 */
function makeTracedTask(trace: { running: number; peak: number }) {
  return () =>
    withFfmpegSlot(async () => {
      trace.running++;
      trace.peak = Math.max(trace.peak, trace.running);
      await new Promise((r) => setTimeout(r, 5));
      trace.running--;
    });
}

describe('ffmpegGate', () => {
  it('同时最多 2 个任务在跑，其余排队等待', async () => {
    const trace = { running: 0, peak: 0 };
    const task = makeTracedTask(trace);
    await Promise.all([task(), task(), task(), task(), task()]);

    expect(trace.peak).toBe(2);
    expect(trace.running).toBe(0);
    expect(ffmpegGateStats()).toEqual({ active: 0, waiting: 0 });
  });

  it('任务抛异常也归还槽位（finally 记账）', async () => {
    await expect(
      withFfmpegSlot(async () => {
        throw new Error('ffmpeg 崩了');
      })
    ).rejects.toThrow('ffmpeg 崩了');

    expect(ffmpegGateStats().active).toBe(0);
    // 槽位确实可用
    await expect(withFfmpegSlot(async () => 'ok')).resolves.toBe('ok');
  });

  it('返回值与异常原样透传', async () => {
    await expect(withFfmpegSlot(async () => 42)).resolves.toBe(42);
  });

  it('等待者按 FIFO 领取槽位', async () => {
    const order: number[] = [];
    const tasks: Promise<void>[] = [];
    // 先占满 2 个槽位并保持住
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (let i = 0; i < 2; i++) {
      tasks.push(withFfmpegSlot(() => hold));
    }
    // 再排 3 个等待者
    for (let i = 0; i < 3; i++) {
      tasks.push(
        withFfmpegSlot(async () => {
          order.push(i);
        })
      );
    }
    expect(ffmpegGateStats().waiting).toBe(3);

    release();
    await Promise.all(tasks);
    expect(order).toEqual([0, 1, 2]);
  });
});
