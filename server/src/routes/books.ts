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
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { asyncHandler } from '../middleware/error';
import { validateBody } from '../validate';
import { getAllBookProgress, getBookProgress, upsertBookProgress } from '../repositories/book-progress.repo';

const router = Router();

/** 书籍根目录: server/books */
const BOOKS_DIR = PATHS.books;

/**
 * 单章在线预览的大小上限（8MB）。
 * 章节文本远超此值说明不是正常阅读内容；该端点是公开的且不受写限流约束，
 * 若不设上限，一个异常大文件就能长时间占住事件循环。
 */
const MAX_CHAPTER_BYTES = 8 * 1024 * 1024;

/** book.json 元数据形状（字段均为可选，读取时给默认值） */
interface BookMeta {
  title?: string;
  author?: string;
  description?: string;
  cover?: string;
  volumes?: unknown;
}

/** 一本书的扫描结果：元数据 + 卷/章节树 */
interface BookEntry {
  meta: BookMeta;
  volumes: { name: string; chapters: string[] }[];
}

// ============================================================
// 每本书的 mtime 校验缓存
// ============================================================
// 列表/详情是公开端点（匿名可调），此前每请求 readFileSync(book.json) +
// 两层 readdirSync，同步磁盘 IO 占住事件循环。缓存命中只做 stat（无内容读）；
// 书目录/元数据/卷目录任一变化都会改变对应 mtime 而触发重建，无陈旧窗口。

interface BookCacheStamp {
  /** 书目录 mtime：卷增删/根章节增删会改变它 */
  dirMtimeMs: number;
  metaExists: boolean;
  metaMtimeMs: number;
  metaSize: number;
  /** 卷目录 mtime（卷内章节增删会改变它）；与 entry.volumes 内的具名卷对应 */
  volumeMtimes: { name: string; mtimeMs: number }[];
  entry: BookEntry;
}

const bookCache = new Map<string, BookCacheStamp>();

function cacheKey(booksDir: string, bookId: string): string {
  return `${booksDir}\u0000${bookId}`;
}

function readMetaFrom(bookDir: string): BookMeta {
  const metaFile = path.join(bookDir, 'book.json');
  if (fs.existsSync(metaFile)) {
    try {
      return JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
    } catch {}
  }
  return {};
}

/**
 * 读取一本书的（缓存后的）扫描结果；书目录不存在返回 null。
 * booksDir 可注入（测试用临时目录验证缓存行为），路由层统一传 BOOKS_DIR。
 */
export function getBookEntry(booksDir: string, bookId: string): BookEntry | null {
  const bookDir = path.join(booksDir, bookId);
  let dirStat: fs.Stats;
  try {
    dirStat = fs.statSync(bookDir);
    if (!dirStat.isDirectory()) return null;
  } catch {
    bookCache.delete(cacheKey(booksDir, bookId));
    return null;
  }

  const metaFile = path.join(bookDir, 'book.json');
  let metaExists = false;
  let metaMtimeMs = 0;
  let metaSize = 0;
  try {
    const metaStat = fs.statSync(metaFile);
    metaExists = true;
    metaMtimeMs = metaStat.mtimeMs;
    metaSize = metaStat.size;
  } catch {
    /* 无 book.json 是合法状态 */
  }

  const key = cacheKey(booksDir, bookId);
  const cached = bookCache.get(key);
  if (
    cached &&
    cached.dirMtimeMs === dirStat.mtimeMs &&
    cached.metaExists === metaExists &&
    cached.metaMtimeMs === metaMtimeMs &&
    cached.metaSize === metaSize
  ) {
    // 卷目录 mtime 抽查（数量与 mtime 都对上才视为有效）
    let volumesValid = cached.volumeMtimes.length === cached.entry.volumes.filter((v) => v.name).length;
    if (volumesValid) {
      for (const vol of cached.volumeMtimes) {
        try {
          if (fs.statSync(path.join(bookDir, vol.name)).mtimeMs !== vol.mtimeMs) {
            volumesValid = false;
            break;
          }
        } catch {
          volumesValid = false;
          break;
        }
      }
    }
    if (volumesValid) return cached.entry;
  }

  // 重建：读 book.json + 扫描卷/章节（同步 IO，仅失效时）
  const meta = readMetaFrom(bookDir);
  const volumes = scanBookDir(bookDir);
  const volumeMtimes: { name: string; mtimeMs: number }[] = [];
  for (const vol of volumes) {
    if (!vol.name) continue;
    try {
      volumeMtimes.push({ name: vol.name, mtimeMs: fs.statSync(path.join(bookDir, vol.name)).mtimeMs });
    } catch {
      /* 卷目录刚列出就消失的竞态：忽略，下次重建 */
    }
  }
  const entry: BookEntry = { meta, volumes };
  bookCache.set(key, {
    dirMtimeMs: dirStat.mtimeMs,
    metaExists,
    metaMtimeMs,
    metaSize,
    volumeMtimes,
    entry,
  });
  return entry;
}

/** 读取 book.json 元数据（走缓存；无则返回默认值） */
function readMeta(bookId: string): BookMeta {
  return getBookEntry(BOOKS_DIR, bookId)?.meta ?? {};
}

/** 按文件名自然排序（01- < 02- < 10-） */
const byName = (a: string, b: string) => a.localeCompare(b, 'zh-CN', { numeric: true });

