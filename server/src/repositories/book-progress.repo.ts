/**
 * ============================================================
 * 图书阅读进度仓库（book-progress.repository）
 * ============================================================
 * 「云端记忆」的数据层：登录用户读到哪了（章 + 页首行的段/字符位置）。
 * 重装 App / 换设备后登录，客户端用它恢复到上次的位置。
 *
 * last-write-wins：每用户每本书只有一条（主键去重），客户端在
 * 退出阅读器/换章两个时机覆盖写入 —— 与进程内锚点的保存节奏一致。
 */

import { stmt } from '../db/connection';

/** book_progress 表行 */
export interface BookProgressRow {
  user_id: number;
  book_id: string;
  chapter_index: number;
  chapter_file: string;
  para: number;
  char_offset: number;
  updated_at: string;
}

/** 读取某用户某本书的阅读进度（没有则 undefined） */
export function getBookProgress(userId: number, bookId: string): BookProgressRow | undefined {
  return stmt('SELECT * FROM book_progress WHERE user_id = ? AND book_id = ?').get(userId, bookId) as
    BookProgressRow | undefined;
}

/** 该用户**全部**图书的云端进度（列表页一次性水合用，按更新时间倒序） */
export function getAllBookProgress(userId: number): BookProgressRow[] {
  return stmt('SELECT * FROM book_progress WHERE user_id = ? ORDER BY updated_at DESC').all(
    userId
  ) as BookProgressRow[];
}

/** 覆盖写入阅读进度，返回写入后的行 */
export function upsertBookProgress(
  userId: number,
  bookId: string,
  input: { chapterIndex: number; chapterFile: string; para: number; charOffset: number }
): BookProgressRow {
  stmt(`
    INSERT INTO book_progress (user_id, book_id, chapter_index, chapter_file, para, char_offset)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, book_id) DO UPDATE SET
      chapter_index = excluded.chapter_index,
      chapter_file = excluded.chapter_file,
      para = excluded.para,
      char_offset = excluded.char_offset,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run(userId, bookId, input.chapterIndex, input.chapterFile, input.para, input.charOffset);
  return getBookProgress(userId, bookId)!;
}
