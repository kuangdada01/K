/**
 * ============================================================
 * 音乐列表路由 (/api/music)
 * ============================================================
 * 扫描 client/public/music 目录，返回音乐文件列表
 */

import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { PATHS } from '../config';
import { logger } from '../lib/logger';
import { readId3Tags } from '../lib/id3';

const router = Router();

router.get('/', (_req, res) => {
  const musicDir = PATHS.music;

  try {
    if (!fs.existsSync(musicDir)) {
      res.json([]);
      return;
    }

    const files = fs.readdirSync(musicDir);
    const musicExtensions = ['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac'];

    const songs = files
      .filter((file) => {
        const ext = path.extname(file).toLowerCase();
        return musicExtensions.includes(ext);
      })
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

    res.json(songs);
  } catch (err) {
    logger.error({ err }, 'Error reading music directory');
    res.json([]);
  }
});

export default router;
