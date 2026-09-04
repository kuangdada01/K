/**
 * ============================================================
 * 管理后台仓库（admin.repository）
 * ============================================================
 */

import { getDb } from '../db/connection';
import { count } from '../db/helpers';

/** 用户管理行（含帖子数） */
export interface AdminUserRow {
  id: number;
  username: string;
  email: string;
  avatar: string | null;
  bio: string;
  role: string;
  banned_until: string | null;
  created_at: string;
  post_count: number;
}

/** 所有用户列表（含帖子数） */
export function listUsers(): AdminUserRow[] {
  return getDb().prepare(`
    SELECT u.id, u.username, u.email, u.avatar, u.bio, u.role, u.banned_until, u.created_at,
      (SELECT COUNT(*) FROM posts WHERE user_id = u.id) as post_count
    FROM users u ORDER BY u.id ASC
  `).all() as AdminUserRow[];
}

/** 搜索用户（按用户名或ID，最多10条，用于公告指定用户等场景） */
export function searchUsers(q: string): { id: number; username: string; avatar: string | null }[] {
  const isId = /^\d+$/.test(q);
  // 统一转义 LIKE 通配符并配合 ESCAPE 子句（B3 修复：含 %/_ 的用户名可正确匹配）
  const escaped = q.replace(/[%_\\]/g, '\\$&');
  const likePattern = `%${escaped}%`;
  if (isId) {
    return getDb().prepare(
      'SELECT id, username, avatar FROM users WHERE id = ? OR username LIKE ? ESCAPE \'\\\' LIMIT 10'
    ).all(parseInt(q), likePattern) as { id: number; username: string; avatar: string | null }[];
  }
  return getDb().prepare(
    'SELECT id, username, avatar FROM users WHERE username LIKE ? ESCAPE \'\\\' LIMIT 10'
  ).all(likePattern) as { id: number; username: string; avatar: string | null }[];
}

/** 按 ID 查用户（含 email，删除/重置密码用） */
export function findUser(userId: number): { id: number; email: string } | undefined {
  return getDb().prepare('SELECT id, email FROM users WHERE id = ?').get(userId) as { id: number; email: string } | undefined;
}

/** 查询用户角色（封禁前置校验: 不能封禁管理员） */
export function getUserRole(userId: number): string | undefined {
  const row = getDb().prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role: string } | undefined;
  return row?.role;
}

/** 删除用户（外键级联删除关联数据）+ 清理验证码记录 */
export function deleteUser(userId: number, email: string): void {
  getDb().prepare('DELETE FROM users WHERE id = ?').run(userId);
  getDb().prepare('DELETE FROM verification_codes WHERE email = ?').run(email);
}

/** 重置用户密码（同时递增 token_version，使该用户已签发的 JWT 全部失效） */
export function resetUserPassword(userId: number, passwordHash: string): void {
  getDb().prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(passwordHash, userId);
}

/** 管理视图帖子行 */
export interface AdminPostRow {
  id: number;
  user_id: number;
  image_url: string;
  title: string;
  description: string;
  close_comments: number;
  pinned: number;
  video_url: string | null;
  video_cover: string | null;
  share_count: number;
  repost_count: number;
  created_at: string;
  username: string;
  avatar: string | null;
}

/** 所有帖子（分页，管理视图） */
export function listAllPosts(page: number, limit: number): { posts: AdminPostRow[]; total: number } {
  const total = count('SELECT COUNT(*) as count FROM posts');
  const posts = getDb().prepare(`
    SELECT p.*, u.username, u.avatar
    FROM posts p JOIN users u ON p.user_id = u.id
    ORDER BY p.created_at DESC LIMIT ? OFFSET ?
  `).all(limit, (page - 1) * limit) as AdminPostRow[];
  return { posts, total };
}

/** 帖子是否存在 */
export function postExists(postId: number): boolean {
  return !!getDb().prepare('SELECT id FROM posts WHERE id = ?').get(postId);
}

/** 管理员删除帖子（先删通知再删帖子） */
export function adminDeletePost(postId: number): void {
  getDb().prepare('DELETE FROM notifications WHERE post_id = ?').run(postId);
  getDb().prepare('DELETE FROM posts WHERE id = ?').run(postId);
}

// ============================================================
// 公告管理
// ============================================================

export interface AdminAnnouncementRow {
  id: number;
  title: string;
  content: string;
  target_user_id: number | null;
  from_user_id: number;
  created_at: string;
  target_username?: string | null;
}

/** 创建公告 */
export function createAnnouncement(input: {
  title: string;
  content: string;
  targetUserId: number | null;
  fromUserId: number;
}): AdminAnnouncementRow {
  const result = getDb().prepare(
    'INSERT INTO announcements (title, content, target_user_id, from_user_id) VALUES (?, ?, ?, ?)'
  ).run(input.title, input.content, input.targetUserId || null, input.fromUserId);
  return getDb().prepare('SELECT * FROM announcements WHERE id = ?').get(result.lastInsertRowid) as AdminAnnouncementRow;
}

/** 所有公告列表（含目标用户名） */
export function listAllAnnouncements(): AdminAnnouncementRow[] {
  return getDb().prepare(`
    SELECT a.*, u.username as target_username
    FROM announcements a
    LEFT JOIN users u ON a.target_user_id = u.id
    ORDER BY a.created_at DESC
  `).all() as AdminAnnouncementRow[];
}

/** 删除公告 */
export function deleteAnnouncement(id: number): void {
  getDb().prepare('DELETE FROM announcements WHERE id = ?').run(id);
}

/** 封禁/解封用户（bannedUntil 为 ISO-8601 时间或 null） */
export function setBanStatus(userId: number, bannedUntil: string | null): void {
  getDb().prepare('UPDATE users SET banned_until = ? WHERE id = ?').run(bannedUntil, userId);
}

/** 实时认证状态（单查询供 authMiddleware / SSE / 语音 WS 校验用） */
export interface AuthStateRow {
  role: string;
  banned_until: string | null;
  token_version: number;
}

/** 查询用户实时认证状态：角色、封禁截止时间、令牌版本（用户不存在返回 undefined） */
export function getAuthState(userId: number): AuthStateRow | undefined {
  return getDb().prepare('SELECT role, banned_until, token_version FROM users WHERE id = ?')
    .get(userId) as AuthStateRow | undefined;
}
