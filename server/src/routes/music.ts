/**
 * ============================================================
 * 音乐列表路由 (/api/music)
 * ============================================================
 * 扫描 client/public/music 目录，返回音乐文件列表。
 *
 * 性能：公开端点（匿名可调），此前每请求 readdirSync + 逐文件同步读 ID3
 * （单文件最多 2MB），同步磁盘 IO 直接占住事件循环——与 SSE 心跳/语音信令
 * 共享同一循环，可被脚本循环请求放大为全站卡顿。现改为 mtime 校验的内存
 * 缓存：命中时只做 stat（无内容读），文件增删改名/内容替换都会改变对应
 * mtime/size 而触发重建，行为与逐次扫描一致（无陈旧窗口）。
 */

import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { PATHS } from '../config';
import { logger } from '../lib/logger';
import { readId3Tags } from '../lib/id3';

const router = Router();

export interface MusicItem {
  title: string;
  artist: string;
  src: string;
}

const MUSIC_EXTENSIONS = ['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac'];

/** 扫描目录构建音乐列表（同步 IO，仅在缓存失效时执行） */
function buildMusicList(musicDir: string): MusicItem[] {
  const files = fs.readdirSync(musicDir);
  return files
    .filter((file) => MUSIC_EXTENSIONS.includes(path.extname(file).toLowerCase()))
    .map((file) => {
      const name = path.basename(file, path.extname(file));
      // 兜底：从文件名解析艺术家和标题 (格式: "艺术家 - 标题" 或直接用文件名作为标题)
      const parts = name.split(' - ');
      let title = name;
      let artist = '未知艺术家';

      if (parts.length >= 2) {
        artist = parts[0]!.trim();
        title = parts.slice(1).join(' - ').trim();
      }

      // 文件内嵌 ID3 标签优先（资源管理器里的「标题/艺术家」就是它），
      // 缺哪个字段才用文件名解析结果补哪个。读不动不拦列表。
      try {
        const tags = readId3Tags(path.join(musicDir, file));
        if (tags.title?.trim()) title = tags.title.trim();
        if (tags.artist?.trim()) artist = tags.artist.trim();
      } catch {
        // ignore
      }

      return {
        title,
        artist,
        src: `/music/${file}`,
      };
    });
}

interface MusicCache {
  /** 目录 mtime：文件增删/改名都会改变它 */
  dirMtimeMs: number;
  /** 缓存时逐文件的 mtime+size：原地替换内容（同名同目录）据此失效 */
  files: { name: string; mtimeMs: number; size: number }[];
  songs: MusicItem[];
}

/**
 * 创建一个目录绑定的音乐列表读取器（mtime 校验缓存）。
 * 目录不存在返回 []（与旧行为一致）；导出供测试用临时目录验证缓存行为。
 */
export function createMusicListReader(musicDir: string): () => MusicItem[] {
  let cache: MusicCache | null = null;

  function valid(next: MusicCache): boolean {
    if (next.dirMtimeMs !== cache?.dirMtimeMs) return false;
    if (next.files.length !== cache.files.length) return false;
    return next.files.every((f, i) => {
      const c = cache!.files[i]!;
      return f.name === c.name && f.mtimeMs === c.mtimeMs && f.size === c.size;
    });
  }

  /** 采集校验戳：目录 mtime + 逐文件 mtime/size（只 stat，不读内容） */
  function stamp(): MusicCache | null {
    try {
      const dirMtimeMs = fs.statSync(musicDir).mtimeMs;
      const files = fs
        .readdirSync(musicDir)
        .filter((file) => MUSIC_EXTENSIONS.includes(path.extname(file).toLowerCase()))
        .map((name) => {
          const st = fs.statSync(path.join(musicDir, name));
          return { name, mtimeMs: st.mtimeMs, size: st.size };
        });
      return { dirMtimeMs, files, songs: [] };
    } catch {
      return null; // 目录不存在/不可读
    }
  }

  return () => {
    const next = stamp();
    if (next === null) {
      cache = null;
      return [];
    }
    if (cache === null || !valid(next)) {
      try {
        next.songs = buildMusicList(musicDir);
        cache = next;
      } catch (err) {
        logger.error({ err }, 'Error reading music directory');
        // 重建失败保留旧缓存（可用性优先：列表陈旧好过空白）
        return cache?.songs ?? [];
      }
    }
    return cache.songs;
  };
}

const getMusicList = createMusicListReader(PATHS.music);

router.get('/', (_req, res) => {
  res.json(getMusicList());
});

export default router;
