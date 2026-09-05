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

import { Capacitor } from '@capacitor/core';
import { getServerUrl } from '../config';
import { getVoiceIceServers } from '../api/voice';
import { showToast } from '../components/ui/Toast';
import type { VoiceChatMessage, VoiceParticipant } from '../types';
// RNNoise 语音降噪（WASM 内嵌的单文件 AudioWorklet，经 Vite 打包为独立 ES bundle）：
// vendor 于 src/voice/rnnoise/（含 VAD 门控能量恢复，保证"开降噪后与不开人声大小一致"）
// 抽出的子系统模块（行为与原内联实现逐行一致）
import { applyOpusPreferences } from './sdp';
import { Denoiser } from './denoiser';
import { RoomRecorder } from './recording/roomRecorder';
import { QualityMonitor } from './qualityMonitor';
import { ShareStatsMonitor } from './share/shareStatsMonitor';
import {
  SHARE_QUALITY_PRESETS,
  type ScreenShareStartResult,
  type ShareQuality,
  type VoiceSelfInfo,
  type VoiceSessionCallbacks,
  type VoiceStatus,
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

/** 屏幕共享质量偏好（localStorage 键随会话类使用） */
const SHARE_QUALITY_KEY = 'voice:shareQuality';
const SHARE_SHARP_KEY = 'voice:shareSharpText';
// 默认流畅 30fps：带宽不足时 60fps 会触发解码饥荒（绿块/画面停滞倒回），极清档留给手动选择
const SHARE_QUALITY_KEY_DEFAULT: ShareQuality = '1080p30';

/** 远端流音频节点（每人对一条） */
interface PeerAudio {
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  gain: GainNode;
  buffer: Uint8Array<ArrayBuffer>;
  hiddenEl: HTMLAudioElement; // Chrome 下 WebAudio 静音 bug 的兜底：同时挂一个静音的 audio 元素
}

/** Mesh 成员条目 */
interface PeerEntry {
  participant: VoiceParticipant;
  pc: RTCPeerConnection;
  audio: PeerAudio | null; // ontrack 后创建
  pendingCandidates: RTCIceCandidateInit[]; // 远端描述就绪前缓存的候选
  remoteDescSet: boolean;
  speaking: boolean;
  /** 上次统计的累计丢包/收包（丢包率按窗口增量计算，避免早期网络高峰永久拖累显示） */
  lastPacketsLost: number;
  lastPacketsReceived: number;
  /** 完美协商角色：userId 大者为 polite（offer 冲突时回滚让步，小者坚持己见） */
  polite: boolean;
  makingOffer: boolean; // 本端 createOffer/setLocalDescription 进行中（冲突检测用）
  /** 完美协商冲突时被本端"忽略"的远端 offer：本端协商落定（stable）后补处理。
   *  修复"进房间加载不出共享画面"：共享者的补挂重协商 offer 紧跟初始 answer 到达，
   *  非礼貌方若仍在消化 answer（signalingState 未回 stable）会按冲突丢弃它且对端不会重发，
   *  导致共享画面永久缺失——暂存后补处理即可收敛。 */
  pendingOffer: { sdp: string } | null;
  negotiateSuppressed: boolean; // 抑制初始 negotiationneeded（初始 offer 由新加入者确定性发起）
  videoSender: RTCRtpSender | null; // 我共享屏幕时发给该对端的视频 sender
  shareAudioSender: RTCRtpSender | null; // 我共享屏幕时的系统声音 sender
  micStreamId: string | null; // 该对端麦克风音频流 id（此后同对端新音频流 = 共享系统声音）
  audioTransceiver: RTCRtpTransceiver | null; // 本端麦克风音频收发器（RED/Opus 编解码偏好挂载点）
  /** 上次统计的累计丢包隐藏样本/总接收样本（隐藏率按窗口增量计算，避免历史劣化永久拖累显示） */
  lastConcealedSamples: number;
  lastTotalSamples: number;
}

/** 说话检测 RMS 阈值（0-1 归一化振幅） */
const SPEAKING_THRESHOLD = 0.045;
/** 说话检测轮询间隔 */
const SPEAKING_INTERVAL_MS = 100;
/** 断线重连间隔 */
const RECONNECT_DELAY_MS = 3000;
/** 音量范围 0-100% */
const MIC_VOLUME_KEY = 'voice:micVolume';
/** 麦克风降噪开关偏好（默认关；刷新/重新进房后保持） */
export const NOISE_REDUCTION_KEY = 'voice:noiseReduction';
/** 音乐模式开关偏好（默认关：高码率立体声 + 关闭回声消除/降噪处理链） */
export const MUSIC_MODE_KEY = 'voice:musicMode';
const peerVolumeKey = (selfId: number, peerId: number) => `voice:vol:${selfId}:${peerId}`;

/** ICE 兜底配置（接口失败时使用，与服务端默认一致） */
const FALLBACK_ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.qq.com:3478', 'stun:stun.miwifi.com:3478', 'stun:stun.l.google.com:19302'] },
];

function loadNumber(key: string, fallback: number): number {
  const v = parseFloat(localStorage.getItem(key) ?? '');
  return Number.isFinite(v) ? v : fallback;
}

