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

/**
 * 探测视频编码格式，返回视频流 codec_name（如 h264/hevc），
 * 探测失败（ffprobe 未安装或文件异常）返回 null
 */
export async function probeVideoCodec(filePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      FFPROBE,
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=codec_name',
        '-of',
        'json',
        filePath,
      ],
      { timeout: 30000 }
    );
    const data = JSON.parse(stdout);
    return data?.streams?.[0]?.codec_name ?? null;
  } catch {
    return null;
  }
}
