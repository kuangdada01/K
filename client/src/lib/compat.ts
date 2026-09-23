/**
 * ============================================================
 * 运行环境能力门槛（lib/compat）
 * ============================================================
 * 2026-09-19 决策：**不再为过低版本的内核做功能降级兼容**，检测到就直接告知
 * "版本过低"，让用户升级系统/换浏览器，而不是让应用在半残状态下勉强运行
 * （老内核上"能进房但看不见别人""开关点了没反应"这类状态，比明确拒绝更难排查、
 *  用户体验也更差，前面两轮线上事故都是这么来的）。
 *
 * 分两级：
 * - **core（核心）**：登录态存储 / fetch / WebSocket / matchMedia。
 *   缺任一 → 整站不可用，直接渲染"版本过低"提示页（main.tsx 拦截）。
 * - **voice（语音）**：WebRTC / 麦克风 / 音频播放 / 屏幕共享 / 录音。
 *   缺任一 → 其余功能照常，只在进入语音页时明确列出缺什么、哪些功能不可用。
 *
 * ⚠️ 重要约束：**要在老内核里显示出"版本过低"，构建产物本身必须能在它上面解析**。
 *    所以 vite 的 `build.target` / `cssTarget` 仍钉在 safari14 —— 取消的是功能层
 *    降级兜底（duck typing 回退、静默 listener 模式等），不是语法目标。
 *    若把 target 一并放开，老浏览器会在解析期 SyntaxError 白屏，连这句话都看不到。
 *
 * 判据一律用「**真要调的方法确实可调用**」而不是「属性存在」：
 * 微信 iOS 内核里 `window.speechSynthesis` 就是典型的存在但残缺的对象。
 * ============================================================
 */

export type CapabilityLevel = 'core' | 'voice';

export interface MissingCapability {
  /** 稳定的标识（日志/上报用） */
  id: string;
  /** 面向用户的名称 */
  label: string;
  /** 缺失会影响什么（一句话） */
  impact: string;
}

export interface CompatReport {
  /** 核心能力是否齐备（不齐则整站不可用） */
  coreOk: boolean;
  coreMissing: MissingCapability[];
  /** 语音能力是否齐备（不齐只影响语音相关功能） */
  voiceOk: boolean;
  voiceMissing: MissingCapability[];
}

/** 探测是否会抛错——抛错按"不可用"计（受限内核常见） */
function safeProbe(fn: () => void): boolean {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

/** 存储可用性：隐私模式/被禁用时 setItem 会抛错，必须真写一次 */
function storageWorks(kind: 'local' | 'session'): boolean {
  return safeProbe(() => {
    const s = kind === 'local' ? window.localStorage : window.sessionStorage;
    const key = '__k_compat_probe__';
    s.setItem(key, '1');
    s.removeItem(key);
  });
}

/** WebRTC：不只看构造器在不在，真实例化一次（有的内核构造器在、new 就抛） */
function webRtcWorks(): boolean {
  if (typeof RTCPeerConnection !== 'function') return false;
  return safeProbe(() => {
    const pc = new RTCPeerConnection();
    pc.close();
  });
}

/** 音频播放/处理：AudioContext 同样真建一次 */
function audioContextWorks(): boolean {
  const Ctor =
    (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (typeof Ctor !== 'function') return false;
  return safeProbe(() => {
    const ctx = new Ctor();
    void ctx.close?.();
  });
}

function hasMediaDevices(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices === 'object' &&
    navigator.mediaDevices !== null
  );
}

/** 采集核心能力的缺失项（整站门槛） */
export function checkCoreCapabilities(): { ok: boolean; missing: MissingCapability[] } {
  const missing: MissingCapability[] = [];

  if (!storageWorks('local')) {
    missing.push({ id: 'localStorage', label: '本地存储', impact: '无法保存登录状态' });
  }
  if (!storageWorks('session')) {
    missing.push({ id: 'sessionStorage', label: '会话存储', impact: '页面间状态无法保持' });
  }
  if (typeof fetch !== 'function') {
    missing.push({ id: 'fetch', label: '网络请求 (fetch)', impact: '无法加载任何内容' });
  }
  if (typeof WebSocket !== 'function') {
    missing.push({ id: 'WebSocket', label: '长连接 (WebSocket)', impact: '实时消息不可用' });
  }
  if (typeof window.matchMedia !== 'function') {
    missing.push({ id: 'matchMedia', label: '媒体查询接口', impact: '页面布局无法正确适配屏幕' });
  }

  return { ok: missing.length === 0, missing };
}

/** 采集语音能力的缺失项（只影响语音相关功能） */
export function checkVoiceCapabilities(): { ok: boolean; missing: MissingCapability[] } {
  const missing: MissingCapability[] = [];

  if (!webRtcWorks()) {
    missing.push({ id: 'rtc', label: 'WebRTC', impact: '无法与其他成员建立语音连接' });
  }
  if (!hasMediaDevices() || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    missing.push({ id: 'getUserMedia', label: '麦克风录音', impact: '无法开麦，只能收听' });
  }
  if (!audioContextWorks()) {
    missing.push({ id: 'audioContext', label: '音频处理', impact: '无法播放房间语音' });
  }
  if (!hasMediaDevices() || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
    missing.push({ id: 'getDisplayMedia', label: '屏幕共享', impact: '无法发起/观看屏幕共享' });
  }
  if (typeof MediaRecorder !== 'function') {
    missing.push({ id: 'mediaRecorder', label: '录音', impact: '无法录制房间音频' });
  }

  return { ok: missing.length === 0, missing };
}

/** 一次性取两份报告 */
export function checkCompat(): CompatReport {
  const core = checkCoreCapabilities();
  const voice = checkVoiceCapabilities();
  return {
    coreOk: core.ok,
    coreMissing: core.missing,
    voiceOk: voice.ok,
    voiceMissing: voice.missing,
  };
}

/** 缺失项拼成一句话（提示文案用） */
export function describeMissing(missing: MissingCapability[]): string {
  return missing.map((m) => m.label).join('、');
}

/** 诊断页地址（提示里给用户，方便他截图反馈） */
export const DIAG_PATH = '/diag.html';
