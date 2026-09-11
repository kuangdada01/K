/**
 * ============================================================
 * 好友/关注仓库（friend.repository）
 * ============================================================
 */

import { stmt } from '../db/connection';
import { count, escapeLike } from '../db/helpers';
import { HARD_LIST_CAP, capRows, probeLimit } from '../lib/listLimits';

export interface FriendUserRow {
  id: number;
  username: string;
  avatar: string | null;
  bio: string;
  is_following?: number;
}

/** 搜索用户（用户名模糊或精确 ID 匹配，最多20条） */
export function searchUsers(keyword: string, userId: number): FriendUserRow[] {
  const escapedKeyword = escapeLike(keyword.trim());
  const likePattern = `%${escapedKeyword}%`;
  return stmt(
    `
    SELECT u.id, u.username, u.avatar, u.bio,
      EXISTS(SELECT 1 FROM friends WHERE user_id = ? AND friend_id = u.id) as is_following
    FROM users u
    WHERE u.id != ?
      AND (u.username LIKE ? ESCAPE '\\' OR CAST(u.id AS TEXT) = ?)
    LIMIT 20
  `
  ).all(userId, userId, likePattern, keyword.trim()) as FriendUserRow[];
}

/** 查询关注状态 */
export function isFollowing(userId: number, targetId: number): boolean {
  return !!stmt('SELECT 1 FROM friends WHERE user_id = ? AND friend_id = ?').get(userId, targetId);
}

/** 目标用户是否存在 */
export function userExists(userId: number): boolean {
  return !!stmt('SELECT id FROM users WHERE id = ?').get(userId);
}

/** 关注（INSERT OR IGNORE 防重复），返回目标用户粉丝数 */
export function follow(userId: number, targetId: number): number {
  stmt('INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)').run(userId, targetId);
  return countFollowers(targetId);
}

/** 取消关注，返回目标用户粉丝数 */
export function unfollow(userId: number, targetId: number): number {
  stmt('DELETE FROM friends WHERE user_id = ? AND friend_id = ?').run(userId, targetId);
  return countFollowers(targetId);
}

function countFollowers(targetId: number): number {
  return count('SELECT COUNT(*) as count FROM friends WHERE friend_id = ?', targetId);
}

/** 粉丝列表（谁关注了 target）；硬上限见 HARD_LIST_CAP，`has_more` 表示被截断 */
export function listFollowers(
  targetId: number,
  viewerId: number,
  cap: number = HARD_LIST_CAP
): { rows: FriendUserRow[]; has_more: boolean } {
  const raw = stmt(
    `
    SELECT u.id, u.username, u.avatar, u.bio,
      EXISTS(SELECT 1 FROM friends WHERE user_id = ? AND friend_id = u.id) as is_following
    FROM friends f
    JOIN users u ON u.id = f.user_id
    WHERE f.friend_id = ?
    ORDER BY u.username ASC, u.id ASC
    LIMIT ?
  `
  ).all(viewerId, targetId, probeLimit(cap)) as FriendUserRow[];
  return capRows(raw, cap);
}

/**
 * 粉丝/关注列表的服务端搜索条件：用户名模糊 + ID 子串。
 *
 * 字段集合与弹窗**原来的本地过滤**一致 —— 但那边只过滤了 `username`，
 * 这里额外加上 ID 子串：搜索框的占位符写的是「搜索用户名」，而弹窗列表里
 * 每行本来也没有露出 ID，所以 ID 分支是纯增益（不会让原本命中变少）。
 * LIKE 通配符经 escapeLike 转义。
 */
function friendSearchWhere(q: string): { sql: string; params: string[] } {
  const keyword = q.trim();
  if (!keyword) return { sql: '', params: [] };
  const like = `%${escapeLike(keyword)}%`;
  return {
    sql: "AND (u.username LIKE ? ESCAPE '\\' OR CAST(u.id AS TEXT) LIKE ? ESCAPE '\\')",
    params: [like, like],
  };
}

/**
 * 粉丝列表（服务端搜索 + 分页）。
 *
 * 老实现是「取回最多 HARD_LIST_CAP 行 + 弹窗里本地过滤」：粉丝超过上限的账号，
 * 那些粉丝**在搜索框里根本不存在**（搜不到 → 也关注/取关不了）。
 * 排序与老实现一致（`u.username ASC, u.id ASC`），并用同样的排序做 OFFSET 分页 ——
 * 用户名+id 唯一，翻页不会重复或漏行。
 */
