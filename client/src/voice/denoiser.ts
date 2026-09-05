/**
 * ============================================================
 * RNNoise 降噪控制器（voice/denoiser）
 * ============================================================
 * 从 VoiceSession 抽出的降噪节点生命周期：worklet 模块预载（与取麦克风并行）、
 * 节点创建/销毁、可用性判定。链路接线（applyLocalRouting）留在会话类，
 * 因为它同时编排麦克风源、说话检测分析器与增益节点。
 * RNNoise 语音降噪（WASM 内嵌的单文件 AudioWorklet，经 Vite 打包为独立 ES bundle）：
 * vendor 于 src/voice/rnnoise/（含 VAD 门控能量恢复，保证"开降噪后与不开人声大小一致"）
 */
import NoiseSuppressorWorkletUrl from './rnnoise/noise-suppressor-worklet.js?worker&url';

// 本地降噪节点注册名
const DENOISER_WORKLET_NAME = 'k-voice-denoiser';

export class Denoiser {
  private node: AudioWorkletNode | null = null;
  private moduleOk = false;
  private modulePromise: Promise<void> | null = null;

  /** 当前降噪节点（null = 未创建/已销毁/不可用） */
  getNode(): AudioWorkletNode | null {
    return this.node;
  }

  /** 预载降噪 worklet 模块（与取麦克风并行；失败静默降级为浏览器 NS/纯直连） */
  prepare(ctx: AudioContext | null): Promise<void> {
    if (!this.modulePromise) {
      // RNNoise 以 48 kHz/480 样本帧训练；采样率不匹配时直接降级，避免错误频谱
      if (!ctx?.audioWorklet || ctx.sampleRate !== 48000) {
        this.modulePromise = Promise.resolve();
        return this.modulePromise;
      }
      this.modulePromise = ctx.audioWorklet
        .addModule(NoiseSuppressorWorkletUrl)
        .then(() => { this.moduleOk = true; })
        .catch(() => { /* 不支持/加载失败：降级为浏览器 NS + 直连 */ });
    }
    return this.modulePromise;
  }

  /** worklet 就绪后创建降噪节点（RNNoise 单声道处理，双声道输入由 AudioContext 自动下混） */
  init(ctx: AudioContext | null, micStream: MediaStream | null): void {
    if (!ctx?.audioWorklet || !micStream || !this.moduleOk) return;
    if (this.node) return;
    try {
      this.node = new AudioWorkletNode(ctx, DENOISER_WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
      });
    } catch {
      this.node = null; // 个别环境创建失败：降级为浏览器 NS + 直连
    }
  }

  /** 销毁降噪节点（切换开关时重建，保证 RNNoise 内部状态/环形缓冲全新） */
  dispose(): void {
    if (!this.node) return;
    try { this.node.disconnect(); } catch { /* 已断开 */ }
    this.node = null;
  }
}
