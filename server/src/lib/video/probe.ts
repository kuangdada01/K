/**
 * ============================================================
 * 视频编码探测（lib/video/probe）
 * ============================================================
 * 自 src/video.ts 拆分：ffprobe 探测视频流编码格式。
 * ============================================================
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { env } from '../../config';

const execFileAsync = promisify(execFile);

/** ffprobe 路径（可通过环境变量覆盖，默认从 PATH 查找） */
const FFPROBE = env.FFPROBE_PATH || 'ffprobe';

/** 视频流探测结果：codec_name 以及用于判断"是否需降级转码"的规格字段 */
export interface VideoStreamInfo {
  /** 视频流编码（h264/hevc/...）；探测失败为 null */
  codec: string | null;
  /** 显示宽度（像素） */
  width: number | null;
  /** 显示高度（像素） */
  height: number | null;
  /** H.264 level（如 51 = 5.1）；非 h264 或未知为 null */
  level: number | null;
}

/**
 * 探测视频流规格。探测失败（ffprobe 未安装或文件异常）返回 null。
 * 字段缺失时单独为 null（不整体失败），由调用方的降级判定处理。
 */
export async function probeVideoStream(filePath: string): Promise<VideoStreamInfo | null> {
  try {
    const { stdout } = await execFileAsync(
      FFPROBE,
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=codec_name,width,height,level',
        '-of',
        'json',
        filePath,
      ],
      { timeout: 30000 }
    );
    const data = JSON.parse(stdout);
    const s = data?.streams?.[0];
    if (!s) return null;
    const num = (v: unknown): number | null =>
      v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v);
    return {
      codec: typeof s.codec_name === 'string' ? s.codec_name : null,
      width: num(s.width),
      height: num(s.height),
      level: num(s.level),
    };
  } catch {
    return null;
  }
}

/**
 * 探测视频编码格式，返回视频流 codec_name（如 h264/hevc），
 * 探测失败（ffprobe 未安装或文件异常）返回 null
 */
export async function probeVideoCodec(filePath: string): Promise<string | null> {
  const info = await probeVideoStream(filePath);
  return info?.codec ?? null;
}
