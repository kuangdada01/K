/**
 * ============================================================
 * 消息举报仓库（report.repository，2026-10-24）
 * ============================================================
 * (message_id, reporter_id) 唯一：同一条消息重复举报以第一次为准 ——
 * 举报是「把事情报到管理员面前」，不是投票；防刷也从这里开始。
 *
 * sender_id 冗余存被举报人：被举报的消息可能随后被发送者撤回
 * （字段清空、文件删除），管理员列表仍要能定位到人。
 */

import { stmt } from '../db/connection';

export interface ReportRow {
  id: number;
  message_id: number;
  reporter_id: number;
  sender_id: number;
  reason: string;
  file_sha256: string | null;
  status: 'open' | 'resolved';
  created_at: string;
  resolved_at: string | null;
  resolved_by: number | null;
}

/** 管理员列表行：举报 + 双方用户名 + 消息上下文（content/file_name 已撤回则为空） */
export interface AdminReportRow extends ReportRow {
  reporter_name: string;
  sender_name: string;
  message_content: string | null;
  message_file_name: string | null;
  message_recalled_at: string | null;
}

/** 创建举报；已举报过（同消息同人）返回 false，调用方按幂等成功处理 */
export function createReport(input: {
  messageId: number;
  reporterId: number;
  senderId: number;
  reason: string;
  fileSha256: string | null;
}): boolean {
  const result = stmt(
    `
    INSERT OR IGNORE INTO message_reports
      (message_id, reporter_id, sender_id, reason, file_sha256)
    VALUES (?, ?, ?, ?, ?)
  `
  ).run(input.messageId, input.reporterId, input.senderId, input.reason, input.fileSha256);
  return result.changes > 0;
}

/** 管理员分页列表（默认只看 open；按时间倒序，新的在前） */
export function listReports(options: { page: number; limit: number; status?: 'open' | 'resolved' | 'all' }): {
  rows: AdminReportRow[];
  total: number;
} {
  const where = options.status && options.status !== 'all' ? 'WHERE r.status = ?' : '';
  const params = options.status && options.status !== 'all' ? [options.status] : [];

  const total = (
    stmt(`SELECT COUNT(*) as n FROM message_reports r ${where}`).all(...params) as { n: number }[]
  )[0]!.n;

  const rows = stmt(
    `
    SELECT r.*,
      ru.username as reporter_name,
      su.username as sender_name,
      m.content   as message_content,
      m.file_name as message_file_name,
      m.recalled_at as message_recalled_at
    FROM message_reports r
    JOIN users ru ON ru.id = r.reporter_id
    JOIN users su ON su.id = r.sender_id
    LEFT JOIN messages m ON m.id = r.message_id
    ${where}
    ORDER BY r.id DESC
    LIMIT ? OFFSET ?
  `
  ).all(...params, options.limit, (options.page - 1) * options.limit) as AdminReportRow[];

  return { rows, total };
}

/** 按 id 取单条（处置前确认存在） */
export function getReportById(id: number): ReportRow | undefined {
  return stmt('SELECT * FROM message_reports WHERE id = ?').get(id) as ReportRow | undefined;
}

/** 标记已处理（幂等：重复 resolve 无副作用） */
export function resolveReport(id: number, adminId: number): void {
  stmt(
    `
    UPDATE message_reports
    SET status = 'resolved', resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), resolved_by = ?
    WHERE id = ?
  `
  ).run(adminId, id);
}
