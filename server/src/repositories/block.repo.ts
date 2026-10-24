/**
 * ============================================================
 * 拉黑仓库（block.repository，2026-10-24）
 * ============================================================
 * 单向拉黑关系（user_blocks）。拉黑后**双向**都不能再发私信
 * （message.service 按「我拉黑了 TA」「TA 拉黑了我」各查一次），
 * 已有消息保留 —— 会话列表仍显示这条会话，否则用户会失去解除拉黑的入口。
 */

import { stmt } from '../db/connection';

/** 拉黑（幂等：重复拉黑无副作用） */
export function block(blockerId: number, blockedId: number): void {
  stmt('INSERT OR IGNORE INTO user_blocks (blocker_id, blocked_id) VALUES (?, ?)').run(blockerId, blockedId);
}

/** 解除拉黑（幂等） */
export function unblock(blockerId: number, blockedId: number): void {
  stmt('DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?').run(blockerId, blockedId);
}

/** 我是否拉黑了对方 */
export function isBlocked(blockerId: number, blockedId: number): boolean {
  return !!stmt('SELECT 1 FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?').get(
    blockerId,
    blockedId
  );
}

/** 我拉黑的全部用户 id（客户端会话页判断要不要画「已拉黑」横幅） */
export function listBlockedBy(userId: number): number[] {
  const rows = stmt('SELECT blocked_id FROM user_blocks WHERE blocker_id = ?').all(userId) as {
    blocked_id: number;
  }[];
  return rows.map((r) => r.blocked_id);
}
