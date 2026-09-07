import type { Migration } from './helpers';

const migration: Migration = {
  id: 16,
  name: 'reposts_table',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS reposts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        post_id INTEGER NOT NULL,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(user_id, post_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_reposts_user_id ON reposts(user_id);
      CREATE INDEX IF NOT EXISTS idx_reposts_post_id ON reposts(post_id);
    `);
  },
};

export default migration;
