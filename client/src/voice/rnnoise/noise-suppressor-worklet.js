/**
 * ============================================================
 * RNNoise 语音降噪 AudioWorklet（K 项目语音房间）
 * ============================================================
 * 链路：麦克风 → RNNoise（10ms/480 样本帧，压制风扇等平稳噪声）
 *       → VAD 门控自适应能量恢复（抵消 RNNoise 对人声的整体压制，
 *         保证"开降噪后人声大小与不开基本一致"）
 *
 * RNNoise 输出对人声有 ~-2.5~-3dB 的整体衰减（语音帧能量保留率约 0.5~0.75），
 * 用户通过录音对比发现"开降噪后声音明显变小"。此处用 RNNoise 自带的
 * 语音概率（VAD 0..1）做门控能量恢复：
 *   - 判定为语音的帧：按 输入能量/输出能量 比例补回（限幅 1.0~1.36）
 *   - 判定为噪声/静音的帧：不补偿，保持 RNNoise 最大压制
 *   - 安静房间（无持续噪声底）：整体禁用补偿（gRange 保持 1.0），
 *     避免背景噪声被放大
 * 参数经 Node 端实测（TTS 人声 + 风扇 @0dB/+6dB/安静三场景）验证。
 *
 * 依赖文件均为 @timephy/rnnoise-wasm@1.0.0 的 vendor 拷贝（polyfills/RnnoiseProcessor/
 * generated 内嵌 wasm/math），改动仅限本文件的增益逻辑。
 */
import './polyfills';
import RnnoiseProcessor from './RnnoiseProcessor';
import createRNNWasmModuleSync from './generated/rnnoise-sync';
import { leastCommonMultiple } from './math';

const PROCESSOR_NAME = 'k-voice-denoiser';

// ---- VAD 门控自适应能量恢复参数（Node 实测调优） ----
const VAD_ATTACK = 0.3; // 语音概率上升平滑系数（帧级 10ms）
const VAD_RELEASE = 0.05; // 语音概率下降平滑系数
const VAD_LO = 0.55; // smoothstep 下限（低于=视为噪声）
const VAD_HI = 0.9; // smoothstep 上限（高于=确定为语音）
const GAIN_MAX = 1.36; // 最大补偿增益（= 1/0.736，对应 RNNoise 语音衰减量）
const GAIN_ATTACK = 0.6; // 增益上升平滑（快 attack，避免开头几帧人声仍被压）
const GAIN_RELEASE = 0.08; // 增益下降平滑（慢 release，避免增益骤降产生咔哒）
// 噪声底门控：仅当"RNNoise 明显压制了非语音帧能量（降噪后 < 50%）且噪声可闻"时启用补偿
const NF_RATIO_THRESHOLD = 0.5;
const NF_RMS_MIN = 0.003; // 环境噪声 RMS 下限（低于此视为安静房间）
const NF_SMOOTH = 0.1; // 噪声底估计平滑
const EN_SMOOTH = 0.03; // 启用状态平滑（防开关抖动）

/** smoothstep（频段/增益过渡用） */
function smoothstep(x, lo, hi) {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}

class KNoiseSuppressorWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    // RNNoise wasm 同步实例（addModule 初始化不等待 Promise）
    this._denoiseProcessor = new RnnoiseProcessor(createRNNWasmModuleSync());
    this._denoiseSampleSize = this._denoiseProcessor.getSampleLength();
    // 环形缓冲：长度取 128（量子）与 480（RNNoise 帧）的最小公倍数，
    // 保证回绕时残量不会被拆断
    this._circularBufferLength = leastCommonMultiple(128, this._denoiseSampleSize);
    this._circularBuffer = new Float32Array(this._circularBufferLength);
    this._inputBufferLength = 0;
    this._denoisedBufferLength = 0;
    this._denoisedBufferIndx = 0;

    // ---- 能量恢复状态 ----
    this._vadSm = 0; // 平滑语音概率
    this._gainSm = 1; // 平滑补偿增益
    this._noiseFloor = 1; // 非语音帧上 降噪输出/原始输入 能量比（1=未压制）
    this._rawNoiseRms = 0; // 非语音帧原始 RMS（环境噪声量级）
    this._enableSm = 0; // 补偿启用状态（0..1 平滑）
  }

  process(inputs, outputs) {
    // 仅处理单声道（VoiceSession 创建时已强制 channelCount=1）
    const inData = inputs[0] && inputs[0][0];
    const outData = outputs[0] && outputs[0][0];
    if (!inData || !outData) return true;

    // 1) 追加输入到环形缓冲
    this._circularBuffer.set(inData, this._inputBufferLength);
    this._inputBufferLength += inData.length;

    // 2) 攒满一帧（480 样本）就降噪 + 能量恢复
    for (
      ;
      this._denoisedBufferLength + this._denoiseSampleSize <= this._inputBufferLength;
      this._denoisedBufferLength += this._denoiseSampleSize
    ) {
      const frame = this._circularBuffer.subarray(
        this._denoisedBufferLength,
        this._denoisedBufferLength + this._denoiseSampleSize
      );
      // 降噪前原始 RMS（用于恢复比）
      let rawRms = 0;
      for (let i = 0; i < frame.length; i++) rawRms += frame[i] * frame[i];
      rawRms = Math.sqrt(rawRms / frame.length);

      // 就地降噪（frame 覆盖为降噪结果），并取得语音概率
      const vad = this._denoiseProcessor.processAudioFrame(frame, true);

      let denRms = 0;
      for (let i = 0; i < frame.length; i++) denRms += frame[i] * frame[i];
      denRms = Math.sqrt(denRms / frame.length);

      // VAD 平滑（帧级）
      const c = vad > this._vadSm ? VAD_ATTACK : VAD_RELEASE;
      this._vadSm += (vad - this._vadSm) * c;

      // 噪声底估计：只在非语音帧更新（降噪输出/原始输入 能量比 + 原始噪声量）
      if (this._vadSm < 0.3 && rawRms > 1e-5) {
        this._noiseFloor += (denRms / rawRms - this._noiseFloor) * NF_SMOOTH;
        this._rawNoiseRms += (rawRms - this._rawNoiseRms) * NF_SMOOTH;
      }

      // 补偿启用判定：噪声底被明显压制 + 环境噪声可闻
      const shouldEnable = this._noiseFloor < NF_RATIO_THRESHOLD && this._rawNoiseRms > NF_RMS_MIN;
      this._enableSm += ((shouldEnable ? 1 : 0) - this._enableSm) * EN_SMOOTH;

      // 语音门（VAD 平滑 → 0..1）
      const speechGate = smoothstep(this._vadSm, VAD_LO, VAD_HI);

      // 自适应恢复增益：目标 = 原样时所需的补偿量，限幅 [1, GAIN_MAX]
      let gTarget = 1;
      if (rawRms > 1e-5 && denRms > 1e-6) {
        gTarget = Math.min(GAIN_MAX, Math.max(1, rawRms / denRms));
      }
      const g = 1 + (gTarget - 1) * speechGate * this._enableSm;
      this._gainSm += (g - this._gainSm) * (g > this._gainSm ? GAIN_ATTACK : GAIN_RELEASE);

      // 应用增益到整帧（限幅防削波：恢复增益叠加 AGC 时可能超 ±1，削波呈静电/爆音）
      if (this._gainSm > 1.0001) {
        for (let i = 0; i < frame.length; i++) {
          const v = frame[i] * this._gainSm;
          frame[i] = v > 1 ? 1 : v < -1 ? -1 : v;
        }
      }
    }

    // 3) 输出可发的降噪数据（与 Jitsi 版一致的延迟对齐：只发"已降噪"段）
    let unsent;
    if (this._denoisedBufferIndx > this._denoisedBufferLength) {
      unsent = this._circularBufferLength - this._denoisedBufferIndx;
    } else {
      unsent = this._denoisedBufferLength - this._denoisedBufferIndx;
    }
    if (unsent > 0) {
      // 欠载（unsent < outData.length，主线程/调度抖动时发生）时写已有部分，
      // 其余保持静音（output 每个量子初始为 0），避免整帧跳过产生不连续咔哒
      const n = Math.min(unsent, outData.length);
      outData.set(this._circularBuffer.subarray(this._denoisedBufferIndx, this._denoisedBufferIndx + n), 0);
      this._denoisedBufferIndx += n;
    }

    // 4) 回绕复位
    if (this._denoisedBufferIndx === this._circularBufferLength) {
      this._denoisedBufferIndx = 0;
    }
    if (this._inputBufferLength === this._circularBufferLength) {
      this._inputBufferLength = 0;
      this._denoisedBufferLength = 0;
    }
    return true;
  }
}

registerProcessor(PROCESSOR_NAME, KNoiseSuppressorWorklet);
