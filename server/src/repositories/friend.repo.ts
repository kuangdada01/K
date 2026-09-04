/**
 * ============================================================
 * 好友/关注仓库（friend.repository）
 * ============================================================
 */

import { getDb } from '../db/connection';
import { count } from '../db/helpers';

export interface FriendUserRow {
  id: number;
  username: string;
  avatar: string | null;
  bio: string;
  is_following?: number;
}

/** 搜索用户（用户名模糊或精确 ID 匹配，最多20条） */
export function searchUsers(keyword: string, userId: number): FriendUserRow[] {
  const escapedKeyword = keyword.trim().replace(/[%_]/g, '\\$&');
  const likePattern = `%${escapedKeyword}%`;
  return getDb().prepare(`
    SELECT u.id, u.username, u.avatar, u.bio,
      EXISTS(SELECT 1 FROM friends WHERE user_id = ? AND friend_id = u.id) as is_following
    FROM users u
    WHERE u.id != ?
      AND (u.username LIKE ? ESCAPE '\\' OR CAST(u.id AS TEXT) = ?)
    LIMIT 20
  `).all(userId, userId, likePattern, keyword.trim()) as FriendUserRow[];
}

/** 查询关注状态 */
export function isFollowing(userId: number, targetId: number): boolean {
  return !!getDb().prepare('SELECT 1 FROM friends WHERE user_id = ? AND friend_id = ?').get(userId, targetId);
}

/** 目标用户是否存在 */
export function userExists(userId: number): boolean {
  return !!getDb().prepare('SELECT id FROM users WHERE id = ?').get(userId);
}

/** 关注（INSERT OR IGNORE 防重复），返回目标用户粉丝数 */
export function follow(userId: number, targetId: number): number {
  getDb().prepare('INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)').run(userId, targetId);
  return countFollowers(targetId);
}

/** 取消关注，返回目标用户粉丝数 */
export function unfollow(userId: number, targetId: number): number {
  getDb().prepare('DELETE FROM friends WHERE user_id = ? AND friend_id = ?').run(userId, targetId);
  return countFollowers(targetId);
}

function countFollowers(targetId: number): number {
  return count('SELECT COUNT(*) as count FROM friends WHERE friend_id = ?', targetId);
}

/** 粉丝列表（谁关注了 target） */
export function listFollowers(targetId: number, viewerId: number): FriendUserRow[] {
  return getDb().prepare(`
    SELECT u.id, u.username, u.avatar, u.bio,
      EXISTS(SELECT 1 FROM friends WHERE user_id = ? AND friend_id = u.id) as is_following
    FROM friends f
    JOIN users u ON u.id = f.user_id
    WHERE f.friend_id = ?
    ORDER BY u.username ASC
  `).all(viewerId, targetId) as FriendUserRow[];
}

/** 关注列表（target 关注了谁） */
export function listFollowing(targetId: number, viewerId: number): FriendUserRow[] {
  return getDb().prepare(`
    SELECT u.id, u.username, u.avatar, u.bio,
      EXISTS(SELECT 1 FROM friends WHERE user_id = ? AND friend_id = u.id) as is_following
    FROM friends f
    JOIN users u ON u.id = f.friend_id
    WHERE f.user_id = ?
    ORDER BY u.username ASC
  `).all(viewerId, targetId) as FriendUserRow[];
}

/** 随机推荐（登录用户排除已关注，游客纯随机；最多5条） */
export function listRecommended(userId?: number): FriendUserRow[] {
  if (userId) {
    return getDb().prepare(`
      SELECT u.id, u.username, u.avatar
      FROM users u
      WHERE u.id != ?
        AND u.id NOT IN (SELECT friend_id FROM friends WHERE user_id = ?)
      ORDER BY RANDOM()
      LIMIT 5
    `).all(userId, userId) as FriendUserRow[];
  }
  return getDb().prepare(`
    SELECT u.id, u.username, u.avatar
    FROM users u
    ORDER BY RANDOM()
    LIMIT 5
  `).all() as FriendUserRow[];
}

/** 当前用户关注列表（按用户名排序） */
export function listMyFollowing(userId: number): FriendUserRow[] {
  return getDb().prepare(`
    SELECT u.id, u.username, u.avatar, u.bio
    FROM friends f
    JOIN users u ON u.id = f.friend_id
    WHERE f.user_id = ?
    ORDER BY u.username ASC
  `).all(userId) as FriendUserRow[];
}