/** 读取 '1'/'0' 开关偏好（缺省 false） */
function loadFlag(key: string): boolean {
  return localStorage.getItem(key) === '1';
}

export class VoiceSession {
  private cb: VoiceSessionCallbacks;
  private self: VoiceParticipant;
  private roomId: number | null = null;

  private ws: WebSocket | null = null;
  private iceServers: RTCIceServer[] = FALLBACK_ICE_SERVERS;
  private intentionalClose = false;

  private audioCtx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private sendTrack: MediaStreamTrack | null = null;
  private localGain: GainNode | null = null;
  private localAnalyser: AnalyserNode | null = null;
  private localBuffer: Uint8Array<ArrayBuffer> | null = null;
  private selfSpeaking = false;

  private peers = new Map<number, PeerEntry>();
  private speakTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private destroyed = false;
  private resumeHandler: (() => void) | null = null;
  /** 语音质量评估（自报语义，实现见 ./qualityMonitor.ts） */
  private quality = new QualityMonitor({
    getPeers: () => [...this.peers.values()].map((e) => ({ userId: e.participant.userId, pc: e.pc })),
    report: (level) => {
      this.quality.emit(this.self.userId, level);
      this.send({ type: 'quality', level });
    },
    onQuality: (userId, level) => this.cb.onPeerQuality(userId, level),
  });
  /** ICE 重启已重试次数（按对端用户计） */
  private restartAttempts = new Map<number, number>();

  private micVolume: number;
  private peerVolumes = new Map<number, number>();

  /** 麦克风降噪开关（默认关；开启后接入 RNNoise worklet 降噪链路） */
  private noiseReductionOn: boolean;
  /** 音乐模式（默认关）：高码率立体声编码 + 关闭采集端 AEC/AGC/NS + 旁路 RNNoise */
  private musicModeOn: boolean;
  /** RNNoise 降噪节点生命周期（实现见 ./denoiser.ts） */
  private denoiser = new Denoiser();
  /** 本地麦克风源节点（降噪开关切换时按需重接路由，重建整条本地链） */
  private micSource: MediaStreamAudioSourceNode | null = null;

  /** 播放总线：各远端 gain → masterGain → 压限器 → 扬声器（多人抢话叠加超 0dB 时压峰值防炸麦） */
  private masterGain: GainNode | null = null;
  private masterLimiter: DynamicsCompressorNode | null = null;

  /** 全房间录制（远端各路 + 开麦时的自己 → 混音 → PCM 直录/MediaRecorder → MP3 结算），
   *  实现见 ./recording/roomRecorder.ts */
  private rec = new RoomRecorder((isRecording, startedAt) =>
    this.cb.onRecordingChange(isRecording, startedAt)
  );

  // ---- 屏幕共享 ----
  /** 本端捕获流（video + 可选系统声音；getDisplayMedia 的原始返回） */
  private shareStream: MediaStream | null = null;
  private sharingActive = false;
  private withShareAudio = false;
  /** 发送侧包装流：固定 stream id，接收端据此把"同对端第二条音频流"识别为共享系统声音 */
  private shareSendVideoStream: MediaStream | null = null;
  private shareSendAudioStream: MediaStream | null = null;
  /** 质量档位与"清晰文字"模式（偏好持久化，下次共享沿用） */
  private shareQuality: ShareQuality;
  private shareSharpText: boolean;
  /** 接收端共享声音开关（默认静音以符合自动播放策略，舞台上手动开启） */
  private shareMuted = true;
  private shareAudioEl: HTMLAudioElement | null = null;
  /** 当前共享者（全房间唯一；服务端 share-changed 广播驱动） */
  private shareSharer: { userId: number; audio: boolean } | null = null;
  /** 发送端共享画面统计与自动降档（实现见 ./share/shareStatsMonitor.ts） */
  private shareStats = new ShareStatsMonitor({
    isSharing: () => this.sharingActive,
    getVideoSenders: () => [...this.peers.values()].flatMap((e) => (e.videoSender ? [e.videoSender] : [])),
    getPeerCount: () => this.peers.size,
    getCaptureStream: () => this.shareStream,
    getQuality: () => this.shareQuality,
    onStats: (stats) => this.cb.onShareStats(stats),
    onAutoDowngrade: () => this.setShareQuality('1080p30'),
  });

  constructor(self: VoiceSelfInfo, cb: VoiceSessionCallbacks) {
    this.cb = cb;
    this.micVolume = Math.min(1, Math.max(0, loadNumber(MIC_VOLUME_KEY, 1)));
    this.noiseReductionOn = loadFlag(NOISE_REDUCTION_KEY);
    this.musicModeOn = loadFlag(MUSIC_MODE_KEY);
    const savedQuality = localStorage.getItem(SHARE_QUALITY_KEY) as ShareQuality | null;
    this.shareQuality =
      savedQuality && savedQuality in SHARE_QUALITY_PRESETS ? savedQuality : SHARE_QUALITY_KEY_DEFAULT;
    this.shareSharpText = loadFlag(SHARE_SHARP_KEY);
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
    return [...this.peers.values()].map((e) => e.pc);
  }

