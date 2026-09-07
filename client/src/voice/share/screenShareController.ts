/**
 * ============================================================
 * 屏幕共享状态机（voice/share/screenShareController）
 * ============================================================
 * 自 VoiceSession.ts 拆出（行为逐行不变）：
 * - 发送端：捕获流登记、包装流（固定 stream id）、onended 兜底、
 *   质量档/清晰文字偏好、统计与自动降档
 * - 接收端：shareSharer（当前共享者）状态机、共享声音 audio 元素
 *   的静音偏好协调
 * - 服务端 share-changed 对账（被抢占兜底停止）与「断线重连对账」
 *   （ws 关闭时以服务端为准清掉本地共享状态——P1 修复）
 *
 * WebRTC/DOM 副作用（对端 track 挂载与摘除、质量档应用、信令上行、
 * 参与者列表刷新、共享声音 audio 元素、UI 回调）经 ScreenShareSink
 * 由会话（VoiceSession）注入实现；本模块不直接触碰 DOM/WebRTC，
 * 状态迁移与回调时序可用 fake sink 单测。
 * ============================================================
 */

import { ShareStatsMonitor } from './shareStatsMonitor';
import { SHARE_QUALITY_PRESETS, type ShareQuality, type ShareStats } from '../types';
import type { VoiceParticipant } from '../../types';
import { loadFlag } from '../prefs';

/** 屏幕共享质量偏好（localStorage 键随会话类使用） */
const SHARE_QUALITY_KEY = 'voice:shareQuality';
const SHARE_SHARP_KEY = 'voice:shareSharpText';
// 默认流畅 30fps：带宽不足时 60fps 会触发解码饥荒（绿块/画面停滞倒回），极清档留给手动选择
const SHARE_QUALITY_KEY_DEFAULT: ShareQuality = '1080p30';

/** 控制器 → 会话的副作用回调（会话实现；控制器内不直接触碰 DOM/WebRTC） */
export interface ScreenShareSink {
  /** 当前用户 id（会话期间可能被 joined 校正为服务端分配值，读实时值） */
  getSelfUserId(): number;
  /** self.sharing 变化（参与者列表数据源） */
  onSelfSharingChanged(sharing: boolean): void;
  /** 信令上行（share-start / share-stop） */
  sendShareStart(withAudio: boolean): void;
  sendShareStop(): void;
  /** 参与者列表刷新（共享状态变化后，与历史实现同一时刻） */
  emitParticipants(): void;
  /** 统计采样数据源（视频 sender 列表 / 房间人数） */
  getVideoSenders(): RTCRtpSender[];
  getPeerCount(): number;
  /** 把当前共享 track 挂到全部对端并应用质量档（开始共享时调用） */
  attachShareTracksToAll(): void;
  /** 摘除全部对端的共享 track（removeTrack 触发各对端自动重协商回纯音频） */
  detachShareTracksFromAll(): void;
  /** 把当前质量档应用到全部视频 sender */
  applyShareQuality(): void;
  /** UI 回调透传 */
  onShareVideo(stream: MediaStream | null): void;
  onShareChanged(info: { userId: number | null; audio: boolean }): void;
  onShareStats(stats: ShareStats | null): void;
  onShareQualityChange(q: ShareQuality): void;
  /** 远端共享系统声音的 audio 元素（新建时带当前静音偏好；默认静音以符合自动播放策略） */
  attachRemoteShareAudio(stream: MediaStream, muted: boolean): void;
  disposeRemoteShareAudio(): void;
  applyShareMuted(muted: boolean): void;
}

export class ScreenShareController {
  // ---- 发送端 ----
  /** 本端捕获流（video + 可选系统声音；getDisplayMedia 的原始返回） */
  shareStream: MediaStream | null = null;
  sharingActive = false;
  withShareAudio = false;
  /** 发送侧包装流：固定 stream id，接收端据此把"同对端第二条音频流"识别为共享系统声音 */
  shareSendVideoStream: MediaStream | null = null;
  shareSendAudioStream: MediaStream | null = null;
  /** 质量档位与"清晰文字"模式（偏好持久化，下次共享沿用） */
  shareQuality: ShareQuality;
  shareSharpText: boolean;

  // ---- 接收端 ----
  /** 共享声音开关（默认静音以符合自动播放策略，舞台上手动开启） */
  shareMuted = true;
  /** 当前共享者（全房间唯一；服务端 share-changed 广播驱动） */
  shareSharer: { userId: number; audio: boolean } | null = null;

  /** 发送端共享画面统计与自动降档（实现见 ./shareStatsMonitor.ts） */
  private shareStats: ShareStatsMonitor;

