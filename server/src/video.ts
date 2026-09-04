/**
 * ============================================================
 * 视频转码工具
 * ============================================================
 * 发布视频时自动转码为浏览器/WebView 通用格式（H.264 + AAC 的 mp4）
 * - 已是 H.264 mp4: 直接跳过
 * - HEVC MOV 等格式: 用 ffmpeg 转码为 H.264 mp4 并替换原文件
 * - ffmpeg 未安装或转码失败: 保留原文件，不阻塞发布流程
 *
 * 资源护栏（2026-08-28 事故复盘：4K HEVC 转码吃光 1.6GB 内存，
 * %iowait 飙到 90%+，整机瘫痪 8 小时直到手动重启）:
 * - 输出分辨率封顶 1080p（x264 内存与输出分辨率成正比，4K 原片不再打爆内存）
 * - 编码线程数限制
 * - Linux 下以 nice 低优先级运行，转码期间 Web/API 请求优先调度
 * - 后台串行队列（enqueueVideoTranscode）：同一时间只跑一个 ffmpeg，
 *   发布请求立即返回，不阻塞、不并发叠加
 * ============================================================
 */

import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { env } from './config';
import { logger } from './lib/logger';
import { AppError } from './middleware/error';

const execFileAsync = promisify(execFile);

/** ffmpeg/ffprobe 路径（可通过环境变量覆盖，默认从 PATH 查找） */
const FFMPEG = env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = env.FFPROBE_PATH || 'ffprobe';

/**
 * 探测视频编码格式，返回视频流 codec_name（如 h264/hevc），
 * 探测失败（ffprobe 未安装或文件异常）返回 null
 */
export async function probeVideoCodec(filePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(FFPROBE, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name',
      '-of', 'json',
      filePath,
    ], { timeout: 30000 });
    const data = JSON.parse(stdout);
    return data?.streams?.[0]?.codec_name ?? null;
  } catch {
    return null;
  }
}

/**
 * 确保视频为浏览器通用格式（H.264 + AAC 的 mp4），输出分辨率封顶 1080p
 *
 * @param filePath - 上传后的视频完整路径
 * @param originalName - 上传时的原始文件名（含扩展名）
 * @returns 最终文件名（转码后可能变为 .mp4）
 */
export async function ensurePlayableVideo(filePath: string, originalName: string): Promise<string> {
  // 任务入队后、真正执行前文件可能已被删除（临时视频过期清理/帖子删除等）
  if (!fs.existsSync(filePath)) return originalName;

  const ext = path.extname(originalName).toLowerCase();
  const codec = await probeVideoCodec(filePath);
  // 无法探测（如服务器未安装 ffprobe）或已是 H.264 mp4，保持原样
  if (codec === null || (codec === 'h264' && ext === '.mp4')) return originalName;

  const dir = path.dirname(filePath);
  const base = originalName.slice(0, originalName.length - ext.length);
  const finalName = `${base}.mp4`;
  const outPath = path.join(dir, finalName);
  // 输入输出同名时（.mp4 但非 H.264），先用中间文件名避免 ffmpeg 覆盖输入
  const actualOut = outPath === filePath ? `${filePath}.enc.mp4` : outPath;

  // scale 封顶 1080p（force_original_aspect_ratio=decrease 保持宽高比，小视频不放大）；
  // 引号内的逗号由 ffmpeg filtergraph 解析器处理（execFile 不经过 shell）
  const ffmpegArgs = [
    '-y',
    '-i', filePath,
    '-vf', "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease",
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    '-max_muxing_queue_size', '1024',
    '-threads', '2',
    actualOut,
  ];
  // Linux 上经 nice 以低优先级运行（Windows/无 nice 环境直接运行）
  const cmd = process.platform === 'linux' ? 'nice' : FFMPEG;
  const args = process.platform === 'linux' ? ['-n', '19', FFMPEG, ...ffmpegArgs] : ffmpegArgs;

  try {
    await execFileAsync(cmd, args, { timeout: 30 * 60 * 1000 });
    if (actualOut !== filePath) {
      fs.unlinkSync(filePath);
    }
    if (actualOut !== outPath) {
      fs.renameSync(actualOut, outPath);
    }
    logger.info(`视频转码完成: ${originalName} -> ${finalName}`);
    return finalName;
  } catch (err) {
    logger.error({ err }, `视频转码失败，保留原文件: ${originalName}`);
    try { if (fs.existsSync(actualOut)) fs.unlinkSync(actualOut); } catch { /* 忽略 */ }
    return originalName;
  }
}

/**
 * 后台串行转码队列：同一时间只跑一个 ffmpeg（内存/CPU 占用有界），
 * 发布请求立即返回不阻塞；转码完成后同 URL 原地替换内容。
 * 单个任务失败只影响自身，不阻塞队列。
 */
let transcodeQueue: Promise<unknown> = Promise.resolve();

/** 队列上限（含正在执行的一个）：防止无限刷入任务长期占用 ffmpeg */
const MAX_PENDING_TRANSCODES = 20;
let pendingTranscodes = 0;

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

/**
 * 从视频截取一帧作为封面 jpg（nice 降优先级；先试 1s 处，过短再取第 0 帧）。
 * 客户端 canvas 截帧可能失败（浏览器解不了 HEVC、同值 seek 不触发 seeked 等），
 * 服务端兜底保证视频帖总有封面。失败返回 null。
 * P4 修复：-threads 限制线程数 + 单档超时降到 5s，避免截帧长时间占用请求/CPU。
 */
export async function generateVideoCover(filePath: string, outPath: string): Promise<string | null> {
  for (const seek of ['1', '0']) {
    if (!fs.existsSync(filePath)) return null;
    try {
      const ffmpegArgs = [
        '-y',
        '-ss', seek,
        '-i', filePath,
        '-vframes', '1',
        '-vf', "scale=w='min(1080,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease",
        '-q:v', '3',
        '-threads', '2',
        outPath,
      ];
      const cmd = process.platform === 'linux' ? 'nice' : FFMPEG;
      const args = process.platform === 'linux' ? ['-n', '19', FFMPEG, ...ffmpegArgs] : ffmpegArgs;
      await execFileAsync(cmd, args, { timeout: 5000 });
      if (fs.existsSync(outPath)) return outPath;
    } catch { /* 该时间点无帧则尝试下一档 */ }
  }
  return null;
}
