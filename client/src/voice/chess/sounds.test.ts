/**
 * ============================================================
 * 象棋音效加载/回落单测（voice/chess/sounds.test）
 * ============================================================
 * 锁死 2026-09-29 线上那次"web 端落子还是之前的声音（App 里是用户给的音效）"：
 * classic 包**必须真的播用户给的素材**，只有素材确实到不了手时才回落合成音，
 * 而且回落要留痕（控制台 + [subscribeClassicPack] → 面板提示）。
 *
 * 覆盖：
 *  · 模块加载即按**文件名**预热（win.wav 被三个终局音共用 → 只下一次）；
 *  · 手势解码之后播放走 BufferSource（不是振荡器）；
 *  · 手势之前/素材还没解码完就响（刷新自动回房、观战）→ 等一小会儿再播素材；
 *  · 404/解码失败 → 回落合成音 + 状态 failed + 控制台留痕；
 *  · 失败**不是终局**：切回经典包会重试（老实现永久记恨）；
 *  · decodeAudioData 会 detach 传进去的字节 → 缓存必须给拷贝（win.wav 两用）；
 *  · 上下文不是 running（自动播放策略）→ 静默跳过，不炸不响。
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
  oscillators: FakeOscillator[] = [];
  /** decodeAudioData 的调用次数（验证 win.wav 被两个终局音各解一次） */
  decodeCalls = 0;

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
    this.decodeCalls += 1;
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

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  FakeAudioContext.instances = [];
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('象棋音效：classic 包真的用素材', () => {
  it('模块加载即按文件名预热（win.wav 三个终局音只下一次）', async () => {
    const { calls } = stubFetch();
    vi.stubGlobal('AudioContext', FakeAudioContext);

    await import('./sounds');
    await flush();

    expect([...calls].sort()).toEqual(SOUND_FILES.map((f) => `/chess/sounds/${f}`).sort());
  });

  it('手势解码之后：落子音走 BufferSource（素材），不走振荡器（合成音）', async () => {
    stubFetch();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const snd = await import('./sounds');

    // 首次手势：建上下文 + 解码
    window.dispatchEvent(new Event('pointerdown'));
    await flush();
    expect(snd.getClassicPackState()).toBe('ready');

    snd.playChessSound('move');
    await flush();

    const ctx = lastCtx();
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.oscillators).toHaveLength(0);
    expect(ctx.sources[0]!.buffer).toBeTruthy();
    expect(warn).not.toHaveBeenCalled();
  });

  it('还没有手势（刷新自动回房/观战）时收到走子：等解码好再播素材，而不是换成合成音', async () => {
    stubFetch();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const snd = await import('./sounds');

    // 不派发手势，直接响（服务端广播先到）
    snd.playChessSound('capture');
    await flush();

    const ctx = lastCtx();
    expect(ctx.sources, '素材在手时必须用素材').toHaveLength(1);
    expect(ctx.oscillators, '不该回落合成音').toHaveLength(0);
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
    expect(ctx.oscillators, '第二次解码失败会回落合成音 —— 说明字节缓存被 detach 了').toHaveLength(0);
  });
});

describe('象棋音效：素材到不了手时的回落（必须留痕）', () => {
  it('404：回落合成音 + 状态 failed + 控制台说明原因', async () => {
    stubFetch(['move.mp3']);
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const snd = await import('./sounds');

    snd.playChessSound('move');
    await flush();

    const ctx = lastCtx();
    expect(ctx.oscillators.length, '兜底至少要有声').toBeGreaterThan(0);
    expect(ctx.sources).toHaveLength(0);
    expect(snd.getClassicPackState()).toBe('failed');
    expect(warn).toHaveBeenCalled();
  });

  it('失败不是终局：切回经典包会重试（老实现把失败永久缓存了）', async () => {
    const calls: string[] = [];
    stubFetch(['move.mp3'], calls);
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const snd = await import('./sounds');

    snd.playChessSound('move');
    await flush();
    expect(snd.getClassicPackState()).toBe('failed');

    // 素材恢复可用了：用户点一下"经典音效"（重试 + 清失败记录）
    stubFetch([], calls);
    snd.setSoundPack('classic');
    await flush();

    // 记下重试前已经响过的合成音（上一次失败留下的），只断言"这次不再响合成音"
    const ctx = lastCtx();
    const sourcesBefore = ctx.sources.length;
    const oscillatorsBefore = ctx.oscillators.length;

    snd.playChessSound('move');
    await flush();

    expect(ctx.sources.length, '重试成功后必须播素材').toBe(sourcesBefore + 1);
    expect(ctx.oscillators.length, '不该还在响合成音').toBe(oscillatorsBefore);
    expect(snd.getClassicPackState()).toBe('ready');
  });

  it('状态变化能被订阅者拿到（面板据此提示用户）', async () => {
    stubFetch(['check.m4a']);
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const snd = await import('./sounds');

    const seen: string[] = [];
    const off = snd.subscribeClassicPack((s: string) => seen.push(s));

    snd.playChessSound('check');
    await flush();

    expect(seen).toContain('failed');
    off();
    expect(snd.getClassicPackState()).toBe('failed');
  });
});

describe('象棋音效：合成包与自动播放策略', () => {
  it('合成包：一个素材都不下，走振荡器', async () => {
    localStorage.setItem('voice:chessSoundPack', 'synth');
    const { fn } = stubFetch();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const snd = await import('./sounds');

    expect(snd.getSoundPack()).toBe('synth');
    snd.playChessSound('move');
    await flush();

    const ctx = lastCtx();
    expect(ctx.oscillators.length).toBeGreaterThan(0);
    expect(fn, '合成包不该请求素材').not.toHaveBeenCalled();
  });

  it('上下文不是 running（自动播放策略拦截）：静默跳过，既不响也不炸', async () => {
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
    expect(ctx.resume, '仍要尝试恢复（iOS 的 interrupted 也靠它）').toHaveBeenCalled();
    expect(ctx.oscillators).toHaveLength(0);
    expect(ctx.sources).toHaveLength(0);
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
