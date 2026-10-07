import { addColumnIfMissing } from './helpers';
import type { Migration } from './helpers';

const migration: Migration = {
  id: 29,
  name: 'voice_rooms.cover_url',
  up: (db) => {
    // 语音房间封面（创建房间时上传的图片 URL，如 /uploads/voice-covers/cover-….jpg）。
    // 用 DEFAULT NULL 而不是 ''：老房间没有封面，列表端按 null 回落到占位横幅。
    addColumnIfMissing(db, 'voice_rooms', 'cover_url', 'cover_url TEXT DEFAULT NULL');
  },
};

export default migration;
