/**
 * ============================================================
 * WebAudio 音频图（voice/audio/audioGraph）
 * ============================================================
 * 自 VoiceSession.ts 拆出（行为逐行不变）：
 * - 音频上下文创建（48kHz 优先）与 resume 兜底（无手势场景）
 * - 本地链：麦克风 → [RNNoise worklet] → 本地增益(麦克风音量) → 发送轨道
 * - 播放总线：各远端 gain → masterGain → 压限器 → 扬声器
 *   （多人抢话叠加超 0dB 时压峰值防炸麦）
 * - 远端 attach：每人 Source → Analyser(说话检测) & Gain(单人音量) →
 *   播放总线；隐藏 audio 元素驱动解码（Chrome WebAudio 静音 bug 兜底）
 * - RMS 说话检测轮询（100ms，含自己与远端翻转逻辑）、对端离开清理
 *
 * 说话状态门（静音/听者）与远端条目经 AudioGraphOptions 注入，
 * 不直接触碰 VoiceSession 的 mesh 结构。
 * ============================================================
 */

/** 说话检测 RMS 阈值（0-1 归一化振幅） */
const SPEAKING_THRESHOLD = 0.045;
/** 说话检测轮询间隔 */
const SPEAKING_INTERVAL_MS = 100;

/** 远端流音频节点（每人对一条） */
export interface PeerAudio {
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  gain: GainNode;
  buffer: Uint8Array<ArrayBuffer>;
  hiddenEl: HTMLAudioElement; // Chrome 下 WebAudio 静音 bug 的兜底：同时挂一个静音的 audio 元素
}

export interface AudioGraphOptions {
  /** 当前自己的 userId（joined 校正后走实时值） */
  getSelfUserId(): number;
  /** 自己是否静音（静音/听者不显示说话） */
  isSelfMuted(): boolean;
  /** 说话状态翻转回调（含自己与远端） */
  onSpeaking(userId: number, speaking: boolean): void;
  /** 说话检测轮询用远端条目（音频节点 + 静音门） */
  getSpeakingPeers(): { userId: number; audio: PeerAudio | null; muted: boolean }[];
  /** resume 兜底触发时重试播放的远端隐藏 audio 元素（自动播放策略曾拦截） */
  getHiddenAudioEls(): HTMLAudioElement[];
}

export class AudioGraph {
  /** 音频上下文（createContext 创建；48kHz 优先，个别浏览器不支持时退回默认采样率） */
  ctx: AudioContext | null = null;
  /** 本端发送轨道（mesh 每对端 addTrack 用；静音 = track.enabled 切换，无需重协商） */
  sendTrack: MediaStreamTrack | null = null;
  /** 本地麦克风增益节点（录制混音需要读它） */
  localGain: GainNode | null = null;

  private micSource: MediaStreamAudioSourceNode | null = null;
  private localAnalyser: AnalyserNode | null = null;
  private localBuffer: Uint8Array<ArrayBuffer> | null = null;
  private masterGain: GainNode | null = null;
  private masterLimiter: DynamicsCompressorNode | null = null;
  private speakTimer: number | null = null;
  private selfSpeaking = false;
  /** 会话已销毁（dispose 置位）。AudioGraph 实例随 VoiceSession 一次性使用，
   *  此标志用于拦住 dispose 之后才到达的迟到调用（如授权弹窗期间用户已退出）。 */
  private disposed = false;
  /** 远端说话状态（上轮轮询快照；翻转才回调，对端离开经 forgetPeer 清掉） */
  private peerSpeaking = new Map<number, boolean>();
  private resumeHandler: (() => void) | null = null;

  constructor(private opts: AudioGraphOptions) {}

  /**
   * 创建音频上下文：RNNoise 固定 48 kHz（480 样本/10ms 帧）；优先显式指定采样率，
   * 个别浏览器不支持时退回默认采样率（由 prepareDenoiser 检查后降级）。
   * AudioContext 需要用户手势后才能出声（点击"加入房间"即手势）；
   * 刷新自动回房等无手势场景由 resumeFallback 兜底。
   */
  createContext(): AudioContext {
    const ACtor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    let ctx: AudioContext;
    try {
      ctx = new ACtor({ sampleRate: 48000 });
    } catch {
      ctx = new ACtor();
    }
    ctx.resume().catch(() => {
      /* 已 running 时忽略 */
    });
    this.ctx = ctx;
    this.resumeFallback();
    return ctx;
  }

