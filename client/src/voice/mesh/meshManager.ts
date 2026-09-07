/**
 * ============================================================
 * WebRTC Mesh 连接管理（voice/mesh/meshManager）
 * ============================================================
 * 自 VoiceSession.ts 拆出（行为逐行不变，按文档拆分顺序最后一个模块）：
 * - 对端条目生命周期：ensurePeer（PC 建连/发送轨道/编解码偏好/事件接线）、
 *   removePeer/disposePeer/cleanupPeers
 * - 完美协商：initiateOffer（初始/ICE 重启/共享 track 重协商共用）、
 *   handleSignal（offer 冲突暂存/过期 answer 忽略/坏候选静默）、
 *   processRemoteOffer、flushPendingOffer（补处理）、flushCandidates
 * - ICE 重启打洞（最多 2 次，userId 较小一方发起）
 * - 音频/共享分流：ontrack video = 共享画面、同对端第二条音频流 =
 *   共享系统声音、首条音频流 = 麦克风（走音频图 + 录制总线）
 *
 * 会话侧依赖（自身参与者的实时信息、发送轨道、ICE 配置、信令上行、
 * 音频图/共享/录制/质量回调）经 MeshManagerOptions 注入。
 * ============================================================
 */

import { applyOpusPreferences } from '../sdp';
import type { VoiceParticipant } from '../../types';
import type { VoiceSignalPayload } from '../types';
import type { PeerAudio } from '../audio/audioGraph';
import type { PeerEntry } from './meshPeer';

export interface MeshManagerOptions {
  /** 实时自身信息（joined 校正后 userId 以服务端为准） */
  getSelf(): VoiceParticipant;
  /** 本端发送轨道（听者模式为 null） */
  getSendTrack(): MediaStreamTrack | null;
  /** 当前 ICE 配置 */
  getIceServers(): RTCIceServer[];
  /** 音乐模式（编解码偏好：纯净 Opus vs RED 冗余） */
  isMusicMode(): boolean;
  /** 会话已销毁（协商/重启守卫；销毁后不发起任何 PC 操作） */
  isDestroyed(): boolean;
  /** 信令上行（signal 消息转发到对端） */
  sendSignal(to: number, data: VoiceSignalPayload): void;
  /** 远端共享画面（video track 到达；服务端单共享者互斥） */
  onRemoteVideo(userId: number, stream: MediaStream): void;
  /** 远端共享系统声音（同对端第二条音频流，独立 audio 元素直连播放） */
  onRemoteShareAudio(stream: MediaStream): void;
  /** 远端麦克风音频接入音频图（返回节点句柄；音频图未就绪返回 null） */
  attachPeerAudio(stream: MediaStream, volume: number): PeerAudio | null;
  /** 录制总线接入（远端增益；录制中中途进房的成员也进混音） */
  attachPeerGainToRecorder(gain: GainNode): void;
  /** 对端单人音量偏好 */
  getPeerVolume(userId: number): number;
  /** 对端离开：说话状态补发翻转并清除（音频图） */
  forgetPeerSpeaking(userId: number): void;
  /** 对端离开：共享舞台/共享声音清理（共享状态机） */
  onPeerLeftShareStage(userId: number): void;
  /** 对端离开：清质量显示状态与窗口计数器 */
  forgetPeerQuality(userId: number): void;
  /** 断线清理：全部质量数据失效（自己的自报值重连后重新上报） */
  forgetAllQuality(): void;
  /** 摘除对端音频节点（dispose 时） */
  disposePeerAudio(audio: PeerAudio): void;
  /** 共享中则把共享 track 补挂到该对端（首次协商完成后自动重协商出画面） */
  attachShareTracks(entry: PeerEntry): void;
  /** flushPendingOffer 补处理失败摘除对端后刷新参与者列表 */
  onParticipantsChanged(): void;
}

export class MeshManager {
  /** 全部对端条目（会话层只读遍历：参与者列表/质量统计/共享/录音/音量） */
  peers = new Map<number, PeerEntry>();
  /** ICE 重启已重试次数（按对端用户计） */
  private restartAttempts = new Map<number, number>();

