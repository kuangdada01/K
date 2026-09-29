/**
 * ============================================================
 * 象棋音效（voice/chess/sounds）
 * ============================================================
 * 两套音效包，可切换（偏好持久化）：
 * - classic（经典）：用户自备的四段录音（落子 mp3 / 吃子·将军·绝杀 m4a +
 *   终局 wav，见 public/chess/sounds/README.md）—— 先 fetch 原始字节
 *   （不需要手势），拿到 AudioContext 后再 decodeAudioData 成 AudioBuffer 缓存，
 *   经与合成音效同一个 AudioContext 播放（解锁语义一致，零额外延迟）；
 * - synth（合成）：Web Audio 实时合成，不依赖任何资源文件。
 *
 * 终局音的变体：end-win 播 win 原速；end-lose/end-draw 用降速播放
 * 造出低沉/平缓的区别。
 *
 * ★★ 加载策略（2026-09-29 线上"web 端落子还是之前的声音"之后重写）：
 * 老实现有三处会把 classic 包**悄悄换成合成音**，而用户只会听到"声音不对"、
 * 完全不知道发生了什么 —— 线上就是这么被报上来的：
 *  1. 只在 `pointerdown`（`once: true`）里预热 → 页面在手势之前/之后拿到广播
 *     （刷新自动回房、观战、对方走子）时，缓冲区还是空的 → 当场回落合成音；
 *  2. 首次播放时缓冲没就绪就**立刻**改播合成音，而不是等那几毫秒的 fetch/decode；
 *  3. 一次失败被 `buffers.set(kind, null)` **永久记恨** —— 素材只是短暂 404
 *     （例如页面停在旧构建上、旧文件名已被删掉）就再也不重试了。
 * 现在：字节在模块加载时就下起来（按文件名去重）、手势后再解码、播放时先等
 * 一小会儿（[CLASSIC_WAIT_MS]）再兜底合成音，失败**可重试**（[RETRY_MS]），
 * 并且把"素材没就位"这件事通过 [subscribeClassicPack] 告诉面板去提示用户。
 *
 * 浏览器自动播放策略：音频上下文必须在用户手势后才能出声——
 * 首次 pointerdown 时预创建并 resume（capture 捕获阶段，先于页面逻辑），
 * 同时预热经典音效缓存；每次播放前若仍不是 running
 * （iOS 上还可能是 'interrupted'）也会尝试 resume，失败则静默跳过。
 * ============================================================
 */

let ctx: AudioContext | null = null;

function ensureCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) {
    try {
      ctx = new Ctor();
    } catch {
      return null; // 上下文数量上限/内核残缺：静默跳过（与本模块其它失败口径一致）
    }
  }
  // 判据是"不是 running"而不是"suspended"：iOS 来电/Siri 之后是 'interrupted'，
  // 那种状态下 resume 才是唯一出路，老实现只判 suspended 就永远静音了。
  if (ctx.state !== 'running') {
    void ctx.resume().catch(() => {});
  }
  return ctx;
}

export type ChessSound = 'move' | 'capture' | 'check' | 'checkmate' | 'end-win' | 'end-lose' | 'end-draw';

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
  // 切回经典包时把失败记录清掉重试一次：用户点了"经典音效"就该听到素材，
  // 而不是继承上一次（可能只是一次网络抖动）的失败。
  if (pack === 'classic') {
    for (const st of rawFiles.values()) st.failedAt = 0;
    for (const st of samples.values()) st.failedAt = 0;
    setPackState('loading');
    preloadClassic();
    armGestureWarmup();
  }
}

/**
 * classic 包里每个音效的文件。
 * · move —— 用户选定音源：Freesound "SingleKnock_Wood"（CC0）；
 * · capture / check / checkmate —— 用户自备音源（man / out / whatcan，M4A 容器，
 *   decodeAudioData 与安卓 SoundPool 都原生支持，无需转码）。
 */
const FILES: Record<ChessSound, string> = {
  move: 'move.mp3',
  capture: 'capture.m4a',
  check: 'check.m4a',
  checkmate: 'checkmate.m4a',
  'end-win': 'win.wav',
  'end-lose': 'win.wav',
  'end-draw': 'win.wav',
};

const ALL_SOUNDS = Object.keys(FILES) as ChessSound[];

/** 终局变体用降速播放造出低沉/平缓的区别 */
const RATES: Partial<Record<ChessSound, number>> = {
  'end-lose': 0.75,
  'end-draw': 0.9,
};

