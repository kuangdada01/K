import type { Migration } from './helpers';

const migration: Migration = {
  id: 33,
  name: 'posts_feed_cursor_index',
  up: (db) => {
    // P2-4.3：信息流游标分页的匹配索引。
    // 游标条件是 (created_at < ?) OR (created_at = ? AND id < ?)，排序 created_at DESC, id DESC ——
    // 复合索引两列同序才能同时满足过滤与排序（EXPLAIN 见 feed-cursor-pagination 测试）。
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_posts_feed_cursor ON posts(created_at DESC, id DESC);
    `);
  },
};

export default migration;
