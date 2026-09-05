/**
 * ============================================================
 * 全房间录制：格式探测 / PCM→MP3 转码 / 结算下载 工具（voice/recording/mp3Encode）
 * ============================================================
 * 全部为不依赖会话状态的纯函数，供 RoomRecorder 结算录制文件使用。
 */

/** MediaRecorder 无浏览器内置 MP3 编码器：Chrome 系 webm/opus，Safari mp4 */
export function pickRecorderMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

/** MP3 转码失败兜底下载时按原始容器给扩展名 */
function rawExtension(mime: string): string {
  if (mime.includes('mp4')) return 'm4a';
  if (mime.includes('ogg')) return 'ogg';
  return 'webm';
}

/** 文件名清洗（Windows 保留字符与控制符） */
function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim() || '房间';
}

function buildRecordingFileName(roomName: string, startedAt: number, ext: string): string {
  const d = new Date(startedAt);
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `语音_${sanitizeFileName(roomName)}_${stamp}.${ext}`;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Float32 PCM [-1,1] → Int16（lamejs 输入格式） */
function floatToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** lamejs 支持的采样率集合（WebAudio 常见 44.1k/48k 均在内） */
const MP3_SUPPORTED_RATES = new Set<number>([
  8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000,
]);

/** 不在 lamejs 支持集内的采样率统一归一到 44.1k（线性重采样，时长不变） */
function normalizeMp3SampleRate(rate: number): number {
  return MP3_SUPPORTED_RATES.has(rate) ? rate : 44100;
}

/** 简单线性重采样（仅在采样率不在 lamejs 支持集时启用） */
function resampleFloat32(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = toRate / fromRate;
  const outLen = Math.max(1, Math.round(input.length * ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i / ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

/** 拼接多个 Float32 切片为连续数组（PCM 直录按处理块累积后合并） */
export function concatFloat32(slices: Float32Array[]): Float32Array {
  let total = 0;
  for (const s of slices) total += s.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const s of slices) { out.set(s, offset); offset += s.length; }
  return out;
}

/** 单声道 Float32 PCM → MP3 Blob（单声道 128kbps；周期性让出主线程避免长录音卡 UI） */
export async function encodePcmToMp3(mono: Float32Array, sampleRate: number): Promise<Blob> {
  const { Mp3Encoder } = await import('@breezystack/lamejs');
  const rate = normalizeMp3SampleRate(sampleRate);
  const pcm = rate === sampleRate ? mono : resampleFloat32(mono, sampleRate, rate);
  const encoder = new Mp3Encoder(1, rate, 128);
  const int16 = floatToInt16(pcm);
  const parts: Uint8Array<ArrayBuffer>[] = [];
  const BLOCK = 1152; // lamejs 单次编码块大小
  for (let i = 0; i < int16.length; i += BLOCK) {
    // 拷贝进新 ArrayBuffer 以满足 BlobPart 的精确类型（lamejs 返回值是 ArrayBufferLike）
    const encoded = new Uint8Array(encoder.encodeBuffer(int16.subarray(i, i + BLOCK)));
    if (encoded.length > 0) parts.push(encoded);
    if ((i / BLOCK) % 200 === 0) await new Promise(r => setTimeout(r, 0));
  }
  const tail = new Uint8Array(encoder.flush());
  if (tail.length > 0) parts.push(tail);
  return new Blob(parts, { type: 'audio/mpeg' });
}

/** AudioBuffer → MP3 Blob（单声道；仅用于 MediaRecorder 原始文件解码的后备路径） */
async function encodeMp3(buffer: AudioBuffer): Promise<Blob> {
  const chs = buffer.numberOfChannels;
  let mono = buffer.getChannelData(0);
  if (chs > 1) {
    // 语音房多人混音本就是单声道内容，声道合并后减半体积
    const len = buffer.length;
    mono = new Float32Array(len);
    for (let c = 0; c < chs; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < len; i++) mono[i] += data[i] / chs;
    }
  }
  return encodePcmToMp3(mono, buffer.sampleRate);
}

/** 录制 Blob → 解码 PCM → MP3（OfflineAudioContext 仅借 decodeAudioData，无需手势、不影响通话中的 AudioContext） */
async function blobToMp3(blob: Blob): Promise<Blob> {
  const decoder = new OfflineAudioContext(1, 1, 44_100);
  const buffer = await decoder.decodeAudioData(await blob.arrayBuffer());
  return encodeMp3(buffer);
}

/**
 * 停止后结算，三档保证输出是 MP3：
 * 1. 首选 PCM 直录（录制时同步采集的 Float32 样本）→ lamejs 直接编码。
 *    不经过浏览器 decodeAudioData —— 该步骤在部分浏览器/长录音下会失败，
 *    正是此前“偶尔下载到 webm/m4a”（不是 mp3）的根因。
 * 2. PCM 不可用时退回 MediaRecorder 原始块 → decodeAudioData → MP3。
 * 3. 仍失败才兜底原始容器（webm/m4a），内容不丢（此路径基本不会再触发）。
 */
export async function finalizeRecording(
  pcm: Float32Array | null,
  sampleRate: number,
  raw: Blob | null,
  mime: string,
  roomName: string,
  startedAt: number,
): Promise<void> {
  if (pcm && pcm.length > 0) {
    try {
      const mp3 = await encodePcmToMp3(pcm, sampleRate);
      downloadBlob(mp3, buildRecordingFileName(roomName, startedAt, 'mp3'));
      return;
    } catch { /* PCM 编码失败则继续尝试解码路径 */ }
  }
  if (raw && raw.size > 0) {
    try {
      const mp3 = await blobToMp3(raw);
      downloadBlob(mp3, buildRecordingFileName(roomName, startedAt, 'mp3'));
      return;
    } catch { /* 解码失败，兜底原始格式 */ }
    downloadBlob(raw, buildRecordingFileName(roomName, startedAt, rawExtension(mime)));
  }
}
