/**
 * ============================================================
 * WebAudio 音频图单测（voice/audio/audioGraph.test）
 * ============================================================
 * jsdom 无 AudioContext：注入 FakeAudioContext 验证——
 * 上下文创建与 resume 兜底、播放总线/本地链/降噪路由的节点接线、
 * 远端 attach 与隐藏元素、RMS 说话检测轮询的翻转逻辑（含静音门/
 * 离开清理）、会话级清理。getByteTimeDomainData 用可配置内容填充，
 * 以驱动 Rms 阈值判定（128=静音，200≈0.56 RMS > 0.045）。
 * ============================================================
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioGraph, type AudioGraphOptions, type PeerAudio } from './audioGraph';

class FakeParam {
  value = 0;
}

class FakeNode {
  connects: unknown[] = [];
  disconnects = 0;
  fftSize = 512;
  /** getByteTimeDomainData 填充值（128=静音；>128 有能量） */
  content = 128;
  stream = { getAudioTracks: () => [{}] };
  connect(target: unknown): void {
    this.connects.push(target);
  }
  disconnect(): void {
    this.disconnects++;
  }
  getByteTimeDomainData(buffer: Uint8Array): void {
    for (let i = 0; i < buffer.length; i++) buffer[i] = this.content;
  }
}

class FakeGainNode extends FakeNode {
  gain = new FakeParam();
}

class FakeCompressorNode extends FakeNode {
  threshold = new FakeParam();
  knee = new FakeParam();
  ratio = new FakeParam();
  attack = new FakeParam();
  release = new FakeParam();
}

class FakeAudioContext {
  state: AudioContextState = 'suspended';
  destination = new FakeNode();
  sampleRate = 48000;
  resume = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          this.state = 'running';
          resolve();
        }, 0);
      })
  );
  close = vi.fn(async () => {});
  createGain = vi.fn(() => new FakeGainNode());
  createDynamicsCompressor = vi.fn(() => new FakeCompressorNode());
  createAnalyser = vi.fn(() => new FakeNode());
  createMediaStreamDestination = vi.fn(() => new FakeNode());
  createMediaStreamSource = vi.fn(() => new FakeNode());
}

interface SpeakingPeer {
  userId: number;
  audio: PeerAudio | null;
  muted: boolean;
}

/** 用 fake 分析器构造 PeerAudio（说话检测轮询只读 analyser/buffer） */
function fakePeerAudio(analyser: FakeNode): PeerAudio {
  return {
    source: {} as MediaStreamAudioSourceNode,
    analyser: analyser as unknown as AnalyserNode,
    gain: {} as GainNode,
    buffer: new Uint8Array(analyser.fftSize),
    hiddenEl: document.createElement('audio'),
  };
}