  /** 播放总线：masterGain → 压限器 → destination。阈值 -6dB/比率 20:1/knee 0/attack 1ms，
   *  近似 brickwall limiter——只处理多人叠加超 0dB 的瞬时峰值，正常听感不受影响（~6ms 处理延迟对语音可忽略） */
  buildMasterBus(): void {
    if (!this.ctx || this.masterGain) return;
    this.masterGain = this.ctx.createGain();
    this.masterLimiter = this.ctx.createDynamicsCompressor();
    this.masterLimiter.threshold.value = -6;
    this.masterLimiter.knee.value = 0;
    this.masterLimiter.ratio.value = 20;
    this.masterLimiter.attack.value = 0.001;
    this.masterLimiter.release.value = 0.1;
    this.masterGain.connect(this.masterLimiter);
    this.masterLimiter.connect(this.ctx.destination);
  }

  /** 本地链路: 麦克风 → 增益(麦克风音量) → 发送轨道；旁路分析器做自己的说话检测。
   *  降噪路由按当前开关由 applyLocalRouting 决定（先按直连建链，再重接）。 */
  buildLocalChain(micStream: MediaStream, micVolume: number): void {
    if (!this.ctx || !micStream) return;
    this.micSource = this.ctx.createMediaStreamSource(micStream);

    this.localGain = this.ctx.createGain();
    this.localGain.gain.value = micVolume;

    const dest = this.ctx.createMediaStreamDestination();

    this.localAnalyser = this.ctx.createAnalyser();
    this.localAnalyser.fftSize = 512;
    this.localBuffer = new Uint8Array(this.localAnalyser.fftSize);

    this.localGain.connect(dest);
    this.sendTrack = dest.stream.getAudioTracks()[0] ?? null;
  }

  /** 按当前降噪开关重接本地链路：开 → 麦克风 → RNNoise worklet → 增益/说话检测；关 → 直连。
   *  音乐模式下永远直连（RNNoise 对音乐频谱是有损压制） */
  applyLocalRouting(denoiserNode: AudioNode | null, noiseReductionOn: boolean, musicModeOn: boolean): void {
    if (!this.micSource || !this.localGain || !this.localAnalyser) return;
    // 先全断开再重接，避免重复 connect 导致音频叠加/重复目标连接
    try {
      this.micSource.disconnect();
    } catch {
      /* 未连接 */
    }
    try {
      denoiserNode?.disconnect();
    } catch {
      /* 未连接 */
    }

    if (denoiserNode && noiseReductionOn && !musicModeOn) {
      this.micSource.connect(denoiserNode);
      denoiserNode.connect(this.localGain);
      denoiserNode.connect(this.localAnalyser);
    } else {
      this.micSource.connect(this.localGain);
      this.micSource.connect(this.localAnalyser);
    }
  }

  /** 远端流接入音频图: Source → Analyser(检测) & Gain(音量) → 播放总线(压限防叠加炸麦)。
   *  返回音频节点句柄（会话层负责挂到成员条目与录制总线）；无上下文返回 null。 */
  attachPeerAudio(stream: MediaStream, volume: number): PeerAudio | null {
    if (!this.ctx) return null;
    const source = this.ctx.createMediaStreamSource(stream);
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 512;
    const gain = this.ctx.createGain();
    gain.gain.value = volume;

    source.connect(analyser);
    source.connect(gain);
    // 播放经总线压限（多人叠加 >0dB 时压峰值）；总线未建（异常时序）直连扬声器兜底
    this.buildMasterBus();
    gain.connect(this.masterGain ?? this.ctx.destination);

    // Chrome 系 bug: 远端流只接 WebAudio 会静音，需同时有 audio 元素在播放该流驱动解码。
    // 关键：不能用 muted=true（元素不拉流，WebAudio 依旧取不到数据），用 volume=0 既驱动解码又不出声
    const hiddenEl = document.createElement('audio');
    hiddenEl.srcObject = stream;
    hiddenEl.volume = 0;
    hiddenEl.play().catch(() => {
      /* 自动播放策略拦截，resumeFallback 恢复后会重试 */
    });

    return { source, analyser, gain, buffer: new Uint8Array(analyser.fftSize), hiddenEl };
  }

