/**
 * ============================================================
 * 象棋音效（voice/chess/sounds）
 * ============================================================
 * 只有**一套**音效：用户自备的四段录音（落子 mp3 / 吃子·将军·绝杀 m4a +
 * 终局 wav，见 public/chess/sounds/README.md）。
 *
 * 流程：先 fetch 原始字节（不需要手势）→ 拿到 AudioContext 后
 * decodeAudioData 成 AudioBuffer 缓存 → 经该上下文播放。
 * 终局音变体：end-win 播 win 原速；end-lose/end-draw 用降速播放造出低沉/平缓的区别。
 *
 * ★★ 为什么**删掉了**原来的"合成音效"包（2026-09-29）：
 * 曾经有两套包（classic 素材 / synth 实时合成），面板上是一个三态循环开关
 * （经典 → 合成 → 关）。结果是三次线上事故都出在这条分支上：
 *  1. 素材没就位时**静默**改播合成音 —— 用户听到的只是"声音不对"，
 *     既不知道素材没加载，也不知道自己被换成了另一套声音；
 *  2. 循环的「关 → 开」那一支写成"保持原音效包"，从合成档出发
 *     **永远回不到经典**，而偏好持久化在 localStorage（强刷不清）→
 *     用户被永久卡在合成音效上（"我浏览器还是旧音效，朋友却能听到新的，Ctrl+F5 没用"）；
 *  3. 档位只写在鼠标悬停的 title 里（手机没有悬停）→ 根本看不出自己在哪一档。
 * 结论：**备用音效本身就是坑**。现在只有用户给的那一套，素材没就位就
 * **不响**（并在控制台 + 面板上说明原因），绝不拿另一套声音顶替。
 *
 * 浏览器自动播放策略：音频上下文必须在用户手势后才能出声 ——
 * 首次 pointerdown 时预创建并 resume（capture 捕获阶段，先于页面逻辑），
 * 同时预热素材；每次播放前若仍不是 running（iOS 上还可能是 'interrupted'）
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
  if (!ctx) {
    try {
      ctx = new Ctor();
    } catch {
      return null; // 上下文数量上限/内核残缺：静默跳过（与本模块其它失败口径一致）
    }
  }
  // 判据是"不是 running"而不是"suspended"：iOS 来电/Siri 之后是 'interrupted'，
  // 那种状态下 resume 才是唯一出路，只判 suspended 会永久静音。
  if (ctx.state !== 'running') {
    void ctx.resume().catch(() => {});
  }
  return ctx;
}

export type ChessSound = 'move' | 'capture' | 'check' | 'checkmate' | 'end-win' | 'end-lose' | 'end-draw';

/** 每个音效对应的文件（decodeAudioData 与安卓 SoundPool 都原生支持，无需转码） */
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

/** 首次播放时素材没就绪：等这么久（毫秒）再放弃本次；本地素材解码只要几毫秒 */
const CLASSIC_WAIT_MS = 300;
/** 取素材失败后的重试间隔：失败**不是**终局（老实现把它当成了终局） */
const RETRY_MS = 8_000;
/** 手势预热最多试几次就收手（避免一辈子挂着 pointerdown 监听） */
const MAX_GESTURE_TRIES = 6;

// ---------- 素材：按文件缓存的字节 → 按音效缓存的解码结果 ----------

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
      console.warn(`[chess-sound] 音效素材取不到（/chess/sounds/${file}）：本次不响`, err);
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
 * 每次解码必须给它一份拷贝（`bytes.slice(0)`），否则第二次解码拿到的是空 buffer
 * （win.wav 被三个终局音共用，缺了它第二次就解不出来）。
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
      refreshLoadState();
      return buffer;
    } catch (err) {
      st.failedAt = Date.now();
      st.fails += 1;
      console.warn(`[chess-sound] 音效解码失败（${FILES[kind]}）：本次不响`, err);
      return null;
    } finally {
      st.inflight = null;
    }
  })();
  return st.inflight;
}

