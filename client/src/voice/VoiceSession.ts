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
import NoiseSuppressorWorkletUrl from './rnnoise/noise-suppressor-worklet.js?worker&url';
// 录音 PCM 采集 worklet（音频线程采样，主线程卡顿不丢样本；零依赖单文件）。
// 必须用 ?worker&url（与 RNNoise 一致）：?url 会被 vite 按 assetsInlineLimit 内联成
// data: URL，而 audioWorklet.addModule 不支持 data: URL → 生产静默回退 ScriptProcessor
import RecorderWorkletUrl from './recorder/recorder-worklet.js?worker&url';
// 本地降噪节点注册名
const DENOISER_WORKLET_NAME = 'k-voice-denoiser';
// 录音采集节点注册名
const RECORDER_WORKLET_NAME = 'k-voice-recorder';

export type VoiceStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'ended';

/** 语音质量等级（每个成员自报自身网络状况，服务器广播给全房间展示） */
export type VoiceQualityLevel = 'good' | 'fair' | 'poor';

/** 屏幕共享质量档位（极清 = 1080p60；mesh 上行 = 观看数 × 码率，人多建议降档） */
export type ShareQuality = '1080p60' | '1080p30' | '720p30';

/** 质量档位 → 编码参数（scale 分辨率下采样倍率；degradation 带宽不足时的降级策略）。
 *  码率上限给足：实际发送码率由 WebRTC 按网络可用带宽自适应（0 ~ 上限），
 *  mesh 拓扑下共享者上行 = 观看数 × 实际码率。 */
const SHARE_QUALITY_PRESETS: Record<ShareQuality, {
  maxBitrate: number;
  scale: number;
  degradation: 'maintain-framerate' | 'maintain-resolution' | 'balanced';
}> = {
  // 1080p60 动态画面（视频/游戏）实测 BWE 自适应会给到 12M 上下，上限给足让拥塞控制按需取值
  '1080p60': { maxBitrate: 30_000_000, scale: 1, degradation: 'maintain-framerate' },
  // 1080p30 动态画面实测会顶满 8M 上限仍偏紧（高动态内容 10M 才接近清晰），提到 10M
  '1080p30': { maxBitrate: 10_000_000, scale: 1, degradation: 'balanced' },
  '720p30': { maxBitrate: 6_000_000, scale: 1.5, degradation: 'balanced' },
};

/** 发送端共享画面统计采样间隔（帧率/码率/降级原因） */
const SHARE_STATS_INTERVAL_MS = 2000;

const SHARE_QUALITY_KEY = 'voice:shareQuality';
const SHARE_SHARP_KEY = 'voice:shareSharpText';
// 默认流畅 30fps：带宽不足时 60fps 会触发解码饥荒（绿块/画面停滞倒回），极清档留给手动选择
const SHARE_QUALITY_KEY_DEFAULT: ShareQuality = '1080p30';

/** 发送端共享画面实时统计（采样自 video outbound-rtp，仅共享者有意义） */
export interface ShareStats {
  /** 编码后实际发送帧率（非捕获帧率；编码瓶颈/窗口共享都会低于 60，0=暂无数据） */
  fps: number;
  /** 实际发送码率 bps（窗口增量均值，0=暂无数据） */
  bitrate: number;
  /** 发送分辨率（带宽/CPU 不足时编码器会缩小，画面糊的直接信号） */
  width: number;
  height: number;
  /** 捕获分辨率（getDisplayMedia 协商结果） */
  captureWidth: number;
  captureHeight: number;
  /** 编码受限原因：none | cpu | bandwidth | other */
  limitation: string;
  /** 捕获源实际帧率（窗口/标签共享被浏览器限制为 30，整屏共享才到 60） */
  captureFps: number;
  /** 1080p60 档因 CPU 编码瓶颈被自动降为 1080p30（一次共享会话只触发一次） */
  autoDowngraded: boolean;
  /** 发送分辨率被带宽降级（观众看到糊画面） */
  resolutionDownscaled: boolean;
}

/** 屏幕共享发起结果（cancelled 含用户在浏览器选择器里取消） */
export type ScreenShareStartResult = 'started' | 'cancelled' | 'unsupported';

export interface VoiceSelfInfo {
  userId: number;
  username: string;
  avatar: string | null;
}

export interface VoiceSessionCallbacks {
  /** 连接状态变化 */
  onStatus: (status: VoiceStatus, detail?: string) => void;
  /** 参与者列表变化（含自己，自己在首位） */
  onParticipants: (participants: VoiceParticipant[]) => void;
  /** 说话状态翻转（含自己） */
  onSpeaking: (userId: number, speaking: boolean) => void;
  /** 可恢复错误（房间满/房间不存在等，会话已终止） */
  onError: (message: string) => void;
  /** 会话被外部终止（房间被删/账号在别处登录/认证失败） */
  onClosed: (reason: string) => void;
  /** 某成员的网络质量更新（数据源为服务器广播的各成员自报值；level=null 表示清除该成员的残留状态） */
  onPeerQuality: (userId: number, level: VoiceQualityLevel | null) => void;
  /** 全房间录制状态翻转（startedAt 为开始时间戳，停止时为 null） */
  onRecordingChange: (isRecording: boolean, startedAt: number | null) => void;
  /** 屏幕共享状态变化（userId=null 表示共享结束；audio=共享是否携带系统声音） */
  onShareChanged: (info: { userId: number | null; audio: boolean }) => void;
  /** 待渲染的共享画面流（共享者=本地捕获流，观看者=远端流；null=无画面） */
  onShareVideo: (stream: MediaStream | null) => void;
  /** 发送端共享画面实时统计（共享中每 2s 更新，null=未共享）。仅共享者端有数据 */
  onShareStats: (stats: ShareStats | null) => void;
  /** 共享质量档位变化（含"1080p60 编码瓶颈自动降档"这类内部触发的档位变更） */
  onShareQualityChange?: (q: ShareQuality) => void;
  /** 收到新聊天消息（服务器广播，含自己发送的；客户端按 id 去重/回显） */
  onChatMessage: (message: VoiceChatMessage) => void;
  /** 聊天记录被房主/管理员清空（本地列表应即时清空） */
  onChatCleared: () => void;
}

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
  audio: PeerAudio | null;       // ontrack 后创建
  pendingCandidates: RTCIceCandidateInit[]; // 远端描述就绪前缓存的候选
  remoteDescSet: boolean;
  speaking: boolean;
  /** 上次统计的累计丢包/收包（丢包率按窗口增量计算，避免早期网络高峰永久拖累显示） */
  lastPacketsLost: number;
  lastPacketsReceived: number;
  /** 完美协商角色：userId 大者为 polite（offer 冲突时回滚让步，小者坚持己见） */
  polite: boolean;
  makingOffer: boolean;          // 本端 createOffer/setLocalDescription 进行中（冲突检测用）
  /** 完美协商冲突时被本端"忽略"的远端 offer：本端协商落定（stable）后补处理。
   *  修复"进房间加载不出共享画面"：共享者的补挂重协商 offer 紧跟初始 answer 到达，
   *  非礼貌方若仍在消化 answer（signalingState 未回 stable）会按冲突丢弃它且对端不会重发，
   *  导致共享画面永久缺失——暂存后补处理即可收敛。 */
  pendingOffer: { sdp: string } | null;
  negotiateSuppressed: boolean;  // 抑制初始 negotiationneeded（初始 offer 由新加入者确定性发起）
  videoSender: RTCRtpSender | null;      // 我共享屏幕时发给该对端的视频 sender
  shareAudioSender: RTCRtpSender | null; // 我共享屏幕时的系统声音 sender
  micStreamId: string | null;    // 该对端麦克风音频流 id（此后同对端新音频流 = 共享系统声音）
  audioTransceiver: RTCRtpTransceiver | null; // 本端麦克风音频收发器（RED/Opus 编解码偏好挂载点）
  /** 上次统计的累计丢包隐藏样本/总接收样本（隐藏率按窗口增量计算，避免历史劣化永久拖累显示） */
  lastConcealedSamples: number;
  lastTotalSamples: number;
}

