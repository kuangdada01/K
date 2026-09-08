/**
 * ============================================================
 * 视频可播规格判定测试（isPlayableVideoStream）
 * ============================================================
 * 转码完成判据：仅 H.264 且 level<=4.2、长边<=2048 视为可播；
 * 4K H.264（level 5.x）与 HEVC 一样需降级转码（Edge 等移动端浏览器
 * 的硬件解码器解不了 4K H.264，此前误判 done 导致"转码完成也不显示"）。
 * ============================================================
 */

import { describe, it, expect } from 'vitest';
import { isPlayableVideoStream } from '../src/lib/video/transcode';
import type { VideoStreamInfo } from '../src/lib/video/probe';

const h264 = (patch: Partial<VideoStreamInfo> = {}): VideoStreamInfo => ({
  codec: 'h264',
  width: 1920,
  height: 1080,
  level: 40,
  ...patch,
});

describe('isPlayableVideoStream', () => {
  it('常规 H.264 1080p（水平/竖屏）可播', () => {
    expect(isPlayableVideoStream(h264({ width: 1920, height: 1080, level: 40 }))).toBe(true);
    // 1080x1920 竖屏（手机竖拍主流规格）
    expect(isPlayableVideoStream(h264({ width: 1080, height: 1920, level: 42 }))).toBe(true);
    // 1080p60 = level 4.2
    expect(isPlayableVideoStream(h264({ width: 1280, height: 720, level: 42 }))).toBe(true);
  });

  it('4K H.264（level 5.1/5.2）不可播 → 需转码', () => {
    expect(isPlayableVideoStream(h264({ width: 3840, height: 2160, level: 51 }))).toBe(false);
    expect(isPlayableVideoStream(h264({ width: 3840, height: 2160, level: 52 }))).toBe(false);
    // 竖屏 2160x3840
    expect(isPlayableVideoStream(h264({ width: 2160, height: 3840, level: 52 }))).toBe(false);
  });

  it('长边 >2048 且 level 缺失/异常时按分辨率兜底判不可播', () => {
    expect(isPlayableVideoStream(h264({ width: 2560, height: 1080, level: null }))).toBe(false);
    expect(isPlayableVideoStream(h264({ width: 3840, height: 2160, level: null }))).toBe(false);
    // level 缺失但长边合规 → 可播
    expect(isPlayableVideoStream(h264({ level: null }))).toBe(true);
  });

  it('非 H.264（HEVC 等）一律不可播（转码为 H.264）', () => {
    expect(isPlayableVideoStream({ codec: 'hevc', width: 1920, height: 1080, level: 40 })).toBe(false);
    expect(isPlayableVideoStream({ codec: 'vp9', width: 1920, height: 1080, level: null })).toBe(false);
  });

  it('探测失败返回 null：不可播（保守，不误报完成）', () => {
    expect(isPlayableVideoStream(null)).toBe(false);
  });
});