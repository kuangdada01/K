/**
 * ============================================================
 * 图书路由 (Books)
 * ============================================================
 * 基于文件系统的可复用图书系统:
 * - 每本书 = server/books/<bookId>/ 一个目录
 * - 目录内 book.json 可选元数据: { title, author, description }
 * - 子目录 = 卷（卷内 *.txt 按文件名排序 = 章节）;
 *   无子目录时根目录 *.txt 直接为章节
 * - 加新书只需放入目录，无需改代码
 *
 * API:
 * - GET /api/books                   图书列表
 * - GET /api/books/:bookId           书籍详情（卷/章节树）
 * - GET /api/books/:bookId/content   章节内容 (query: file=相对路径)
 * ============================================================
 */

import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { PATHS } from '../config';
import { logger } from '../lib/logger';

const router = Router();

/** 书籍根目录: server/books */
const BOOKS_DIR = PATHS.books;

/** 读取 book.json 元数据（无则返回默认值） */
function readMeta(bookId: string) {
  const metaFile = path.join(BOOKS_DIR, bookId, 'book.json');
  if (fs.existsSync(metaFile)) {
    try {
      return JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
    } catch {}
  }
  return {};
}

/** 按文件名自然排序（01- < 02- < 10-） */
const byName = (a: string, b: string) => a.localeCompare(b, 'zh-CN', { numeric: true });

/** 中文数字映射（用于卷名排序） */
const CN_NUM: Record<string, number> = {
  '一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
  '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
};

/** 从卷名提取数字序号（支持阿拉伯数字与中文数字），无则返回 null */
function volumeOrder(name: string): number | null {
  const arabic = name.match(/\d+/);
  if (arabic) return parseInt(arabic[0], 10);
  for (const [k, v] of Object.entries(CN_NUM)) {
    if (name.includes(k)) return v;
  }
  return null;
}

/** 卷目录排序：优先按卷名中的数字序号（第一卷 < 第二卷 < 第三卷），无数字按名称排序 */
const byVolumeName = (a: string, b: string) => {
  const numA = volumeOrder(a);
  const numB = volumeOrder(b);
  if (numA !== null && numB !== null) return numA - numB;
  if (numA !== null) return -1;
  if (numB !== null) return 1;
  return byName(a, b);
};

/** 扫描书籍目录，返回章节文件列表（按卷分组） */
function scanBook(bookId: string): { volumes: { name: string; chapters: string[] }[] } {
  const bookDir = path.join(BOOKS_DIR, bookId);
  const entries = fs.readdirSync(bookDir, { withFileTypes: true }).sort((a, b) => byVolumeName(a.name, b.name));
  const txtExt = ['.txt', '.md', '.pdf'];

  const volumes: { name: string; chapters: string[] }[] = [];
  const rootChapters: string[] = [];

  for (const entry of entries) {
    const full = path.join(bookDir, entry.name);
    if (entry.isDirectory()) {
      const files = fs.readdirSync(full)
        .filter(f => txtExt.includes(path.extname(f).toLowerCase()))
        .sort(byName);
      if (files.length > 0) volumes.push({ name: entry.name, chapters: files });
    } else if (entry.isFile() && txtExt.includes(path.extname(entry.name).toLowerCase())) {
      rootChapters.push(entry.name);
    }
  }

  // 根目录 txt 归为默认卷
  if (rootChapters.length > 0) {
    volumes.unshift({ name: '', chapters: rootChapters });
  }
  return { volumes };
}

/** bookId 只允许目录名安全字符（杜绝 '..'、'/'、'\' 等路径片段参与拼接） */
const BOOK_ID_RE = /^[A-Za-z0-9_-]+$/;

/** 校验相对路径安全（防目录穿越），返回绝对路径 */
function safeResolve(bookId: string, relPath: string): string | null {
  if (!BOOK_ID_RE.test(bookId)) return null;
  const bookDir = path.resolve(BOOKS_DIR, bookId);
  if (!bookDir.startsWith(path.resolve(BOOKS_DIR) + path.sep)) return null;
  const abs = path.resolve(bookDir, relPath);
  if (!abs.startsWith(bookDir + path.sep) && abs !== bookDir) return null;
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  return abs;
}