  constructor(private sink: ScreenShareSink) {
    const savedQuality = localStorage.getItem(SHARE_QUALITY_KEY) as ShareQuality | null;
    this.shareQuality =
      savedQuality && savedQuality in SHARE_QUALITY_PRESETS ? savedQuality : SHARE_QUALITY_KEY_DEFAULT;
    this.shareSharpText = loadFlag(SHARE_SHARP_KEY);
    this.shareStats = new ShareStatsMonitor({
      isSharing: () => this.sharingActive,
      getVideoSenders: () => this.sink.getVideoSenders(),
      getPeerCount: () => this.sink.getPeerCount(),
      getCaptureStream: () => this.shareStream,
      getQuality: () => this.shareQuality,
      onStats: (stats) => this.sink.onShareStats(stats),
      onAutoDowngrade: () => this.setShareQuality('1080p30'),
    });
  }

  isSharing(): boolean {
    return this.sharingActive;
  }

  /**
   * 共享开始后的状态登记（VoiceSession 已完成 getDisplayMedia 捕获与
   * 销毁前校验）。顺序与原实现逐行一致：登记流 → 包装发送流 →
   * 声明状态（服务端互斥/抢占并广播）→ 挂 track → 应用质量档 →
   * 启动统计 → UI 回调。
   */
  start(stream: MediaStream): void {
    this.shareStream = stream;
    const video = stream.getVideoTracks()[0] ?? null;
    this.withShareAudio = stream.getAudioTracks().length > 0;
    if (video) {
      // 注意：不设 contentHint='motion' —— 它会开启 Chrome 屏幕捕获的"平滑模式"
      // （帧间混合保帧率），动态画面出现明显拖影/回退感。清晰文字模式仍用 detail。
      if (this.shareSharpText) video.contentHint = 'detail';
      // 浏览器自带的"停止共享"条 → 与主动停止走同一清理路径
      video.onended = () => {
        this.stop();
      };
    }
    // 记录捕获实际帧率与分辨率：窗口/标签共享被 Chromium 限制最高 30fps，
    // 只有整屏(monitor)共享能到 60 —— 后续 UI 据此提示"选 60 档但实际只有 30"
    const capSettings = video?.getSettings();
    this.shareStats.reset({ captureFps: capSettings?.frameRate ?? 0 });
    // 发送侧包装流（固定 stream id，接收端区分共享声音与麦克风）
    this.shareSendVideoStream = video ? new MediaStream([video]) : null;
    const audio = stream.getAudioTracks()[0] ?? null;
    this.shareSendAudioStream = audio ? new MediaStream([audio]) : null;

    this.sharingActive = true;
    this.sink.onSelfSharingChanged(true);
    this.sink.emitParticipants();

    // 先声明状态（服务端互斥/抢占并广播），随后挂 track；重协商由 onnegotiationneeded 自动完成
    this.sink.sendShareStart(this.withShareAudio);
    this.sink.attachShareTracksToAll();
    this.shareStats.start();

    this.sink.onShareChanged({ userId: this.sink.getSelfUserId(), audio: this.withShareAudio });
    if (this.shareSendVideoStream) this.sink.onShareVideo(this.shareSendVideoStream);
  }

  /** 停止屏幕共享；notify=false 用于被抢占/服务端兜底（状态已在服务端翻转，不再回发 share-stop）。
   *  与主动停止/浏览器"停止共享"条走同一清理路径。 */
  stop(notify = true): void {
    if (!this.sharingActive && !this.shareStream) return;
    this.sharingActive = false;
    this.sink.onSelfSharingChanged(false);
    if (this.shareSharer?.userId === this.sink.getSelfUserId()) this.shareSharer = null;
    this.sink.detachShareTracksFromAll();
    if (this.shareStream) {
      for (const t of this.shareStream.getTracks()) t.onended = null;
      this.shareStream.getTracks().forEach((t) => t.stop());
    }
    this.shareStream = null;
    this.shareSendVideoStream = null;
    this.shareSendAudioStream = null;
    this.withShareAudio = false;
    this.shareStats.stop();
    this.sink.emitParticipants();
    if (notify) this.sink.sendShareStop();
    // removeTrack 触发各对端 onnegotiationneeded → 自动重协商回纯音频
    this.sink.onShareVideo(null);
    this.sink.onShareChanged({ userId: null, audio: false });
  }

  /** 加入房间时已有成员在共享：先立状态与徽标（画面随后经该共享者的补挂重协商到达） */
  onJoined(participants: VoiceParticipant[]): void {
    const sharer = participants.find((p) => p.sharing);
    if (sharer) {
      this.shareSharer = { userId: sharer.userId, audio: false };
      this.sink.onShareChanged({ userId: sharer.userId, audio: false });
    }
  }

