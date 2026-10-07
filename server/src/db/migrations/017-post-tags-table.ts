import { extractTags } from '@k/shared';
import { tableExists } from './helpers';
import type { Migration } from './helpers';

const migration: Migration = {
  id: 17,
  name: 'post_tags_table',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS post_tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id INTEGER NOT NULL,
        tag TEXT NOT NULL,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(post_id, tag),
        FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_post_tags_tag ON post_tags(tag);
      CREATE INDEX IF NOT EXISTS idx_post_tags_post_id ON post_tags(post_id);
    `);
    // 回填：解析存量帖子 description 中的 #话题（幂等，UNIQUE 冲突时忽略）
    if (tableExists(db, 'posts')) {
      const posts = db.prepare('SELECT id, description FROM posts').all() as {
        id: number;
        description: string | null;
      }[];
      const insert = db.prepare('INSERT OR IGNORE INTO post_tags (post_id, tag) VALUES (?, ?)');
      const insertAll = db.transaction((rows: { id: number; tags: string[] }[]) => {
        for (const row of rows) {
          for (const tag of row.tags) insert.run(row.id, tag);
        }
      });
      const rows = posts
        .map((p) => ({ id: p.id, tags: extractTags(p.description || '') }))
        .filter((r) => r.tags.length > 0);
      if (rows.length > 0) insertAll(rows);
    }
  },
};

export default migration;
