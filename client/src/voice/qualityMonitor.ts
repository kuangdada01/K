/**
 * ============================================================
 * 语音质量评估（voice/qualityMonitor）
 * ============================================================
 * 自报语义：评估"自己的网络"（全部对等连接的窗口增量丢包/往返延迟/丢包隐藏率），
 * 变化时上报服务器广播给全房间。从 VoiceSession 抽出；
 * 会话通过 deps 提供对等连接快照，计数器按 userId 保存在本类内
 * （成员离开/断线重连时由会话调用 forget/forgetAll 对齐 PeerEntry 生命周期）。
 */
import type { VoiceQualityLevel } from './types';

/** 语音质量评估间隔 */
const QUALITY_INTERVAL_MS = 4000;
/** 质量分级阈值：丢包率超过 2%/8%、往返延迟超过 300ms/600ms 依次降级 */
const QUALITY_LOSS_FAIR = 0.02;
const QUALITY_LOSS_POOR = 0.08;
const QUALITY_RTT_FAIR = 0.3;
const QUALITY_RTT_POOR = 0.6;
/** 丢包隐藏率阈值（接收端用合成音频填补丢包的比例，即"电流声/机器声"的直接指标）：
 *  良好网络 <1%，普通 WiFi 1~3%，>3% 可闻劣化、>12% 明显断续 */
const QUALITY_CONCEAL_FAIR = 0.03;
const QUALITY_CONCEAL_POOR = 0.12;

export interface QualityPeerSnapshot {
  userId: number;
  pc: RTCPeerConnection;
}

export interface QualityMonitorDeps {
  getPeers(): QualityPeerSnapshot[];
  /** 自报网络质量：本地即时展示自己的点 + 上报服务器广播给全房间 */
  report(level: VoiceQualityLevel): void;
  /** 某成员质量状态变化（level=null 表示清除该成员的残留状态） */
  onQuality(userId: number, level: VoiceQualityLevel | null): void;
}

/** 单个对端上一轮的统计累计值（丢包率按窗口增量计算，避免早期网络高峰永久拖累显示） */
interface PeerWindowCounters {
  lastPacketsLost: number;
  lastPacketsReceived: number;
  lastConcealedSamples: number;
  lastTotalSamples: number;
}

export class QualityMonitor {
  private deps: QualityMonitorDeps;
  private timer: number | null = null;
  /** 各成员当前展示的质量等级（key 为 userId，含自己） */
  private levels = new Map<number, VoiceQualityLevel>();
  /** 各对端的窗口增量计数器（生命周期对齐 PeerEntry，见 forget/forgetAll） */
  private counters = new Map<number, PeerWindowCounters>();

  constructor(deps: QualityMonitorDeps) {
    this.deps = deps;
  }