/** 说话检测 RMS 阈值（0-1 归一化振幅） */
const SPEAKING_THRESHOLD = 0.045;
/** 说话检测轮询间隔 */
const SPEAKING_INTERVAL_MS = 100;
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

/**
 * Opus 抗丢包/音质调优：本地 SDP 的 fmtp 追加
 * 语音模式：useinbandfec=1（带内 FEC：弱网丢包时显著减少电流/机器声）、
 *   usedtx=0（不启用不连续传输，保持声音连续性）、
 *   maxaveragebitrate=64000（人声 48k+ 已接近透明的甜点；mesh 架构下带宽 ×(N-1)，
 *   再高人声无感、弱网先崩）。
 * 音乐模式：maxaveragebitrate=96000 + stereo=1（Opus 高保真档：音乐瞬态与立体声
 *   声像不再被 32k 单声道糊掉；配合采集端关闭 AEC/AGC/NS 的原始声）。
 * fmtp 描述的是本端编码器行为，只写本地描述即可；对端部署同版本后其编码器同样生效。
 */
function applyOpusPreferences(sdp: string, musicMode: boolean): string {
  if (!sdp) return sdp;
  const lines = sdp.split(/\r?\n/);
  const extra = musicMode
    ? 'useinbandfec=1;usedtx=0;maxaveragebitrate=96000;stereo=1'
    : 'useinbandfec=1;usedtx=0;maxaveragebitrate=64000';
  // 收集所有 opus rtpmap 的 payload type（麦克风 + 屏幕共享系统声音各一条 m 段）
  const opusPayloads: string[] = [];
  for (const line of lines) {
    const m = line.match(/^a=rtpmap:(\d+)\s+opus\/48000/i);
    if (m && !opusPayloads.includes(m[1])) opusPayloads.push(m[1]);
  }
  if (opusPayloads.length === 0) return sdp;
  // 对每条 opus 的 fmtp 追加参数；无 fmtp 行的插到其 rtpmap 之后
  for (let i = 0; i < lines.length; i++) {
    const rtp = lines[i].match(/^a=rtpmap:(\d+)\s+opus\/48000/i);
    if (!rtp || !opusPayloads.includes(rtp[1])) continue;
    const payload = rtp[1];
    const fmtpIdx = lines.findIndex((l, j) => j > i && l.startsWith(`a=fmtp:${payload} `));
    if (fmtpIdx >= 0) {
      const prefix = `a=fmtp:${payload} `;
      const kept = lines[fmtpIdx]
        .slice(prefix.length)
        .split(';')
        .map(p => p.trim())
        .filter(p => p && !/^(useinbandfec|usedtx|maxaveragebitrate|stereo)=/i.test(p));
      lines[fmtpIdx] = `${prefix}${[...kept, extra].join(';')}`;
    } else {
      lines.splice(i + 1, 0, `a=fmtp:${payload} ${extra}`);
    }
  }
  return lines.join('\r\n');
}

function loadNumber(key: string, fallback: number): number {
  const v = parseFloat(localStorage.getItem(key) ?? '');
  return Number.isFinite(v) ? v : fallback;
}

/** 读取 '1'/'0' 开关偏好（缺省 false） */
function loadFlag(key: string): boolean {
  return localStorage.getItem(key) === '1';
}

// ============================================================
// 全房间录制：格式探测 / 转码 / 下载 工具
// ============================================================

/** MediaRecorder 无浏览器内置 MP3 编码器：Chrome 系 webm/opus，Safari mp4 */
function pickRecorderMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

/** MP3 转码失败兜底下载时按原始容器给扩展名 */
function rawExtension(mime: string): string {
  if (mime.includes('mp4')) return 'm4a';
  if (mime.includes('ogg')) return 'ogg';
  return 'webm';
}

/** 文件名清洗（Windows 保留字符与控制符） */
function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim() || '房间';
}