describe('AudioGraph', () => {
  let ctx: FakeAudioContext;
  let speakingPeers: SpeakingPeer[];
  let hiddenEls: HTMLAudioElement[];
  let calls: string[];
  let opts: AudioGraphOptions;
  let g: AudioGraph;

  const SELF_ID = 7;

  /** 新建图并创建上下文（AudioContext 全局 stub 每次 new 出独立实例，以返回值断言） */
  function createGraph(): FakeAudioContext {
    g = new AudioGraph(opts);
    ctx = g.createContext() as unknown as FakeAudioContext;
    return ctx;
  }

  beforeEach(() => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    // jsdom 未实现 HTMLMediaElement.play：测试里恒成功
    Object.defineProperty(HTMLMediaElement.prototype, 'play', {
      configurable: true,
      writable: true,
      value: vi.fn(async () => {}),
    });
    speakingPeers = [];
    hiddenEls = [];
    calls = [];
    opts = {
      getSelfUserId: () => SELF_ID,
      isSelfMuted: () => false,
      onSpeaking: (userId, speaking) => calls.push(`${userId}:${speaking}`),
      getSpeakingPeers: () =>
        speakingPeers.map((p) => ({ userId: p.userId, audio: p.audio, muted: p.muted })),
      getHiddenAudioEls: () => hiddenEls,
    };
    g = new AudioGraph(opts);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('createContext：48kHz 创建 + resume；suspended 时挂 resume 兜底监听', () => {
    const c = createGraph();
    expect(c.sampleRate).toBe(48000);
    expect(c.resume).toHaveBeenCalled();

    // suspended → 兜底监听已挂；初次 pointerdown 触发 resume + 隐藏元素重播并自卸
    const el = document.createElement('audio');
    hiddenEls.push(el);
    document.dispatchEvent(new Event('pointerdown'));
    expect(c.resume).toHaveBeenCalledTimes(2);
    expect(el.play).toHaveBeenCalled();
    document.dispatchEvent(new Event('pointerdown'));
    expect(c.resume).toHaveBeenCalledTimes(2); // 已卸监听，不再重复
  });

  it('createContext：已 running 时不再挂兜底监听', () => {
    vi.stubGlobal(
      'AudioContext',
      class extends FakeAudioContext {
        state: AudioContextState = 'running';
        resume = vi.fn(() => Promise.resolve());
      }
    );
    g = new AudioGraph(opts);
    g.createContext();
    document.dispatchEvent(new Event('pointerdown'));
    // resume 仅创建时那一次（创建无条件 resume 与历史一致）；pointerdown 无兜底监听
    expect((g.ctx as unknown as FakeAudioContext).resume).toHaveBeenCalledTimes(1);
  });

  it('buildMasterBus：masterGain → 压限器 → destination（压限参数固定）', () => {
    createGraph();
    g.buildMasterBus();
    const gain = ctx.createGain.mock.results[0]!.value as FakeGainNode;
    const limiter = ctx.createDynamicsCompressor.mock.results[0]!.value as FakeCompressorNode;
    expect(limiter.threshold.value).toBe(-6);
    expect(limiter.knee.value).toBe(0);
    expect(limiter.ratio.value).toBe(20);
    expect(limiter.attack.value).toBe(0.001);
    expect(limiter.release.value).toBe(0.1);
    expect(gain.connects).toContain(limiter);
    expect(limiter.connects).toContain(ctx.destination);
    // 幂等
    g.buildMasterBus();
    expect(ctx.createGain).toHaveBeenCalledTimes(1);
  });

  it('buildLocalChain + 直连路由：源 → 增益(音量) → 发送轨道 + 旁路说话分析器', () => {
    createGraph();
    g.buildMasterBus();
    const micStream = {} as MediaStream;
    g.buildLocalChain(micStream, 0.8);
    g.applyLocalRouting(null, false, false); // 直连路由（会话层在建链后按开关调用）
    const source = ctx.createMediaStreamSource.mock.results[0]!.value as FakeNode;
    // createGain 第 1 次 = masterGain，第 2 次 = 本地增益
    const gain = ctx.createGain.mock.results[1]!.value as FakeGainNode;
    const analyser = ctx.createAnalyser.mock.results[0]!.value as FakeNode;
    expect(gain.gain.value).toBe(0.8);
    expect(analyser.fftSize).toBe(512);
    expect(g.sendTrack).not.toBeNull();
    // 直连：源 → 增益 与 源 → 分析器
    expect(source.connects).toContain(gain);
    expect(source.connects).toContain(analyser);
  });

  it('applyLocalRouting：开降噪时源 → worklet → 增益/分析器（worklet 先断开再重接）', () => {
    createGraph();
    g.buildLocalChain({} as MediaStream, 1);
    const source = ctx.createMediaStreamSource.mock.results[0]!.value as FakeNode;
    const gain = ctx.createGain.mock.results[0]!.value as FakeGainNode;
    const analyser = ctx.createAnalyser.mock.results[0]!.value as FakeNode;
    const worklet = { connect: vi.fn(), disconnect: vi.fn() } as unknown as AudioNode;
    g.applyLocalRouting(worklet, true, false);
    expect(source.connects).toContain(worklet);
    expect(worklet.connect).toHaveBeenCalledWith(gain);
    expect(worklet.connect).toHaveBeenCalledWith(analyser);
    expect(worklet.disconnect).toHaveBeenCalledTimes(1);
  });

  it('attachPeerAudio：源 → 分析器&增益 → 总线；隐藏 audio 元素驱动解码；返回句柄', () => {
    createGraph();
    g.buildMasterBus();
    const peer = g.attachPeerAudio({} as MediaStream, 0.5)!;
    expect(peer).not.toBeNull();
    expect(peer.gain.gain.value).toBe(0.5);
    expect(peer.analyser.fftSize).toBe(512);
    const source = ctx.createMediaStreamSource.mock.results[0]!.value as FakeNode;
    const masterGain = ctx.createGain.mock.results[0]!.value as FakeGainNode;
    expect(source.connects).toContain(peer.analyser);
    expect(source.connects).toContain(peer.gain);
    expect((peer.gain as unknown as FakeNode).connects).toContain(masterGain);
    expect(peer.hiddenEl).toBeInstanceOf(HTMLAudioElement);
    expect(peer.hiddenEl.play).toHaveBeenCalled();
    expect(peer.hiddenEl.volume).toBe(0);
  });

  it('attachPeerAudio：无上下文（异常时序）返回 null', () => {
    expect(g.attachPeerAudio({} as MediaStream, 1)).toBeNull();
  });

  it('disposePeerAudio：断开节点并移除隐藏元素', () => {
    createGraph();
    const peer = g.attachPeerAudio({} as MediaStream, 1)!;
    const el = peer.hiddenEl;
    expect(el.isConnected).toBe(false); // 未挂 DOM
    document.body.appendChild(el);
    expect(el.isConnected).toBe(true);
    g.disposePeerAudio(peer);
    // 真实节点类型是 fake，断言断开计数
    const source = peer.source as unknown as FakeNode;
    const analyser = peer.analyser as unknown as FakeNode;
    const gain = peer.gain as unknown as FakeNode;
    expect(source.disconnects).toBe(1);
    expect(analyser.disconnects).toBe(1);
    expect(gain.disconnects).toBe(1);
    expect(el.isConnected).toBe(false);
  });

  it('setMicGain：更新本地增益', () => {
    createGraph();
    g.buildLocalChain({} as MediaStream, 1);
    g.setMicGain(0.3);
    const gain = ctx.createGain.mock.results[0]!.value as FakeGainNode;
    expect(gain.gain.value).toBe(0.3);
  });

  describe('说话检测轮询', () => {
    function localAnalyser(): FakeNode {
      return ctx.createAnalyser.mock.results[0]!.value as FakeNode;
    }

    it('自己：静音时不触发；有能量时翻转；回静音再翻转', () => {
      createGraph();
      g.buildLocalChain({} as MediaStream, 1);
      g.startSpeakingLoop();
      const analyser = localAnalyser();
      vi.advanceTimersByTime(100);
      expect(calls).toEqual([]); // 静音（content=128）不触发

      analyser.content = 200; // ~0.56 RMS
      vi.advanceTimersByTime(100);
      expect(calls).toEqual([`${SELF_ID}:true`]);

      analyser.content = 128;
      vi.advanceTimersByTime(100);
      expect(calls).toEqual([`${SELF_ID}:true`, `${SELF_ID}:false`]);
    });

    it('自己：静音门（isSelfMuted）压住说话指示', () => {
      opts.isSelfMuted = () => true;
      createGraph();
      g.buildLocalChain({} as MediaStream, 1);
      g.startSpeakingLoop();
      localAnalyser().content = 200;
      vi.advanceTimersByTime(100);
      expect(calls).toEqual([]);
    });

    it('远端：能量翻转回调、静音门强制复位、重复值不回调', () => {
      g.createContext();
      const analyser = new FakeNode();
      const peer: SpeakingPeer = {
        userId: 5,
        audio: fakePeerAudio(analyser),
        muted: false,
      };
      speakingPeers.push(peer);
      g.startSpeakingLoop();

      vi.advanceTimersByTime(100);
      expect(calls).toEqual([]); // 静音不触发

      analyser.content = 200;
      vi.advanceTimersByTime(100);
      expect(calls).toEqual(['5:true']);

      vi.advanceTimersByTime(100); // 持续说话不再重复回调
      expect(calls).toEqual(['5:true']);

      peer.muted = true; // 静音门
      vi.advanceTimersByTime(100);
      expect(calls).toEqual(['5:true', '5:false']);

      vi.advanceTimersByTime(100); // 已复位不再重复
      expect(calls).toEqual(['5:true', '5:false']);
    });

    it('远端：无音频节点（异常时序）视为静音', () => {
      g.createContext();
      speakingPeers.push({ userId: 5, audio: null, muted: false });
      g.startSpeakingLoop();
      vi.advanceTimersByTime(100);
      expect(calls).toEqual([]);
    });

    it('forgetPeer：按最后已知状态补发翻转并清除（成员离开）', () => {
      g.createContext();
      const analyser = new FakeNode();
      speakingPeers.push({ userId: 5, audio: fakePeerAudio(analyser), muted: false });
      g.startSpeakingLoop();
      analyser.content = 200;
      vi.advanceTimersByTime(100);
      expect(calls).toEqual(['5:true']);

      speakingPeers.length = 0;
      g.forgetPeer(5);
      expect(calls).toEqual(['5:true', '5:false']);
      g.forgetPeer(5);
      expect(calls).toEqual(['5:true', '5:false']); // 已清除不再补发
    });
  });

  it('dispose：说话轮询与兜底监听清理、节点断开、上下文关闭', () => {
    createGraph();
    g.buildMasterBus();
    g.buildLocalChain({} as MediaStream, 1);
    g.attachPeerAudio({} as MediaStream, 1);
    g.startSpeakingLoop();
    g.dispose();

    expect(ctx.close).toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(calls).toEqual([]); // 轮询已停
    document.dispatchEvent(new Event('pointerdown'));
    expect(ctx.resume).toHaveBeenCalledTimes(1); // 兜底监听已卸
    expect(g.ctx).toBeNull();
    expect(g.sendTrack).toBeNull();
    expect(g.localGain).toBeNull();
    // 本地源与总线节点已断开
    const source = ctx.createMediaStreamSource.mock.results[0]!.value as FakeNode;
    const masterGain = ctx.createGain.mock.results[0]!.value as FakeGainNode;
    const limiter = ctx.createDynamicsCompressor.mock.results[0]!.value as FakeCompressorNode;
    expect(source.disconnects).toBeGreaterThan(0);
    expect(masterGain.disconnects).toBe(1);
    expect(limiter.disconnects).toBe(1);
  });
});
