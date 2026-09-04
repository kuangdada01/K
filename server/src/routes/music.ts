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
      .filter(file => {
        const ext = path.extname(file).toLowerCase();
        return musicExtensions.includes(ext);
      })
      .map(file => {
        const name = path.basename(file, path.extname(file));
        // 尝试从文件名解析艺术家和标题 (格式: "艺术家 - 标题" 或直接用文件名作为标题)
        const parts = name.split(' - ');
        let title = name;
        let artist = '未知艺术家';

        if (parts.length >= 2) {
          artist = parts[0].trim();
          title = parts.slice(1).join(' - ').trim();
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