/** 图书封面 URL（book.json 的 cover 字段指向 bookId 目录内的文件，如 cover.jpg） */
function coverUrl(bookId: string, meta: any): string | null {
  const cover = meta?.cover;
  if (!cover) return null;
  if (safeResolve(bookId, cover)) return `/api/books/${bookId}/cover`;
  return null;
}

/** GET /api/books - 图书列表 */
router.get('/', (_req: Request, res: Response) => {
  try {
    if (!fs.existsSync(BOOKS_DIR)) {
      res.json({ books: [] });
      return;
    }
    const books = fs.readdirSync(BOOKS_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => {
        const meta = readMeta(e.name);
        const { volumes } = scanBook(e.name);
        const chapterCount = volumes.reduce((sum, v) => sum + v.chapters.length, 0);
        return {
          id: e.name,
          title: meta.title || e.name,
          author: meta.author || '',
          description: meta.description || '',
          cover: coverUrl(e.name, meta),
          volumeCount: volumes.length,
          chapterCount,
        };
      });
    res.json({ books });
  } catch (err) {
    logger.error({ err }, 'Error reading books');
    res.status(500).json({ error: '图书列表读取失败' });
  }
});

/** GET /api/books/:bookId/cover - 图书封面图片 */
router.get('/:bookId/cover', (req: Request, res: Response) => {
  const bookId = req.params.bookId as string;
  if (!BOOK_ID_RE.test(bookId)) {
    res.status(404).json({ error: '图书不存在' });
    return;
  }
  const meta = readMeta(bookId);
  const cover = meta?.cover;
  if (!cover) {
    res.status(404).json({ error: '无封面' });
    return;
  }
  try {
    const abs = safeResolve(bookId, cover);
    if (!abs) {
      res.status(404).json({ error: '封面不存在' });
      return;
    }
    res.sendFile(abs);
  } catch (err) {
    logger.error({ err }, 'Error sending cover');
    res.status(500).json({ error: '封面读取失败' });
  }
});

/** GET /api/books/:bookId - 书籍详情 */
router.get('/:bookId', (req: Request, res: Response) => {
  const bookId = req.params.bookId as string;
  const bookDir = path.resolve(BOOKS_DIR, bookId);
  if (!bookDir.startsWith(path.resolve(BOOKS_DIR) + path.sep) || !fs.existsSync(bookDir) || !fs.statSync(bookDir).isDirectory()) {
    res.status(404).json({ error: '图书不存在' });
    return;
  }
  try {
    const meta = readMeta(bookId);
    const { volumes } = scanBook(bookId);
    res.json({
      id: bookId,
      title: meta.title || bookId,
      author: meta.author || '',
      description: meta.description || '',
      cover: coverUrl(bookId, meta),
      volumes: volumes.map(v => ({
        name: v.name,
        chapters: v.chapters.map(f => ({
          file: v.name ? path.join(v.name, f) : f,
          type: path.extname(f).toLowerCase() === '.pdf' ? 'pdf' : 'text',
          title: path.basename(f, path.extname(f)).replace(/^\d+[-_.\s]*/, ''),
        })),
      })),
    });
  } catch (err) {
    logger.error({ err }, 'Error reading book');
    res.status(500).json({ error: '图书详情读取失败' });
  }
});

/** GET /api/books/:bookId/content - 章节内容 (query: file=相对路径) */
router.get('/:bookId/content', (req: Request, res: Response) => {
  const bookId = req.params.bookId as string;
  const relPath = req.query.file as string | undefined;
  if (!relPath) {
    res.status(400).json({ error: '缺少 file 参数' });
    return;
  }
  try {
    const abs = safeResolve(bookId, relPath);
    if (!abs) {
      res.status(404).json({ error: '章节不存在' });
      return;
    }
    // PDF 以附件方式提供（阅读页直接打开/下载）
    if (path.extname(abs).toLowerCase() === '.pdf') {
      res.download(abs, path.basename(abs));
      return;
    }
    const content = fs.readFileSync(abs, 'utf-8');
    res.type('text/plain; charset=utf-8').send(content);
  } catch (err) {
    logger.error({ err }, 'Error reading chapter');
    res.status(500).json({ error: '章节读取失败' });
  }
});

export default router;