  start(): void {
    this.timer = window.setInterval(() => {
      this.measure().catch(() => {
        /* 统计失败忽略，下轮再试 */
      });
    }, QUALITY_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 广播质量更新（去重后透传给上层） */
  emit(userId: number, level: VoiceQualityLevel): void {
    if (this.levels.get(userId) === level) return;
    this.levels.set(userId, level);
    this.deps.onQuality(userId, level);
  }

  /** 清除某成员的质量状态并通知上层删除（level=null 语义） */
  clear(userId: number): void {
    if (!this.levels.has(userId)) return;
    this.levels.delete(userId);
    this.deps.onQuality(userId, null);
  }

  /** 成员离开：丢弃其窗口计数器（新成员进房时从零累计） */
  forget(userId: number): void {
    this.counters.delete(userId);
    this.clear(userId);
  }

  /** 断线重建：全部对等连接失效，清空计数器与质量显示（自己的自报值会在重连后重新上报） */
  forgetAll(): void {
    this.counters.clear();
    for (const userId of [...this.levels.keys()]) this.clear(userId);
  }

  private async measure(): Promise<void> {
    const peers = this.deps.getPeers();
    if (peers.length === 0) {
      // 房间里只有自己：无对等连接，网络状态视为良好
      this.deps.report('good');
      return;
    }

    let deltaLost = 0;
    let deltaReceived = 0;
    let deltaConcealed = 0;
    let deltaSamples = 0;
    const rtts: number[] = [];
    let degraded = false;

    for (const { userId, pc } of peers) {
      const counters = this.counters.get(userId) ?? {
        lastPacketsLost: 0,
        lastPacketsReceived: 0,
        lastConcealedSamples: 0,
        lastTotalSamples: 0,
      };
      let lost = 0;
      let received = 0;
      let concealed = 0;
      let samples = 0;
      const peerRtts: number[] = [];
      const stats = await pc.getStats();
      stats.forEach((r: RTCStats) => {
        const report = r as {
          type: string;
          kind?: string;
          packetsLost?: number;
          packetsReceived?: number;
          nominated?: boolean;
          state?: string;
          currentRoundTripTime?: number;
          concealedSamples?: number;
          totalSamplesReceived?: number;
        };
        if (report.type === 'inbound-rtp' && report.kind === 'audio') {
          lost += Math.max(0, report.packetsLost ?? 0);
          received += Math.max(0, report.packetsReceived ?? 0);
          // 丢包隐藏（NetEq 合成插值）样本：FEC/RED 冗余恢复失败后接收端只能合成填补，
          // 隐藏率是"电流声/机器声"最直接的观测指标（丢包率看不出 FEC 已兜住的部分）
          concealed += Math.max(0, report.concealedSamples ?? 0);
          samples += Math.max(0, report.totalSamplesReceived ?? 0);
        } else if (
          report.type === 'candidate-pair' &&
          (report.nominated === true || report.state === 'succeeded') &&
          typeof report.currentRoundTripTime === 'number'
        ) {
          peerRtts.push(report.currentRoundTripTime);
        }
      });
      // 丢包率按窗口增量计算（上次→本次）：早期网络高峰不会永久拖累显示，
      // 计数器回绕/重协商导致的负增量按 0 处理
      deltaLost += Math.max(0, lost - counters.lastPacketsLost);
      deltaReceived += Math.max(0, received - counters.lastPacketsReceived);
      deltaConcealed += Math.max(0, concealed - counters.lastConcealedSamples);
      deltaSamples += Math.max(0, samples - counters.lastTotalSamples);
      this.counters.set(userId, {
        lastPacketsLost: lost,
        lastPacketsReceived: received,
        lastConcealedSamples: concealed,
        lastTotalSamples: samples,
      });
      // 连接失败的对等路径不并入统计；断线/新建连接视为自身网络降级信号
      const connState = pc.connectionState;
      if (connState === 'failed') continue;
      rtts.push(...peerRtts);
      if (connState === 'disconnected' || connState === 'new') degraded = true;
    }

    // 连接没建立成功时没有任何统计（会被误判为良好），用连接状态修正
    let level = this.grade(deltaLost, deltaReceived, rtts, deltaConcealed, deltaSamples);
    if (degraded) level = level === 'good' ? 'fair' : level;
    this.deps.report(level);
  }

  private grade(
    lost: number,
    received: number,
    rtts: number[],
    concealed: number,
    samples: number
  ): VoiceQualityLevel {
    const lossRate = lost + received > 0 ? lost / (lost + received) : 0;
    const avgRtt = rtts.length > 0 ? rtts.reduce((a, b) => a + b, 0) / rtts.length : 0;
    // 隐藏率：无样本（连接未建立/浏览器不报）时不参与降级
    const concealRate = samples > 0 ? concealed / samples : 0;
    if (lossRate > QUALITY_LOSS_POOR || avgRtt > QUALITY_RTT_POOR || concealRate > QUALITY_CONCEAL_POOR)
      return 'poor';
    if (lossRate > QUALITY_LOSS_FAIR || avgRtt > QUALITY_RTT_FAIR || concealRate > QUALITY_CONCEAL_FAIR)
      return 'fair';
    return 'good';
  }
}