/** 首次播放时缓冲没就绪：等这么久（毫秒）再兜底合成音。本地素材解码只要几毫秒 */
const CLASSIC_WAIT_MS = 300;
/** 取素材失败后的重试间隔：失败**不是**终局（老实现把它当成了终局） */
const RETRY_MS = 8_000;
/** 手势预热最多试几次就收手（避免一辈子挂着 pointerdown 监听） */
const MAX_GESTURE_TRIES = 6;

// ---------- classic 包：字节缓存 → 解码缓存 ----------

/** 按**文件**缓存的原始字节（end-win/lose/draw 共用 win.wav，只下一份） */
interface FetchState {
  bytes?: ArrayBuffer;
  failedAt: number;
  fails: number;
  inflight: Promise<ArrayBuffer | null> | null;
}
const rawFiles = new Map<string, FetchState>();

/** 按**音效**缓存的解码结果 */
interface SampleState {
  buffer?: AudioBuffer;
  failedAt: number;
  fails: number;
  inflight: Promise<AudioBuffer | null> | null;
}
const samples = new Map<ChessSound, SampleState>();

function fetchState(file: string): FetchState {
  let st = rawFiles.get(file);
  if (!st) {
    st = { failedAt: 0, fails: 0, inflight: null };
    rawFiles.set(file, st);
  }
  return st;
}

function sampleState(kind: ChessSound): SampleState {
  let st = samples.get(kind);
  if (!st) {
    st = { failedAt: 0, fails: 0, inflight: null };
    samples.set(kind, st);
  }
  return st;
}

