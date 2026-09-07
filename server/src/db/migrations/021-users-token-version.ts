import { addColumnIfMissing } from './helpers';
import type { Migration } from './helpers';

const migration: Migration = {
  id: 21,
  name: 'users.token_version',
  up: (db) => {
    // 令牌版本：改密/重置密码时 +1，使已签发的 JWT（7 天有效期）全部失效
    addColumnIfMissing(db, 'users', 'token_version', 'token_version INTEGER NOT NULL DEFAULT 0');
  },
};

export default migration;