export function listFollowersPage(
  targetId: number,
  viewerId: number,
  opts: { q?: string; page: number; limit: number }
): { rows: FriendUserRow[]; total: number } {
  const { q = '', page, limit } = opts;
  const { sql, params } = friendSearchWhere(q);
  const total = count(
    `SELECT COUNT(*) as count FROM friends f JOIN users u ON u.id = f.user_id WHERE f.friend_id = ? ${sql}`,
    targetId,
    ...params
  );
  const rows = stmt(
    `
    SELECT u.id, u.username, u.avatar, u.bio,
      EXISTS(SELECT 1 FROM friends WHERE user_id = ? AND friend_id = u.id) as is_following
    FROM friends f
    JOIN users u ON u.id = f.user_id
    WHERE f.friend_id = ? ${sql}
    ORDER BY u.username ASC, u.id ASC
    LIMIT ? OFFSET ?
  `
  ).all(viewerId, targetId, ...params, limit, (page - 1) * limit) as FriendUserRow[];
  return { rows, total };
}

/** 关注列表（服务端搜索 + 分页），语义与 listFollowersPage 对称 */
export function listFollowingPage(
  targetId: number,
  viewerId: number,
  opts: { q?: string; page: number; limit: number }
): { rows: FriendUserRow[]; total: number } {
  const { q = '', page, limit } = opts;
  const { sql, params } = friendSearchWhere(q);
  const total = count(
    `SELECT COUNT(*) as count FROM friends f JOIN users u ON u.id = f.friend_id WHERE f.user_id = ? ${sql}`,
    targetId,
    ...params
  );
  const rows = stmt(
    `
    SELECT u.id, u.username, u.avatar, u.bio,
      EXISTS(SELECT 1 FROM friends WHERE user_id = ? AND friend_id = u.id) as is_following
    FROM friends f
    JOIN users u ON u.id = f.friend_id
    WHERE f.user_id = ? ${sql}
    ORDER BY u.username ASC, u.id ASC
    LIMIT ? OFFSET ?
  `
  ).all(viewerId, targetId, ...params, limit, (page - 1) * limit) as FriendUserRow[];
  return { rows, total };
}

/** 关注列表（target 关注了谁）；硬上限同上 */
export function listFollowing(
  targetId: number,
  viewerId: number,
  cap: number = HARD_LIST_CAP
): { rows: FriendUserRow[]; has_more: boolean } {
  const raw = stmt(
    `
    SELECT u.id, u.username, u.avatar, u.bio,
      EXISTS(SELECT 1 FROM friends WHERE user_id = ? AND friend_id = u.id) as is_following
    FROM friends f
    JOIN users u ON u.id = f.friend_id
    WHERE f.user_id = ?
    ORDER BY u.username ASC, u.id ASC
    LIMIT ?
  `
  ).all(viewerId, targetId, probeLimit(cap)) as FriendUserRow[];
  return capRows(raw, cap);
}

/** 随机推荐（登录用户排除已关注，游客纯随机；最多5条） */
export function listRecommended(userId?: number): FriendUserRow[] {
  if (userId) {
    return stmt(
      `
      SELECT u.id, u.username, u.avatar
      FROM users u
      WHERE u.id != ?
        AND u.id NOT IN (SELECT friend_id FROM friends WHERE user_id = ?)
      ORDER BY RANDOM()
      LIMIT 5
    `
    ).all(userId, userId) as FriendUserRow[];
  }
  return stmt(
    `
    SELECT u.id, u.username, u.avatar
    FROM users u
    ORDER BY RANDOM()
    LIMIT 5
  `
  ).all() as FriendUserRow[];
}

/** 当前用户关注列表（按用户名排序） */
export function listMyFollowing(userId: number): FriendUserRow[] {
  return stmt(
    `
    SELECT u.id, u.username, u.avatar, u.bio
    FROM friends f
    JOIN users u ON u.id = f.friend_id
    WHERE f.user_id = ?
    ORDER BY u.username ASC
  `
  ).all(userId) as FriendUserRow[];
}