  /** 服务端 share-changed 广播：全房间唯一的共享者状态以此为准 */
  onShareChanged(userId: number, active: boolean, audio: boolean): void {
    if (active) {
      this.shareSharer = { userId, audio };
    } else if (this.shareSharer?.userId === userId) {
      this.shareSharer = null;
      this.sink.disposeRemoteShareAudio();
      this.sink.onShareVideo(null);
    }
    // 被服务端判定不再共享（被抢占等）：本地兜底停止采集（状态由服务端管理，不再回发 share-stop）
    if (userId === this.sink.getSelfUserId() && !active && this.sharingActive) {
      this.stop(false);
    }
    this.sink.onShareChanged({ userId: active ? userId : null, audio });
  }

  /** 被新共享者抢占（share-force-stop）：服务端已广播状态，本地静默停止采集即可 */
  onForceStop(): void {
    this.stop(false);
  }

  /** 成员离开：离开的正是当前共享者时关闭舞台与共享声音 */
  onPeerLeft(userId: number): void {
    if (this.shareSharer?.userId !== userId) return;
    this.shareSharer = null;
    this.sink.disposeRemoteShareAudio();
    this.sink.onShareVideo(null);
    this.sink.onShareChanged({ userId: null, audio: false });
  }

  /** 收到共享画面流（服务端单共享者互斥，video track 只可能来自当前共享者） */
  onRemoteVideo(userId: number, stream: MediaStream): void {
    this.shareSharer = { userId, audio: this.shareSharer?.audio ?? false };
    this.sink.onShareVideo(stream);
  }

  /** 远端共享系统声音：独立 audio 元素直连播放（默认静音；不进 WebAudio 音量链与房间录制） */
  onRemoteShareAudio(stream: MediaStream): void {
    this.sink.attachRemoteShareAudio(stream, this.shareMuted);
    if (this.shareSharer) this.sink.onShareChanged({ userId: this.shareSharer.userId, audio: true });
  }

  /**
   * 断线重连对账（P1 修复）：共享状态以服务端为准。断线期间服务端已清除
   * member.sharing 并广播，本地不同步清掉会：观看方残留死流舞台永不关闭；
   * 共享方重连后把旧捕获流挂到新连接持续推流，与后来的共享者形成"双共享者"。
   */
  onWsClosed(): void {
    if (this.sharingActive) this.stop(false);
    if (this.shareSharer) {
      this.shareSharer = null;
      this.sink.disposeRemoteShareAudio();
      this.sink.onShareVideo(null);
      this.sink.onShareChanged({ userId: null, audio: false });
    }
  }

  /** 会话级销毁（不发 share-stop，服务端随连接移除广播 share-changed(false)） */
  destroy(): void {
    this.sharingActive = false;
    this.shareSharer = null;
    this.shareStats.stop();
    if (this.shareStream) {
      for (const t of this.shareStream.getTracks()) t.onended = null;
      this.shareStream.getTracks().forEach((t) => t.stop());
    }
    this.shareStream = null;
    this.shareSendVideoStream = null;
    this.shareSendAudioStream = null;
    this.sink.disposeRemoteShareAudio();
  }

  getShareQuality(): ShareQuality {
    return this.shareQuality;
  }

  setShareQuality(q: ShareQuality): void {
    if (!(q in SHARE_QUALITY_PRESETS)) return;
    this.shareQuality = q;
    localStorage.setItem(SHARE_QUALITY_KEY, q);
    this.sink.applyShareQuality();
    // 自动降档（1080p60 CPU 瓶颈）等内部触发的档位变更也要同步给上层 UI
    this.sink.onShareQualityChange(q);
  }

  getShareSharpText(): boolean {
    return this.shareSharpText;
  }

  /** "清晰文字"模式：contentHint=detail + 带宽不足时保分辨率降帧率（写代码/文档场景）；关 = 捕获默认行为 */
  setShareSharpText(on: boolean): void {
    this.shareSharpText = on;
    localStorage.setItem(SHARE_SHARP_KEY, on ? '1' : '0');
    const video = this.shareStream?.getVideoTracks()[0];
    if (video) {
      if (on) video.contentHint = 'detail';
      else video.contentHint = ''; // 清空 = 回到浏览器默认捕获行为（无平滑混帧）
    }
    this.sink.applyShareQuality();
  }

  /** 接收端共享声音开关（默认静音；开启动作本身即用户手势，满足自动播放策略） */
  setShareMuted(muted: boolean): void {
    this.shareMuted = muted;
    this.sink.applyShareMuted(muted);
  }

  getShareMuted(): boolean {
    return this.shareMuted;
  }
}