  constructor(private opts: MeshManagerOptions) {}

  /** 取/建对端条目：已存在则刷新参与者信息；否则建连并接线全部事件 */
  ensurePeer(participant: VoiceParticipant): PeerEntry {
    const existing = this.peers.get(participant.userId);
    if (existing) {
      existing.participant = participant;
      return existing;
    }
    const pc = new RTCPeerConnection({ iceServers: this.opts.getIceServers() });

    // 发送本地音频；听者模式只收不发。
    // 关键：必须用 addTrack（而非 addTransceiver）——Chrome 对远端 offer 的收发器匹配
    // 只复用 addTrack 创建的收发器；addTransceiver 建的在 setRemoteDescription(offer)
    // 时会被跳过、另建一个 recvonly 收发器（实测复现：首次应答降级为只收 + 一次多余重协商，
    // 还会残留一条永不复用的 recvonly m 行）。RED 编解码偏好仍可设：addTrack 返回 sender，
    // 用 getTransceivers 找回对应收发器即可。
    let audioTransceiver: RTCRtpTransceiver | null = null;
    const sendTrack = this.opts.getSendTrack();
    if (sendTrack) {
      const sender = pc.addTrack(sendTrack, new MediaStream([sendTrack]));
      this.markSenderHighPriority(sender);
      audioTransceiver = pc.getTransceivers().find((t) => t.sender === sender) ?? null;
    } else {
      audioTransceiver = pc.addTransceiver('audio', { direction: 'recvonly' });
    }
    this.applyAudioCodecPreference(audioTransceiver);

    pc.onicecandidate = (e) => {
      if (e.candidate)
        this.opts.sendSignal(participant.userId, {
          type: 'candidate',
          candidate: e.candidate.toJSON(),
        });
    };
    pc.ontrack = (e) => {
      const entry = this.peers.get(participant.userId);
      if (!entry || !e.streams[0]) return;
      if (e.track.kind === 'video') {
        // 屏幕共享画面（服务端单共享者互斥，video track 只可能来自当前共享者）
        // 低延迟优先：限制接收端抖动缓冲深度（默认自适应可累积数百毫秒，
        // 丢包后关键帧跳变时表现为"画面一直回退"）
        try {
          (e.receiver as RTCRtpReceiver & { jitterBufferTarget?: number }).jitterBufferTarget = 200;
        } catch {
          /* 浏览器不支持则忽略 */
        }
        this.opts.onRemoteVideo(participant.userId, e.streams[0]);
        return;
      }
      // 音频分流：同对端第一条音频流 = 麦克风（走 WebAudio 音量链路），
      // 共享开始后新出现的第二条音频流 = 共享系统声音（独立 audio 元素直连播放）
      const streamId = e.streams[0].id;
      if (entry.micStreamId !== null && streamId !== entry.micStreamId) {
        this.opts.onRemoteShareAudio(e.streams[0]);
        return;
      }
      // 音频接收端抖动缓冲目标 80ms：防长时间通话的"延迟爬升"（丢包高峰后缓冲
      // 增大且回落缓慢）；RED 冗余兜底丢包，不需要更深的缓冲
      try {
        (e.receiver as RTCRtpReceiver & { jitterBufferTarget?: number }).jitterBufferTarget = 80;
      } catch {
        /* 浏览器不支持则忽略（沿用自适应） */
      }
      if (entry.audio) return; // 重复 ontrack 防御（与历史 attachPeerAudio 守卫一致）
      const peerAudio = this.opts.attachPeerAudio(e.streams[0], this.opts.getPeerVolume(participant.userId));
      if (!peerAudio) return; // 音频图未就绪（异常时序）：跳过接入
      entry.micStreamId = e.streams[0].id; // 该对端的麦克风流 id（此后新出现的音频流 = 共享系统声音）
      entry.audio = peerAudio;
      // 录制中：中途进房的成员也接入录制总线（同样经压限，录出的 MP3 不炸）
      this.opts.attachPeerGainToRecorder(peerAudio.gain);
    };

    const self = this.opts.getSelf();
    const entry: PeerEntry = {
      participant,
      pc,
      audio: null,
      pendingCandidates: [],
      remoteDescSet: false,
      lastPacketsLost: 0,
      lastPacketsReceived: 0,
      polite: self.userId > participant.userId,
      makingOffer: false,
      pendingOffer: null,
      negotiateSuppressed: true, // 初始 offer 由新加入者确定性发起；首次协商完成后解除
      videoSender: null,
      shareAudioSender: null,
      micStreamId: null,
      audioTransceiver,
      lastConcealedSamples: 0,
      lastTotalSamples: 0,
    };
    this.peers.set(participant.userId, entry);

    // 共享 track 增删后的自动重协商（初始协商被抑制，见 negotiateSuppressed）
    pc.onnegotiationneeded = () => {
      void this.handleNegotiationNeeded(entry);
    };

    // 协商落定（stable）时补处理被完美协商冲突忽略的远端 offer（见 flushPendingOffer）：
    // 该 offer 通常是共享者补挂屏幕共享 track 的重协商，错过即画面永久缺失。
    pc.onsignalingstatechange = () => {
      if (pc.signalingState === 'stable') this.flushPendingOffer(entry);
    };

    // 打洞失败时自动 ICE 重启重试（由 userId 较小一方发起，避免双方同时重启冲突）
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') void this.tryIceRestart(entry);
    };
    return entry;
  }

  /** 音频 RTP 包高优先级标记（DSCP EF）：同链路的 WiFi WMM/QoS 会优先转发语音，降低被视频/下载抢占的概率 */
  private markSenderHighPriority(sender: RTCRtpSender): void {
    try {
      // 部分浏览器/TS 类型库缺这两个字段，运行时 Chrome/Edge/Safari 均支持
      const params = sender.getParameters() as RTCRtpSendParameters & {
        priority?: string;
        networkPriority?: string;
      };
      params.priority = 'high';
      params.networkPriority = 'high';
      sender.setParameters(params).catch(() => {
        /* 浏览器不支持则忽略 */
      });
    } catch {
      /* 浏览器不支持则忽略 */
    }
  }

  /**
   * 音频编解码偏好（必须在首次 offer/answer 前设置）：
   * - 语音模式：优先 audio/red（RFC 2198 冗余编码——每包捎带上一帧音频的副本，
   *   弱网丢包时接收端用冗余副本恢复而非合成插值，对"断续/电流声"的改善比
   *   带内 FEC 强一个量级，代价仅 ~20ms 额外延迟与约 2 倍音频码率）。
   *   Chrome/Edge/Android WebView(Chromium 96+) 支持；Safari/Firefox 的能力列表
   *   里没有 red，setCodecPreferences 传不存在的编码无效→自动落到 Opus，无兼容风险。
   * - 音乐模式：优先纯净 Opus（96k 立体声），RED 对高码率音乐的双倍冗余性价比低。
   * 对端协商到哪个编码由双方 offer/answer 交集决定：任一端语音模式即协商出 RED。
   */
  applyAudioCodecPreference(transceiver: RTCRtpTransceiver | null): void {
    if (!transceiver) return;
    try {
      const caps = RTCRtpSender.getCapabilities('audio');
      const codecs = caps?.codecs ?? [];
      if (codecs.length === 0) return;
      const mime = (m: string) => m.toLowerCase();
      const red = codecs.filter((c) => mime(c.mimeType) === 'audio/red');
      const opus = codecs.filter((c) => mime(c.mimeType) === 'audio/opus');
      const rest = codecs.filter(
        (c) => mime(c.mimeType) !== 'audio/red' && mime(c.mimeType) !== 'audio/opus'
      );
      const ordered = this.opts.isMusicMode() ? [...opus, ...red, ...rest] : [...red, ...opus, ...rest];
      transceiver.setCodecPreferences(ordered);
    } catch {
      /* 浏览器不支持编解码偏好则忽略 */
    }
  }

  /** ICE 重启重试打洞（最多 2 次；超过则靠质量圆点提示网络不通） */
  private async tryIceRestart(entry: PeerEntry): Promise<void> {
    if (this.opts.isDestroyed()) return;
    const peerId = entry.participant.userId;
    const attempts = this.restartAttempts.get(peerId) ?? 0;
    if (attempts >= 2) return;
    // 双方都会收到 failed，只由 userId 较小一方发起重启
    if (this.opts.getSelf().userId > peerId) return;
    this.restartAttempts.set(peerId, attempts + 1);
    try {
      await this.initiateOffer(entry, { iceRestart: true });
    } catch {
      // 重启失败：静默，等待下次 failed 事件或由质量圆点暴露
    }
  }

  /**
   * 发起 offer：初始协商（新加入者）/ ICE 重启 / 共享 track 增删的自动重协商共用。
   * makingOffer 在整个异步过程置位，供对端与本端做完美协商的冲突检测。
   */
  async initiateOffer(entry: PeerEntry, options?: RTCOfferOptions): Promise<void> {
    entry.makingOffer = true;
    try {
      const offer = await entry.pc.createOffer(options);
      if (!offer.sdp) return; // 理论上不会发生（createOffer 必返回 sdp）
      const sdp = applyOpusPreferences(offer.sdp, this.opts.isMusicMode());
      await entry.pc.setLocalDescription({ type: 'offer', sdp });
      this.opts.sendSignal(entry.participant.userId, { type: 'offer', sdp });
    } finally {
      entry.makingOffer = false;
    }
  }

  /** onnegotiationneeded：共享 track 增删后自动重协商（初始协商被抑制，由确定性规则发起） */
  async handleNegotiationNeeded(entry: PeerEntry): Promise<void> {
    if (this.opts.isDestroyed() || entry.negotiateSuppressed) return;
    // 完美协商守卫（P1 修复）：本端已有 offer 在途或未回到 stable 时，忽略重复触发的
    // negotiationneeded。此前在 have-local-offer 态再次 createOffer 会抛错（被吞），
    // 留下双 offer 竞争窗口，是"偶发画面/音频缺失"的候选根因
    if (entry.makingOffer || entry.pc.signalingState !== 'stable') return;
    try {
      await this.initiateOffer(entry);
    } catch {
      /* PC 已关闭或冲突被回滚取代：忽略 */
    }
  }

  /** 处理远端信令（offer/answer/candidate）；坏信令由调用方按对端粒度降级 */
  async handleSignal(from: number, data: VoiceSignalPayload): Promise<void> {
    const entry = this.peers.get(from);
    if (!entry) return;

    if (data.type === 'offer') {
      // 完美协商：offer 冲突（本端也在协商）时，非礼貌方丢弃来包（自己的协商胜出），
      // 礼貌方接受——setRemoteDescription 会自动回滚本地半成品 offer（现代浏览器内建支持）
      const offerCollision = entry.makingOffer || entry.pc.signalingState !== 'stable';
      if (!entry.polite && offerCollision) {
        // 不能永久丢弃：冲突若仅因本端还在消化对端的 answer（本端并无竞争中的 offer），
        // 对端不会再主动重发，该 offer 会永久丢失（典型：屏幕共享补挂重协商 → 观者
        // 永远等不到画面）。暂存，等本端协商落定（stable）后补处理，见 flushPendingOffer。
        entry.pendingOffer = { sdp: data.sdp };
        return;
      }
      await this.processRemoteOffer(entry, data.sdp);
    } else if (data.type === 'answer') {
      if (entry.pc.signalingState !== 'have-local-offer') return; // 过期 answer，忽略
      await entry.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
      entry.remoteDescSet = true;
      await this.flushCandidates(entry);
      // 首次协商完成：解除抑制（此后 track 增删走 onnegotiationneeded 自动重协商）
      entry.negotiateSuppressed = false;
      // 冲突期间被忽略的远端 offer（如共享补挂重协商）现在可补处理；signalingstatechange
      // 也会触发本方法，这里同步调用即时兜底。
      this.flushPendingOffer(entry);
    } else if (data.type === 'candidate') {
      if (entry.remoteDescSet) {
        try {
          await entry.pc.addIceCandidate(data.candidate);
        } catch {
          // 畸形/过期候选或 PC 已关闭：静默忽略（与 flushCandidates 一致）。
          // 服务端对 signal data 原样转发，异常客户端可投递任意坏候选，
          // 不能因单条坏包影响会话
        }
      } else entry.pendingCandidates.push(data.candidate);
    }
  }

  /** 处理远端 offer（首次协商 / 完美协商回滚 / 共享 track 补挂重协商共用）。
   *  注意：本端为共享者时，首次协商完成后要把共享 track 补挂上（画面随随后重协商到达）。 */
  private async processRemoteOffer(entry: PeerEntry, sdp: string): Promise<void> {
    await entry.pc.setRemoteDescription({ type: 'offer', sdp });
    entry.remoteDescSet = true;
    await this.flushCandidates(entry);
    const answer = await entry.pc.createAnswer();
    if (!answer.sdp) return; // 理论上不会发生（createAnswer 必返回 sdp）
    const sdp2 = applyOpusPreferences(answer.sdp, this.opts.isMusicMode());
    await entry.pc.setLocalDescription({ type: 'answer', sdp: sdp2 });
    this.opts.sendSignal(entry.participant.userId, { type: 'answer', sdp: sdp2 });
    // 首次协商完成：解除抑制；共享中则把共享 track 补挂到这条新建对端连接（随后自动重协商出画面）
    entry.negotiateSuppressed = false;
    this.opts.attachShareTracks(entry);
  }

  /** 补处理被完美协商冲突忽略的远端 offer（本端协商落定、非协商中时执行）。
   *  场景：加入"正在共享"的房间时，共享者的补挂重协商 offer 紧跟初始 answer 到达，
   *  本端（非礼貌方）若仍在消化 answer（signalingState 未回 stable）会按冲突丢弃该 offer，
   *  且对端不会重新发起 → 画面永久缺失。落定后补处理即可收敛。 */
  private flushPendingOffer(entry: PeerEntry): void {
    const pending = entry.pendingOffer;
    if (!pending) return;
    if (entry.makingOffer || entry.pc.signalingState !== 'stable') return; // 仍忙：下次 stable 再试
    entry.pendingOffer = null;
    void this.processRemoteOffer(entry, pending.sdp).catch(() => {
      // 补处理失败只摘除该对端（与 handleSignal 同粒度），不整会话 teardown
      this.removePeer(entry.participant.userId);
      this.opts.onParticipantsChanged();
    });
  }

  private async flushCandidates(entry: PeerEntry): Promise<void> {
    for (const c of entry.pendingCandidates) {
      try {
        await entry.pc.addIceCandidate(c);
      } catch {
        /* 候选过期忽略 */
      }
    }
    entry.pendingCandidates = [];
  }

  /** 摘除对端：释放音频节点/质量/说话/共享状态并关闭 PC */
  removePeer(userId: number): void {
    const entry = this.peers.get(userId);
    if (!entry) return;
    this.disposePeer(entry);
    this.peers.delete(userId);
    this.opts.forgetPeerQuality(userId); // 成员已离开：清掉其残留的质量显示状态与窗口计数器
    this.opts.forgetPeerSpeaking(userId); // 按最后已知说话状态补发翻转并清除
    // 离开的正是当前共享者：关闭舞台与共享声音
    this.opts.onPeerLeftShareStage(userId);
  }

  private disposePeer(entry: PeerEntry): void {
    entry.pc.onicecandidate = null;
    entry.pc.ontrack = null;
    entry.pc.onnegotiationneeded = null;
    entry.pc.onsignalingstatechange = null;
    entry.pc.onconnectionstatechange = null;
    entry.pendingOffer = null;
    try {
      entry.pc.close();
    } catch {
      /* 已关闭 */
    }
    entry.videoSender = null;
    entry.shareAudioSender = null;
    if (entry.audio) {
      this.opts.disposePeerAudio(entry.audio);
      entry.audio = null;
    }
  }

  /** 断线/会话清理：销毁全部对端连接 */
  cleanupPeers(): void {
    for (const entry of this.peers.values()) this.disposePeer(entry);
    this.peers.clear();
    // 断线重建期间所有质量数据失效：清空（自己的自报值会在重连后重新上报）
    this.opts.forgetAllQuality();
  }
}
