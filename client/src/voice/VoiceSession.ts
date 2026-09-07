/**
 * ============================================================
 * 语音会话核心（VoiceSession）
 * ============================================================
 * 非 React 的纯 TS 类，管理一次语音房间的全部实时状态:
 * 1. WebSocket 信令（/api/voice/ws，token 走查询参数）
 * 2. WebRTC Mesh：新加入者向已在场者逐一发起 offer（确定性规则防冲突）
 * 3. WebAudio 音量控制:
 *    - 本地: 麦克风 → GainNode(麦克风音量) → 发送轨道
 *    - 远端: 每人 Source → Analyser(说话检测) → GainNode(单人音量) → 扬声器
 * 4. 静音 = track.enabled = false（发静默包，无需重协商）
 * 5. 说话指示（RMS 阈值，100ms 轮询）、断线自动重连、听者模式兜底
 * 6. 全房间混音录制：各路 gain → 混音节点 →（并行）PCM 直录（AudioWorklet 音频线程
 *    采样，回退 ScriptProcessor）+ MediaRecorder，
 *    停止时 lamejs 把 PCM 直转 MP3 自动下载（PCM 不可用才走 MediaRecorder 解码，仍失败才兜底原始 webm）
 *
 * 音量偏好按用户持久化在 localStorage。
 */

import { CONTROL_CHAR_RE, STUN_SERVER_URLS } from '@k/shared';
import { getVoiceIceServers } from '../api/voice';
import { showToast } from '../components/ui/Toast';
import type { VoiceChatMessage, VoiceParticipant } from '../types';
// RNNoise 语音降噪（WASM 内嵌的单文件 AudioWorklet，经 Vite 打包为独立 ES bundle）：
// vendor 于 src/voice/rnnoise/（含 VAD 门控能量恢复，保证"开降噪后与不开人声大小一致"）
// 抽出的子系统模块（行为与原内联实现逐行一致）
import { Denoiser } from './denoiser';
import { RoomRecorder } from './recording/roomRecorder';
import { QualityMonitor } from './qualityMonitor';
import { AudioGraph } from './audio/audioGraph';
import { ScreenShareController, type ScreenShareSink } from './share/screenShareController';
import { WsSignaling } from './signaling/wsSignaling';
import { MeshManager } from './mesh/meshManager';
import type { PeerEntry } from './mesh/meshPeer';
import {
  SHARE_QUALITY_PRESETS,
  type ScreenShareStartResult,
  type ShareQuality,
  type VoiceSelfInfo,
  type VoiceSessionCallbacks,
  type VoiceStatus,
  type VoiceServerMessage,
} from './types';

// 共享类型与预设收敛在 ./types；这里 re-export 保持既有 import 路径不变
export type {
  VoiceStatus,
  VoiceQualityLevel,
  ShareQuality,
  ShareStats,
  ScreenShareStartResult,
  VoiceSelfInfo,
  VoiceSessionCallbacks,
} from './types';
export { SHARE_QUALITY_PRESETS } from './types';

// 偏好持久化键与读写辅助收敛于 ./prefs（行为不变）；re-export 兼容既有导入
import {
  MIC_VOLUME_KEY,
  NOISE_REDUCTION_KEY,
  MUSIC_MODE_KEY,
  peerVolumeKey,
  loadNumber,
  loadFlag,
} from './prefs';
export { NOISE_REDUCTION_KEY, MUSIC_MODE_KEY };

/** ICE 兜底配置（接口失败时使用，与服务端默认一致；STUN 地址来自 @k/shared 共享常量） */
const FALLBACK_ICE_SERVERS: RTCIceServer[] = [{ urls: [...STUN_SERVER_URLS] }];

export class VoiceSession {
  private cb: VoiceSessionCallbacks;
  private self: VoiceParticipant;
  private roomId: number | null = null;

  /** 信令 WS 传输（连接/断开/自动重连/终止类关闭码，见 ./signaling/wsSignaling.ts） */
  private signaling = new WsSignaling({
    onOpen: () => {
      this.send({
        type: 'join',
        roomId: this.roomId,
        muted: this.self.muted,
        listener: this.self.listener,
      });
    },
    onMessage: (msg) => this.handleServerMessage(msg as VoiceServerMessage),
    onTerminalClose: (code) => {
      // 主动踢出类关闭码直接结束会话（原因必须说清楚）
      if (code === 4002) {
        // 同账号单点在线：被另一设备顶掉。静默退出会让用户以为"互通坏了"，
        // 必须把原因说出来。
        showToast('该账号已在其他设备进入语音，本机已退出房间');
        this.teardown('replaced');
      } else if (code === 4001) {
        this.teardown('auth');
      } else if (code === 4003) {
        // 房间已被删除（服务端 hub.closeRoom 主动关闭）。若 room-closed 消息弱网丢失，
        // 只能靠关闭码终止——否则会按 3s 间隔无限重连一个已不存在的房间
        this.teardown('room-closed');
      }
    },
    onNetworkClose: () => {
      // 共享状态以服务端为准的重连对账见 share.onWsClosed()（screenShareController）
      this.mesh.cleanupPeers();
      this.share.onWsClosed();
      this.emitStatus('reconnecting');
    },
  });
  private iceServers: RTCIceServer[] = FALLBACK_ICE_SERVERS;

