/**
 * ============================================================
 * 象棋音效加载与播放单测（voice/chess/sounds.test）
 * ============================================================
 * 现在是**一套**音效（用户给的四个素材），没有备用包。这里钉住的都是
 * 09-29 线上两次事故的成因：
 *  · 素材没就位时**绝不拿另一套声音顶替**（老实现静默回落到合成音，
 *    用户听到的只是"声音不对"，还以为"音效没生效"）；
 *  · 失败**可以重试**（老实现把失败永久缓存，页面停在旧构建上就再也不试）；
 *  · 模块加载即按文件名预热（老实现只等 pointerdown，刷新自动回房/观战
 *    在手势之前收到广播时缓冲还是空的）。
 *
 * 覆盖：预热去重 · 素材优先（BufferSource）· 未就绪时的等待窗口 ·
 * 失败＝不响＋状态 failed＋控制台留痕 · 过重试窗口会再试 ·
 * decodeAudioData 的 detach 回归（win.wav 三用）· 上下文未 running / 不可用。
 * ============================================================
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------- Web Audio 替身 ----------------

class FakeParam {
  value = 0;
  setValueAtTime = vi.fn();
  linearRampToValueAtTime = vi.fn();
  exponentialRampToValueAtTime = vi.fn();
}

class FakeGainNode {
  gain = new FakeParam();
  connect = vi.fn((target: unknown) => target);
  disconnect = vi.fn();
}

class FakeBufferSource {
  buffer: unknown = null;
  playbackRate = new FakeParam();
  connect = vi.fn((target: unknown) => target);
  start = vi.fn();
  stop = vi.fn();
}

class FakeOscillator {
  type = 'sine';
  frequency = new FakeParam();
  connect = vi.fn((target: unknown) => target);
  start = vi.fn();
  stop = vi.fn();
}

/** 假的 AudioBuffer（播放侧只把它塞进 src.buffer） */
function fakeAudioBuffer(): AudioBuffer {
  return { duration: 1, sampleRate: 48000, numberOfChannels: 2 } as unknown as AudioBuffer;
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];

  state: AudioContextState;
  currentTime = 0;
  destination = { name: 'destination' };
  sources: FakeBufferSource[] = [];
  /** 合成音的"振荡器"：本模块**不该**再产出任何振荡器（备用音效已删除） */
  oscillators: FakeOscillator[] = [];

  constructor(initial: AudioContextState = 'running') {
    this.state = initial;
    FakeAudioContext.instances.push(this);
  }

  resume = vi.fn(async () => {
    this.state = 'running';
  });
  close = vi.fn(async () => {});
  createGain = vi.fn(() => new FakeGainNode());
  createBufferSource = vi.fn(() => {
    const node = new FakeBufferSource();
    this.sources.push(node);
    return node;
  });
  createOscillator = vi.fn(() => {
    const node = new FakeOscillator();
    this.oscillators.push(node);
    return node;
  });
  /**
   * 真实 Chrome 的 decodeAudioData 会**夺走**传进去的 ArrayBuffer（transfer），
   * 这里照样模拟；空 buffer 直接失败（缺 slice(0) 的实现会在这里露馅）。
   */
  decodeAudioData = vi.fn(async (bytes: ArrayBuffer) => {
    if (bytes.byteLength === 0) throw new Error('Decoding failed: empty buffer');
    structuredClone(bytes, { transfer: [bytes] });
    return fakeAudioBuffer();
  });
}

// ---------------- fetch 替身 ----------------

const SOUND_FILES = ['move.mp3', 'capture.m4a', 'check.m4a', 'checkmate.m4a', 'win.wav'];

function okResponse(size = 64): unknown {
  return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(size) };
}

function notFound(): unknown {
  return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
}

