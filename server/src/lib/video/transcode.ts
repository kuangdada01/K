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
import { probeVideoStream, type VideoStreamInfo } from './probe';
import { withFfmpegSlot } from './ffmpegGate';

const execFileAsync = promisify(execFile);

/** ffmpeg 路径（可通过环境变量覆盖，默认从 PATH 查找） */
const FFMPEG = env.FFMPEG_PATH || 'ffmpeg';

/**
 * 判断视频流是否为"浏览器/移动端通用可播"：
 * 仅 H.264 且规格在主流硬件解码能力内的才直接可播，否则需要转码。
 *
 * 判据（h264 之外一律需转码；h264 还需同时满足）：
 * - level <= 42（4.2）：覆盖 1080p60、任意竖屏 1080x1920 等主流规格；
 *   4K30 为 5.1、4K60 为 5.2，超出一众手机/网页硬件解码器能力（Edge 等
 *   直接解码失败，表现为"转码完成也不显示"）
 * - 长边 <= 2048：兜底 level 缺失/异常标记的文件（如 2560x1080 带鱼屏）
 * 探测失败/字段缺失时保守判定为需转码？——不：保持原语义（探测失败不转码，
 * 由客户端发布路径与播放器错误处理兜底），仅能确认的规格参与判断。
 */
export function isPlayableVideoStream(info: VideoStreamInfo | null): boolean {
  if (!info || info.codec !== 'h264') return false;
  const level = info.level;
  if (level !== null && level > 42) return false;
  const w = info.width;
  const h = info.height;
  if (w !== null && h !== null && Math.max(w, h) > 2048) return false;
  return true;
}

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
  const info = await probeVideoStream(filePath);
  // 无法探测（如服务器未安装 ffprobe）保持原样；已是可播规格（H.264 且
  // level/分辨率在硬件解码能力内）的 mp4 也保持原样——
  // 4K H.264（level 5.x）与 HEVC 一样需要降级转码：多数移动端浏览器/
  // WebView 的硬件解码器解不了 4K H.264，此前"h264 直接跳过"导致
  // 这类视频转码状态显示完成却永远无法预览
  if (info === null || (ext === '.mp4' && isPlayableVideoStream(info))) return originalName;

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
    // 进程级闸门：与封面截帧共用槽位，保证全局 ffmpeg 进程数有界
    await withFfmpegSlot(() => execFileAsync(cmd, args, { timeout: 30 * 60 * 1000 }));
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
      // 进程级闸门：本函数在请求处理器内直接调用（不在 queue.ts 的串行链上），
      // 不经闸门就会与转码叠加成「1 转码 + N 截帧」把 CPU 打满
      await withFfmpegSlot(() => execFileAsync(cmd, args, { timeout: 5000 }));
      if (fs.existsSync(outPath)) return outPath;
    } catch {
      /* 该时间点无帧则尝试下一档 */
    }
  }
  return null;
}