  /** WebAudio 音频图（本地链/播放总线/远端 attach/RMS 说话检测/resume 兜底，见 ./audio/audioGraph.ts） */
  private audio: AudioGraph = new AudioGraph({
    getSelfUserId: () => this.self.userId,
    isSelfMuted: () => this.self.muted,
    onSpeaking: (userId, speaking) => this.cb.onSpeaking(userId, speaking),
    getSpeakingPeers: () =>
      [...this.mesh.peers.values()].map((e) => ({
        userId: e.participant.userId,
        audio: e.audio,
        muted: e.participant.muted,
      })),
    getHiddenAudioEls: () =>
      [...this.mesh.peers.values()].flatMap((e) => (e.audio ? [e.audio.hiddenEl] : [])),
  });
  private micStream: MediaStream | null = null;

  /** WebRTC Mesh 连接管理（完美协商/ICE 重启/对端生命周期，见 ./mesh/meshManager.ts） */
  private mesh: MeshManager = new MeshManager({
    getSelf: () => this.self,
    getSendTrack: () => this.audio.sendTrack,
    getIceServers: () => this.iceServers,
    isMusicMode: () => this.musicModeOn,
    isDestroyed: () => this.destroyed,
    sendSignal: (to, data) => this.send({ type: 'signal', to, data }),
    onRemoteVideo: (userId, stream) => this.share.onRemoteVideo(userId, stream),
    onRemoteShareAudio: (stream) => this.share.onRemoteShareAudio(stream),
    attachPeerAudio: (stream, volume) => this.audio.attachPeerAudio(stream, volume),
    attachPeerGainToRecorder: (gain) => this.rec.attachPeerGain(gain),
    getPeerVolume: (userId) => this.peerVolumes.get(userId) ?? 1,
    forgetPeerSpeaking: (userId) => this.audio.forgetPeer(userId),
    onPeerLeftShareStage: (userId) => this.share.onPeerLeft(userId),
    forgetPeerQuality: (userId) => this.quality.forget(userId),
    forgetAllQuality: () => this.quality.forgetAll(),
    disposePeerAudio: (audio) => this.audio.disposePeerAudio(audio),
    attachShareTracks: (entry) => this.maybeAttachShareTracks(entry),
    onParticipantsChanged: () => this.emitParticipants(),
  });
  private destroyed = false;
  /** 语音质量评估（自报语义，实现见 ./qualityMonitor.ts） */
  private quality = new QualityMonitor({
    getPeers: () => [...this.mesh.peers.values()].map((e) => ({ userId: e.participant.userId, pc: e.pc })),
    report: (level) => {
      this.quality.emit(this.self.userId, level);
      this.send({ type: 'quality', level });
    },
    onQuality: (userId, level) => this.cb.onPeerQuality(userId, level),
  });

  private micVolume: number;
  private peerVolumes = new Map<number, number>();

  /** 麦克风降噪开关（默认关；开启后接入 RNNoise worklet 降噪链路） */
  private noiseReductionOn: boolean;
  /** 音乐模式（默认关）：高码率立体声编码 + 关闭采集端 AEC/AGC/NS + 旁路 RNNoise */
  private musicModeOn: boolean;
  /** RNNoise 降噪节点生命周期（实现见 ./denoiser.ts） */
  private denoiser = new Denoiser();

  /** 全房间录制（远端各路 + 开麦时的自己 → 混音 → PCM 直录/MediaRecorder → MP3 结算），
   *  实现见 ./recording/roomRecorder.ts */
  private rec = new RoomRecorder((isRecording, startedAt) =>
    this.cb.onRecordingChange(isRecording, startedAt)
  );

