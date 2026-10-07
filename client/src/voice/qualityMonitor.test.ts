/**
 * ============================================================
 * 语音质量评估单测（voice/qualityMonitor）
 * ============================================================
 * jsdom 无 RTCPeerConnection：注入假对等连接快照，验证
 * - 轮询测量与分级（丢包率/往返延迟/丢包隐藏率三路阈值）
 * - 窗口增量语义（累计值不重复计入）
 * - 会话销毁后迟到 start 不复活轮询（VoiceSession 授权期间退出的竞态）
 * ============================================================
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QualityMonitor, type QualityPeerSnapshot } from './qualityMonitor';
import type { VoiceQualityLevel } from './types';

interface Report {
  userId: number;
  level: VoiceQualityLevel | null;
}

/** 假对等连接：getStats 返回可配置的 RTCStats 列表 */
function fakePeer(
  userId: number,
  reports: Record<string, unknown>[],
  connectionState: RTCPeerConnectionState = 'connected'
): QualityPeerSnapshot {
  const stats = new Map<string, unknown>();
  reports.forEach((r, i) => stats.set(`r${i}`, r));
  return {
    userId,
    pc: {
      getStats: async () => stats,
      connectionState,
    } as unknown as RTCPeerConnection,
  };
}

/** 一条正常的音频 inbound-rtp 统计 */
function audioInbound(over: Partial<Record<string, number>> = {}): Record<string, unknown> {
  return {
    type: 'inbound-rtp',
    kind: 'audio',
    packetsLost: over.packetsLost ?? 0,
    packetsReceived: over.packetsReceived ?? 1000,
    concealedSamples: over.concealedSamples ?? 0,
    totalSamplesReceived: over.totalSamplesReceived ?? 48000,
  };
}

describe('QualityMonitor', () => {
  let peers: QualityPeerSnapshot[];
  let selfReports: VoiceQualityLevel[];
  let peerReports: Report[];
  let onQuality: (userId: number, level: VoiceQualityLevel | null) => void;
  let m: QualityMonitor;

  beforeEach(() => {
    peers = [];
    selfReports = [];
    peerReports = [];
    onQuality = (userId, level) => peerReports.push({ userId, level });
    m = new QualityMonitor({
      getPeers: () => peers,
      report: (level) => selfReports.push(level),
      onQuality,
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('房间内只有自己：视为良好', async () => {
    m.start();
    await vi.advanceTimersByTimeAsync(4000);
    expect(selfReports).toEqual(['good']);
  });

  it('丢包率 > 8% 降为 poor', async () => {
    peers = [fakePeer(2, [audioInbound({ packetsLost: 120, packetsReceived: 880 })])];
    m.start();
    await vi.advanceTimersByTimeAsync(4000);
    expect(selfReports[selfReports.length - 1]).toBe('poor');
  });

  it('丢包隐藏率 5%（>3% 且 <12%）降为 fair', async () => {
    peers = [fakePeer(2, [audioInbound({ concealedSamples: 2400, totalSamplesReceived: 48000 })])];
    m.start();
    await vi.advanceTimersByTimeAsync(4000);
    expect(selfReports[selfReports.length - 1]).toBe('fair');
  });

  it('往返延迟 0.4s（>0.3s）降为 fair', async () => {
    peers = [
      fakePeer(2, [audioInbound(), { type: 'candidate-pair', nominated: true, currentRoundTripTime: 0.4 }]),
    ];
    m.start();
    await vi.advanceTimersByTimeAsync(4000);
    expect(selfReports[selfReports.length - 1]).toBe('fair');
  });

  it('窗口增量语义：累计值不重复计入（第二轮同值应为 good）', async () => {
    peers = [fakePeer(2, [audioInbound({ packetsLost: 500, packetsReceived: 500 })])];
    m.start();
    await vi.advanceTimersByTimeAsync(4000);
    expect(selfReports[selfReports.length - 1]).toBe('poor'); // 首轮窗口 = 累计值本身

    // 统计未增长 → 窗口增量为 0 → 恢复良好
    await vi.advanceTimersByTimeAsync(4000);
    expect(selfReports[selfReports.length - 1]).toBe('good');
  });

  it('连接未建立（new/disconnected）时至少降为 fair', async () => {
    peers = [fakePeer(2, [audioInbound()], 'new')];
    m.start();
    await vi.advanceTimersByTimeAsync(4000);
    expect(selfReports[selfReports.length - 1]).toBe('fair');
  });

  it('emit 去重；forget 清除计数器并通知上层删除', () => {
    m.emit(2, 'good');
    m.emit(2, 'good'); // 同值不再回调
    expect(peerReports).toEqual([{ userId: 2, level: 'good' }]);

    m.forget(2);
    expect(peerReports).toEqual([
      { userId: 2, level: 'good' },
      { userId: 2, level: null },
    ]);

    m.forget(2); // 已清除：不再重复通知
    expect(peerReports).toHaveLength(2);
  });

  it('stop 之后迟到的 start 不复活轮询（会话销毁竞态第二道闸门）', async () => {
    m.start();
    m.stop();
    m.start(); // 模拟 join 的续体在 teardown 之后才恢复执行

    await vi.advanceTimersByTimeAsync(20000);
    expect(selfReports).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
