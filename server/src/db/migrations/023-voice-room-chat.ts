import { addColumnIfMissing, tableExists } from './helpers';
import type { Migration } from './helpers';

const migration: Migration = {
  id: 23,
  name: 'voice_room_chat',
  up: (db) => {
    // 语音房间文本聊天 + 创建者快照（guest 可建房，建房间时把创建者信息冗余到房间表，
    // 不再依赖 JOIN users —— 游客创建者没有 users 行；creator_id 仍保留 FK 语义）
    if (tableExists(db, 'voice_rooms')) {
      addColumnIfMissing(db, 'voice_rooms', 'creator_name', "creator_name TEXT DEFAULT ''");
      addColumnIfMissing(db, 'voice_rooms', 'creator_avatar', 'creator_avatar TEXT DEFAULT NULL');
      // creator_ip 仅用于校验游客房主身份（guestIds 只在内存中，重启即丢），永不返回给前端
      addColumnIfMissing(db, 'voice_rooms', 'creator_ip', 'creator_ip TEXT DEFAULT NULL');
      // 回填存量房间的创建者快照（仅限已登录创建者；游客创建者不存在存量）
      db.exec(`
        UPDATE voice_rooms SET
          creator_name = COALESCE((SELECT username FROM users WHERE users.id = voice_rooms.creator_id), ''),
          creator_avatar = (SELECT avatar FROM users WHERE users.id = voice_rooms.creator_id)
        WHERE creator_id > 0 AND (creator_name IS NULL OR creator_name = '');
      `);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS voice_room_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id INTEGER NOT NULL,
        sender_id INTEGER NOT NULL,
        username TEXT NOT NULL,
        avatar TEXT DEFAULT NULL,
        content TEXT NOT NULL,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_voice_room_messages_room ON voice_room_messages(room_id, id);
    `);
  },
};

export default migration;