  /** 摘除远端音频节点（对端离开/断线清理）：断开节点 + 移除隐藏 audio 元素 */
  disposePeerAudio(audio: PeerAudio): void {
    try {
      audio.source.disconnect();
      audio.analyser.disconnect();
      audio.gain.disconnect();
    } catch {
      /* 已断开 */
    }
    audio.hiddenEl.srcObject = null;
    audio.hiddenEl.remove();
  }

  /** 麦克风音量（0-1，影响对方听到的音量；持久化由会话层负责） */
  setMicGain(volume: number): void {
    if (this.localGain) this.localGain.gain.value = volume;
  }

  /** 成员离开：按最后已知说话状态补发翻转并清除（与 removePeer 原逻辑一致） */
  forgetPeer(userId: number): void {
    if (this.peerSpeaking.get(userId)) this.opts.onSpeaking(userId, false);
    this.peerSpeaking.delete(userId);
  }

  /** 说话检测轮询（100ms）：自己（静音/听者不显示）+ 各远端（静音门 + RMS 阈值）翻转才回调 */
  startSpeakingLoop(): void {
    // dispose 之后的迟到调用（会话已销毁）：直接忽略。若放行会在已关闭的图上
    // 复活一个永不清理的轮询——teardown 只执行一次，dispose 不会再来第二次。
    if (this.disposed) return;
    this.speakTimer = window.setInterval(() => {
      // 自己
      const selfNow =
        !this.opts.isSelfMuted() &&
        !!this.localAnalyser &&
        !!this.localBuffer &&
        this.rms(this.localAnalyser, this.localBuffer) > SPEAKING_THRESHOLD;
      if (selfNow !== this.selfSpeaking) {
        this.selfSpeaking = selfNow;
        this.opts.onSpeaking(this.opts.getSelfUserId(), selfNow);
      }
      // 远端
      for (const { userId, audio, muted } of this.opts.getSpeakingPeers()) {
        const prev = this.peerSpeaking.get(userId) ?? false;
        if (!audio || muted) {
          if (prev) {
            this.peerSpeaking.set(userId, false);
            this.opts.onSpeaking(userId, false);
          }
          continue;
        }
        const now = this.rms(audio.analyser, audio.buffer) > SPEAKING_THRESHOLD;
        if (now !== prev) {
          this.peerSpeaking.set(userId, now);
          this.opts.onSpeaking(userId, now);
        }
      }
    }, SPEAKING_INTERVAL_MS);
  }

  /** 无手势建会话时 AudioContext 可能是 suspended：任意首次点击/按键时恢复出声 */
  resumeFallback(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'running') return;
    const resume = () => {
      this.detachResumeHandler();
      this.ctx?.resume().catch(() => {
        /* 忽略 */
      });
      // 自动播放策略此前可能拦掉了兜底音频元素的播放，一并重试
      for (const el of this.opts.getHiddenAudioEls()) {
        el.play().catch(() => {
          /* 仍被拦截则等下次交互 */
        });
      }
    };
    this.resumeHandler = resume;
    document.addEventListener('pointerdown', resume);
    document.addEventListener('keydown', resume);
  }

  /** 会话销毁：清理说话轮询/resume 监听/节点/上下文 */
  dispose(): void {
    this.disposed = true;
    this.detachResumeHandler();
    if (this.speakTimer) {
      clearInterval(this.speakTimer);
      this.speakTimer = null;
    }
    this.peerSpeaking.clear();
    this.sendTrack = null;
    this.localGain = null;
    this.localAnalyser = null;
    this.localBuffer = null;
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
    this.ctx?.close().catch(() => {
      /* 已关闭 */
    });
    this.ctx = null;
  }

  private detachResumeHandler(): void {
    if (!this.resumeHandler) return;
    document.removeEventListener('pointerdown', this.resumeHandler);
    document.removeEventListener('keydown', this.resumeHandler);
    this.resumeHandler = null;
  }

  private rms(analyser: AnalyserNode, buffer: Uint8Array<ArrayBuffer>): number {
    analyser.getByteTimeDomainData(buffer);
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) {
      const d = (buffer[i]! - 128) / 128;
      sum += d * d;
    }
    return Math.sqrt(sum / buffer.length);
  }
}
