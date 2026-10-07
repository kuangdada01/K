import { tableExists } from './helpers';
import type { Migration } from './helpers';

const migration: Migration = {
  id: 24,
  name: 'voice_rooms_drop_creator_fk',
  up: (db) => {
    // 语音房支持未登录访客创建后，creator_id 不再是 users 外键：
    // 访客创建者没有 users 行（且负数/0 id 都会撞外键约束，生产库
    // PRAGMA foreign_keys=ON 会拒绝写入）。房间改由"创建者/管理员显式删除"
    // 管理生命周期（与访客房、聊天记录随房清理语义一致），不再随用户删除级联。
    // 重建表结构（SQLite 无 DROP CONSTRAINT；本表无其它表的 FK 引用，
    // foreign_keys=ON 下 DROP/重建安全，applyMigrations 已在事务中包裹）。
    if (tableExists(db, 'voice_rooms')) {
      db.exec(`
        CREATE TABLE voice_rooms_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          description TEXT DEFAULT '',
          creator_id INTEGER NOT NULL,
          creator_name TEXT DEFAULT '',
          creator_avatar TEXT DEFAULT NULL,
          creator_ip TEXT DEFAULT NULL,
          created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        INSERT INTO voice_rooms_new (id, name, description, creator_id, creator_name, creator_avatar, creator_ip, created_at)
          SELECT id, name, description, creator_id, creator_name, creator_avatar, creator_ip, created_at FROM voice_rooms;
        DROP TABLE voice_rooms;
        ALTER TABLE voice_rooms_new RENAME TO voice_rooms;
        CREATE INDEX IF NOT EXISTS idx_voice_rooms_creator ON voice_rooms(creator_id);
      `);
    }
  },
};

export default migration;
