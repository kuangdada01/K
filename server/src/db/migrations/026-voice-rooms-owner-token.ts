import { addColumnIfMissing } from './helpers';
import type { Migration } from './helpers';

const migration: Migration = {
  id: 26,
  name: 'voice_rooms_owner_token',
  up: (db) => {
    // 访客房间的所有权此前以**来源 IP** 为唯一锚点（creator_ip）：
    // 同一 NAT 后的两个人互相能删对方的房间；换 IP（切网/重连）则丢掉自己的房间。
    // 改为「创建时签发房间级令牌」，客户端保存并在删除/清聊天时带上。
    //
    // 存量访客房间（该列为 NULL）继续按 IP 判定 —— 这些房间是临时的（无 TTL 但也有
    // 5 间/创建者上限），无法回溯补发令牌，回退到旧行为比让它们变成谁都删不掉更合理。
    addColumnIfMissing(db, 'voice_rooms', 'owner_token', 'owner_token TEXT DEFAULT NULL');
  },
};

export default migration;
