/**
 * ============================================================
 * 象棋音效（voice/chess/sounds）
 * ============================================================
 * 两套音效包，可切换（偏好持久化）：
 * - classic（经典）：真实录音 wav（MIT，来源 ChessBook，
 *   见 public/chess/sounds/README.md）—— fetch + decodeAudioData
 *   预解码为 AudioBuffer 缓存，经与合成音效同一个 AudioContext 播放
 *   （解锁语义一致，零额外延迟）；
 * - synth（合成）：Web Audio 实时合成，不依赖任何资源文件。
 *
 * 终局音的变体：end-win 播 win 原速；end-lose/end-draw 用降速播放
 * 造出低沉/平缓的区别。
 *
 * 浏览器自动播放策略：音频上下文必须在用户手势后才能出声——
 * 首次 pointerdown 时预创建并 resume（capture 捕获阶段，先于页面逻辑），
 * 同时预热经典音效缓存并预解锁语音合成；每次播放前若仍 suspended
 * 也会尝试 resume，失败则静默跳过。
 * ============================================================
 */

let ctx: AudioContext | null = null;

function ensureCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) ctx = new Ctor();
  if (ctx.state === 'suspended') {
    void ctx.resume().catch(() => {});
  }
  return ctx;
}

export type ChessSound = 'move' | 'capture' | 'check' | 'end-win' | 'end-lose' | 'end-draw';

// ---------- 音效包选择（偏好持久化） ----------

export type ChessSoundPack = 'classic' | 'synth';

const PACK_KEY = 'voice:chessSoundPack';

export const SOUND_PACKS: { id: ChessSoundPack; label: string }[] = [
  { id: 'classic', label: '经典音效' },
  { id: 'synth', label: '合成音效' },
];

export function getSoundPack(): ChessSoundPack {
  return localStorage.getItem(PACK_KEY) === 'synth' ? 'synth' : 'classic';
}

export function setSoundPack(pack: ChessSoundPack): void {
  localStorage.setItem(PACK_KEY, pack);
}

/** classic 包里每个音效的 wav 文件 */
const FILES: Record<ChessSound, string> = {
  move: 'move.wav',
  capture: 'capture.wav',
  check: 'check.wav',
  'end-win': 'win.wav',
  'end-lose': 'win.wav',
  'end-draw': 'win.wav',
};

/** 终局变体用降速播放造出低沉/平缓的区别 */
const RATES: Partial<Record<ChessSound, number>> = {
  'end-lose': 0.75,
  'end-draw': 0.9,
};

// ---------- classic 包：wav 预解码缓存 ----------

const buffers = new Map<ChessSound, AudioBuffer | null>();

async function loadBuffer(ac: AudioContext, kind: ChessSound): Promise<AudioBuffer | null> {
  const cached = buffers.get(kind);
  if (cached !== undefined) return cached;
  try {
    const res = await fetch(`/chess/sounds/${FILES[kind]}`);
    if (!res.ok) throw new Error(String(res.status));
    const buf = await ac.decodeAudioData(await res.arrayBuffer());
    buffers.set(kind, buf);
    return buf;
  } catch {
    buffers.set(kind, null); // 失败标记：不再重复请求，回落合成
    return null;
  }
}

/** 首次手势时预热 classic 包缓存（后台进行，不阻塞交互） */
function warmBuffers(): void {
  const ac = ensureCtx();
  if (!ac) return;
  for (const kind of Object.keys(FILES) as ChessSound[]) {
    if (!buffers.has(kind)) void loadBuffer(ac, kind);
  }
}

// ---------- synth 包：Web Audio 实时合成 ----------

/** 单音：at（秒，相对当前时间轴）起振，freq 可滑向 slideTo，指数衰减包络 */
function tone(
  ac: AudioContext,
  at: number,
  freq: number,
  dur: number,
  vol: number,
  type: OscillatorType = 'sine',
  slideTo?: number
): void {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, at + dur);
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(vol, at + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(gain).connect(ac.destination);
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

/** 木鱼式敲击：主音快速下滑 + 高频瞬态 */
function knock(ac: AudioContext, at: number, freq = 190, dur = 0.09, vol = 0.5): void {
  tone(ac, at, freq, dur, vol, 'sine', freq * 0.55);
  tone(ac, at, freq * 2.7, 0.02, vol * 0.25, 'triangle');
}

function playSynth(ac: AudioContext, kind: ChessSound): void {
  const t = ac.currentTime + 0.02;
  switch (kind) {
    case 'move':
      knock(ac, t);
      break;
    case 'capture':
      knock(ac, t, 210, 0.08, 0.55);
      knock(ac, t + 0.07, 150, 0.1, 0.45);
      break;
    case 'check':
      knock(ac, t, 190, 0.07, 0.4);
      tone(ac, t + 0.1, 784, 0.1, 0.22, 'triangle');
      tone(ac, t + 0.21, 988, 0.12, 0.22, 'triangle');
      break;
    case 'end-win':
      [523, 659, 784, 1047].forEach((f, i) => tone(ac, t + i * 0.13, f, 0.16, 0.25, 'triangle'));
      break;
    case 'end-lose':
      [523, 440, 349, 262].forEach((f, i) => tone(ac, t + i * 0.15, f, 0.18, 0.2, 'sine'));
      break;
    case 'end-draw':
      tone(ac, t, 523, 0.15, 0.22, 'triangle');
      tone(ac, t + 0.18, 523, 0.2, 0.18, 'triangle');
      break;
  }
}

// ---------- 对外入口 ----------

export function playChessSound(kind: ChessSound): void {
  const ac = ensureCtx();
  if (!ac || ac.state !== 'running') return; // 自动播放策略拦截时静默跳过
  if (getSoundPack() === 'classic') {
    const buf = buffers.get(kind);
    if (buf) {
      const src = ac.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = RATES[kind] ?? 1;
      const gain = ac.createGain();
      gain.gain.value = kind.startsWith('end') ? 0.8 : 1;
      src.connect(gain).connect(ac.destination);
      src.start();
      return;
    }
    void loadBuffer(ac, kind); // 缓存未就绪：异步加载，本次回落合成
  }
  playSynth(ac, kind);
}

/**
 * 预解锁语音合成（移动端 iOS/安卓要求首次 speak 发生在用户手势内，
 * 否则之后的程序化播报会被静默拦截）；空文本 + 0 音量，听不见。
 */
function primeSpeechSynthesis(): void {
  try {
    const synth = window.speechSynthesis;
    if (!synth || typeof SpeechSynthesisUtterance !== 'function') return;
    const utter = new SpeechSynthesisUtterance(' ');
    utter.volume = 0;
    synth.speak(utter);
  } catch {
    /* 残缺内核静默跳过（判据与 useChatTTS 一致） */
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener(
    'pointerdown',
    () => {
      void ensureCtx();
      warmBuffers();
      primeSpeechSynthesis();
    },
    { capture: true, once: true, passive: true }
  );
}
