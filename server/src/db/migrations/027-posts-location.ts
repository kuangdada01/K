import { addColumnIfMissing } from './helpers';
import type { Migration } from './helpers';

const migration: Migration = {
  id: 27,
  name: 'posts.location',
  up: (db) => {
    // 发帖时的位置（客户端文本输入的地点名，如「深圳·南山」）。
    // 用 DEFAULT '' 而不是 NULL：全链路（zod 默认值 / Kotlin 的 String）都以空串表示"没填"，
    // 少一层 null 判断，也就少一处"前端显示 null"的机会。
    addColumnIfMissing(db, 'posts', 'location', "location TEXT DEFAULT ''");
  },
};

export default migration;
