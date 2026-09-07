import { hasColumn, tableExists } from './helpers';
import type { Migration } from './helpers';

const migration: Migration = {
  id: 13,
  name: 'timestamps_iso_utc',
  up: (db) => {
    // 历史数据格式 'YYYY-MM-DD HH:MM:SS' → ISO-8601 UTC 'YYYY-MM-DDTHH:MM:SS.000Z'
    // GLOB 精确匹配旧格式，避免重复转换或误伤已有 ISO 值
    const LEGACY = '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]';
    const tables: { table: string; column: string }[] = [
      { table: 'users', column: 'created_at' },
      { table: 'verification_codes', column: 'created_at' },
      { table: 'announcements', column: 'created_at' },
      { table: 'announcement_reads', column: 'read_at' },
      { table: 'posts', column: 'created_at' },
      { table: 'likes', column: 'created_at' },
      { table: 'comments', column: 'created_at' },
      { table: 'messages', column: 'created_at' },
      { table: 'notifications', column: 'created_at' },
      { table: 'comment_likes', column: 'created_at' },
      { table: 'friends', column: 'created_at' },
      { table: 'private_images', column: 'created_at' },
      { table: 'shares', column: 'created_at' },
      { table: 'bookmarks', column: 'created_at' },
      { table: 'reposts', column: 'created_at' },
      { table: 'schema_migrations', column: 'applied_at' },
    ];
    for (const { table, column } of tables) {
      if (!tableExists(db, table) || !hasColumn(db, table, column)) continue;
      db.prepare(
        `UPDATE ${table} SET ${column} = replace(${column}, ' ', 'T') || '.000Z' WHERE ${column} GLOB ?`
      ).run(LEGACY);
    }
  },
};

export default migration;
