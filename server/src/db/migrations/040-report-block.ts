import type { Migration } from './helpers';

/**
 * 举报与拉黑（2026-10-24，私信文件类型放开后的配套处置通道）。
 *
 * message_reports：
 *  · 一条举报 = (message_id, reporter_id) 唯一，重复举报以第一次为准（防刷）；
 *  · sender_id 冗余存被举报人 —— 管理员列表一次 JOIN 就能出全量上下文，
 *    且消息被删除（撤回留痕仍在，但字段已清空）后依然能定位到人；
 *  · file_sha256：文件消息落盘内容的哈希，举报时由服务端现算 ——
 *    同一个恶意包换个名字再发，哈希相同，管理员一眼看出是惯犯；
 *  · status：open（待处理）/ resolved（已处理，dismiss 与删消息都算）。
 *
 * user_blocks：
 *  · (blocker_id, blocked_id) 主键，单向关系；
 *  · 拉黑后**双向**都不能再发私信（发消息服务按两个方向各查一次），
 *    已有消息保留（解除拉黑还能看），会话列表仍显示（否则没有解除入口）。
 */
const migration: Migration = {
  id: 40,
  name: 'messages.report-block',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS message_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL,
        reporter_id INTEGER NOT NULL,
        sender_id INTEGER NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        file_sha256 TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        resolved_at TEXT,
        resolved_by INTEGER,
        UNIQUE(message_id, reporter_id)
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_blocks (
        blocker_id INTEGER NOT NULL,
        blocked_id INTEGER NOT NULL,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (blocker_id, blocked_id)
      )
    `);
  },
};

export default migration;
