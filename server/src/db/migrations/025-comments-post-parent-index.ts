import { tableExists } from './helpers';
import type { Migration } from './helpers';

const migration: Migration = {
  id: 25,
  name: 'comments_post_parent_index',
  up: (db) => {
    // 评论回复分页（comment.repo.ts 的 listCommentsPaged）按
    //   WHERE c.post_id = ? AND c.parent_id IN (...)
    // 取某帖下若干顶级评论的回复。既有索引是两条单列
    // （idx_comments_post_id、idx_comments_parent_id），SQLite 只能用其中一条
    // 再回表过滤另一列；热帖上等于对每条分页都扫一遍该帖全部评论。
    // 补一条覆盖组合谓词的复合索引。
    if (tableExists(db, 'comments')) {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_comments_post_parent ON comments(post_id, parent_id);`);
    }
  },
};

export default migration;