function buildRecordingFileName(roomName: string, startedAt: number, ext: string): string {
  const d = new Date(startedAt);
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `语音_${sanitizeFileName(roomName)}_${stamp}.${ext}`;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Float32 PCM [-1,1] → Int16（lamejs 输入格式） */
function floatToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** lamejs 支持的采样率集合（WebAudio 常见 44.1k/48k 均在内） */
const MP3_SUPPORTED_RATES = new Set<number>([
  8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000,
]);

/** 不在 lamejs 支持集内的采样率统一归一到 44.1k（线性重采样，时长不变） */
function normalizeMp3SampleRate(rate: number): number {
  return MP3_SUPPORTED_RATES.has(rate) ? rate : 44100;
}

/** 简单线性重采样（仅在采样率不在 lamejs 支持集时启用） */
function resampleFloat32(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = toRate / fromRate;
  const outLen = Math.max(1, Math.round(input.length * ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i / ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

/** 拼接多个 Float32 切片为连续数组（PCM 直录按处理块累积后合并） */
function concatFloat32(slices: Float32Array[]): Float32Array {
  let total = 0;
  for (const s of slices) total += s.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const s of slices) { out.set(s, offset); offset += s.length; }
  return out;
}

/** 单声道 Float32 PCM → MP3 Blob（单声道 128kbps；周期性让出主线程避免长录音卡 UI） */
async function encodePcmToMp3(mono: Float32Array, sampleRate: number): Promise<Blob> {
  const { Mp3Encoder } = await import('@breezystack/lamejs');
  const rate = normalizeMp3SampleRate(sampleRate);
  const pcm = rate === sampleRate ? mono : resampleFloat32(mono, sampleRate, rate);
  const encoder = new Mp3Encoder(1, rate, 128);
  const int16 = floatToInt16(pcm);
  const parts: Uint8Array<ArrayBuffer>[] = [];
  const BLOCK = 1152; // lamejs 单次编码块大小
  for (let i = 0; i < int16.length; i += BLOCK) {
    // 拷贝进新 ArrayBuffer 以满足 BlobPart 的精确类型（lamejs 返回值是 ArrayBufferLike）
    const encoded = new Uint8Array(encoder.encodeBuffer(int16.subarray(i, i + BLOCK)));
    if (encoded.length > 0) parts.push(encoded);
    if ((i / BLOCK) % 200 === 0) await new Promise(r => setTimeout(r, 0));
  }
  const tail = new Uint8Array(encoder.flush());
  if (tail.length > 0) parts.push(tail);
  return new Blob(parts, { type: 'audio/mpeg' });
}

/** AudioBuffer → MP3 Blob（单声道；仅用于 MediaRecorder 原始文件解码的后备路径） */
async function encodeMp3(buffer: AudioBuffer): Promise<Blob> {
  const chs = buffer.numberOfChannels;
  let mono = buffer.getChannelData(0);
  if (chs > 1) {
    // 语音房多人混音本就是单声道内容，声道合并后减半体积
    const len = buffer.length;
    mono = new Float32Array(len);
    for (let c = 0; c < chs; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < len; i++) mono[i] += data[i] / chs;
    }
  }
  return encodePcmToMp3(mono, buffer.sampleRate);
}

/** 录制 Blob → 解码 PCM → MP3（OfflineAudioContext 仅借 decodeAudioData，无需手势、不影响通话中的 AudioContext） */
async function blobToMp3(blob: Blob): Promise<Blob> {
  const decoder = new OfflineAudioContext(1, 1, 44_100);
  const buffer = await decoder.decodeAudioData(await blob.arrayBuffer());
  return encodeMp3(buffer);
}

/**
 * 停止后结算，三档保证输出是 MP3：
 * 1. 首选 PCM 直录（录制时同步采集的 Float32 样本）→ lamejs 直接编码。
 *    不经过浏览器 decodeAudioData —— 该步骤在部分浏览器/长录音下会失败，
 *    正是此前“偶尔下载到 webm/m4a”（不是 mp3）的根因。
 * 2. PCM 不可用时退回 MediaRecorder 原始块 → decodeAudioData → MP3。
 * 3. 仍失败才兜底原始容器（webm/m4a），内容不丢（此路径基本不会再触发）。
 */
async function finalizeRecording(
  pcm: Float32Array | null,
  sampleRate: number,
  raw: Blob | null,
  mime: string,
  roomName: string,
  startedAt: number,
): Promise<void> {
  if (pcm && pcm.length > 0) {
    try {
      const mp3 = await encodePcmToMp3(pcm, sampleRate);
      downloadBlob(mp3, buildRecordingFileName(roomName, startedAt, 'mp3'));
      return;
    } catch { /* PCM 编码失败则继续尝试解码路径 */ }
  }
  if (raw && raw.size > 0) {
    try {
      const mp3 = await blobToMp3(raw);
      downloadBlob(mp3, buildRecordingFileName(roomName, startedAt, 'mp3'));
      return;
    } catch { /* 解码失败，兜底原始格式 */ }
    downloadBlob(raw, buildRecordingFileName(roomName, startedAt, rawExtension(mime)));
  }
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
  private qualityTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private destroyed = false;
  private resumeHandler: (() => void) | null = null;
  /** 各成员自报的网络质量（数据源为服务器广播；key 为 userId，含自己） */
  private qualityMap = new Map<number, VoiceQualityLevel>();
  /** ICE 重启已重试次数（按对端用户计） */
  private restartAttempts = new Map<number, number>();

  private micVolume: number;
  private peerVolumes = new Map<number, number>();

  /** 麦克风降噪开关（默认关；开启后接入 RNNoise worklet 降噪链路） */
  private noiseReductionOn: boolean;
  /** 音乐模式（默认关）：高码率立体声编码 + 关闭采集端 AEC/AGC/NS + 旁路 RNNoise */
  private musicModeOn: boolean;
  private denoiserNode: AudioWorkletNode | null = null;
  private denoiserModuleOk = false;
  private denoiserModulePromise: Promise<void> | null = null;
  /** 本地麦克风源节点（降噪开关切换时按需重接路由，重建整条本地链） */
  private micSource: MediaStreamAudioSourceNode | null = null;

  /** 播放总线：各远端 gain → masterGain → 压限器 → 扬声器（多人抢话叠加超 0dB 时压峰值防炸麦） */
  private masterGain: GainNode | null = null;
  private masterLimiter: DynamicsCompressorNode | null = null;

  /** 全房间录制状态（远端各路 + 开麦时的自己 → 录制总线 → 压限器 → 混音节点 → MediaRecorder） */
  private recBus: GainNode | null = null;
  private recLimiter: DynamicsCompressorNode | null = null;
  private recDest: MediaStreamAudioDestinationNode | null = null;
  private recLocalGain: GainNode | null = null;
  private recorder: MediaRecorder | null = null;
  private recChunks: Blob[] = [];
  private recMime = '';
  private recRoomName = '';
  private recordingStartedAt: number | null = null;

  /** PCM 直录（跨浏览器稳定的 MP3 主路径）：从混音流采集原始 Float32 样本。
   *  优先 AudioWorklet（音频渲染线程，主线程卡顿不丢样本），
   *  worklet 不可用（无 audioWorklet / 模块加载失败）时回退 ScriptProcessor。 */
  private pcmSource: MediaStreamAudioSourceNode | null = null;
  private pcmProcessor: ScriptProcessorNode | null = null;
  private pcmWorklet: AudioWorkletNode | null = null;
  private pcmWorkletModuleOk = false;
  private pcmWorkletPromise: Promise<void> | null = null;
  private pcmSilenceGain: GainNode | null = null;
  private pcmCh0Slices: Float32Array[] = [];
  private pcmCh1Slices: Float32Array[] = [];
  private pcmChannelCount = 0;

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
  /** 发送端共享画面统计定时器（2s 采样编码帧率/码率/降级原因） */
  private shareStatsTimer: number | null = null;
  /** 捕获源实际帧率（getSettings().frameRate；窗口/标签共享被浏览器限制为 30） */
  private shareCaptureFps = 0;
  /** 1080p60 档已被 CPU 编码瓶颈自动降档（一次共享会话只触发一次，防反复横跳） */
  private shareAutoDowngraded = false;
  /** 自动降档判定计数（连续 2 次采样命中才触发，避免瞬时抖动误判） */
  private shareCpuStrike = 0;
  /** outbound-rtp 累计字节缓存（发送码率按窗口增量计算） */
  private shareLastOutbound = new Map<RTCRtpSender, { bytes: number; ts: number }>();

  constructor(self: VoiceSelfInfo, cb: VoiceSessionCallbacks) {
    this.cb = cb;
    this.micVolume = Math.min(1, Math.max(0, loadNumber(MIC_VOLUME_KEY, 1)));
    this.noiseReductionOn = loadFlag(NOISE_REDUCTION_KEY);
    this.musicModeOn = loadFlag(MUSIC_MODE_KEY);
    const savedQuality = localStorage.getItem(SHARE_QUALITY_KEY) as ShareQuality | null;
    this.shareQuality = savedQuality && savedQuality in SHARE_QUALITY_PRESETS ? savedQuality : SHARE_QUALITY_KEY_DEFAULT;
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
    return [...this.peers.values()].map(e => e.pc);
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
    try { this.iceServers = await getVoiceIceServers(); } catch { /* 用 FALLBACK_ICE_SERVERS */ }

    // RNNoise 固定 48 kHz（480 样本/10ms 帧）；优先显式指定采样率，
    // 个别浏览器不支持时退回默认采样率，由 prepareDenoiser 检查后降级
    const ACtor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    try {
      this.audioCtx = new ACtor({ sampleRate: 48000 });
    } catch {
      this.audioCtx = new ACtor();
    }
    // AudioContext 需要用户手势后才能出声（点击"加入房间"即手势）；
    // 刷新自动回房等无手势场景由 ensureAudioResume 兜底
    this.audioCtx.resume().catch(() => { /* 已 running 时忽略 */ });
    this.ensureAudioResume();

    // 播放总线（听者模式也需要）：各远端 gain 汇入 masterGain → 压限器 → 扬声器。
    // 压限器只压超 -6dB 的叠加峰值（多人同时说话叠加 >1.0 会硬削波炸麦），单人正常音量不受影响
    this.buildMasterBus();

    // 预载降噪 worklet（与拿麦克风并行，不拖慢进房速度）
    this.prepareDenoiser();
    // 预载录音采集 worklet（同理并行；录音走音频线程，主线程卡顿不丢样本）
    this.preparePcmWorklet();

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
      await this.prepareDenoiser(); // worklet 就绪后再接本地链路
      if (this.noiseReductionOn && !this.musicModeOn) this.initDenoiserNode();
      this.buildLocalChain();
      // 用户偏好开但 RNNoise 不可用（加载失败/非 48k 采样率）：浏览器 NS 兜底（音乐模式除外）
      if (this.noiseReductionOn && !this.musicModeOn && !this.denoiserNode) {
        this.micStream.getAudioTracks()[0]
          ?.applyConstraints({ noiseSuppression: true, autoGainControl: true })
          .catch(() => { /* 不支持则忽略 */ });
      }
    } catch {
      this.self.listener = true;
      this.self.muted = true;
    }

    // 麦克风权限结果已定（正常开麦 / 听者模式），再广播一次同步准确状态
    this.emitParticipants();

    this.openWs();
    this.startSpeakingLoop();
    this.startQualityLoop();
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
    try { this.micSource.disconnect(); } catch { /* 未连接 */ }
    try { this.denoiserNode?.disconnect(); } catch { /* 未连接 */ }

    if (this.denoiserNode && this.noiseReductionOn && !this.musicModeOn) {
      this.micSource.connect(this.denoiserNode);
      this.denoiserNode.connect(this.localGain);
      this.denoiserNode.connect(this.localAnalyser);
    } else {
      this.micSource.connect(this.localGain);
      this.micSource.connect(this.localAnalyser);
    }
  }

  /** 销毁降噪节点（切换开关时重建，保证 RNNoise 内部状态/环形缓冲全新） */
  private disposeDenoiserNode(): void {
    if (!this.denoiserNode) return;
    try { this.denoiserNode.disconnect(); } catch { /* 已断开 */ }
    this.denoiserNode = null;
  }

  /** 预载降噪 worklet 模块（与取麦克风并行；失败静默降级为浏览器 NS/纯直连） */
  private prepareDenoiser(): Promise<void> {
    if (!this.denoiserModulePromise) {
      const ctx = this.audioCtx;
      // RNNoise 以 48 kHz/480 样本帧训练；采样率不匹配时直接降级，避免错误频谱
      if (!ctx?.audioWorklet || ctx.sampleRate !== 48000) {
        this.denoiserModulePromise = Promise.resolve();
        return this.denoiserModulePromise;
      }
      this.denoiserModulePromise = ctx.audioWorklet
        .addModule(NoiseSuppressorWorkletUrl)
        .then(() => { this.denoiserModuleOk = true; })
        .catch(() => { /* 不支持/加载失败：降级为浏览器 NS + 直连 */ });
    }
    return this.denoiserModulePromise;
  }

  /** 预载录音采集 worklet 模块（进房时与降噪预载并行；失败静默降级 ScriptProcessor） */
  private preparePcmWorklet(): Promise<void> {
    if (!this.pcmWorkletPromise) {
      const ctx = this.audioCtx;
      if (!ctx?.audioWorklet) {
        this.pcmWorkletPromise = Promise.resolve();
        return this.pcmWorkletPromise;
      }
      this.pcmWorkletPromise = ctx.audioWorklet
        .addModule(RecorderWorkletUrl)
        .then(() => { this.pcmWorkletModuleOk = true; })
        .catch(() => { /* 加载失败：录音回退 ScriptProcessor */ });
    }
    return this.pcmWorkletPromise;
  }

  /** worklet 就绪后创建降噪节点（RNNoise 单声道处理，双声道输入由 AudioContext 自动下混） */
  private initDenoiserNode(): void {
    if (!this.audioCtx?.audioWorklet || !this.micStream || !this.denoiserModuleOk) return;
    if (this.denoiserNode) return;
    try {
      const node = new AudioWorkletNode(this.audioCtx, DENOISER_WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
      });
      this.denoiserNode = node;
    } catch {
      this.denoiserNode = null; // 个别环境创建失败：降级为浏览器 NS + 直连
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
      try { msg = JSON.parse(String(e.data)); } catch { return; }
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
      if (e.code === 4001) { this.teardown('auth'); return; }
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
        const sharer = (msg.participants as VoiceParticipant[]).find(p => p.sharing);
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
          this.emitQuality(userId, level);
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
      audioTransceiver = pc.getTransceivers().find(t => t.sender === sender) ?? null;
    } else {
      audioTransceiver = pc.addTransceiver('audio', { direction: 'recvonly' });
    }
    this.applyAudioCodecPreference(audioTransceiver);

    pc.onicecandidate = (e) => {
      if (e.candidate) this.send({ type: 'signal', to: participant.userId, data: { type: 'candidate', candidate: e.candidate.toJSON() } });
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
        } catch { /* 浏览器不支持则忽略 */ }
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
      } catch { /* 浏览器不支持则忽略（沿用自适应） */ }
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
    pc.onnegotiationneeded = () => { void this.handleNegotiationNeeded(entry); };

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
      const params = sender.getParameters() as RTCRtpSendParameters & { priority?: string; networkPriority?: string };
      params.priority = 'high';
      params.networkPriority = 'high';
      sender.setParameters(params).catch(() => { /* 浏览器不支持则忽略 */ });
    } catch { /* 浏览器不支持则忽略 */ }
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
      const red = codecs.filter(c => mime(c.mimeType) === 'audio/red');
      const opus = codecs.filter(c => mime(c.mimeType) === 'audio/opus');
      const rest = codecs.filter(c => mime(c.mimeType) !== 'audio/red' && mime(c.mimeType) !== 'audio/opus');
      const ordered = this.musicModeOn ? [...opus, ...red, ...rest] : [...red, ...opus, ...rest];
      transceiver.setCodecPreferences(ordered);
    } catch { /* 浏览器不支持编解码偏好则忽略 */ }
  }

  /** ICE 重启重试打洞（最多 2 次；超过则靠质量圆点提示网络不通） */
  private async tryIceRestart(entry: PeerEntry): Promise<void> {    if (this.destroyed) return;
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
    } catch { /* PC 已关闭或冲突被回滚取代：忽略 */ }
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
      try { await entry.pc.addIceCandidate(c); } catch { /* 候选过期忽略 */ }
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
    if (this.recBus) gain.connect(this.recBus);

    // Chrome 系 bug: 远端流只接 WebAudio 会静音，需同时有 audio 元素在播放该流驱动解码。
    // 关键：不能用 muted=true（元素不拉流，WebAudio 依旧取不到数据），用 volume=0 既驱动解码又不出声
    const hiddenEl = document.createElement('audio');
    hiddenEl.srcObject = stream;
    hiddenEl.volume = 0;
    hiddenEl.play().catch(() => { /* 自动播放策略拦截，ensureAudioResume 恢复后会重试 */ });

    entry.audio = { source, analyser, gain, buffer: new Uint8Array(analyser.fftSize), hiddenEl };
  }

  private removePeer(userId: number): void {
    const entry = this.peers.get(userId);
    if (!entry) return;
    this.disposePeer(entry);
    this.peers.delete(userId);
    this.clearQuality(userId); // 成员已离开：清掉其残留的质量显示状态
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
    try { entry.pc.close(); } catch { /* 已关闭 */ }
    entry.videoSender = null;
    entry.shareAudioSender = null;
    if (entry.audio) {
      try {
        entry.audio.source.disconnect();
        entry.audio.analyser.disconnect();
        entry.audio.gain.disconnect();
      } catch { /* 已断开 */ }
      entry.audio.hiddenEl.srcObject = null;
      entry.audio.hiddenEl.remove();
      entry.audio = null;
    }
  }

  private cleanupPeers(): void {
    for (const entry of this.peers.values()) this.disposePeer(entry);
    this.peers.clear();
    // 断线重建期间所有质量数据失效：清空（自己的自报值会在重连后重新上报）
    for (const userId of [...this.qualityMap.keys()]) this.clearQuality(userId);
  }

  // ============================================================
  // 说话检测
  // ============================================================

  private startSpeakingLoop(): void {
    this.speakTimer = window.setInterval(() => {
      // 自己（静音/听者不显示说话）
      const selfNow = !this.self.muted && !!this.localAnalyser && !!this.localBuffer && this.rms(this.localAnalyser, this.localBuffer) > SPEAKING_THRESHOLD;
      if (selfNow !== this.selfSpeaking) {
        this.selfSpeaking = selfNow;
        this.cb.onSpeaking(this.self.userId, selfNow);
      }
      // 远端
      for (const [userId, entry] of this.peers) {
        if (!entry.audio || entry.participant.muted) {
          if (entry.speaking) { entry.speaking = false; this.cb.onSpeaking(userId, false); }
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

  // ============================================================
  // 语音质量评估（自报语义：评估"自己的网络"，上报服务器广播给全房间）
  // ============================================================

  /** 定期评估自身网络（全部对等连接的窗口增量丢包/往返延迟），变化时上报服务器 */
  private startQualityLoop(): void {
    this.qualityTimer = window.setInterval(() => {
      this.measureQuality().catch(() => { /* 统计失败忽略，下轮再试 */ });
    }, QUALITY_INTERVAL_MS);
  }

  private emitQuality(userId: number, level: VoiceQualityLevel): void {
    if (this.qualityMap.get(userId) === level) return;
    this.qualityMap.set(userId, level);
    this.cb.onPeerQuality(userId, level);
  }

  /** 清除某成员的质量状态并通知上层删除（level=null 语义） */
  private clearQuality(userId: number): void {
    if (!this.qualityMap.has(userId)) return;
    this.qualityMap.delete(userId);
    this.cb.onPeerQuality(userId, null);
  }

  private async measureQuality(): Promise<void> {
    if (this.peers.size === 0) {
      // 房间里只有自己：无对等连接，网络状态视为良好
      this.reportSelfQuality('good');
      return;
    }

    let deltaLost = 0;
    let deltaReceived = 0;
    let deltaConcealed = 0;
    let deltaSamples = 0;
    const rtts: number[] = [];
    let degraded = false;

    for (const entry of this.peers.values()) {
      let lost = 0;
      let received = 0;
      let concealed = 0;
      let samples = 0;
      const peerRtts: number[] = [];
      const stats = await entry.pc.getStats();
      stats.forEach((r: RTCStats) => {
        const report = r as {
          type: string; kind?: string; packetsLost?: number; packetsReceived?: number;
          nominated?: boolean; state?: string; currentRoundTripTime?: number;
          concealedSamples?: number; totalSamplesReceived?: number;
        };
        if (report.type === 'inbound-rtp' && report.kind === 'audio') {
          lost += Math.max(0, report.packetsLost ?? 0);
          received += Math.max(0, report.packetsReceived ?? 0);
          // 丢包隐藏（NetEq 合成插值）样本：FEC/RED 冗余恢复失败后接收端只能合成填补，
          // 隐藏率是"电流声/机器声"最直接的观测指标（丢包率看不出 FEC 已兜住的部分）
          concealed += Math.max(0, report.concealedSamples ?? 0);
          samples += Math.max(0, report.totalSamplesReceived ?? 0);
        } else if (report.type === 'candidate-pair'
          && (report.nominated === true || report.state === 'succeeded')
          && typeof report.currentRoundTripTime === 'number') {
          peerRtts.push(report.currentRoundTripTime);
        }
      });
      // 丢包率按窗口增量计算（上次→本次）：早期网络高峰不会永久拖累显示，
      // 计数器回绕/重协商导致的负增量按 0 处理
      deltaLost += Math.max(0, lost - entry.lastPacketsLost);
      deltaReceived += Math.max(0, received - entry.lastPacketsReceived);
      deltaConcealed += Math.max(0, concealed - entry.lastConcealedSamples);
      deltaSamples += Math.max(0, samples - entry.lastTotalSamples);
      entry.lastPacketsLost = lost;
      entry.lastPacketsReceived = received;
      entry.lastConcealedSamples = concealed;
      entry.lastTotalSamples = samples;
      // 连接失败的对等路径不并入统计；断线/新建连接视为自身网络降级信号
      const connState = entry.pc.connectionState;
      if (connState === 'failed') continue;
      rtts.push(...peerRtts);
      if (connState === 'disconnected' || connState === 'new') degraded = true;
    }

    // 连接没建立成功时没有任何统计（会被误判为良好），用连接状态修正
    let level = this.gradeQuality(deltaLost, deltaReceived, rtts, deltaConcealed, deltaSamples);
    if (degraded) level = level === 'good' ? 'fair' : level;
    this.reportSelfQuality(level);
  }

  /** 自报网络质量：本地即时展示自己的点 + 上报服务器广播给全房间 */
  private reportSelfQuality(level: VoiceQualityLevel): void {
    this.emitQuality(this.self.userId, level);
    this.send({ type: 'quality', level });
  }

  private gradeQuality(lost: number, received: number, rtts: number[], concealed: number, samples: number): VoiceQualityLevel {
    const lossRate = lost + received > 0 ? lost / (lost + received) : 0;
    const avgRtt = rtts.length > 0 ? rtts.reduce((a, b) => a + b, 0) / rtts.length : 0;
    // 隐藏率：无样本（连接未建立/浏览器不报）时不参与降级
    const concealRate = samples > 0 ? concealed / samples : 0;
    if (lossRate > QUALITY_LOSS_POOR || avgRtt > QUALITY_RTT_POOR || concealRate > QUALITY_CONCEAL_POOR) return 'poor';
    if (lossRate > QUALITY_LOSS_FAIR || avgRtt > QUALITY_RTT_FAIR || concealRate > QUALITY_CONCEAL_FAIR) return 'fair';
    return 'good';
  }

  /** 无手势建会话时 AudioContext 可能是 suspended：任意首次点击/按键时恢复出声 */
  private ensureAudioResume(): void {
    const ctx = this.audioCtx;
    if (!ctx || ctx.state === 'running') return;
    const resume = () => {
      this.detachResumeHandler();
      this.audioCtx?.resume().catch(() => { /* 忽略 */ });
      // 自动播放策略此前可能拦掉了兜底音频元素的播放，一并重试
      for (const entry of this.peers.values()) {
        entry.audio?.hiddenEl.play().catch(() => { /* 仍被拦截则等下次交互 */ });
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
    if (this.recLocalGain) this.recLocalGain.gain.value = muted ? 0 : 1;
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
      this.initDenoiserNode();
    } else {
      this.disposeDenoiserNode();
    }
    this.applyLocalRouting();
    const track = this.micStream?.getAudioTracks()[0];
    if (!track) return; // 听者模式/无麦克风：仅保存偏好，进房后按偏好生效
    // RNNoise 生效时不用浏览器 NS（双重降噪会压瘪人声）；worklet 不可用则由浏览器 NS 兜底；
    // 音乐模式保持处理链全关（保真优先）
    track
      .applyConstraints({
        noiseSuppression: on && !this.denoiserNode && !this.musicModeOn,
        autoGainControl: !this.musicModeOn,
      })
      .catch(() => { /* 浏览器不支持动态切换则忽略 */ });
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
    track?.applyConstraints({
      echoCancellation: !on,
      noiseSuppression: false,
      autoGainControl: !on,
    }).catch(() => { /* 浏览器不支持动态切换则忽略 */ });
    // 关闭音乐模式时若降噪开关仍开：补建 RNNoise 节点（进房时音乐模式开着则未创建）
    if (!on && this.noiseReductionOn) this.initDenoiserNode();
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
      stream.getTracks().forEach(t => t.stop());
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
      video.onended = () => { void this.stopScreenShare(); };
    }
    // 记录捕获实际帧率与分辨率：窗口/标签共享被 Chromium 限制最高 30fps，
    // 只有整屏(monitor)共享能到 60 —— 后续 UI 据此提示"选 60 档但实际只有 30"
    const capSettings = video?.getSettings();
    this.shareCaptureFps = capSettings?.frameRate ?? 0;
    this.shareAutoDowngraded = false;
    this.shareCpuStrike = 0;
    this.shareLastOutbound.clear();
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
    this.startShareStatsLoop();

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
        try { entry.pc.removeTrack(entry.videoSender); } catch { /* PC 已关闭 */ }
        entry.videoSender = null;
      }
      if (entry.shareAudioSender) {
        try { entry.pc.removeTrack(entry.shareAudioSender); } catch { /* PC 已关闭 */ }
        entry.shareAudioSender = null;
      }
    }
    if (this.shareStream) {
      for (const t of this.shareStream.getTracks()) t.onended = null;
      this.shareStream.getTracks().forEach(t => t.stop());
    }
    this.shareStream = null;
    this.shareSendVideoStream = null;
    this.shareSendAudioStream = null;
    this.withShareAudio = false;
    this.stopShareStatsLoop();
    this.shareLastOutbound.clear();
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
      const transceiver = entry.pc.addTransceiver(video, { direction: 'sendonly', streams: [this.shareSendVideoStream] });
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
      const h264 = codecs.filter(c => c.mimeType.toLowerCase() === 'video/h264');
      if (h264.length === 0) return; // 无 H264 能力：保持默认（VP8/VP9）
      const rest = codecs.filter(c => c.mimeType.toLowerCase() !== 'video/h264');
      transceiver.setCodecPreferences([...h264, ...rest]);
    } catch { /* 浏览器不支持编解码偏好则忽略 */ }
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
      if (!muted) this.shareAudioEl.play().catch(() => { /* 仍被拦截则等下次交互 */ });
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
      (params as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference =
        this.shareSharpText ? 'maintain-resolution' : preset.degradation;
      sender.setParameters(params).catch(() => { /* 浏览器不支持则忽略 */ });
    } catch { /* 参数不支持：按浏览器默认编码 */ }
  }

  // ============================================================
  // 发送端共享画面实时统计（解决"选 60 档但画面糊/帧率低"的盲区：
  // 实际发送帧率、码率、分辨率、编码降级原因全部可视化 + 自动纠偏）
  // ============================================================

  private startShareStatsLoop(): void {
    this.stopShareStatsLoop();
    this.shareStatsTimer = window.setInterval(() => {
      this.measureShareStats().catch(() => { /* 统计失败忽略，下轮再试 */ });
    }, SHARE_STATS_INTERVAL_MS);
  }

  private stopShareStatsLoop(): void {
    if (this.shareStatsTimer) { clearInterval(this.shareStatsTimer); this.shareStatsTimer = null; }
  }

  /** 聚合采样全部视频 sender（mesh 下每个对端一个 sender）：
   *  帧率取最大值（观众解码能力不影响发送），码率/分辨率/降级原因取首个有数据的 */
  private async measureShareStats(): Promise<void> {
    if (!this.sharingActive) {
      this.cb.onShareStats(null);
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
    for (const entry of this.peers.values()) {
      if (!entry.videoSender) continue;
      const stats = await entry.videoSender.getStats();
      for (const r of stats.values()) {
        if (r.type !== 'outbound-rtp' || (r as { kind?: string }).kind !== 'video') continue;
        sampled = true;
        const o = r as RTCStats & {
          framesPerSecond?: number; frameWidth?: number; frameHeight?: number;
          qualityLimitationReason?: string; bytesSent?: number;
        };
        if (o.framesPerSecond) fps = Math.max(fps, o.framesPerSecond);
        if (!width && o.frameWidth) {
          width = o.frameWidth;
          height = o.frameHeight ?? 0;
        }
        if (o.qualityLimitationReason && o.qualityLimitationReason !== 'none') limitation = o.qualityLimitationReason;
        if (typeof o.bytesSent === 'number') {
          const prev = this.shareLastOutbound.get(entry.videoSender);
          if (prev) {
            bytesDelta += Math.max(0, o.bytesSent - prev.bytes);
            tsDelta += Math.max(1, now - prev.ts);
          }
          this.shareLastOutbound.set(entry.videoSender, { bytes: o.bytesSent, ts: now });
        }
      }
    }
    // 捕获分辨率/帧率：getSettings() 每轮都读（协商后浏览器回填实际值）
    let captureWidth = 0;
    let captureHeight = 0;
    let captureFps = this.shareCaptureFps;
    const cap = this.shareStream?.getVideoTracks()[0]?.getSettings();
    if (cap) {
      captureWidth = cap.width ?? 0;
      captureHeight = cap.height ?? 0;
      if (cap.frameRate) captureFps = cap.frameRate;
    }
    // 无人观看（单人房间/观众尚未连上）：没有 video sender 数据，只上报捕获信息，
    // 让 UI 仍能提示捕获帧率限制（窗口/标签共享 30fps）
    if (!sampled && this.peers.size === 0) {
      this.cb.onShareStats({
        fps: 0, bitrate: 0, width: 0, height: 0,
        captureWidth, captureHeight, limitation: 'none',
        captureFps, autoDowngraded: this.shareAutoDowngraded, resolutionDownscaled: false,
      });
      return;
    }
    if (!sampled) return; // 有对端但 sender 数据未就绪，等下一轮
    bitrate = tsDelta > 0 ? Math.round((bytesDelta * 8) / (tsDelta / 1000)) : 0;

    // 带宽降级判定：发送分辨率明显小于捕获分辨率 = 编码器在降分辨率保帧率（糊的直接来源）
    const resolutionDownscaled = width > 0 && captureWidth > 0 && width < captureWidth * 0.75;

    // 自动纠偏：1080p60 档被 CPU 编码瓶颈卡住（软编/硬件编码器受限）时自动降 1080p30，
    // 连续 2 次采样命中才触发；一次共享会话只降一次，避免与用户手动档位反复拉锯
    let autoDowngraded = this.shareAutoDowngraded;
    if (this.shareQuality === '1080p60' && !autoDowngraded && fps > 0) {
      if (fps < 45 && (limitation === 'cpu' || limitation === 'other')) {
        this.shareCpuStrike += 1;
        if (this.shareCpuStrike >= 2) {
          this.shareAutoDowngraded = true;
          autoDowngraded = true;
          // 降档本身会触发 UI 档位变化；再发一帧统计让提示条即时出现
          this.setShareQuality('1080p30');
          this.cb.onShareStats({
            fps, bitrate, width, height, captureWidth, captureHeight,
            limitation, captureFps, autoDowngraded, resolutionDownscaled,
          });
          return;
        }
      } else {
        this.shareCpuStrike = 0;
      }
    }

    this.cb.onShareStats({
      fps, bitrate, width, height, captureWidth, captureHeight,
      limitation, captureFps, autoDowngraded, resolutionDownscaled,
    });
  }

  /** 远端共享系统声音：独立 audio 元素直连播放（默认静音；不进 WebAudio 音量链与房间录制） */
  private attachShareAudio(stream: MediaStream): void {
    if (!this.shareAudioEl) {
      const el = document.createElement('audio');
      el.muted = this.shareMuted;
      this.shareAudioEl = el;
    }
    this.shareAudioEl.srcObject = stream;
    this.shareAudioEl.play().catch(() => { /* 自动播放拦截：舞台上点声音开关时会重试 */ });
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
    if (this.isRecording() || !this.audioCtx) return false;

    this.recRoomName = roomName ?? '';
    this.recMime = pickRecorderMime();
    // 录制总线：各路混音 → 压限器 → 混音节点（多人叠加超 0dB 时压峰值，录出的 MP3 不炸）
    this.recBus = this.audioCtx.createGain();
    this.recLimiter = this.audioCtx.createDynamicsCompressor();
    this.recLimiter.threshold.value = -6;
    this.recLimiter.knee.value = 0;
    this.recLimiter.ratio.value = 20;
    this.recLimiter.attack.value = 0.001;
    this.recLimiter.release.value = 0.1;
    this.recDest = this.audioCtx.createMediaStreamDestination();
    this.recBus.connect(this.recLimiter);
    this.recLimiter.connect(this.recDest);

    // 已在场成员的远端声音接入混音（录制中途进房的由 attachPeerAudio 接入）
    for (const entry of this.peers.values()) {
      if (entry.audio) entry.audio.gain.connect(this.recBus);
    }
    // 自己的麦克风：localGain 已含麦克风音量，recLocalGain 做静音门
    if (this.localGain) {
      this.recLocalGain = this.audioCtx.createGain();
      this.recLocalGain.gain.value = this.self.muted ? 0 : 1;
      this.localGain.connect(this.recLocalGain);
      this.recLocalGain.connect(this.recBus);
    }

    // MP3 主路径：从混音流直录 PCM（不经过浏览器 decodeAudioData，输出必然为 MP3）
    this.setupPcmCapture();

    // MediaRecorder 仅作后备：容器由浏览器决定（webm/mp4），只在 PCM 不可用时供解码兜底
    if (this.recMime) {
      try {
        this.recorder = new MediaRecorder(this.recDest.stream, { mimeType: this.recMime });
        this.recorder.ondataavailable = (e) => {
          if (e.data.size > 0) this.recChunks.push(e.data);
        };
        // 每秒吐一次数据：页面意外关闭时已录部分仍有机会落地
        this.recorder.start(1000);
      } catch {
        this.recorder = null; // 个别环境不支持该 mime：仅靠 PCM 路径继续
      }
    }

    // PCM 与 MediaRecorder 都不可用：无法录制，回滚混音节点
    if (!this.pcmProcessor && !this.pcmWorklet && !this.recorder) {
      this.cleanupRecNodes();
      return false;
    }

    this.recordingStartedAt = Date.now();
    this.cb.onRecordingChange(true, this.recordingStartedAt);
    return true;
  }

  /** 停止录制：立即恢复状态；优先用 PCM 直录数据异步编码 MP3 下载（PCM 不可用才走 MediaRecorder 解码路径） */
  stopRecording(): void {
    // 未在录制（recorder / PCM 采集都已停止）：清理可能残留的数据并返回。
    // 关键：MediaRecorder.stop() 异步派发的最后一次 dataavailable 可能已把尾部数据
    // 写入 recChunks（见下方 ondataavailable 置空），这里必须整体丢弃，杜绝“退出房间时
    // 把上一次录制的残片再次结算下载成 webm”。
    if (!this.recorder && !this.pcmProcessor) {
      this.recChunks = [];
      this.recMime = '';
      this.recRoomName = '';
      this.recordingStartedAt = null;
      this.cb.onRecordingChange(false, null);
      return;
    }
    const rec = this.recorder;
    const chunks = this.recChunks;
    const mime = this.recMime;
    const roomName = this.recRoomName;
    const startedAt = this.recordingStartedAt ?? Date.now(); // 开始时间存在时优先，兜底防类型 null
    const sampleRate = this.audioCtx?.sampleRate ?? 48_000; // PCM 编码采样率（需在 ctx 关闭前读取）
    // 先取走 PCM 数据，再断开采集与混音节点（此后不再接收新样本）
    const pcm = this.collectPcm();
    this.recorder = null;
    this.recChunks = [];
    this.recordingStartedAt = null;
    this.teardownPcmCapture();
    this.cleanupRecNodes();
    this.cb.onRecordingChange(false, null);

    const finalize = () => {
      void finalizeRecording(
        pcm,
        sampleRate,
        chunks.length > 0 ? new Blob(chunks, { type: mime }) : null,
        mime,
        roomName,
        startedAt,
      );
    };
    if (rec) {
      // 必须先置空：stop() 之后浏览器还会派发一次 dataavailable（停止前的尾部数据），
      // 若回调仍指向 this.recChunks，会把残片写进刚重置的新数组，导致下次 stopRecording
      // （如退出房间）把它当有效录制再结算一次 —— 表现为“没录制也下载 webm”。
      rec.ondataavailable = null;
      rec.onstop = finalize;
      if (rec.state !== 'inactive') rec.stop();
      else finalize(); // 罕见：已 inactive 但 onstop 未触发，直接结算
    } else {
      finalize(); // 无 MediaRecorder（纯 PCM 直录）：立即结算
    }
  }

  isRecording(): boolean {
    return this.recorder !== null || this.pcmProcessor !== null || this.pcmWorklet !== null;
  }

  getRecordingStartedAt(): number | null {
    return this.recordingStartedAt;
  }

  /** 从混音流抓取原始 PCM（2 声道输入；输入缓冲会被复用，切片必须拷贝）。
   *  优先 AudioWorklet（音频渲染线程采样）；模块未就绪/不支持时回退
   *  ScriptProcessor（主线程采样，UI 卡顿会丢量子）。 */
  private setupPcmCapture(): void {
    if (!this.audioCtx || !this.recDest) return;
    if (this.pcmWorklet || this.pcmProcessor) return;
    const ctx = this.audioCtx;
    this.pcmCh0Slices = [];
    this.pcmCh1Slices = [];
    this.pcmChannelCount = 0;

    // ---- 主路径：AudioWorklet（进房时已预载模块） ----
    if (this.pcmWorkletModuleOk) {
      try {
        this.pcmSource = ctx.createMediaStreamSource(this.recDest.stream);
        const node = new AudioWorkletNode(ctx, RECORDER_WORKLET_NAME, {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        });
        node.port.onmessage = (e) => {
          // teardown 后仍在途的迟到消息不再入列
          if (this.pcmWorklet !== node) return;
          const d = e.data as { ch0: Float32Array; ch1: Float32Array | null };
          this.pcmChannelCount = Math.max(this.pcmChannelCount, d.ch1 ? 2 : 1);
          this.pcmCh0Slices.push(d.ch0);
          if (d.ch1) this.pcmCh1Slices.push(d.ch1);
        };
        this.pcmWorklet = node;
        this.pcmSource.connect(node);
        // 与 ScriptProcessor 一致：连 0 增益节点到目标，保证稳定驱动且无混音回声
        this.pcmSilenceGain = ctx.createGain();
        this.pcmSilenceGain.gain.value = 0;
        node.connect(this.pcmSilenceGain);
        this.pcmSilenceGain.connect(ctx.destination);
        return;
      } catch {
        // worklet 节点创建失败：清掉半建状态走 ScriptProcessor
        this.teardownPcmCapture();
        this.pcmCh0Slices = [];
        this.pcmChannelCount = 0;
      }
    }

    // ---- 兜底：ScriptProcessor ----
    if (typeof ctx.createScriptProcessor !== 'function') return;
    try {
      this.pcmSource = ctx.createMediaStreamSource(this.recDest.stream);
      this.pcmProcessor = ctx.createScriptProcessor(4096, 2, 2);
      this.pcmProcessor.onaudioprocess = (e) => {
        const input = e.inputBuffer;
        const chs = input.numberOfChannels;
        if (chs > this.pcmChannelCount) this.pcmChannelCount = chs;
        // 输入缓冲的底层数组会被后续事件复用，必须拷贝，否则旧数据会被覆盖
        this.pcmCh0Slices.push(new Float32Array(input.getChannelData(0)));
        if (chs > 1) this.pcmCh1Slices.push(new Float32Array(input.getChannelData(1)));
      };
      this.pcmSource.connect(this.pcmProcessor);
      // ScriptProcessor 需连到目标才会稳定触发；接 0 增益节点避免混音回声
      this.pcmSilenceGain = ctx.createGain();
      this.pcmSilenceGain.gain.value = 0;
      this.pcmProcessor.connect(this.pcmSilenceGain);
      this.pcmSilenceGain.connect(ctx.destination);
    } catch {
      this.teardownPcmCapture();
    }
  }

  /** 汇总 PCM 为单声道（1 路原样，2 路取均值）；无数据返回 null */
  private collectPcm(): Float32Array | null {
    if (this.pcmCh0Slices.length === 0) return null;
    const ch0 = concatFloat32(this.pcmCh0Slices);
    if (this.pcmChannelCount > 1 && this.pcmCh1Slices.length > 0) {
      const ch1 = concatFloat32(this.pcmCh1Slices);
      const n = Math.min(ch0.length, ch1.length);
      const mono = new Float32Array(n);
      for (let i = 0; i < n; i++) mono[i] = (ch0[i] + ch1[i]) / 2;
      return mono;
    }
    return ch0;
  }

  /** 断开并清空 PCM 采集（对已断开节点操作会抛错，逐个兜底） */
  private teardownPcmCapture(): void {
    if (this.pcmWorklet) {
      // 先置 null：阻断在途消息继续入列（onmessage 里以此判断）
      const node = this.pcmWorklet;
      this.pcmWorklet = null;
      node.port.onmessage = null;
      try { node.disconnect(); } catch { /* 已断开 */ }
      try { node.port.close(); } catch { /* 已关闭 */ }
    }
    if (this.pcmProcessor) {
      this.pcmProcessor.onaudioprocess = null;
      try { this.pcmProcessor.disconnect(); } catch { /* 已断开 */ }
      this.pcmProcessor = null;
    }
    if (this.pcmSource) {
      try { this.pcmSource.disconnect(); } catch { /* 已断开 */ }
      this.pcmSource = null;
    }
    if (this.pcmSilenceGain) {
      try { this.pcmSilenceGain.disconnect(); } catch { /* 已断开 */ }
      this.pcmSilenceGain = null;
    }
    this.pcmCh0Slices = [];
    this.pcmCh1Slices = [];
    this.pcmChannelCount = 0;
  }

  /** 断开并释放混音相关节点（对已断开节点操作会抛错，逐个兜底） */
  private cleanupRecNodes(): void {
    if (this.recLocalGain) {
      try { this.localGain?.disconnect(this.recLocalGain); } catch { /* 已断开 */ }
      try { this.recLocalGain.disconnect(); } catch { /* 已断开 */ }
      this.recLocalGain = null;
    }
    if (this.recBus) {
      for (const entry of this.peers.values()) {
        if (entry.audio) { try { entry.audio.gain.disconnect(this.recBus); } catch { /* 已断开 */ } }
      }
      try { this.recBus.disconnect(); } catch { /* 已断开 */ }
      this.recBus = null;
    }
    if (this.recLimiter) {
      try { this.recLimiter.disconnect(); } catch { /* 已断开 */ }
      this.recLimiter = null;
    }
    this.recDest = null;
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
    this.cb.onParticipants([this.self, ...[...this.peers.values()].map(e => ({ ...e.participant }))]);
  }

  private teardown(reason: string, detail?: string): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.intentionalClose = true;
    this.detachResumeHandler();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.speakTimer) { clearInterval(this.speakTimer); this.speakTimer = null; }
    if (this.qualityTimer) { clearInterval(this.qualityTimer); this.qualityTimer = null; }
    this.stopRecording(); // 退出时结算录制文件（转码下载在后台完成）
    this.cleanupPeers();

    // 屏幕共享清理（会话级销毁：不发 share-stop，服务端随连接移除广播 share-changed(false)）
    this.sharingActive = false;
    this.shareSharer = null;
    this.stopShareStatsLoop();
    this.shareLastOutbound.clear();
    if (this.shareStream) {
      for (const t of this.shareStream.getTracks()) t.onended = null;
      this.shareStream.getTracks().forEach(t => t.stop());
    }
    this.shareStream = null;
    this.shareSendVideoStream = null;
    this.shareSendAudioStream = null;
    this.disposeShareAudio();

    this.micStream?.getTracks().forEach(t => t.stop());
    this.micStream = null;
    this.sendTrack = null;
    this.localGain = null;
    this.localAnalyser = null;
    if (this.micSource) {
      try { this.micSource.disconnect(); } catch { /* 未连接 */ }
      this.micSource = null;
    }
    if (this.denoiserNode) {
      try { this.denoiserNode.disconnect(); } catch { /* 已断开 */ }
      this.denoiserNode = null;
    }
    if (this.masterLimiter) {
      try { this.masterLimiter.disconnect(); } catch { /* 已断开 */ }
      this.masterLimiter = null;
    }
    if (this.masterGain) {
      try { this.masterGain.disconnect(); } catch { /* 已断开 */ }
      this.masterGain = null;
    }
    this.audioCtx?.close().catch(() => { /* 已关闭 */ });
    this.audioCtx = null;

    if (this.ws) {
      try { this.ws.close(1000); } catch { /* 已关闭 */ }
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
