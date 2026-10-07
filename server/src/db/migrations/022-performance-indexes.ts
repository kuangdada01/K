import { tableExists } from './helpers';
import type { Migration } from './helpers';

const migration: Migration = {
  id: 22,
  name: 'performance_indexes',
  up: (db) => {
    // P1 修复：为高频查询路径补齐 6 个关键索引，消除全表扫描。
    // 各表可能不存在（迁移测试用最小 schema 运行），逐表守卫保证幂等安全。
    if (tableExists(db, 'notifications')) {
      // 管理删帖/删评论时清理通知（admin.repo.ts:103、comment.repo.ts:83 的递归 CTE）
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_notifications_post_id ON notifications(post_id);
        CREATE INDEX IF NOT EXISTS idx_notifications_comment_id ON notifications(comment_id);
      `);
    }
    if (tableExists(db, 'verification_codes')) {
      // 每次登录/发码都按 email 查验证码（auth.repo.ts:27-49）
      db.exec(`CREATE INDEX IF NOT EXISTS idx_verification_codes_email ON verification_codes(email);`);
    }
    if (tableExists(db, 'messages')) {
      // 会话列表对每个 partner 跑相关子查询（message.repo.ts:34-62）
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_messages_sender_receiver_created ON messages(sender_id, receiver_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_messages_receiver_sender_read ON messages(receiver_id, sender_id, read);
      `);
    }
    if (tableExists(db, 'comments')) {
      // 评论树递归展开（comment.repo.ts:84-91）
      db.exec(`CREATE INDEX IF NOT EXISTS idx_comments_parent_id ON comments(parent_id);`);
    }
    // 顺带修复：清理过期验证码（表只增不减；expires 存 ISO-8601，用 datetime 比较）
    if (tableExists(db, 'verification_codes')) {
      db.exec(`DELETE FROM verification_codes WHERE datetime(expires) < datetime('now')`);
    }
  },
};

export default migration;