  /** 加入房间（获取 ICE + 麦克风 → 建 WS → 发 join） */
  async join(roomId: number): Promise<void> {
    if (this.destroyed || this.roomId !== null) return;
    this.roomId = roomId;
    this.intentionalClose = false;
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

    // RNNoise 固定 48 kHz（480 样本/10ms 帧）；优先显式指定采样率，
    // 个别浏览器不支持时退回默认采样率，由 prepareDenoiser 检查后降级
    const ACtor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    try {
      this.audioCtx = new ACtor({ sampleRate: 48000 });
    } catch {
      this.audioCtx = new ACtor();
    }
    // AudioContext 需要用户手势后才能出声（点击"加入房间"即手势）；
    // 刷新自动回房等无手势场景由 ensureAudioResume 兜底
    this.audioCtx.resume().catch(() => {
      /* 已 running 时忽略 */
    });
    this.ensureAudioResume();

    // 播放总线（听者模式也需要）：各远端 gain 汇入 masterGain → 压限器 → 扬声器。
    // 压限器只压超 -6dB 的叠加峰值（多人同时说话叠加 >1.0 会硬削波炸麦），单人正常音量不受影响
    this.buildMasterBus();

    // 预载降噪 worklet（与拿麦克风并行，不拖慢进房速度）
    this.denoiser.prepare(this.audioCtx);
    // 预载录音采集 worklet（同理并行；录音走音频线程，主线程卡顿不丢样本）
    this.rec.prepareWorklet(this.audioCtx);

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
      await this.denoiser.prepare(this.audioCtx); // worklet 就绪后再接本地链路
      if (this.noiseReductionOn && !this.musicModeOn) this.denoiser.init(this.audioCtx, this.micStream);
      this.buildLocalChain();
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

    this.openWs();
    this.startSpeakingLoop();
    this.quality.start();
  }

  /** 播放总线：masterGain → 压限器 → destination。阈值 -6dB/比率 20:1/knee 0/attack 1ms，
   *  近似 brickwall limiter——只处理多人叠加超 0dB 的瞬时峰值，正常听感不受影响（~6ms 处理延迟对语音可忽略） */
  private buildMasterBus(): void {
    if (!this.audioCtx || this.masterGain) return;
    this.masterGain = this.audioCtx.createGain();
    this.masterLimiter = this.audioCtx.createDynamicsCompressor();
    this.masterLimiter.threshold.value = -6;
    this.masterLimiter.knee.value = 0;
    this.masterLimiter.ratio.value = 20;
    this.masterLimiter.attack.value = 0.001;
    this.masterLimiter.release.value = 0.1;
    this.masterGain.connect(this.masterLimiter);
    this.masterLimiter.connect(this.audioCtx.destination);
  }

  /** 本地链路: 麦克风 → [worklet] → 增益(麦克风音量) → 发送轨道；旁路分析器做自己的说话检测 */
  private buildLocalChain(): void {
    if (!this.audioCtx || !this.micStream) return;
    this.micSource = this.audioCtx.createMediaStreamSource(this.micStream);

    this.localGain = this.audioCtx.createGain();
    this.localGain.gain.value = this.micVolume;

    const dest = this.audioCtx.createMediaStreamDestination();

    this.localAnalyser = this.audioCtx.createAnalyser();
    this.localAnalyser.fftSize = 512;
    this.localBuffer = new Uint8Array(this.localAnalyser.fftSize);

    this.applyLocalRouting();

    this.localGain.connect(dest);

    this.sendTrack = dest.stream.getAudioTracks()[0] ?? null;
    if (this.sendTrack) this.sendTrack.enabled = !this.self.muted;
  }

  /** 按当前降噪开关重接本地链路：开 → 麦克风 → RNNoise worklet → 增益/说话检测；关 → 直连。
   *  音乐模式下永远直连（RNNoise 对音乐频谱是有损压制） */
  private applyLocalRouting(): void {
    if (!this.micSource || !this.localGain || !this.localAnalyser) return;
    // 先全断开再重接，避免重复 connect 导致音频叠加/重复目标连接
    try {
      this.micSource.disconnect();
    } catch {
      /* 未连接 */
    }
    const denoiserNode = this.denoiser.getNode();
    try {
      denoiserNode?.disconnect();
    } catch {
      /* 未连接 */
    }

    if (denoiserNode && this.noiseReductionOn && !this.musicModeOn) {
      this.micSource.connect(denoiserNode);
      denoiserNode.connect(this.localGain);
      denoiserNode.connect(this.localAnalyser);
    } else {
      this.micSource.connect(this.localGain);
      this.micSource.connect(this.localAnalyser);
    }
  }

  // ============================================================
  // WebSocket 信令
  // ============================================================

  private wsUrl(): string {
    const token = localStorage.getItem('k_token') ?? '';
    const serverUrl = getServerUrl();
    let base: string;
    if (Capacitor.isNativePlatform() && serverUrl) {
      // 仅原生端直连配置的服务器（无混合内容限制）
      base = serverUrl.replace(/^http/, 'ws'); // http→ws / https→wss
    } else {
      // 网页端必须同源：https 页面发起 ws:// 会被浏览器当作混合内容直接拦截
      // （SERVER_URL 烘进网页包曾导致语音信令全灭，网页一律走 location.host）
      base = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
    }
    return `${base}/api/voice/ws?token=${encodeURIComponent(token)}`;
  }

