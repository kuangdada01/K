/**
 * ============================================================
 * 视频转码队列（lib/video/queue）
 * ============================================================
 * 自 src/video.ts 拆分：后台串行转码队列——同一时间只跑一个 ffmpeg
 * （内存/CPU 占用有界），发布请求立即返回不阻塞；转码完成后同 URL
 * 原地替换内容（见 transcode.ts ensurePlayableVideo）。
 * 单个任务失败只影响自身，不阻塞队列。
 * ============================================================
 */

import { AppError } from '../../middleware/error';
import { logger } from '../logger';
import { ensurePlayableVideo } from './transcode';

/** 串行队列链：同一时间只执行一个转码任务 */
let transcodeQueue: Promise<unknown> = Promise.resolve();

/** 队列上限（含正在执行的一个）：防止无限刷入任务长期占用 ffmpeg */
const MAX_PENDING_TRANSCODES = 20;
let pendingTranscodes = 0;

/**
 * 入队一个视频转码任务（不阻塞调用方）。
 * 队列已满（pendingTranscodes >= MAX_PENDING_TRANSCODES）时抛 429，
 * 由调用方（routes/posts/media.ts）按业务错误响应。
 */
export function enqueueVideoTranscode(filePath: string, originalName: string): void {
  if (pendingTranscodes >= MAX_PENDING_TRANSCODES) {
    throw new AppError(429, '视频处理任务繁忙，请稍后再试');
  }
  pendingTranscodes++;
  transcodeQueue = transcodeQueue
    .then(() => {
      logger.info(`视频转码开始: ${originalName}`);
      return ensurePlayableVideo(filePath, originalName);
    })
    .then((finalName) => {
      logger.info(`视频转码结束: ${finalName}`);
    })
    .catch((err) => {
      logger.error({ err }, `视频转码任务失败(跳过): ${originalName}`);
    })
    .finally(() => {
      pendingTranscodes--;
    });
}
