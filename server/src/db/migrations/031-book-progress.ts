import type { Migration } from './helpers';

const migration: Migration = {
  id: 31,
  name: 'book_progress',
  up: (db) => {
    // 图书「云端记忆」：登录用户的阅读进度（读到第几章、页首行的段/字符位置）。
    // 重装 App / 换设备后登录即可从上次的位置继续读，不再从章首开始。
    // - (user_id, book_id) 主键：每用户每本书只保最新一条，重复写直接覆盖（last-write-wins）
    // - chapter_file 冗余存章节相对路径：章节列表重排后客户端可用它二次校准
    // - para/char_offset：页首行在章节里的 (段下标, 段内字符偏移)，与安卓端锚点语义一致
    db.exec(`
      CREATE TABLE IF NOT EXISTS book_progress (
        user_id INTEGER NOT NULL,
        book_id TEXT NOT NULL,
        chapter_index INTEGER NOT NULL DEFAULT 0,
        chapter_file TEXT NOT NULL DEFAULT '',
        para INTEGER NOT NULL DEFAULT 0,
        char_offset INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (user_id, book_id)
      );
    `);
  },
};

export default migration;
