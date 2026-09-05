/**
 * ============================================================
 * 全房间混音录制器（voice/recording/roomRecorder）
 * ============================================================
 * 从 VoiceSession 抽出的录制子系统：远端各路 + 开麦时的自己 → 录制总线 →
 * 压限器 → 混音节点 →（并行）PCM 直录（AudioWorklet 音频线程采样，回退
 * ScriptProcessor）+ MediaRecorder；停止时由 mp3Encode 三档结算输出 MP3。
 *
 * 与会话的耦合面（由 VoiceSession 注入/驱动）：
 * - prepareWorklet：进房时预载 PCM 采集 worklet（与拿麦克风并行）
 * - start：传入 AudioContext、已在场成员增益、本地麦克风增益与静音态
 * - attachPeerGain：录制中途进房的成员接入混音
 * - setMutedGate：静音时自己的声音不进录制
 * - stop/dispose：退出房间时结算并释放全部节点
 */
import RecorderWorkletUrl from '../recorder/recorder-worklet.js?worker&url';
import { concatFloat32, finalizeRecording, pickRecorderMime } from './mp3Encode';

// 录音采集节点注册名
const RECORDER_WORKLET_NAME = 'k-voice-recorder';

export interface RoomRecorderStartOptions {
  roomName: string;
  audioCtx: AudioContext;
  /** 已在场成员的远端增益节点（各自连到录制总线混入） */
  peerGains: GainNode[];
  /** 自己的麦克风链路出口（localGain 已含麦克风音量） */
  localGain: GainNode | null;
  selfMuted: boolean;
}

export class RoomRecorder {
  private onChange: (isRecording: boolean, startedAt: number | null) => void;

  private ctx: AudioContext | null = null;
  /** 录制混音总线：各路 gain → 压限器 → 混音节点 → MediaRecorder */
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

  /** 已接入录制总线的增益节点（释放时逐个断开，对未连接的节点操作会抛错） */
  private attachedGains: GainNode[] = [];
  /** start 时注入的本地麦克风链路出口（dispose 时断开 recLocalGain 用） */
  private localGain: GainNode | null = null;

  constructor(onChange: (isRecording: boolean, startedAt: number | null) => void) {
    this.onChange = onChange;
  }

  /** 预载录音采集 worklet 模块（进房时与降噪预载并行；失败静默降级 ScriptProcessor） */
  prepareWorklet(ctx: AudioContext | null): Promise<void> {
    if (!this.pcmWorkletPromise) {
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

  /** 开始录制全房间混音；已在录时返回 false */
  start(opts: RoomRecorderStartOptions): boolean {
    if (this.isRecording()) return false;

    this.ctx = opts.audioCtx;
    this.localGain = opts.localGain;
    this.recRoomName = opts.roomName;
    this.recMime = pickRecorderMime();
    // 录制总线：各路混音 → 压限器 → 混音节点（多人叠加超 0dB 时压峰值，录出的 MP3 不炸）
    this.recBus = opts.audioCtx.createGain();
    this.recLimiter = opts.audioCtx.createDynamicsCompressor();
    this.recLimiter.threshold.value = -6;
    this.recLimiter.knee.value = 0;
    this.recLimiter.ratio.value = 20;
    this.recLimiter.attack.value = 0.001;
    this.recLimiter.release.value = 0.1;
    this.recDest = opts.audioCtx.createMediaStreamDestination();
    this.recBus.connect(this.recLimiter);
    this.recLimiter.connect(this.recDest);

    // 已在场成员的远端声音接入混音（录制中途进房的由 attachPeerGain 接入）
    for (const gain of opts.peerGains) {
      gain.connect(this.recBus);
      this.attachedGains.push(gain);
    }
    // 自己的麦克风：localGain 已含麦克风音量，recLocalGain 做静音门
    if (opts.localGain) {
      this.recLocalGain = opts.audioCtx.createGain();
      this.recLocalGain.gain.value = opts.selfMuted ? 0 : 1;
      opts.localGain.connect(this.recLocalGain);
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
      this.dispose();
      return false;
    }

    this.recordingStartedAt = Date.now();
    this.onChange(true, this.recordingStartedAt);
    return true;
  }

  /** 停止录制：立即恢复状态；优先用 PCM 直录数据异步编码 MP3 下载（PCM 不可用才走 MediaRecorder 解码路径） */
  stop(): void {
    // 未在录制（recorder / PCM 采集都已停止）：清理可能残留的数据并返回。
    // 关键：MediaRecorder.stop() 异步派发的最后一次 dataavailable 可能已把尾部数据
    // 写入 recChunks（见 start 中 ondataavailable），这里必须整体丢弃，杜绝“退出房间时
    // 把上一次录制的残片再次结算下载成 webm”。
    if (!this.recorder && !this.pcmProcessor) {
      this.recChunks = [];
      this.recMime = '';
      this.recRoomName = '';
      this.recordingStartedAt = null;
      this.onChange(false, null);
      return;
    }
    const rec = this.recorder;
    const chunks = this.recChunks;
    const mime = this.recMime;
    const roomName = this.recRoomName;
    const startedAt = this.recordingStartedAt ?? Date.now(); // 开始时间存在时优先，兜底防类型 null
    const sampleRate = this.ctx?.sampleRate ?? 48_000; // PCM 编码采样率（需在 ctx 关闭前读取）
    // 先取走 PCM 数据，再断开采集与混音节点（此后不再接收新样本）
    const pcm = this.collectPcm();
    this.recorder = null;
    this.recChunks = [];
    this.recordingStartedAt = null;
    this.teardownPcmCapture();
    this.dispose();
    this.onChange(false, null);

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

  getStartedAt(): number | null {
    return this.recordingStartedAt;
  }

  /** 录制中途进房的成员接入混音总线（未在录制时无害） */
  attachPeerGain(gain: GainNode): void {
    if (!this.recBus) return;
    gain.connect(this.recBus);
    this.attachedGains.push(gain);
  }

  /** 静音时自己的声音不进录制（录制 = 房间其他人实际听到的内容） */
  setMutedGate(muted: boolean): void {
    if (this.recLocalGain) this.recLocalGain.gain.value = muted ? 0 : 1;
  }

  /** 从混音流抓取原始 PCM（2 声道输入；输入缓冲会被复用，切片必须拷贝）。
   *  优先 AudioWorklet（音频渲染线程采样）；模块未就绪/不支持时回退
   *  ScriptProcessor（主线程采样，UI 卡顿会丢量子）。 */
  private setupPcmCapture(): void {
    if (!this.ctx || !this.recDest) return;
    if (this.pcmWorklet || this.pcmProcessor) return;
    const ctx = this.ctx;
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
  private dispose(): void {
    if (this.recLocalGain) {
      try { this.localGain?.disconnect(this.recLocalGain); } catch { /* 已断开 */ }
      try { this.recLocalGain.disconnect(); } catch { /* 已断开 */ }
      this.recLocalGain = null;
    }
    if (this.recBus) {
      for (const gain of this.attachedGains) {
        try { gain.disconnect(this.recBus); } catch { /* 已断开 */ }
      }
      try { this.recBus.disconnect(); } catch { /* 已断开 */ }
      this.recBus = null;
    }
    if (this.recLimiter) {
      try { this.recLimiter.disconnect(); } catch { /* 已断开 */ }
      this.recLimiter = null;
    }
    this.recDest = null;
    this.attachedGains = [];
    this.localGain = null;
  }
}
