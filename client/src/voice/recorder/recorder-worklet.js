/**
 * ============================================================
 * 录音 PCM 采集 AudioWorklet（K 项目语音房间）
 * ============================================================
 * 替代主线程 ScriptProcessor：ScriptProcessor 的 onaudioprocess
 * 跑在主线程，UI 卡顿（长任务/滚动/编码）时会丢渲染量子，录音出现
 * 跳变；本 worklet 跑在音频渲染线程，与主线程卡顿完全解耦。
 *
 * 行为对齐 ScriptProcessor 路径：
 * - 每个渲染量子（128 样本）把双声道 Float32 拷贝后发往主线程
 *   （拷贝是必须的：输入缓冲底层会被复用；随后 transfer 零拷贝传递）
 * - 主线程收到的数组直接 push 进切片列表，由 collectPcm() 汇总
 */
const PROCESSOR_NAME = 'k-voice-recorder';

class KRecorderWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const ch0 = new Float32Array(input[0]);
    const ch1 = input.length > 1 ? new Float32Array(input[1]) : null;
    const msg = { ch0, ch1 };
    // transfer 底层 buffer：主线程零二次拷贝
    this.port.postMessage(msg, ch1 ? [ch0.buffer, ch1.buffer] : [ch0.buffer]);
    return true;
  }
}

registerProcessor(PROCESSOR_NAME, KRecorderWorklet);