  private openWs(): void {
    if (this.destroyed) return;
    this.ws = new WebSocket(this.wsUrl());

    this.ws.onopen = () => {
      this.send({ type: 'join', roomId: this.roomId, muted: this.self.muted, listener: this.self.listener });
    };

    this.ws.onmessage = (e) => {
      let msg: any;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      this.handleServerMessage(msg);
    };

    this.ws.onclose = (e) => {
      this.ws = null;
      if (this.destroyed || this.intentionalClose) return;
      // 主动踢出类关闭码直接结束会话
      if (e.code === 4002) {
        // 同账号单点在线：被另一设备顶掉。静默退出会让用户以为“互通坏了”，
        // 必须把原因说出来。
        showToast('该账号已在其他设备进入语音，本机已退出房间');
        this.teardown('replaced');
        return;
      }
      if (e.code === 4001) {
        this.teardown('auth');
        return;
      }
      // 其余（网络抖动等）自动重连：清空对等连接后重新加入房间
      this.cleanupPeers();
      this.emitStatus('reconnecting');
      this.reconnectTimer = window.setTimeout(() => this.openWs(), RECONNECT_DELAY_MS);
    };
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
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
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    // 与控制字符清洗保持一致（服务器也会再做一次）
    const cleaned = trimmed.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
    if (!cleaned) return false;
    this.send({ type: 'chat', content: cleaned });
    return true;
  }