/** 中文数字映射（用于卷名排序） */
const CN_NUM: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
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

/** 扫描书籍目录，返回章节文件列表（按卷分组）；仅缓存失效时执行 */
function scanBookDir(bookDir: string): { name: string; chapters: string[] }[] {
  const entries = fs
    .readdirSync(bookDir, { withFileTypes: true })
    .sort((a, b) => byVolumeName(a.name, b.name));
  const txtExt = ['.txt', '.md', '.pdf'];

  const volumes: { name: string; chapters: string[] }[] = [];
  const rootChapters: string[] = [];

  for (const entry of entries) {
    const full = path.join(bookDir, entry.name);
    if (entry.isDirectory()) {
      const files = fs
        .readdirSync(full)
        .filter((f) => txtExt.includes(path.extname(f).toLowerCase()))
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
  return volumes;
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
function coverUrl(bookId: string, meta: BookMeta | null): string | null {
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
    const books = fs
      .readdirSync(BOOKS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .flatMap((e) => {
        // 书目录在 readdir 与 getBookEntry 之间被删的竞态：entry 为 null 时跳过
        const entry = getBookEntry(BOOKS_DIR, e.name);
        if (!entry) return [];
        const chapterCount = entry.volumes.reduce((sum, v) => sum + v.chapters.length, 0);
        return [
          {
            id: e.name,
            title: entry.meta.title || e.name,
            author: entry.meta.author || '',
            description: entry.meta.description || '',
            cover: coverUrl(e.name, entry.meta),
            volumeCount: entry.volumes.length,
            chapterCount,
          },
        ];
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
  if (
    !bookDir.startsWith(path.resolve(BOOKS_DIR) + path.sep) ||
    !fs.existsSync(bookDir) ||
    !fs.statSync(bookDir).isDirectory()
  ) {
    res.status(404).json({ error: '图书不存在' });
    return;
  }
  try {
    const entry = getBookEntry(BOOKS_DIR, bookId);
    const meta = entry?.meta ?? {};
    const volumes = entry?.volumes ?? [];
    res.json({
      id: bookId,
      title: meta.title || bookId,
      author: meta.author || '',
      description: meta.description || '',
      cover: coverUrl(bookId, meta),
      volumes: volumes.map((v) => ({
        name: v.name,
        chapters: v.chapters.map((f) => ({
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
router.get('/:bookId/content', async (req: Request, res: Response) => {
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
    // 大小护栏 + 异步读：此前是无上限的 readFileSync，一个超大章节文件会把
    // 事件循环整个卡住（该端点是公开的、不受写限流约束）。
    const stat = fs.statSync(abs);
    if (stat.size > MAX_CHAPTER_BYTES) {
      res.status(413).json({ error: '章节内容过大，无法在线预览' });
      return;
    }
    const content = await fs.promises.readFile(abs, 'utf-8');
    res.type('text/plain; charset=utf-8').send(content);
  } catch (err) {
    logger.error({ err }, 'Error reading chapter');
    res.status(500).json({ error: '章节读取失败' });
  }
});

/** 把 book_progress 行映射成对外的 JSON 形状（下划线列名 → camelCase） */
function toProgressJson(row: ReturnType<typeof getBookProgress>) {
  if (!row) return null;
  return {
    bookId: row.book_id,
    chapterIndex: row.chapter_index,
    chapterFile: row.chapter_file,
    para: row.para,
    charOffset: row.char_offset,
    updatedAt: row.updated_at,
  };
}

/**
 * GET /api/books/:bookId/progress - 读云端阅读进度（需登录）
 *
 * 返回 { progress: null | { chapterIndex, chapterFile, para, charOffset, updatedAt } }。
 * progress 为 null 表示云端还没有记录（首次阅读/从未同步）。
 */
/**
 * GET /api/books/progress/all - 该用户全部图书的云端进度（需登录）
 *
 * 给列表页一次性水合用：进图书 tab 就能把所有书的「已读 N%」和
 * 继续阅读位置恢复出来，而不是要一本本点进详情才知道。
 */
router.get(
  '/progress/all',
  authMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const rows = getAllBookProgress(req.user!.id);
    res.json({ progress: rows.map(toProgressJson) });
  })
);

router.get(
  '/:bookId/progress',
  authMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const bookId = String(req.params.bookId);
    const row = getBookProgress(req.user!.id, bookId);
    res.json({ progress: toProgressJson(row) });
  })
);

/**
 * PUT /api/books/:bookId/progress - 覆盖写入云端阅读进度（需登录）
 *
 * 客户端在「退出阅读器/换章」两个时机写入（与进程内锚点同节奏），
 * last-write-wins：同一用户同一本书只保最新一条。
 */
const upsertProgressSchema = z.object({
  chapterIndex: z.number().int().min(0),
  chapterFile: z.string().max(512),
  para: z.number().int().min(0),
  charOffset: z.number().int().min(0),
});

router.put(
  '/:bookId/progress',
  authMiddleware,
  validateBody(upsertProgressSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const bookId = String(req.params.bookId);
    const row = upsertBookProgress(req.user!.id, bookId, {
      chapterIndex: req.body.chapterIndex,
      chapterFile: req.body.chapterFile,
      para: req.body.para,
      charOffset: req.body.charOffset,
    });
    res.json({ progress: toProgressJson(row) });
  })
);

export default router;