/** 记录请求路径的 fetch 替身；missing 里的文件返回 404 */
function stubFetch(missing: string[] = [], calls: string[] = []) {
  const fn = vi.fn(async (url: string) => {
    calls.push(url);
    const file = url.split('/').pop() ?? '';
    return missing.includes(file) ? notFound() : okResponse();
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

/** 取最新一个 fake 上下文（模块内是单例，重置模块后是新的） */
function lastCtx(): FakeAudioContext {
  return FakeAudioContext.instances[FakeAudioContext.instances.length - 1]!;
}

/** 冲干净的微任务队列：让预热/解码/等待链跑完 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

let warn: ReturnType<typeof vi.spyOn>;
/** 可控时钟：用来越过 RETRY_MS 的重试窗口 */
let now = 0;

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  FakeAudioContext.instances = [];
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  now = 1_800_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});

afterEach(() => {
  warn.mockRestore();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('象棋音效：素材加载', () => {
  it('模块加载即按文件名预热（win.wav 被三个终局音共用 → 只下一次）', async () => {
    const { calls } = stubFetch();
    vi.stubGlobal('AudioContext', FakeAudioContext);

    await import('./sounds');
    await flush();

    expect([...calls].sort()).toEqual(SOUND_FILES.map((f) => `/chess/sounds/${f}`).sort());
  });

  it('手势解码之后：落子音走 BufferSource（素材）', async () => {
    stubFetch();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const snd = await import('./sounds');

    window.dispatchEvent(new Event('pointerdown'));
    await flush();
    expect(snd.getSoundLoadState()).toBe('ready');

    snd.playChessSound('move');
    await flush();

    const ctx = lastCtx();
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.sources[0]!.buffer).toBeTruthy();
    expect(ctx.oscillators, '备用音效已删除，不该再出现振荡器').toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('还没有手势（刷新自动回房/观战）时收到走子：等解码好再播素材', async () => {
    stubFetch();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const snd = await import('./sounds');

    // 不派发手势，直接响（服务端广播先到）
    snd.playChessSound('capture');
    await flush();

    expect(lastCtx().sources, '素材在手时必须用素材').toHaveLength(1);
    expect(lastCtx().oscillators).toHaveLength(0);
  });

  it('终局变体按倍率播放（end-lose = 0.75 倍速）', async () => {
    stubFetch();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const snd = await import('./sounds');

    window.dispatchEvent(new Event('pointerdown'));
    await flush();

    snd.playChessSound('end-lose');
    await flush();
    expect(lastCtx().sources[0]!.playbackRate.value).toBe(0.75);
  });

  it('win.wav 被三个终局音共用：解码拿到的必须是拷贝（缓存不能被 detach 掉）', async () => {
    stubFetch();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const snd = await import('./sounds');

    window.dispatchEvent(new Event('pointerdown'));
    await flush();

    snd.playChessSound('end-win');
    snd.playChessSound('end-lose');
    await flush();

    const ctx = lastCtx();
    expect(ctx.sources, '两个终局音都要响').toHaveLength(2);
    expect(warn, '第二次解码失败会打警告 —— 说明字节缓存被 detach 了').not.toHaveBeenCalled();
  });
});

describe('象棋音效：素材到不了手时不响（且留痕）', () => {
  it('404：一声都不响（不拿别的音效顶替）+ 状态 failed + 控制台说明原因', async () => {
    stubFetch(['move.mp3']);
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const snd = await import('./sounds');

    snd.playChessSound('move');
    await flush();

    const ctx = lastCtx();
    expect(ctx.sources, '没有素材就不响（旧的合成音已删除）').toHaveLength(0);
    expect(ctx.oscillators).toHaveLength(0);
    expect(snd.getSoundLoadState()).toBe('failed');
    expect(warn).toHaveBeenCalled();
  });

  it('失败不是终局：过了重试窗口会重新取素材，成功后照常播', async () => {
    const calls: string[] = [];
    stubFetch(['move.mp3'], calls);
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const snd = await import('./sounds');

    window.dispatchEvent(new Event('pointerdown'));
    await flush();
    snd.playChessSound('move');
    await flush();
    expect(snd.getSoundLoadState()).toBe('failed');
    const attemptsBefore = calls.filter((c) => c.endsWith('move.mp3')).length;

    // 素材恢复可用了 + 越过 RETRY_MS：下一次播放会重新尝试
    stubFetch([], calls);
    now += 9_000;
    snd.playChessSound('move');
    await flush();

    const ctx = lastCtx();
    expect(calls.filter((c) => c.endsWith('move.mp3')).length).toBeGreaterThan(attemptsBefore);
    expect(ctx.sources, '重试成功后必须播素材').toHaveLength(1);
    expect(snd.getSoundLoadState()).toBe('ready');
  });

  it('状态变化能被订阅者拿到（面板据此提示用户）', async () => {
    stubFetch(['check.m4a']);
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const snd = await import('./sounds');

    const seen: string[] = [];
    const off = snd.subscribeSoundLoad((s: string) => seen.push(s));

    snd.playChessSound('check');
    await flush();

    expect(seen).toContain('failed');
    off();
    expect(snd.getSoundLoadState()).toBe('failed');
  });
});

describe('象棋音效：自动播放策略与残缺内核', () => {
  it('上下文不是 running：静默跳过，既不响也不炸（仍会尝试 resume）', async () => {
    stubFetch();
    class SuspendedContext extends FakeAudioContext {
      constructor() {
        super('suspended');
      }
      override resume = vi.fn(async () => {
        /* 仍然被拦截 */
      });
    }
    vi.stubGlobal('AudioContext', SuspendedContext);
    const snd = await import('./sounds');

    const before = FakeAudioContext.instances.length;
    expect(() => snd.playChessSound('move')).not.toThrow();
    await flush();

    const ctx = lastCtx();
    expect(FakeAudioContext.instances.length).toBe(before + 1);
    expect(ctx.resume, '仍要尝试恢复（iOS 的 interrupted 也靠它）').toBeDefined();
    expect(ctx.resume).toHaveBeenCalled();
    expect(ctx.sources).toHaveLength(0);
    expect(ctx.oscillators).toHaveLength(0);
  });

  it('音频上下文无法创建（内核残缺/数量上限）：静默跳过', async () => {
    stubFetch();
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          throw new Error('too many AudioContexts');
        }
      }
    );
    const snd = await import('./sounds');
    expect(() => snd.playChessSound('move')).not.toThrow();
    await flush();
  });
});
