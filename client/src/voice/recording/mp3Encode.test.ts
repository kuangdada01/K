/**
 * 录制编码工具测试（voice/recording/mp3Encode）
 * 覆盖：切片拼接、PCM→MP3 端到端编码、格式探测在无 MediaRecorder 环境的降级
 */
import { describe, it, expect } from 'vitest';
import { concatFloat32, encodePcmToMp3, pickRecorderMime } from './mp3Encode';

describe('concatFloat32', () => {
  it('按序拼接多个切片', () => {
    const out = concatFloat32([new Float32Array([1, 2]), new Float32Array([3]), new Float32Array([])]);
    expect([...out]).toEqual([1, 2, 3]);
  });

  it('空输入返回空数组', () => {
    expect(concatFloat32([]).length).toBe(0);
  });
});

describe('encodePcmToMp3', () => {
  it('标准采样率输入产出 MP3 Blob', async () => {
    // 100ms 的 48kHz 正弦样本
    const pcm = new Float32Array(4800);
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.5;
    const blob = await encodePcmToMp3(pcm, 48_000);
    expect(blob.type).toBe('audio/mpeg');
    expect(blob.size).toBeGreaterThan(0);
  });

  it('非 lamejs 支持的采样率（如 44106）归一到 44.1k 后仍可编码', async () => {
    const pcm = new Float32Array(4410); // 100ms
    const blob = await encodePcmToMp3(pcm, 44_106);
    expect(blob.type).toBe('audio/mpeg');
    expect(blob.size).toBeGreaterThan(0);
  });
});

describe('pickRecorderMime', () => {
  it('无 MediaRecorder 环境（jsdom）安全返回空串', () => {
    expect(pickRecorderMime()).toBe('');
  });
});
