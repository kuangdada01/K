/**
 * ============================================================
 * 语音房间封面孤儿文件清理（lib/voiceCoverSweep）
 * ============================================================
 * 封面上传（POST /api/voice/rooms/cover）与建房完全解耦：访客可以只传封面
 * 不建房，文件落在公开静态目录 uploads/voice-covers，此前**没有任何回收
 * 路径**（房间删除也不回收）——全局限流 120 次/分 × 10MB 意味着单 IP 每天可
 * 堆约 17GB 孤儿文件，是慢速磁盘耗尽向量。
 *
 * 策略：按「是否被 voice_rooms.cover_url 引用」判定孤儿——
 *  - 未被任何房间引用且 mtime 超过 TTL 的文件删除（TTL 覆盖「先传封面、
 *    稍后建房」的正常窗口，宽裕取 24h，与临时视频同量级）；
 *  - 被引用的文件永不清扫（删房时由路由层顺带删除封面文件）。
 *
 * 与 startTempVideoSweeper 同一套约束：定时器只由 bootstrap（index.ts）显式
 * 启动，**不能**放模块顶层——清扫要查默认数据库，会打破测试的
 * 「真实 k.db 零接触」不变量。
 */

import fs from 'fs';
import path from 'path';
import { PATHS } from '../config';
import { stmt } from '../db/connection';
import { logger } from './logger';

/** 未引用封面的存活窗口：覆盖上传→建房的正常间隔，超时视为孤儿 */
export const VOICE_COVER_TTL_MS = 24 * 3600 * 1000;
/** 清扫周期（与临时视频清理同频） */
const SWEEP_INTERVAL_MS = 3600 * 1000;

/** 目录内安全的文件名（只删 voice-covers 目录直属文件，basename 防拼接） */
function referencedBasenames(): Set<string> {
  const rows = stmt('SELECT cover_url FROM voice_rooms WHERE cover_url IS NOT NULL').all() as {
    cover_url: string;
  }[];
  const set = new Set<string>();
  for (const row of rows) {
    const name = path.basename(row.cover_url);
    if (name && name !== '/' && name !== '.') set.add(name);
  }
  return set;
}

/**
 * 清扫 uploads/voice-covers 下未被任何房间引用且超过 TTL 的文件。
 * 返回删除的文件数。目录不存在时静默建目录（全新环境/CI 无事可做）。
 */
export function sweepOrphanVoiceCovers(now: number = Date.now()): number {
  const dir = PATHS.voiceCovers;
  let removed = 0;
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      return 0;
    }
    const referenced = referencedBasenames();
    const cutoff = now - VOICE_COVER_TTL_MS;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      try {
        if (referenced.has(name)) continue;
        const st = fs.statSync(p);
        if (st.isFile() && st.mtimeMs < cutoff) {
          fs.unlinkSync(p);
          removed++;
        }
      } catch {
        /* 忽略单个文件错误 */
      }
    }
  } catch {
    /* 忽略目录级错误 */
  }
  return removed;
}

/** 删除一个房间封面文件（房间删除/换封面的补偿路径），尽力而为不抛错 */
export function deleteVoiceCoverFile(coverUrl: string | null | undefined): void {
  if (!coverUrl) return;
  const name = path.basename(coverUrl);
  if (!name || name === '/' || name === '.') return;
  try {
    const p = path.join(PATHS.voiceCovers, name);
    // 只删本目录内的同名文件；文件不存在（已被清扫/从未落盘）视为成功
    if (fs.existsSync(p) && fs.statSync(p).isFile()) fs.unlinkSync(p);
  } catch (err) {
    logger.warn({ err }, '删除房间封面文件失败（等待孤儿清扫兜底）');
  }
}

let sweepTimer: NodeJS.Timeout | null = null;

/** 装配期初始化（幂等）：启动清一次 + 每小时一次，定时器 unref */
export function startVoiceCoverSweeper(): void {
  sweepOrphanVoiceCovers();
  if (sweepTimer == null) {
    sweepTimer = setInterval(() => {
      const n = sweepOrphanVoiceCovers();
      if (n > 0) logger.info(`[voice-covers] 孤儿封面清理：${n} 个文件已删除`);
    }, SWEEP_INTERVAL_MS);
    sweepTimer.unref();
  }
}
