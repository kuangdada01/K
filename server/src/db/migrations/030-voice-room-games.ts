import type { Migration } from './helpers';

const migration: Migration = {
  id: 30,
  name: 'voice_room_games',
  up: (db) => {
    // 语音房间对战象棋：终局留档（复盘数据）。对局进行中只有内存态，
    // 终局（含认输/超时/断线判负等裁决）时写入一行。
    // 玩家身份在终局时快照（访客无 users 行）；moves 为着法数组 JSON
    // （from/to/piece/captured），notations 为对应中文记谱。
    db.exec(`
      CREATE TABLE IF NOT EXISTS voice_room_games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id INTEGER NOT NULL,
        game_id TEXT NOT NULL,
        red_user_id INTEGER NOT NULL,
        black_user_id INTEGER NOT NULL,
        red_name TEXT NOT NULL,
        black_name TEXT NOT NULL,
        result TEXT NOT NULL,
        reason TEXT NOT NULL,
        move_count INTEGER NOT NULL,
        moves TEXT NOT NULL,
        notations TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_voice_room_games_room ON voice_room_games(room_id, id);
      CREATE INDEX IF NOT EXISTS idx_voice_room_games_game ON voice_room_games(game_id);
    `);
  },
};

export default migration;
