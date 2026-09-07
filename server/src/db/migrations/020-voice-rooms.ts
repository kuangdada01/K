import type { Migration } from './helpers';

const migration: Migration = {
  id: 20,
  name: 'voice_rooms',
  up: (db) => {
    // 语音房间表（新库已由 createSchema 直接建表，此处为老库升级，幂等）
    db.exec(`
      CREATE TABLE IF NOT EXISTS voice_rooms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        creator_id INTEGER NOT NULL,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_voice_rooms_creator ON voice_rooms(creator_id);
    `);
  },
};

export default migration;