/** 取字节 → 解码（完整链路；两步各自去重/可重试） */
async function ensureSample(kind: ChessSound): Promise<AudioBuffer | null> {
  const bytes = await fetchBytes(FILES[kind]);
  if (!bytes) return null;
  return decodeSample(kind);
}

/** 预热素材字节：不需要手势，模块加载时就下起来（解码等有上下文之后） */
function preloadSounds(): void {
  if (typeof window === 'undefined') return;
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

/** 这个音效最近一次**真失败**的时间（取字节失败或解码失败都算；0 = 没失败过） */
function failedAtOf(kind: ChessSound): number {
  return Math.max(samples.get(kind)?.failedAt ?? 0, rawFiles.get(FILES[kind])?.failedAt ?? 0);
}

// ---------- 素材状态（面板据此提示"素材没就位"） ----------

export type SoundLoadState = 'loading' | 'ready' | 'failed';

let loadState: SoundLoadState = 'loading';
const loadListeners = new Set<(state: SoundLoadState) => void>();

export function getSoundLoadState(): SoundLoadState {
  return loadState;
}

/** 订阅素材状态变化；返回退订函数（面板用它在标题上提示 + 弹一次 toast） */
export function subscribeSoundLoad(listener: (state: SoundLoadState) => void): () => void {
  loadListeners.add(listener);
  return () => {
    loadListeners.delete(listener);
  };
}

function setLoadState(next: SoundLoadState): void {
  if (next === loadState) return;
  loadState = next;
  for (const listener of loadListeners) listener(next);
}

/** 解码成功后重算：全部就位 = ready；否则保持 loading/failed（失败的那几个还没救回来） */
function refreshLoadState(): void {
  if (ALL_SOUNDS.every((kind) => samples.get(kind)?.buffer)) setLoadState('ready');
}

// ---------- 播放 ----------

/** 播某个音效（缓冲已在手） */
function playBuffer(ac: AudioContext, buffer: AudioBuffer, kind: ChessSound): void {
  const src = ac.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = RATES[kind] ?? 1;
  const gain = ac.createGain();
  gain.gain.value = kind.startsWith('end') ? 0.8 : 1;
  src.connect(gain).connect(ac.destination);
  src.start();
}

/** 超时后放弃等待（但底层加载继续跑，下一次可能就绪） */
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

/**
 * 素材还没就绪：等一小会儿（首次落子时预热可能刚好在路上），到点再放弃。
 *
 * ★ 这里**不再回落到合成音**：宁可这一声不响，也不拿另一套声音顶替 ——
 * 那正是 09-29「web 端落子还是之前的声音」的成因。
 * 真失败（而不是"还在路上"）才把状态标成 failed，面板据此提示用户。
 */
async function playDeferred(ac: AudioContext, kind: ChessSound): Promise<void> {
  const buffer = await withTimeout(ensureSample(kind), CLASSIC_WAIT_MS);
  if (buffer && ac.state === 'running') {
    playBuffer(ac, buffer, kind);
    return;
  }
  if (failedAtOf(kind)) setLoadState('failed');
}

export function playChessSound(kind: ChessSound): void {
  const ac = ensureCtx();
  if (!ac || ac.state !== 'running') return; // 自动播放策略拦截时静默跳过
  warmDecode();
  const buffer = samples.get(kind)?.buffer;
  if (buffer) {
    playBuffer(ac, buffer, kind);
    return;
  }
  void playDeferred(ac, kind);
}

// ---------- 手势预热（建上下文 + 解码 + 失败重试） ----------

let gestureArmed = false;
let gestureTries = 0;

function onGesture(): void {
  const ac = ensureCtx();
  gestureTries += 1;
  preloadSounds();
  if (ac && ac.state === 'running') warmDecode();
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
  preloadSounds();
  armGestureWarmup();
}