  // ---- 屏幕共享 ----
  /** 屏幕共享状态机（发送/接收端状态与「断线重连对账」决策集中于此，见
   *  ./share/screenShareController.ts；副作用经 sink 回调回来执行） */
  private share = new ScreenShareController({
    getSelfUserId: () => this.self.userId,
    onSelfSharingChanged: (sharing) => {
      this.self.sharing = sharing;
    },
    sendShareStart: (withAudio) => this.send({ type: 'share-start', audio: withAudio }),
    sendShareStop: () => this.send({ type: 'share-stop' }),
    emitParticipants: () => this.emitParticipants(),
    getVideoSenders: () =>
      [...this.mesh.peers.values()].flatMap((e) => (e.videoSender ? [e.videoSender] : [])),
    getPeerCount: () => this.mesh.peers.size,
    attachShareTracksToAll: () => {
      for (const entry of this.mesh.peers.values()) this.maybeAttachShareTracks(entry);
      this.applyShareQuality();
    },
    detachShareTracksFromAll: () => {
      for (const entry of this.mesh.peers.values()) {
        if (entry.videoSender) {
          try {
            entry.pc.removeTrack(entry.videoSender);
          } catch {
            /* PC 已关闭 */
          }
          entry.videoSender = null;
        }
        if (entry.shareAudioSender) {
          try {
            entry.pc.removeTrack(entry.shareAudioSender);
          } catch {
            /* PC 已关闭 */
          }
          entry.shareAudioSender = null;
        }
      }
    },
    applyShareQuality: () => this.applyShareQuality(),
    onShareVideo: (stream) => this.cb.onShareVideo(stream),
    onShareChanged: (info) => this.cb.onShareChanged(info),
    onShareStats: (stats) => this.cb.onShareStats(stats),
    onShareQualityChange: (q) => this.cb.onShareQualityChange?.(q),
    attachRemoteShareAudio: (stream, muted) => this.attachShareAudioElement(stream, muted),
    disposeRemoteShareAudio: () => this.disposeShareAudioElement(),
    applyShareMuted: (muted) => this.applyShareAudioMuted(muted),
  } satisfies ScreenShareSink);
  /** 远端共享系统声音的 audio 元素（独立直连播放；不进 WebAudio 音量链与房间录制） */
  private shareAudioEl: HTMLAudioElement | null = null;