/** 拉一个音效文件的原始字节（按文件名去重；失败只记时间戳，过 [RETRY_MS] 再试） */
function fetchBytes(file: string): Promise<ArrayBuffer | null> {
  const st = fetchState(file);
  if (st.bytes) return Promise.resolve(st.bytes);
  if (st.inflight) return st.inflight;
  if (st.failedAt && Date.now() - st.failedAt < RETRY_MS) return Promise.resolve(null);
  st.inflight = (async () => {
    try {
      const res = await fetch(`/chess/sounds/${file}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = await res.arrayBuffer();
      if (bytes.byteLength === 0) throw new Error('响应为空');
      st.bytes = bytes;
      st.failedAt = 0;
      return bytes;
    } catch (err) {
      st.failedAt = Date.now();
      st.fails += 1;
      console.warn(`[chess-sound] 经典音效素材取不到（/chess/sounds/${file}）：本次回落合成音`, err);
      return null;
    } finally {
      st.inflight = null;
    }
  })();
  return st.inflight;
}

/**
 * 解码成 AudioBuffer（需要 AudioContext；没有就只留字节，等有上下文再解）。
 *
 * ⚠️ `decodeAudioData` 会**夺走（detach）**传进去的 ArrayBuffer —— 缓存的是原始字节，
 * 每次解码必须给它一份拷贝（`bytes.slice(0)`），否则第二次解码拿到的是空 buffer。
 */
function decodeSample(kind: ChessSound): Promise<AudioBuffer | null> {
  const st = sampleState(kind);
  if (st.buffer) return Promise.resolve(st.buffer);
  const ac = ctx;
  if (!ac) return Promise.resolve(null);
  if (st.inflight) return st.inflight;
  if (st.failedAt && Date.now() - st.failedAt < RETRY_MS) return Promise.resolve(null);
  st.inflight = (async () => {
    try {
      const bytes = await fetchBytes(FILES[kind]);
      if (!bytes) return null;
      const buffer = await ac.decodeAudioData(bytes.slice(0));
      st.buffer = buffer;
      st.failedAt = 0;
      refreshPackState();
      return buffer;
    } catch (err) {
      st.failedAt = Date.now();
      st.fails += 1;
      console.warn(`[chess-sound] 经典音效解码失败（${FILES[kind]}）：本次回落合成音`, err);
      return null;
    } finally {
      st.inflight = null;
    }
  })();
  return st.inflight;
}

/** 取字节 → 解码（经典的完整链路；两步各自去重/可重试） */
async function ensureSample(kind: ChessSound): Promise<AudioBuffer | null> {
  const bytes = await fetchBytes(FILES[kind]);
  if (!bytes) return null;
  return decodeSample(kind);
}

/** 预热字节：不需要手势，模块加载/切包时就下起来（解码等有上下文之后） */
function preloadClassic(): void {
  if (typeof window === 'undefined') return;
  if (getSoundPack() !== 'classic') return;
  for (const kind of ALL_SOUNDS) void ensureSample(kind);
}

/** 有上下文之后把已取到的字节解码掉（每个音效只解一次） */
function warmDecode(): void {
  if (!ctx) return;
  for (const kind of ALL_SOUNDS) {
    const st = samples.get(kind);
    if (st?.buffer) continue;
    void decodeSample(kind);
  }
}

// ---------- 素材状态（面板据此提示"经典素材没就位"） ----------

export type ClassicPackState = 'loading' | 'ready' | 'failed';

let packState: ClassicPackState = 'loading';
const packListeners = new Set<(state: ClassicPackState) => void>();

export function getClassicPackState(): ClassicPackState {
  return packState;
}

/** 订阅素材状态变化；返回退订函数（面板用它在标题上提示 + 弹一次 toast） */
export function subscribeClassicPack(listener: (state: ClassicPackState) => void): () => void {
  packListeners.add(listener);
  return () => {
    packListeners.delete(listener);
  };
}

function setPackState(next: ClassicPackState): void {
  if (next === packState) return;
  packState = next;
  for (const listener of packListeners) listener(next);
}

/** 解码成功后重算：全部就位 = ready；否则保持 loading/failed（失败的那几个还没救回来） */
function refreshPackState(): void {
  if (ALL_SOUNDS.every((kind) => samples.get(kind)?.buffer)) setPackState('ready');
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

/** 播 classic 的某个音效（缓冲已在手） */
function playBuffer(ac: AudioContext, buffer: AudioBuffer, kind: ChessSound): void {
  const src = ac.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = RATES[kind] ?? 1;
  const gain = ac.createGain();
  gain.gain.value = kind.startsWith('end') ? 0.8 : 1;
  src.connect(gain).connect(ac.destination);
  src.start();
}

/** 这个音效最近一次**真失败**的时间（取字节失败或解码失败都算；0 = 没失败过） */
function failedAtOf(kind: ChessSound): number {
  return Math.max(samples.get(kind)?.failedAt ?? 0, rawFiles.get(FILES[kind])?.failedAt ?? 0);
}

/** 缓冲还没就绪：等一小会儿（首次落子时预热可能刚好在路上），到点再兜底合成音 */
async function playClassicDeferred(ac: AudioContext, kind: ChessSound): Promise<void> {
  const buffer = await withTimeout(ensureSample(kind), CLASSIC_WAIT_MS);
  if (buffer && ac.state === 'running') {
    playBuffer(ac, buffer, kind);
    return;
  }
  // 真失败（而不是"还在路上"）才把状态标成 failed：面板据此提示用户
  if (failedAtOf(kind)) setPackState('failed');
  if (ac.state === 'running') playSynth(ac, kind); // 兜底：至少有声
}

/** 超时后放弃等待（但底层加载继续跑，下一次就绪） */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    void p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}

export function playChessSound(kind: ChessSound): void {
  const ac = ensureCtx();
  if (!ac || ac.state !== 'running') return; // 自动播放策略拦截时静默跳过
  if (getSoundPack() === 'classic') {
    warmDecode();
    const buffer = samples.get(kind)?.buffer;
    if (buffer) {
      playBuffer(ac, buffer, kind);
      return;
    }
    void playClassicDeferred(ac, kind);
    return;
  }
  playSynth(ac, kind);
}

// ---------- 手势预热（建上下文 + 解码 + 失败重试） ----------

let gestureArmed = false;
let gestureTries = 0;

function onGesture(): void {
  const ac = ensureCtx();
  gestureTries += 1;
  if (getSoundPack() === 'classic') {
    preloadClassic();
    if (ac && ac.state === 'running') warmDecode();
  }
  const allReady = ALL_SOUNDS.every((kind) => samples.get(kind)?.buffer);
  if (allReady || gestureTries >= MAX_GESTURE_TRIES) disarmGestureWarmup();
}

function armGestureWarmup(): void {
  if (typeof window === 'undefined' || gestureArmed) return;
  gestureArmed = true;
  window.addEventListener('pointerdown', onGesture, { capture: true, passive: true });
}

function disarmGestureWarmup(): void {
  if (!gestureArmed) return;
  gestureArmed = false;
  window.removeEventListener('pointerdown', onGesture, true);
}

if (typeof window !== 'undefined') {
  // 字节与手势无关，先下起来；解码等第一次手势建出上下文（避免"未获授权的 AudioContext"告警）
  preloadClassic();
  armGestureWarmup();
}
