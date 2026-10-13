import type { Migration } from './helpers';

const migration: Migration = {
  id: 34,
  name: 'push_devices',
  up: (db) => {
    // 厂商离线推送的设备注册表（见 schema.ts 同名表的注释）。
    // 老库补建；新库由 createSchema 直接建好 —— 两边 DDL 必须一致。
    db.exec(`
      CREATE TABLE IF NOT EXISTS push_devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        provider TEXT NOT NULL DEFAULT 'oppo',
        token TEXT NOT NULL,
        package_name TEXT DEFAULT NULL,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(provider, token),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_push_devices_user ON push_devices(user_id);
    `);
  },
};

export default migration;
