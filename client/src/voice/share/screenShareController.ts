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
  /** 信令上行（share-start 带共享方声明的采集尺寸，见 `captureSizeOf`；share-stop 不带） */
  sendShareStart(withAudio: boolean, size: { width: number; height: number } | null): void;
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

/**
 * 采集轨道声明的**像素尺寸**（`share-start` 的 width/height）。
 *
 * 拿不到或数值非法一律返回 null = "未声明" —— 服务端与观看端都会回落到接收探针，
 * 与"老客户端不发这两个字段"是同一条路径（见 shared/src/types.ts 的 VoiceParticipant.width）。
 */
export function captureSizeOf(
  track: MediaStreamTrack | null | undefined
): { width: number; height: number } | null {
  const s = track?.getSettings();
  const w = s?.width;
  const h = s?.height;
  return typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0 ? { width: w, height: h } : null;
}

/** 采集尺寸真值的等待上限 / 轮询间隔（见 [resolveCaptureSize] 的注释：为什么必须等、为什么等得起） */
const SHARE_SIZE_WAIT_MS = 300;
const SHARE_SIZE_POLL_MS = 25;

/**
 * 采集尺寸的**真值**（`share-start` 要带的那两个数）。
 *
 * ⚠️ 这里有个 Chrome 的坑，实测数据（2560x1600 屏、请求 2134x1200）：
 * ```
 *  getDisplayMedia 返回时  getSettings() = 2134x1200（比例 1.778）← 请求的**约束盒**，不是采集尺寸
 *  +100ms                 getSettings() = 1920x1200（比例 1.600）← 采集真的出帧后的真实尺寸
 * ```
 * 直接读第一次会得到一个**错的比例**（16:9 而画面是 16:10）。而这个字段在观看端是**最高优先**
 * 的比例来源，报错的比观看端就会拿 16:9 的框去套 16:10 的画面 —— 正是这一轮要消灭的东西。
 *
 * 判定规则：读数与**请求的约束盒**（[requested]，调用方传自己给 getDisplayMedia 的 ideal 值）
 * 不同 ⇒ 已经是真值，直接用（Firefox/Safari 与"源尺寸≠请求盒"的多数情况都走这条，零等待）；
 * 相同 ⇒ 可能还没出帧（Chrome 先报请求盒）⇒ 轮询等它变化，
 * 上限 [capMs]（真值 ~100ms 就出现；上限同时兜底"源尺寸恰好等于请求盒"与 Chrome 行为变化）。
 *
 * 等得起：观看端的首帧在这之后约 1s（真机实测：声明 13:25:16.206 → 首帧 13:25:17.290），
 * "首帧之前就知道比例"依然成立。
 */
export async function resolveCaptureSize(
  track: MediaStreamTrack | null | undefined,
  requested?: { width: number; height: number },
  capMs = SHARE_SIZE_WAIT_MS
): Promise<{ width: number; height: number } | null> {
  const first = captureSizeOf(track);
  if (!first) return null;
  const looksLikeRequestBox =
    !!requested && first.width === requested.width && first.height === requested.height;
  if (!looksLikeRequestBox) return first;
  const deadline = Date.now() + capMs;
  let latest = first;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, SHARE_SIZE_POLL_MS));
    latest = captureSizeOf(track) ?? latest;
    if (latest.width !== first.width || latest.height !== first.height) return latest;
  }
  return latest;
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
   * 销毁前校验）：登记流 → 包装发送流 → 本地 UI 回调 →
   * **声明状态（服务端互斥/抢占并广播）→ 挂 track** → 应用质量档 → 启动统计。
   *
   * 「声明 → 挂轨」这一对是**异步**的（见 [announce]）：声明必须带采集尺寸的**真值**，
   * 而 Chrome 要等采集真的出帧才报真值（见 [resolveCaptureSize]）。顺序不能反：
   * 先声明后挂轨，对方才不会先收到帧、比例还没到。
   *
   * @param requested 本端给 getDisplayMedia 的 ideal 宽高（用于识别"Chrome 报的是请求盒"）
   * @returns 声明+挂轨完成（返回 Promise 只为了可测：调用方（VoiceSession）不关心它何时完成）
   */
  start(stream: MediaStream, requested?: { width: number; height: number }): Promise<void> {
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

    const announced = this.announce(stream, video, requested);
    this.shareStats.start();

    this.sink.onShareChanged({ userId: this.sink.getSelfUserId(), audio: this.withShareAudio });
    if (this.shareSendVideoStream) this.sink.onShareVideo(this.shareSendVideoStream);
    return announced;
  }

  /**
   * 上行 `share-start`（带采集尺寸真值）并挂 track —— 开始共享的**唯一**入口。
   *
   * 为什么要等（而不是立刻发）：尺寸来自 [resolveCaptureSize]，Chrome 在采集出帧之前报的是
   * **请求的约束盒**（实测 2134x1200/1.778），真值要 ~100ms 后才可见（1920x1200/1.600）。
   * 发一个 16:9 的框给 16:10 的画面，观看端就会按错的框排版。
   *
   * 等待期间用户可能点了停止/被抢占（`sharingActive` 翻假）或换了另一路共享：那时**不能**再补发
   * `share-start` —— 服务端会把它当成一次新的共享声明。所以这里用 `shareStream` 身份比对兜底。
   */
  private async announce(
    stream: MediaStream,
    video: MediaStreamTrack | null,
    requested?: { width: number; height: number }
  ): Promise<void> {
    const size = await resolveCaptureSize(video, requested);
    if (!this.sharingActive || this.shareStream !== stream) return;
    this.sink.sendShareStart(this.withShareAudio, size);
    this.sink.attachShareTracksToAll();
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