  constructor(self: VoiceSelfInfo, cb: VoiceSessionCallbacks) {
    this.cb = cb;
    this.micVolume = Math.min(1, Math.max(0, loadNumber(MIC_VOLUME_KEY, 1)));
    this.noiseReductionOn = loadFlag(NOISE_REDUCTION_KEY);
    this.musicModeOn = loadFlag(MUSIC_MODE_KEY);
    this.self = {
      userId: self.userId,
      username: self.username,
      avatar: self.avatar,
      muted: false,
      listener: false,
    };
    // dev 联调钩子：e2e/fps-probe.mjs 通过 window.__voiceSession 读取 peer 连接统计
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__voiceSession = this;
    }
  }

  /** dev 联调：暴露全部对等连接（帧率探针读取 outbound/inbound 统计用） */
  getPeerConnections(): RTCPeerConnection[] {
    return [...this.mesh.peers.values()].map((e) => e.pc);
  }

  /** 加入房间（获取 ICE + 麦克风 → 建 WS → 发 join） */
  async join(roomId: number): Promise<void> {
    if (this.destroyed || this.roomId !== null) return;
    this.roomId = roomId;
    this.emitStatus('connecting');

    // 进房即广播本地成员（自己）：底部麦克风按钮/成员卡片由 participants[0] 驱动，
    // 提前广播避免连接期间（取 ICE 配置 + WS 握手 + 服务端 joined 确认）按钮误显示红色静音态
    this.emitParticipants();

    // ICE 配置失败不阻断（用兜底 STUN）
    try {
      this.iceServers = await getVoiceIceServers();
    } catch {
      /* 用 FALLBACK_ICE_SERVERS */
    }

    // 创建音频上下文（RNNoise 固定 48 kHz，见 audioGraph.createContext）：
    // AudioContext 需要用户手势后才能出声（点击"加入房间"即手势）；
    // 刷新自动回房等无手势场景由 AudioGraph 的 resumeFallback 兜底
    const audioCtx = this.audio.createContext();

    // 播放总线（听者模式也需要）：各远端 gain 汇入 masterGain → 压限器 → 扬声器。
    // 压限器只压超 -6dB 的叠加峰值（多人同时说话叠加 >1.0 会硬削波炸麦），单人正常音量不受影响
    this.audio.buildMasterBus();

    // 预载降噪 worklet（与拿麦克风并行，不拖慢进房速度）
    this.denoiser.prepare(audioCtx);
    // 预载录音采集 worklet（同理并行；录音走音频线程，主线程卡顿不丢样本）
    this.rec.prepareWorklet(audioCtx);

    // 麦克风：拿不到权限则以听者模式加入
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        // 浏览器原生 NS 与 RNNoise 只留一个：RNNoise 生效时不启用浏览器 NS，避免双重降噪压瘪人声
        // 音乐模式：连 AEC/AGC 也一并关闭（保真优先，代价是外放会产生回声，UI 提示佩戴耳机）
        audio: {
          echoCancellation: !this.musicModeOn,
          noiseSuppression: false,
          autoGainControl: !this.musicModeOn,
        },
      });
      await this.denoiser.prepare(audioCtx); // worklet 就绪后再接本地链路
      if (this.noiseReductionOn && !this.musicModeOn) this.denoiser.init(audioCtx, this.micStream);
      // 本地链路: 麦克风 → 增益(麦克风音量) → 发送轨道；降噪路由按当前开关重接
      this.audio.buildLocalChain(this.micStream, this.micVolume);
      this.audio.applyLocalRouting(this.denoiser.getNode(), this.noiseReductionOn, this.musicModeOn);
      if (this.audio.sendTrack) this.audio.sendTrack.enabled = !this.self.muted;
      // 用户偏好开但 RNNoise 不可用（加载失败/非 48k 采样率）：浏览器 NS 兜底（音乐模式除外）
      if (this.noiseReductionOn && !this.musicModeOn && !this.denoiser.getNode()) {
        this.micStream
          .getAudioTracks()[0]
          ?.applyConstraints({ noiseSuppression: true, autoGainControl: true })
          .catch(() => {
            /* 不支持则忽略 */
          });
      }
    } catch {
      this.self.listener = true;
      this.self.muted = true;
    }

    // 麦克风权限结果已定（正常开麦 / 听者模式），再广播一次同步准确状态
    this.emitParticipants();

    this.signaling.open();
    this.audio.startSpeakingLoop();
    this.quality.start();
  }

  // ============================================================
  // WebSocket 信令（传输/自动重连/终止类关闭码收敛于 ./signaling/wsSignaling.ts；
  // 消息分发见 handleServerMessage）
  // ============================================================

  private send(msg: unknown): void {
    this.signaling.send(msg);
  }

  /**
   * 发送文字聊天消息（走信令 WS，与语音媒体分离：
   * 语音 WebRTC 质量差时文字仍可正常收发）。
   * 本地先做与服务器一致的约束校验（非空、≤500 字），
   * 服务器仍会二次校验并限流（400ms/条）。
   * @returns 是否已发出（false = 未进房/未连接/内容非法，上层可提示）
   */
  sendChat(content: string): boolean {
    const trimmed = content.trim();
    if (!trimmed || trimmed.length > 500) return false;
    if (this.destroyed || !this.roomId) return false;
    if (!this.signaling.isOpen()) return false;
    // 与控制字符清洗保持一致（共享 @k/shared 的 CONTROL_CHAR_RE，服务器也会再做一次）
    const cleaned = trimmed.replace(CONTROL_CHAR_RE, '');
    if (!cleaned) return false;
    this.send({ type: 'chat', content: cleaned });
    return true;
  }

  private handleServerMessage(msg: VoiceServerMessage): void {
    switch (msg.type) {
      case 'joined': {
        // 访客身份回传：未登录进房时 userId 由服务端分配（负数），用其校正占位身份。
        // WebRTC 完美协商（polite=id 大者让步）与信号路由都以该 id 为准，必须在发起 offer 前生效。
        if (msg.self && typeof msg.self.userId === 'number') {
          const s = msg.self as { userId: number; username?: string; avatar?: string | null };
          if (s.userId !== this.self.userId) {
            this.self.userId = s.userId;
            if (typeof s.username === 'string') this.self.username = s.username;
            if ('avatar' in s) this.self.avatar = s.avatar ?? null;
          }
        }
        // 收到既有成员列表 → 由我（新加入者）逐一发起 offer
        this.emitStatus('connected');
        for (const p of msg.participants as VoiceParticipant[]) {
          const entry = this.mesh.ensurePeer(p);
          this.mesh.initiateOffer(entry).catch(() => {
            // 单对端协商失败（对端恰在此时退出/PC 关闭等）只摘除该对端，
            // 不再整会话 teardown——异常对端不应成为打崩整个房间的武器
            this.mesh.removePeer(entry.participant.userId);
            this.emitParticipants();
          });
        }
        // 加入时已有人在共享：先立状态与徽标（画面随后经该共享者的补挂重协商到达）
        this.share.onJoined(msg.participants as VoiceParticipant[]);
        this.emitParticipants();
        break;
      }
      case 'peer-joined':
        // 别人加入：建好对等连接等他的 offer（规则：新加入者发起）
        this.mesh.ensurePeer(msg.participant as VoiceParticipant);
        this.emitParticipants();
        break;
      case 'peer-left':
        this.mesh.removePeer(msg.userId);
        this.emitParticipants();
        break;
      case 'mute-changed': {
        const entry = this.mesh.peers.get(msg.userId);
        if (entry) {
          entry.participant.muted = !!msg.muted;
          this.emitParticipants();
        }
        break;
      }
      case 'peer-quality': {
        // 各成员自报的网络质量（服务器广播）：圆点语义 = 该成员自身的网络状况
        const userId = Number(msg.userId);
        const level = msg.level;
        if (Number.isInteger(userId) && (level === 'good' || level === 'fair' || level === 'poor')) {
          this.quality.emit(userId, level);
        }
        break;
      }
      case 'signal':
        this.mesh.handleSignal(msg.from, msg.data).catch(() => {
          // 坏信令（畸形 ICE 候选/过期 answer 等，服务端原样转发零校验）只降级到
          // 摘除该对端，不销毁整个会话
          const entry = this.mesh.peers.get(msg.from);
          if (entry) {
            this.mesh.removePeer(msg.from);
            this.emitParticipants();
          }
        });
        break;
      case 'share-changed': {
        const userId = Number(msg.userId);
        const active = !!msg.active;
        const audio = !!msg.audio;
        if (!Number.isInteger(userId)) break;
        const entry = this.mesh.peers.get(userId);
        if (entry) {
          entry.participant.sharing = active;
          this.emitParticipants();
        }
        this.share.onShareChanged(userId, active, audio);
        break;
      }
      case 'share-force-stop':
        // 被新共享者抢占：服务端已广播状态，本地静默停止采集即可
        this.share.onForceStop();
        break;
      case 'chat':
        // 新聊天消息（含自己在别的设备发的）：交给上层（去重/追加由 VoiceContext 处理）
        if (msg.message && typeof msg.message.id === 'number') {
          this.cb.onChatMessage(msg.message as VoiceChatMessage);
        }
        break;
      case 'chat-cleared':
        this.cb.onChatCleared();
        break;
      case 'room-closed':
        this.teardown('room-closed', msg.reason);
        break;
      case 'error':
        // 加入失败（房间满/不存在/同账号被顶等）：终止会话并明确告知原因
        if (msg.message) showToast(msg.message);
        this.teardown('error', msg.message);
        break;
      default:
        break;
    }
  }

  // ============================================================
  // WebRTC Mesh（完美协商/ICE 重启/对端生命周期收敛于 ./mesh/meshManager.ts；
  // 会话侧仅保留共享 track 挂载与质量应用等对端无关的编排）
  // ============================================================

  // ============================================================
  // 对外控制
  // ============================================================

  /** 静音/开麦（track.enabled 切换，无需重协商） */
  setMuted(muted: boolean): void {
    if (this.self.listener) return; // 无麦克风权限不能开麦
    this.self.muted = muted;
    if (this.audio.sendTrack) this.audio.sendTrack.enabled = !muted;
    // 静音时自己的声音不进录制（录制 = 房间其他人实际听到的内容）
    this.rec.setMutedGate(muted);
    this.send({ type: 'mute', muted });
    this.emitParticipants();
  }

  /** 麦克风音量（0-1，影响对方听到的音量） */
  setMicVolume(volume: number): void {
    this.micVolume = Math.min(1, Math.max(0, volume));
    this.audio.setMicGain(this.micVolume);
    localStorage.setItem(MIC_VOLUME_KEY, String(this.micVolume));
  }

  /** 单人音量（0-1，只影响自己听到 TA 的音量） */
  setPeerVolume(userId: number, volume: number): void {
    const v = Math.min(1, Math.max(0, volume));
    this.peerVolumes.set(userId, v);
    localStorage.setItem(peerVolumeKey(this.self.userId, userId), String(v));
    const entry = this.mesh.peers.get(userId);
    if (entry?.audio) entry.audio.gain.gain.value = v;
  }

  /** 读取对某人的持久化音量（0-1，默认 1；收敛历史遗留的超 100% 旧值） */
  getPeerVolume(userId: number): number {
    if (this.peerVolumes.has(userId)) return this.peerVolumes.get(userId)!;
    return Math.min(1, loadNumber(peerVolumeKey(this.self.userId, userId), 1));
  }

  getMicVolume(): number {
    return this.micVolume;
  }

  /** 麦克风降噪开关状态（默认关） */
  getNoiseReduction(): boolean {
    return this.noiseReductionOn;
  }

  /** 麦克风降噪开关：开 = 接入 RNNoise worklet；关 = 直连。worklet 不可用时回退浏览器 NS */
  setNoiseReduction(on: boolean): void {
    this.noiseReductionOn = on;
    localStorage.setItem(NOISE_REDUCTION_KEY, on ? '1' : '0');
    if (on) {
      // 首次开启/重新开启：创建全新节点（RNNoise 状态复位），再按开关重接链路
      this.denoiser.init(this.audio.ctx, this.micStream);
    } else {
      this.denoiser.dispose();
    }
    this.audio.applyLocalRouting(this.denoiser.getNode(), this.noiseReductionOn, this.musicModeOn);
    const track = this.micStream?.getAudioTracks()[0];
    if (!track) return; // 听者模式/无麦克风：仅保存偏好，进房后按偏好生效
    // RNNoise 生效时不用浏览器 NS（双重降噪会压瘪人声）；worklet 不可用则由浏览器 NS 兜底；
    // 音乐模式保持处理链全关（保真优先）
    track
      .applyConstraints({
        noiseSuppression: on && !this.denoiser.getNode() && !this.musicModeOn,
        autoGainControl: !this.musicModeOn,
      })
      .catch(() => {
        /* 浏览器不支持动态切换则忽略 */
      });
  }

  /** 音乐模式开关状态 */
  getMusicMode(): boolean {
    return this.musicModeOn;
  }

  /**
   * 音乐模式（播放/演唱音乐时开启）：
   * 1. 编码升档：Opus 96kbps 立体声（语音档 32k 单声会把音乐糊成一团），
   *    编解码偏好切到纯净 Opus（RED 双倍冗余对高码率音乐性价比低）；
   * 2. 采集端关闭 AEC/AGC/浏览器 NS 并旁路 RNNoise（处理链对音乐频谱有损），
   *    代价是外放会回声——UI 层提示佩戴耳机；
   * 3. 对已在场的对等连接逐个重协商使新 fmtp 生效（编解码偏好只影响下次 offer/answer）。
   */
  setMusicMode(on: boolean): void {
    if (this.musicModeOn === on) return;
    this.musicModeOn = on;
    localStorage.setItem(MUSIC_MODE_KEY, on ? '1' : '0');

    // 采集处理链实时切换（applyConstraints 无需重协商）
    const track = this.micStream?.getAudioTracks()[0];
    track
      ?.applyConstraints({
        echoCancellation: !on,
        noiseSuppression: false,
        autoGainControl: !on,
      })
      .catch(() => {
        /* 浏览器不支持动态切换则忽略 */
      });
    // 关闭音乐模式时若降噪开关仍开：补建 RNNoise 节点（进房时音乐模式开着则未创建）
    if (!on && this.noiseReductionOn) this.denoiser.init(this.audio.ctx, this.micStream);
    // 本地链路重接（音乐模式旁路 RNNoise；关闭时若降噪开关仍开则恢复降噪链）
    this.audio.applyLocalRouting(this.denoiser.getNode(), this.noiseReductionOn, this.musicModeOn);

    // 编码参数变化：更新各对端编解码偏好并重协商（negotiateSuppressed 的初始协商
    // 尚未完成的连接自动跳过——其 offer 会实时读取当前模式）
    for (const entry of this.mesh.peers.values()) {
      this.mesh.applyAudioCodecPreference(entry.audioTransceiver);
      void this.mesh.handleNegotiationNeeded(entry);
    }
  }

  // ============================================================
  // 屏幕共享
  // ============================================================

  /** 浏览器是否支持屏幕捕获（不支持时 UI 隐藏共享入口） */
  supportsScreenShare(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;
  }

  isSharing(): boolean {
    return this.share.isSharing();
  }

  /**
   * 发起屏幕共享：getDisplayMedia（1080p60 ideal，系统声音由浏览器共享选择器决定是否携带）
   * → 状态登记与广播由 share.start() 完成（挂 track/应用质量档/启动统计/UI 回调）。
   */
  async startScreenShare(): Promise<ScreenShareStartResult> {
    if (this.destroyed || this.share.isSharing()) return 'cancelled';
    if (!this.supportsScreenShare()) return 'unsupported';
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        // Chromium 屏幕捕获会对请求分辨率应用 ~0.9 的缩放余量：请求 1920×1080 实际
        // 只给 1728×1080（少 20% 像素）。请求 0.9 补偿值 2134×1200 后，16:9 源得到
        // 1920×1080，16:10 源（如 1920×1200 显示器）得到 1920×1200 全分辨率 ——
        // 宽度恒为 1920，高度跟随源，实测帧率反而更高（37→43fps）
        // 实验结论：帧率请求 120 时 getSettings 报 120 但实际帧到达率仍 43fps ——
        // 捕获链路上限与请求值无关（实测 60/120 请求均为 ~42fps），保持 60 请求
        video: { width: { ideal: 2134 }, height: { ideal: 1200 }, frameRate: { ideal: 60, max: 60 } },
        // Chrome/Edge 的共享选择器带"分享音频"勾选；Safari/Firefox 忽略 audio 也不报错
        audio: true,
      });
    } catch {
      return 'cancelled'; // 用户在选择器取消：静默
    }
    if (this.destroyed) {
      stream.getTracks().forEach((t) => t.stop());
      return 'cancelled';
    }

    this.share.start(stream);
    return 'started';
  }

  /** 停止屏幕共享；notify=false 用于被抢占/服务端兜底（状态已在服务端翻转，不再回发 share-stop） */
  stopScreenShare(notify = true): void {
    this.share.stop(notify);
  }

  /** 把当前共享的 video / 系统声音 track 挂到对端 PC（开始共享遍历全房间；对端新建连接后补挂） */
  private maybeAttachShareTracks(entry: PeerEntry): void {
    if (!this.share.sharingActive || !this.share.shareStream) return;
    const video = this.share.shareSendVideoStream?.getVideoTracks()[0];
    if (video && this.share.shareSendVideoStream && !entry.videoSender) {
      // addTransceiver（而非 addTrack）：直接拿到收发器，便于设置编解码偏好
      const transceiver = entry.pc.addTransceiver(video, {
        direction: 'sendonly',
        streams: [this.share.shareSendVideoStream],
      });
      entry.videoSender = transceiver.sender;
      this.preferH264ForSender(transceiver);
      this.applyShareQualityToSender(entry.videoSender);
    }
    const audio = this.share.withShareAudio ? this.share.shareSendAudioStream?.getAudioTracks()[0] : null;
    if (audio && this.share.shareSendAudioStream && !entry.shareAudioSender) {
      entry.shareAudioSender = entry.pc.addTrack(audio, this.share.shareSendAudioStream);
    }
  }

  /**
   * 共享视频优先协商 H.264：默认协商到的 VP8 走 libvpx 软编，
   * 1080p60 软编 CPU 扛不住（实测只能编 ~32fps，qualityLimitation=none、
   * 网络零丢包，纯粹编码吞吐瓶颈）。H.264 可命中显卡硬件编码器
   * （NVIDIA NVENC 等），60fps 轻松跑满；各端 H.264 解码也普遍支持。
   * 必须在首次视频协商前设置（addTransceiver 之后、offer 之前）。
   */
  private preferH264ForSender(transceiver: RTCRtpTransceiver): void {
    try {
      const caps = RTCRtpSender.getCapabilities('video');
      const codecs = caps?.codecs ?? [];
      const h264 = codecs.filter((c) => c.mimeType.toLowerCase() === 'video/h264');
      if (h264.length === 0) return; // 无 H264 能力：保持默认（VP8/VP9）
      const rest = codecs.filter((c) => c.mimeType.toLowerCase() !== 'video/h264');
      transceiver.setCodecPreferences([...h264, ...rest]);
    } catch {
      /* 浏览器不支持编解码偏好则忽略 */
    }
  }

  getShareQuality(): ShareQuality {
    return this.share.getShareQuality();
  }

  setShareQuality(q: ShareQuality): void {
    this.share.setShareQuality(q);
  }

  getShareSharpText(): boolean {
    return this.share.getShareSharpText();
  }

  /** "清晰文字"模式：contentHint=detail + 带宽不足时保分辨率降帧率（写代码/文档场景）；关 = 捕获默认行为 */
  setShareSharpText(on: boolean): void {
    this.share.setShareSharpText(on);
  }

  /** 接收端共享声音开关（默认静音；开启动作本身即用户手势，满足自动播放策略） */
  setShareMuted(muted: boolean): void {
    this.share.setShareMuted(muted);
  }

  getShareMuted(): boolean {
    return this.share.getShareMuted();
  }

  /** 把当前档位应用到全部视频 sender（码率/分辨率缩放/降级偏好） */
  private applyShareQuality(): void {
    for (const entry of this.mesh.peers.values()) {
      if (entry.videoSender) this.applyShareQualityToSender(entry.videoSender);
    }
  }

  private applyShareQualityToSender(sender: RTCRtpSender): void {
    const preset = SHARE_QUALITY_PRESETS[this.share.shareQuality];
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      const enc = params.encodings[0]!;
      enc.maxBitrate = preset.maxBitrate;
      // 不设 minBitrate：实测 BWE 对屏幕共享采用内容自适应（静态内容自动压低、
      // 高动态自动爬升），minBitrate 既不生效也无必要，设了反而可能浪费 mesh 上行
      enc.scaleResolutionDownBy = preset.scale;
      // 60fps 档优先保帧率；清晰文字模式优先保分辨率（文字不糊比流畅重要）
      (params as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference = this.share
        .shareSharpText
        ? 'maintain-resolution'
        : preset.degradation;
      sender.setParameters(params).catch(() => {
        /* 浏览器不支持则忽略 */
      });
    } catch {
      /* 参数不支持：按浏览器默认编码 */
    }
  }

  /** 远端共享系统声音：独立 audio 元素直连播放（默认静音；不进 WebAudio 音量链与房间录制） */
  private attachShareAudioElement(stream: MediaStream, muted: boolean): void {
    if (!this.shareAudioEl) {
      const el = document.createElement('audio');
      el.muted = muted;
      this.shareAudioEl = el;
    }
    this.shareAudioEl.srcObject = stream;
    this.shareAudioEl.play().catch(() => {
      /* 自动播放拦截：舞台上点声音开关时会重试 */
    });
  }

  private disposeShareAudioElement(): void {
    if (!this.shareAudioEl) return;
    this.shareAudioEl.srcObject = null;
    this.shareAudioEl = null;
  }

  private applyShareAudioMuted(muted: boolean): void {
    if (!this.shareAudioEl) return;
    this.shareAudioEl.muted = muted;
    if (!muted)
      this.shareAudioEl.play().catch(() => {
        /* 仍被拦截则等下次交互 */
      });
  }

  // ============================================================
  // 全房间录制
  // ============================================================

  /** 开始录制全房间混音（远端各路 + 开麦时的自己）；已在录/不支持时返回 false */
  startRecording(roomName?: string): boolean {
    const audioCtx = this.audio.ctx;
    if (!audioCtx) return false;
    return this.rec.start({
      roomName: roomName ?? '',
      audioCtx,
      peerGains: [...this.mesh.peers.values()].flatMap((e) => (e.audio ? [e.audio.gain] : [])),
      localGain: this.audio.localGain,
      selfMuted: this.self.muted,
    });
  }

  /** 停止录制：立即恢复状态；优先用 PCM 直录数据异步编码 MP3 下载（PCM 不可用才走 MediaRecorder 解码路径） */
  stopRecording(): void {
    this.rec.stop();
  }

  isRecording(): boolean {
    return this.rec.isRecording();
  }

  getRecordingStartedAt(): number | null {
    return this.rec.getStartedAt();
  }

  /** 主动退出房间 */
  leave(): void {
    this.teardown('leave');
  }

  // ============================================================
  // 状态与清理
  // ============================================================

  private emitStatus(status: VoiceStatus, detail?: string): void {
    this.cb.onStatus(status, detail);
  }

  private emitParticipants(): void {
    this.cb.onParticipants([this.self, ...[...this.mesh.peers.values()].map((e) => ({ ...e.participant }))]);
  }

  private teardown(reason: string, detail?: string): void {
    if (this.destroyed) return;
    this.destroyed = true;
    // 音频图会话级清理（含 resume 监听/说话轮询/节点断开/上下文关闭）
    this.audio.dispose();
    this.quality.stop();
    this.stopRecording(); // 退出时结算录制文件（转码下载在后台完成）
    this.mesh.cleanupPeers();

    // 屏幕共享会话级清理（不发 share-stop，服务端随连接移除广播 share-changed(false)）
    this.share.destroy();

    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;

    // 信令 WS 终止（含取消重连定时器），与 intentionalClose 同理
    this.signaling.close();

    this.emitStatus('ended', detail);
    if (reason === 'room-closed') this.cb.onClosed(detail || '房间已被删除');
    else if (reason === 'replaced') this.cb.onClosed('账号在其他地方进入了语音');
    else if (reason === 'auth') this.cb.onClosed('登录已过期，请重新登录后再加入');
    else if (reason === 'error') this.cb.onError(detail || '加入房间失败');
    else if (reason === 'negotiation') this.cb.onError('语音连接建立失败，请重新加入');
    // leave：静默结束
  }
}
