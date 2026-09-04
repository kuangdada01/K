/**
 * 迁移测试：旧数据时间格式 → ISO-8601 UTC
 */

import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { applyMigrations, ensureMigrationTable } from '../src/db/migrations';

/** 构造一个仅含 legacy 时间列的旧库 */
function createLegacyDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      avatar TEXT DEFAULT NULL,
      bio TEXT DEFAULT '',
      role TEXT DEFAULT 'user',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      image_url TEXT NOT NULL,
      title TEXT DEFAULT '',
      description TEXT DEFAULT '',
      close_comments INTEGER DEFAULT 0,
      pinned INTEGER DEFAULT 0,
      video_url TEXT DEFAULT NULL,
      video_cover TEXT DEFAULT NULL,
      share_count INTEGER DEFAULT 0,
      repost_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
  return db;
}

describe('迁移 timestamps_iso_utc (id 13)', () => {
  it('把 legacy "YYYY-MM-DD HH:MM:SS" 转换为 ISO-8601 UTC', () => {
    const db = createLegacyDb();
    db.exec(`
      INSERT INTO users (username, email, password_hash, created_at) VALUES ('a', 'a@t.com', 'x', '2026-08-13 14:29:12');
      INSERT INTO posts (user_id, image_url, created_at) VALUES (1, '[]', '2025-01-02 03:04:05');
    `);
    ensureMigrationTable(db);
    applyMigrations(db);

    const u = db.prepare('SELECT created_at FROM users WHERE id = 1').get() as { created_at: string };
    const p = db.prepare('SELECT created_at FROM posts WHERE id = 1').get() as { created_at: string };
    expect(u.created_at).toBe('2026-08-13T14:29:12.000Z');
    expect(p.created_at).toBe('2025-01-02T03:04:05.000Z');
    // 字符串排序语义正确：ISO 时间可直接比较
    const cmp = db.prepare("SELECT (? > ?) as v").get(p.created_at, u.created_at) as { v: number };
    expect(cmp.v).toBe(0);
  });

  it('幂等：已转换的数据不受影响，重复执行不报错', () => {
    const db = createLegacyDb();
    db.exec(`INSERT INTO users (username, email, password_hash, created_at) VALUES ('a', 'a@t.com', 'x', '2026-08-13 14:29:12');`);
    ensureMigrationTable(db);
    applyMigrations(db);
    applyMigrations(db); // 第二次执行：全部已应用，直接跳过
    const u = db.prepare('SELECT created_at FROM users WHERE id = 1').get() as { created_at: string };
    expect(u.created_at).toBe('2026-08-13T14:29:12.000Z');
  });
});