  private handleServerMessage(msg: any): void {
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
          const entry = this.ensurePeer(p);
          this.initiateOffer(entry).catch(() => this.teardown('negotiation'));
        }
        // 加入时已有人在共享：先立状态与徽标（画面随后经该共享者的补挂重协商到达）
        const sharer = (msg.participants as VoiceParticipant[]).find((p) => p.sharing);
        if (sharer) {
          this.shareSharer = { userId: sharer.userId, audio: false };
          this.cb.onShareChanged({ userId: sharer.userId, audio: false });
        }
        this.emitParticipants();
        break;
      }
      case 'peer-joined':
        // 别人加入：建好对等连接等他的 offer（规则：新加入者发起）
        this.ensurePeer(msg.participant as VoiceParticipant);
        this.emitParticipants();
        break;
      case 'peer-left':
        this.removePeer(msg.userId);
        this.emitParticipants();
        break;
      case 'mute-changed': {
        const entry = this.peers.get(msg.userId);
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
        this.handleSignal(msg.from, msg.data).catch(() => this.teardown('negotiation'));
        break;
      case 'share-changed': {
        const userId = Number(msg.userId);
        const active = !!msg.active;
        const audio = !!msg.audio;
        if (!Number.isInteger(userId)) break;
        const entry = this.peers.get(userId);
        if (entry) {
          entry.participant.sharing = active;
          this.emitParticipants();
        }
        if (active) {
          this.shareSharer = { userId, audio };
        } else if (this.shareSharer?.userId === userId) {
          this.shareSharer = null;
          this.disposeShareAudio();
          this.cb.onShareVideo(null);
        }
        // 被服务端判定不再共享（被抢占等）：本地兜底停止采集（状态由服务端管理，不再回发 share-stop）
        if (userId === this.self.userId && !active && this.sharingActive) {
          this.stopScreenShare(false);
        }
        this.cb.onShareChanged({ userId: active ? userId : null, audio });
        break;
      }
      case 'share-force-stop':
        // 被新共享者抢占：服务端已广播状态，本地静默停止采集即可
        this.stopScreenShare(false);
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
  // WebRTC Mesh
  // ============================================================

  private ensurePeer(participant: VoiceParticipant): PeerEntry {
    const existing = this.peers.get(participant.userId);
    if (existing) {
      existing.participant = participant;
      return existing;
    }
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });

    // 发送本地音频；听者模式只收不发。
    // 关键：必须用 addTrack（而非 addTransceiver）——Chrome 对远端 offer 的收发器匹配
    // 只复用 addTrack 创建的收发器；addTransceiver 建的在 setRemoteDescription(offer)
    // 时会被跳过、另建一个 recvonly 收发器（实测复现：首次应答降级为只收 + 一次多余重协商，
    // 还会残留一条永不复用的 recvonly m 行）。RED 编解码偏好仍可设：addTrack 返回 sender，
    // 用 getTransceivers 找回对应收发器即可。
    let audioTransceiver: RTCRtpTransceiver | null = null;
    if (this.sendTrack) {
      const sender = pc.addTrack(this.sendTrack, new MediaStream([this.sendTrack]));
      this.markSenderHighPriority(sender);
      audioTransceiver = pc.getTransceivers().find((t) => t.sender === sender) ?? null;
    } else {
      audioTransceiver = pc.addTransceiver('audio', { direction: 'recvonly' });
    }
    this.applyAudioCodecPreference(audioTransceiver);

    pc.onicecandidate = (e) => {
      if (e.candidate)
        this.send({
          type: 'signal',
          to: participant.userId,
          data: { type: 'candidate', candidate: e.candidate.toJSON() },
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
        this.shareSharer = { userId: participant.userId, audio: this.shareSharer?.audio ?? false };
        this.cb.onShareVideo(e.streams[0]);
        return;
      }
      // 音频分流：同对端第一条音频流 = 麦克风（走 WebAudio 音量链路），
      // 共享开始后新出现的第二条音频流 = 共享系统声音（独立 audio 元素直连播放）
      const streamId = e.streams[0].id;
      if (entry.micStreamId !== null && streamId !== entry.micStreamId) {
        this.attachShareAudio(e.streams[0]);
        return;
      }
      // 音频接收端抖动缓冲目标 80ms：防长时间通话的"延迟爬升"（丢包高峰后缓冲
      // 增大且回落缓慢）；RED 冗余兜底丢包，不需要更深的缓冲
      try {
        (e.receiver as RTCRtpReceiver & { jitterBufferTarget?: number }).jitterBufferTarget = 80;
      } catch {
        /* 浏览器不支持则忽略（沿用自适应） */
      }
      this.attachPeerAudio(entry, e.streams[0]);
    };

    const entry: PeerEntry = {
      participant,
      pc,
      audio: null,
      pendingCandidates: [],
      remoteDescSet: false,
      speaking: false,
      lastPacketsLost: 0,
      lastPacketsReceived: 0,
      polite: this.self.userId > participant.userId,
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
      if (pc.connectionState === 'failed') this.tryIceRestart(entry);
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
  private applyAudioCodecPreference(transceiver: RTCRtpTransceiver | null): void {
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
      const ordered = this.musicModeOn ? [...opus, ...red, ...rest] : [...red, ...opus, ...rest];
      transceiver.setCodecPreferences(ordered);
    } catch {
      /* 浏览器不支持编解码偏好则忽略 */
    }
  }

  /** ICE 重启重试打洞（最多 2 次；超过则靠质量圆点提示网络不通） */
  private async tryIceRestart(entry: PeerEntry): Promise<void> {
    if (this.destroyed) return;
    const peerId = entry.participant.userId;
    const attempts = this.restartAttempts.get(peerId) ?? 0;
    if (attempts >= 2) return;
    // 双方都会收到 failed，只由 userId 较小一方发起重启
    if (this.self.userId > peerId) return;
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
  private async initiateOffer(entry: PeerEntry, options?: RTCOfferOptions): Promise<void> {
    entry.makingOffer = true;
    try {
      const offer = await entry.pc.createOffer(options);
      if (!offer.sdp) return; // 理论上不会发生（createOffer 必返回 sdp）
      const sdp = applyOpusPreferences(offer.sdp, this.musicModeOn);
      await entry.pc.setLocalDescription({ type: 'offer', sdp });
      this.send({ type: 'signal', to: entry.participant.userId, data: { type: 'offer', sdp } });
    } finally {
      entry.makingOffer = false;
    }
  }

  /** onnegotiationneeded：共享 track 增删后自动重协商（初始协商被抑制，由确定性规则发起） */
  private async handleNegotiationNeeded(entry: PeerEntry): Promise<void> {
    if (this.destroyed || entry.negotiateSuppressed) return;
    try {
      await this.initiateOffer(entry);
    } catch {
      /* PC 已关闭或冲突被回滚取代：忽略 */
    }
  }

  private async handleSignal(from: number, data: any): Promise<void> {
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
      if (entry.remoteDescSet) await entry.pc.addIceCandidate(data.candidate);
      else entry.pendingCandidates.push(data.candidate);
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
    const sdp2 = applyOpusPreferences(answer.sdp, this.musicModeOn);
    await entry.pc.setLocalDescription({ type: 'answer', sdp: sdp2 });
    this.send({ type: 'signal', to: entry.participant.userId, data: { type: 'answer', sdp: sdp2 } });
    // 首次协商完成：解除抑制；共享中则把共享 track 补挂到这条新建对端连接（随后自动重协商出画面）
    entry.negotiateSuppressed = false;
    this.maybeAttachShareTracks(entry);
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
    void this.processRemoteOffer(entry, pending.sdp).catch(() => this.teardown('negotiation'));
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

  /** 远端流接入音频图: Source → Analyser(检测) & Gain(音量) → 播放总线(压限防叠加炸麦) */
  private attachPeerAudio(entry: PeerEntry, stream: MediaStream): void {
    if (entry.audio || !this.audioCtx) return;
    entry.micStreamId = stream.id; // 该对端的麦克风流 id（此后新出现的音频流 = 共享系统声音）
    const source = this.audioCtx.createMediaStreamSource(stream);
    const analyser = this.audioCtx.createAnalyser();
    analyser.fftSize = 512;
    const gain = this.audioCtx.createGain();
    const stored = this.peerVolumes.get(entry.participant.userId);
    gain.gain.value = stored ?? 1;

    source.connect(analyser);
    source.connect(gain);
    // 播放经总线压限（多人叠加 >0dB 时压峰值）；总线未建（异常时序）直连扬声器兜底
    this.buildMasterBus();
    gain.connect(this.masterGain ?? this.audioCtx.destination);
    // 录制中：中途进房的成员也接入录制总线（同样经压限，录出的 MP3 不炸）
    this.rec.attachPeerGain(gain);

    // Chrome 系 bug: 远端流只接 WebAudio 会静音，需同时有 audio 元素在播放该流驱动解码。
    // 关键：不能用 muted=true（元素不拉流，WebAudio 依旧取不到数据），用 volume=0 既驱动解码又不出声
    const hiddenEl = document.createElement('audio');
    hiddenEl.srcObject = stream;
    hiddenEl.volume = 0;
    hiddenEl.play().catch(() => {
      /* 自动播放策略拦截，ensureAudioResume 恢复后会重试 */
    });

    entry.audio = { source, analyser, gain, buffer: new Uint8Array(analyser.fftSize), hiddenEl };
  }

  private removePeer(userId: number): void {
    const entry = this.peers.get(userId);
    if (!entry) return;
    this.disposePeer(entry);
    this.peers.delete(userId);
    this.quality.forget(userId); // 成员已离开：清掉其残留的质量显示状态与窗口计数器
    if (entry.speaking) this.cb.onSpeaking(userId, false);
    // 离开的正是当前共享者：关闭舞台与共享声音
    if (this.shareSharer?.userId === userId) {
      this.shareSharer = null;
      this.disposeShareAudio();
      this.cb.onShareVideo(null);
      this.cb.onShareChanged({ userId: null, audio: false });
    }
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
      try {
        entry.audio.source.disconnect();
        entry.audio.analyser.disconnect();
        entry.audio.gain.disconnect();
      } catch {
        /* 已断开 */
      }
      entry.audio.hiddenEl.srcObject = null;
      entry.audio.hiddenEl.remove();
      entry.audio = null;
    }
  }

  private cleanupPeers(): void {
    for (const entry of this.peers.values()) this.disposePeer(entry);
    this.peers.clear();
    // 断线重建期间所有质量数据失效：清空（自己的自报值会在重连后重新上报）
    this.quality.forgetAll();
  }

  // ============================================================
  // 说话检测
  // ============================================================

  private startSpeakingLoop(): void {
    this.speakTimer = window.setInterval(() => {
      // 自己（静音/听者不显示说话）
      const selfNow =
        !this.self.muted &&
        !!this.localAnalyser &&
        !!this.localBuffer &&
        this.rms(this.localAnalyser, this.localBuffer) > SPEAKING_THRESHOLD;
      if (selfNow !== this.selfSpeaking) {
        this.selfSpeaking = selfNow;
        this.cb.onSpeaking(this.self.userId, selfNow);
      }
      // 远端
      for (const [userId, entry] of this.peers) {
        if (!entry.audio || entry.participant.muted) {
          if (entry.speaking) {
            entry.speaking = false;
            this.cb.onSpeaking(userId, false);
          }
          continue;
        }
        const now = this.rms(entry.audio.analyser, entry.audio.buffer) > SPEAKING_THRESHOLD;
        if (now !== entry.speaking) {
          entry.speaking = now;
          this.cb.onSpeaking(userId, now);
        }
      }
    }, SPEAKING_INTERVAL_MS);
  }

  private rms(analyser: AnalyserNode, buffer: Uint8Array<ArrayBuffer>): number {
    analyser.getByteTimeDomainData(buffer);
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) {
      const d = (buffer[i] - 128) / 128;
      sum += d * d;
    }
    return Math.sqrt(sum / buffer.length);
  }

  /** 无手势建会话时 AudioContext 可能是 suspended：任意首次点击/按键时恢复出声 */
  private ensureAudioResume(): void {
    const ctx = this.audioCtx;
    if (!ctx || ctx.state === 'running') return;
    const resume = () => {
      this.detachResumeHandler();
      this.audioCtx?.resume().catch(() => {
        /* 忽略 */
      });
      // 自动播放策略此前可能拦掉了兜底音频元素的播放，一并重试
      for (const entry of this.peers.values()) {
        entry.audio?.hiddenEl.play().catch(() => {
          /* 仍被拦截则等下次交互 */
        });
      }
    };
    this.resumeHandler = resume;
    document.addEventListener('pointerdown', resume);
    document.addEventListener('keydown', resume);
  }

  private detachResumeHandler(): void {
    if (!this.resumeHandler) return;
    document.removeEventListener('pointerdown', this.resumeHandler);
    document.removeEventListener('keydown', this.resumeHandler);
    this.resumeHandler = null;
  }

  // ============================================================
  // 对外控制
  // ============================================================

  /** 静音/开麦（track.enabled 切换，无需重协商） */
  setMuted(muted: boolean): void {
    if (this.self.listener) return; // 无麦克风权限不能开麦
    this.self.muted = muted;
    if (this.sendTrack) this.sendTrack.enabled = !muted;
    // 静音时自己的声音不进录制（录制 = 房间其他人实际听到的内容）
    this.rec.setMutedGate(muted);
    this.send({ type: 'mute', muted });
    this.emitParticipants();
  }

  /** 麦克风音量（0-1，影响对方听到的音量） */
  setMicVolume(volume: number): void {
    this.micVolume = Math.min(1, Math.max(0, volume));
    if (this.localGain) this.localGain.gain.value = this.micVolume;
    localStorage.setItem(MIC_VOLUME_KEY, String(this.micVolume));
  }

  /** 单人音量（0-1，只影响自己听到 TA 的音量） */
  setPeerVolume(userId: number, volume: number): void {
    const v = Math.min(1, Math.max(0, volume));
    this.peerVolumes.set(userId, v);
    localStorage.setItem(peerVolumeKey(this.self.userId, userId), String(v));
    const entry = this.peers.get(userId);
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
      this.denoiser.init(this.audioCtx, this.micStream);
    } else {
      this.denoiser.dispose();
    }
    this.applyLocalRouting();
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
    if (!on && this.noiseReductionOn) this.denoiser.init(this.audioCtx, this.micStream);
    // 本地链路重接（音乐模式旁路 RNNoise；关闭时若降噪开关仍开则恢复降噪链）
    this.applyLocalRouting();

    // 编码参数变化：更新各对端编解码偏好并重协商（negotiateSuppressed 的初始协商
    // 尚未完成的连接自动跳过——其 offer 会实时读取当前模式）
    for (const entry of this.peers.values()) {
      this.applyAudioCodecPreference(entry.audioTransceiver);
      void this.handleNegotiationNeeded(entry);
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
    return this.sharingActive;
  }

  /**
   * 发起屏幕共享：getDisplayMedia（1080p60 ideal，系统声音由浏览器共享选择器决定是否携带）
   * → 向服务端声明（抢占旧共享者并广播）→ 把 video/共享音频 track 挂到各对端 PC
   * → onnegotiationneeded 逐对端自动重协商，画面即达。
   */
  async startScreenShare(): Promise<ScreenShareStartResult> {
    if (this.destroyed || this.sharingActive) return 'cancelled';
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

    this.shareStream = stream;
    const video = stream.getVideoTracks()[0] ?? null;
    this.withShareAudio = stream.getAudioTracks().length > 0;
    if (video) {
      // 注意：不设 contentHint='motion' —— 它会开启 Chrome 屏幕捕获的"平滑模式"
      // （帧间混合保帧率），动态画面出现明显拖影/回退感。清晰文字模式仍用 detail。
      if (this.shareSharpText) video.contentHint = 'detail';
      // 浏览器自带的"停止共享"条 → 与主动停止走同一清理路径
      video.onended = () => {
        void this.stopScreenShare();
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
    this.self.sharing = true;
    this.emitParticipants();

    // 先声明状态（服务端互斥/抢占并广播），随后挂 track；重协商由 onnegotiationneeded 自动完成
    this.send({ type: 'share-start', audio: this.withShareAudio });
    for (const entry of this.peers.values()) this.maybeAttachShareTracks(entry);
    this.applyShareQuality();
    this.shareStats.start();

    this.cb.onShareChanged({ userId: this.self.userId, audio: this.withShareAudio });
    if (this.shareSendVideoStream) this.cb.onShareVideo(this.shareSendVideoStream);
    return 'started';
  }

  /** 停止屏幕共享；notify=false 用于被抢占/服务端兜底（状态已在服务端翻转，不再回发 share-stop） */
  stopScreenShare(notify = true): void {
    if (!this.sharingActive && !this.shareStream) return;
    this.sharingActive = false;
    this.self.sharing = false;
    if (this.shareSharer?.userId === this.self.userId) this.shareSharer = null;
    for (const entry of this.peers.values()) {
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
    if (this.shareStream) {
      for (const t of this.shareStream.getTracks()) t.onended = null;
      this.shareStream.getTracks().forEach((t) => t.stop());
    }
    this.shareStream = null;
    this.shareSendVideoStream = null;
    this.shareSendAudioStream = null;
    this.withShareAudio = false;
    this.shareStats.stop();
    this.emitParticipants();
    if (notify) this.send({ type: 'share-stop' });
    // removeTrack 触发各对端 onnegotiationneeded → 自动重协商回纯音频
    this.cb.onShareVideo(null);
    this.cb.onShareChanged({ userId: null, audio: false });
  }

  /** 把当前共享的 video / 系统声音 track 挂到对端 PC（开始共享遍历全房间；对端新建连接后补挂） */
  private maybeAttachShareTracks(entry: PeerEntry): void {
    if (!this.sharingActive || !this.shareStream) return;
    const video = this.shareSendVideoStream?.getVideoTracks()[0];
    if (video && this.shareSendVideoStream && !entry.videoSender) {
      // addTransceiver（而非 addTrack）：直接拿到收发器，便于设置编解码偏好
      const transceiver = entry.pc.addTransceiver(video, {
        direction: 'sendonly',
        streams: [this.shareSendVideoStream],
      });
      entry.videoSender = transceiver.sender;
      this.preferH264ForSender(transceiver);
      this.applyShareQualityToSender(entry.videoSender);
    }
    const audio = this.withShareAudio ? this.shareSendAudioStream?.getAudioTracks()[0] : null;
    if (audio && this.shareSendAudioStream && !entry.shareAudioSender) {
      entry.shareAudioSender = entry.pc.addTrack(audio, this.shareSendAudioStream);
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
    return this.shareQuality;
  }

  setShareQuality(q: ShareQuality): void {
    if (!(q in SHARE_QUALITY_PRESETS)) return;
    this.shareQuality = q;
    localStorage.setItem(SHARE_QUALITY_KEY, q);
    this.applyShareQuality();
    // 自动降档（1080p60 CPU 瓶颈）等内部触发的档位变更也要同步给上层 UI
    this.cb.onShareQualityChange?.(q);
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
    this.applyShareQuality();
  }

  /** 接收端共享声音开关（默认静音；开启动作本身即用户手势，满足自动播放策略） */
  setShareMuted(muted: boolean): void {
    this.shareMuted = muted;
    if (this.shareAudioEl) {
      this.shareAudioEl.muted = muted;
      if (!muted)
        this.shareAudioEl.play().catch(() => {
          /* 仍被拦截则等下次交互 */
        });
    }
  }

  getShareMuted(): boolean {
    return this.shareMuted;
  }

  /** 把当前档位应用到全部视频 sender（码率/分辨率缩放/降级偏好） */
  private applyShareQuality(): void {
    for (const entry of this.peers.values()) {
      if (entry.videoSender) this.applyShareQualityToSender(entry.videoSender);
    }
  }

  private applyShareQualityToSender(sender: RTCRtpSender): void {
    const preset = SHARE_QUALITY_PRESETS[this.shareQuality];
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      const enc = params.encodings[0];
      enc.maxBitrate = preset.maxBitrate;
      // 不设 minBitrate：实测 BWE 对屏幕共享采用内容自适应（静态内容自动压低、
      // 高动态自动爬升），minBitrate 既不生效也无必要，设了反而可能浪费 mesh 上行
      enc.scaleResolutionDownBy = preset.scale;
      // 60fps 档优先保帧率；清晰文字模式优先保分辨率（文字不糊比流畅重要）
      (params as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference = this
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
  private attachShareAudio(stream: MediaStream): void {
    if (!this.shareAudioEl) {
      const el = document.createElement('audio');
      el.muted = this.shareMuted;
      this.shareAudioEl = el;
    }
    this.shareAudioEl.srcObject = stream;
    this.shareAudioEl.play().catch(() => {
      /* 自动播放拦截：舞台上点声音开关时会重试 */
    });
    if (this.shareSharer) this.cb.onShareChanged({ userId: this.shareSharer.userId, audio: true });
  }

  private disposeShareAudio(): void {
    if (!this.shareAudioEl) return;
    this.shareAudioEl.srcObject = null;
    this.shareAudioEl = null;
  }

  // ============================================================
  // 全房间录制
  // ============================================================

  /** 开始录制全房间混音（远端各路 + 开麦时的自己）；已在录/不支持时返回 false */
  startRecording(roomName?: string): boolean {
    if (!this.audioCtx) return false;
    return this.rec.start({
      roomName: roomName ?? '',
      audioCtx: this.audioCtx,
      peerGains: [...this.peers.values()].flatMap((e) => (e.audio ? [e.audio.gain] : [])),
      localGain: this.localGain,
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
    this.cb.onParticipants([this.self, ...[...this.peers.values()].map((e) => ({ ...e.participant }))]);
  }

  private teardown(reason: string, detail?: string): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.intentionalClose = true;
    this.detachResumeHandler();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.speakTimer) {
      clearInterval(this.speakTimer);
      this.speakTimer = null;
    }
    this.quality.stop();
    this.stopRecording(); // 退出时结算录制文件（转码下载在后台完成）
    this.cleanupPeers();

    // 屏幕共享清理（会话级销毁：不发 share-stop，服务端随连接移除广播 share-changed(false)）
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
    this.disposeShareAudio();

    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    this.sendTrack = null;
    this.localGain = null;
    this.localAnalyser = null;
    if (this.micSource) {
      try {
        this.micSource.disconnect();
      } catch {
        /* 未连接 */
      }
      this.micSource = null;
    }
    if (this.masterLimiter) {
      try {
        this.masterLimiter.disconnect();
      } catch {
        /* 已断开 */
      }
      this.masterLimiter = null;
    }
    if (this.masterGain) {
      try {
        this.masterGain.disconnect();
      } catch {
        /* 已断开 */
      }
      this.masterGain = null;
    }
    this.audioCtx?.close().catch(() => {
      /* 已关闭 */
    });
    this.audioCtx = null;

    if (this.ws) {
      try {
        this.ws.close(1000);
      } catch {
        /* 已关闭 */
      }
      this.ws = null;
    }

    this.emitStatus('ended', detail);
    if (reason === 'room-closed') this.cb.onClosed(detail || '房间已被删除');
    else if (reason === 'replaced') this.cb.onClosed('账号在其他地方进入了语音');
    else if (reason === 'auth') this.cb.onClosed('登录已过期，请重新登录后再加入');
    else if (reason === 'error') this.cb.onError(detail || '加入房间失败');
    else if (reason === 'negotiation') this.cb.onError('语音连接建立失败，请重新加入');
    // leave：静默结束
  }
}
