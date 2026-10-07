/**
 * ============================================================
 * 发送端共享画面实时统计（voice/share/shareStatsMonitor）
 * ============================================================
 * 解决"选 60 档但画面糊/帧率低"的盲区：实际发送帧率、码率、分辨率、
 * 编码降级原因全部可视化 + CPU 编码瓶颈时自动降档。
 * 从 VoiceSession 抽出；会话通过 deps 提供只读数据源与回调。
 */
import type { ShareQuality, ShareStats } from '../types';

/** 发送端共享画面统计采样间隔（帧率/码率/降级原因） */
const SHARE_STATS_INTERVAL_MS = 2000;

export interface ShareStatsDeps {
  /** 是否正在共享（未共享时上报 null 清空 UI） */
  isSharing(): boolean;
  /** mesh 下每个对端一个视频 sender（共享中） */
  getVideoSenders(): RTCRtpSender[];
  /** 房间成员数（区分"无人观看"与"有对端但 sender 数据未就绪"） */
  getPeerCount(): number;
  /** 本端捕获流（getDisplayMedia 原始返回；读 getSettings 取捕获分辨率/帧率） */
  getCaptureStream(): MediaStream | null;
  /** 当前质量档位（自动降档判定用） */
  getQuality(): ShareQuality;
  /** 统计上报（UI 状态栏与提示条） */
  onStats(stats: ShareStats | null): void;
  /** 1080p60 连续采样被 CPU 编码瓶颈卡住 → 会话执行 setShareQuality('1080p30') */
  onAutoDowngrade(): void;
}

export class ShareStatsMonitor {
  private deps: ShareStatsDeps;
  private timer: number | null = null;
  /** outbound-rtp 累计字节缓存（发送码率按窗口增量计算） */
  private lastOutbound = new Map<RTCRtpSender, { bytes: number; ts: number }>();
  /** 捕获源实际帧率（getSettings().frameRate 快照；窗口/标签共享被浏览器限制为 30） */
  private captureFps = 0;
  /** 1080p60 档已被 CPU 编码瓶颈自动降档（一次共享会话只触发一次，防反复横跳） */
  private autoDowngraded = false;
  /** 自动降档判定计数（连续 2 次采样命中才触发，避免瞬时抖动误判） */
  private cpuStrike = 0;

  constructor(deps: ShareStatsDeps) {
    this.deps = deps;
  }

  /** 共享开始时重置统计状态（captureFps 为捕获协商结果的首次快照） */
  reset(opts: { captureFps: number }): void {
    this.captureFps = opts.captureFps;
    this.autoDowngraded = false;
    this.cpuStrike = 0;
    this.lastOutbound.clear();
  }

  start(): void {
    this.stop();
    this.timer = window.setInterval(() => {
      this.measure().catch(() => {
        /* 统计失败忽略，下轮再试 */
      });
    }, SHARE_STATS_INTERVAL_MS);
  }

  /** 停止采样并清空字节缓存（共享结束/会话销毁时调用） */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.lastOutbound.clear();
  }

  /** 聚合采样全部视频 sender（mesh 下每个对端一个 sender）：
   *  帧率取最大值（观众解码能力不影响发送），码率/分辨率/降级原因取首个有数据的 */
  private async measure(): Promise<void> {
    if (!this.deps.isSharing()) {
      this.deps.onStats(null);
      return;
    }
    let fps = 0;
    let bitrate = 0;
    let width = 0;
    let height = 0;
    let limitation = 'none';
    const now = performance.now();
    let bytesDelta = 0;
    let tsDelta = 0;
    let sampled = false;
    for (const sender of this.deps.getVideoSenders()) {
      const stats = await sender.getStats();
      for (const r of stats.values()) {
        if (r.type !== 'outbound-rtp' || (r as { kind?: string }).kind !== 'video') continue;
        sampled = true;
        const o = r as RTCStats & {
          framesPerSecond?: number;
          frameWidth?: number;
          frameHeight?: number;
          qualityLimitationReason?: string;
          bytesSent?: number;
        };
        if (o.framesPerSecond) fps = Math.max(fps, o.framesPerSecond);
        if (!width && o.frameWidth) {
          width = o.frameWidth;
          height = o.frameHeight ?? 0;
        }
        if (o.qualityLimitationReason && o.qualityLimitationReason !== 'none')
          limitation = o.qualityLimitationReason;
        if (typeof o.bytesSent === 'number') {
          const prev = this.lastOutbound.get(sender);
          if (prev) {
            bytesDelta += Math.max(0, o.bytesSent - prev.bytes);
            tsDelta += Math.max(1, now - prev.ts);
          }
          this.lastOutbound.set(sender, { bytes: o.bytesSent, ts: now });
        }
      }
    }
    // 捕获分辨率/帧率：getSettings() 每轮都读（协商后浏览器回填实际值）
    let captureWidth = 0;
    let captureHeight = 0;
    let captureFps = this.captureFps;
    const cap = this.deps.getCaptureStream()?.getVideoTracks()[0]?.getSettings();
    if (cap) {
      captureWidth = cap.width ?? 0;
      captureHeight = cap.height ?? 0;
      if (cap.frameRate) captureFps = cap.frameRate;
    }
    // 无人观看（单人房间/观众尚未连上）：没有 video sender 数据，只上报捕获信息，
    // 让 UI 仍能提示捕获帧率限制（窗口/标签共享 30fps）
    if (!sampled && this.deps.getPeerCount() === 0) {
      this.deps.onStats({
        fps: 0,
        bitrate: 0,
        width: 0,
        height: 0,
        captureWidth,
        captureHeight,
        limitation: 'none',
        captureFps,
        autoDowngraded: this.autoDowngraded,
        resolutionDownscaled: false,
      });
      return;
    }
    if (!sampled) return; // 有对端但 sender 数据未就绪，等下一轮
    bitrate = tsDelta > 0 ? Math.round((bytesDelta * 8) / (tsDelta / 1000)) : 0;

    // 带宽降级判定：发送分辨率明显小于捕获分辨率 = 编码器在降分辨率保帧率（糊的直接来源）
    const resolutionDownscaled = width > 0 && captureWidth > 0 && width < captureWidth * 0.75;

    // 自动纠偏：1080p60 档被 CPU 编码瓶颈卡住（软编/硬件编码器受限）时自动降 1080p30，
    // 连续 2 次采样命中才触发；一次共享会话只降一次，避免与用户手动档位反复拉锯
    let autoDowngraded = this.autoDowngraded;
    if (this.deps.getQuality() === '1080p60' && !autoDowngraded && fps > 0) {
      if (fps < 45 && (limitation === 'cpu' || limitation === 'other')) {
        this.cpuStrike += 1;
        if (this.cpuStrike >= 2) {
          this.autoDowngraded = true;
          autoDowngraded = true;
          // 降档本身会触发 UI 档位变化；再发一帧统计让提示条即时出现
          this.deps.onAutoDowngrade();
          this.deps.onStats({
            fps,
            bitrate,
            width,
            height,
            captureWidth,
            captureHeight,
            limitation,
            captureFps,
            autoDowngraded,
            resolutionDownscaled,
          });
          return;
        }
      } else {
        this.cpuStrike = 0;
      }
    }

    this.deps.onStats({
      fps,
      bitrate,
      width,
      height,
      captureWidth,
      captureHeight,
      limitation,
      captureFps,
      autoDowngraded,
      resolutionDownscaled,
    });
  }
}
