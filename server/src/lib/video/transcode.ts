/**
 * ============================================================
 * 视频转码工具（lib/video/transcode）
 * ============================================================
 * 自 src/video.ts 拆分：发布视频时自动转码为浏览器/WebView 通用格式
 * （H.264 + AAC 的 mp4）
 * - 已是 H.264 mp4: 直接跳过
 * - HEVC MOV 等格式: 用 ffmpeg 转码为 H.264 mp4 并替换原文件
 * - ffmpeg 未安装或转码失败: 保留原文件，不阻塞发布流程
 *
 * 资源护栏（2026-08-28 事故复盘：4K HEVC 转码吃光 1.6GB 内存，
 * %iowait 飙到 90%+，整机瘫痪 8 小时直到手动重启）:
 * - 输出分辨率封顶 1080p（x264 内存与输出分辨率成正比，4K 原片不再打爆内存）
 * - 编码线程数限制
 * - Linux 下以 nice 低优先级运行，转码期间 Web/API 请求优先调度
 * - 由同目录 queue.ts 串行调度（enqueueVideoTranscode）：同一时间只跑一个
 *   ffmpeg，发布请求立即返回，不阻塞、不并发叠加
 * ============================================================
 */

import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { env } from '../../config';
import { logger } from '../logger';
import { probeVideoCodec } from './probe';

const execFileAsync = promisify(execFile);

/** ffmpeg 路径（可通过环境变量覆盖，默认从 PATH 查找） */
const FFMPEG = env.FFMPEG_PATH || 'ffmpeg';

/**
 * 确保视频为浏览器通用格式（H.264 + AAC 的 mp4），输出分辨率封顶 1080p
 *
 * @param filePath - 上传后的视频完整路径
 * @param originalName - 上传时的原始文件名（含扩展名；入队前恒为 .mp4）
 * @returns 最终文件名（原地替换，恒等于入参 originalName）
 */
export async function ensurePlayableVideo(filePath: string, originalName: string): Promise<string> {
  // 任务入队后、真正执行前文件可能已被删除（临时视频过期清理/帖子删除等）
  if (!fs.existsSync(filePath)) return originalName;

  const ext = path.extname(originalName).toLowerCase();
  const codec = await probeVideoCodec(filePath);
  // 无法探测（如服务器未安装 ffprobe）或已是 H.264 mp4，保持原样
  if (codec === null || (codec === 'h264' && ext === '.mp4')) return originalName;

  // ============================================================
  // 原地替换说明（原「非 .mp4 输入改名 finalName + unlinkSync 原文件」分支已删除）：
  // 所有调用方（routes/posts/media.ts 的 normalizeVideoToMp4）在入队前已把
  // 视频统一改存 .mp4 扩展名，因此输入与最终输出恒为同一路径，队列恒为原地替换——
  // 不再存在「转码后文件名从 .mov 变 .mp4」的改名场景。
  // 输入输出同名时使用 .enc.mp4 中间文件：先让 ffmpeg 写中间文件，避免
  // 边读边写同一文件损坏数据；成功后删除原文件并把中间文件改名为原路径。
  // ============================================================
  const actualOut = `${filePath}.enc.mp4`;

  // scale 封顶 1080p（force_original_aspect_ratio=decrease 保持宽高比，小视频不放大）；
  // 引号内的逗号由 ffmpeg filtergraph 解析器处理（execFile 不经过 shell）
  const ffmpegArgs = [
    '-y',
    '-i',
    filePath,
    '-vf',
    "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease",
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    '-max_muxing_queue_size',
    '1024',
    '-threads',
    '2',
    actualOut,
  ];
  // Linux 上经 nice 以低优先级运行（Windows/无 nice 环境直接运行）
  const cmd = process.platform === 'linux' ? 'nice' : FFMPEG;
  const args = process.platform === 'linux' ? ['-n', '19', FFMPEG, ...ffmpegArgs] : ffmpegArgs;

  try {
    await execFileAsync(cmd, args, { timeout: 30 * 60 * 1000 });
    // 原地替换原文件：先删旧文件再改名（与历史行为一致，避免目标已存在时改名失败）
    fs.unlinkSync(filePath);
    fs.renameSync(actualOut, filePath);
    logger.info(`视频转码完成（原地替换）: ${originalName}`);
    return originalName;
  } catch (err) {
    logger.error({ err }, `视频转码失败，保留原文件: ${originalName}`);
    try {
      if (fs.existsSync(actualOut)) fs.unlinkSync(actualOut);
    } catch {
      /* 忽略 */
    }
    return originalName;
  }
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
        '-ss',
        seek,
        '-i',
        filePath,
        '-vframes',
        '1',
        '-vf',
        "scale=w='min(1080,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease",
        '-q:v',
        '3',
        '-threads',
        '2',
        outPath,
      ];
      const cmd = process.platform === 'linux' ? 'nice' : FFMPEG;
      const args = process.platform === 'linux' ? ['-n', '19', FFMPEG, ...ffmpegArgs] : ffmpegArgs;
      await execFileAsync(cmd, args, { timeout: 5000 });
      if (fs.existsSync(outPath)) return outPath;
    } catch {
      /* 该时间点无帧则尝试下一档 */
    }
  }
  return null;
}
