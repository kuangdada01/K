/**
 * ============================================================
 * 语音转写（StepFun StepAudio ASR）
 * ============================================================
 * 私信语音消息的「转文字」：服务端读 uploads_private 里的 m4a，base64 后调
 * StepFun 的 ASR SSE 接口，拿到整段文本返回。
 *
 * 为什么走服务端：
 *  · API Key 只存在于服务端（与 /api/tts 同一条红线），客户端永远看不到；
 *  · 转写结果要落库缓存（`messages.audio_text`），同一段语音只烧一次上游额度。
 *
 * 端点选择：TTS 用的是 Step Plan 命名空间（`/step_plan/v1/...`），ASR 也先走
 * Step Plan；若该账号没有这个命名空间（404/405），回退到标准 `/v1/...`。
 * 可用 `STEP_ASR_ENDPOINT` 显式覆盖（换区域/换网关时不必改代码）。
 * ============================================================
 */

import fs from 'fs';
import path from 'path';
import { env } from '../config';
import { logger } from '../lib/logger';

/** StepFun ASR 模型（官方推荐；中文短语音足够） */
const ASR_MODEL = 'stepaudio-2.5-asr';

/** 上游超时：60 秒语音的转写通常 1~3 秒，30 秒兜底防连接悬挂 */
const TIMEOUT_MS = 30_000;

/** 转写文本上限（与消息正文 5000 字符同一口径，避免异常响应撑爆 DB/UI） */
const MAX_TEXT_CHARS = 5000;

const DEFAULT_ENDPOINTS = [
  'https://api.stepfun.com/step_plan/v1/audio/asr/sse',
  'https://api.stepfun.com/v1/audio/asr/sse',
];

/** 服务端没配 STEP_API_KEY（路由据此返回 503，而不是 502） */
export class AsrNotConfiguredError extends Error {
  constructor() {
    super('语音转写未配置（服务端缺少 STEP_API_KEY）');
    this.name = 'AsrNotConfiguredError';
  }
}

/** 上游失败/超时/空结果（路由按 502 处理） */
export class AsrFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AsrFailedError';
  }
}

/**
 * 转写一个音频文件（m4a/AAC）。
 *
 * @returns 识别出的文本（已 trim；可能为空字符串 —— 由调用方决定是否缓存）
 * @throws AsrNotConfiguredError | AsrFailedError
 */
export async function transcribeAudioFile(filePath: string): Promise<string> {
  if (!env.STEP_API_KEY) throw new AsrNotConfiguredError();

  const audio = fs.readFileSync(filePath);
  if (audio.length === 0) throw new AsrFailedError('音频文件为空');

  // 容器格式按扩展名推断：录音端是 m4a，测试/将来 Web 录音可能是 mp3/wav/ogg。
  // ASR 接口只认这四种；未知扩展名按 m4a 兜底（服务端上传白名单也包含 m4a）。
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const formatType = ['m4a', 'mp3', 'wav', 'ogg'].includes(ext) ? ext : 'm4a';

  const endpoints = env.STEP_ASR_ENDPOINT ? [env.STEP_ASR_ENDPOINT] : DEFAULT_ENDPOINTS;

  let lastError: unknown = null;
  for (let i = 0; i < endpoints.length; i++) {
    const endpoint = endpoints[i]!;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.STEP_API_KEY}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          audio: {
            data: audio.toString('base64'),
            input: {
              transcription: {
                language: 'zh',
                model: ASR_MODEL,
                enable_itn: true,
              },
              // 录音端固定 MPEG_4/AAC（.m4a）；SSE 接口的 format.type 支持 m4a/mp3/wav/ogg
              format: { type: formatType },
            },
          },
        }),
        signal: controller.signal,
      });

      // 命名空间不存在：换下一个端点（只在还有候选时继续）
      if ((response.status === 404 || response.status === 405) && i < endpoints.length - 1) {
        lastError = new AsrFailedError(`ASR 端点不可用（${response.status}）`);
        continue;
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new AsrFailedError(
          `ASR 上游失败（${response.status}）${detail ? `：${detail.slice(0, 200)}` : ''}`
        );
      }

      const text = (await readSseText(response)).trim();
      if (!text) throw new AsrFailedError('ASR 未识别出文本');
      return text.slice(0, MAX_TEXT_CHARS);
    } catch (e) {
      lastError = e;
      // 超时/网络错误：不再换端点（换一个也一样），直接抛出
      if (e instanceof AsrNotConfiguredError) throw e;
      if (e instanceof AsrFailedError && !String(e.message).includes('端点不可用')) {
        throw e;
      }
      if (controller.signal.aborted) {
        throw new AsrFailedError('语音转写超时，请稍后再试');
      }
    } finally {
      clearTimeout(timer);
    }
  }

  logger.warn({ err: lastError }, '[asr] 转写失败');
  throw lastError instanceof AsrFailedError ? lastError : new AsrFailedError('语音转写失败');
}

/**
 * 读 SSE 流，取 `transcript.text.done` 的完整文本。
 *
 * 只关心两个事件：`transcript.text.done`（成功）与 `error`（失败）。
 * 增量事件（delta）忽略 —— 我们要的是整段结果，不是打字机效果。
 */
async function readSseText(response: Response): Promise<string> {
  if (!response.body) throw new AsrFailedError('ASR 响应没有内容');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let doneText = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 以空行分隔事件；这里按行处理即可（每个事件只有一行 data）
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        let event: unknown;
        try {
          event = JSON.parse(payload);
        } catch {
          continue; // 非 JSON 的心跳/注释行，忽略
        }
        if (!event || typeof event !== 'object') continue;
        const e = event as { type?: string; text?: string; message?: string };

        if (e.type === 'transcript.text.done' && typeof e.text === 'string') {
          doneText = e.text;
        } else if (e.type === 'error') {
          throw new AsrFailedError(`ASR 上游报错：${e.message ?? '未知错误'}`);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return doneText;
}
