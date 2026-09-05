/**
 * ============================================================
 * 用户仓库（user.repository）
 * ============================================================
 */

import { stmt } from '../db/connection';
import { count } from '../db/helpers';

/** users 表安全行（不含密码哈希） */
export interface SafeUserRow {
  id: number;
  username: string;
  email: string;
  avatar: string | null;
  bio: string;
  role: string;
  created_at: string;
}

/** 公开资料（不含 email 等私密字段；含统计数） */
export interface PublicProfile {
  id: number;
  username: string;
  avatar: string | null;
  bio: string;
  created_at: string;
  post_count: number;
  followers_count: number;
  following_count: number;
}

/** 公开资料查询（含帖子/粉丝/关注统计） */
export function getPublicProfile(userId: number): PublicProfile | undefined {
  const user = stmt('SELECT id, username, avatar, bio, created_at FROM users WHERE id = ?').get(userId) as
    Omit<PublicProfile, 'post_count' | 'followers_count' | 'following_count'> | undefined;
  if (!user) return undefined;

  const postCount = count('SELECT COUNT(*) as count FROM posts WHERE user_id = ?', userId);
  const followersCount = count('SELECT COUNT(*) as count FROM friends WHERE friend_id = ?', userId);
  const followingCount = count('SELECT COUNT(*) as count FROM friends WHERE user_id = ?', userId);

  return {
    ...user,
    post_count: postCount,
    followers_count: followersCount,
    following_count: followingCount,
  };
}

/** 用户名唯一性检查（排除自身） */
export function usernameTaken(username: string, excludeUserId: number): boolean {
  return !!stmt('SELECT id FROM users WHERE username = ? AND id != ?').get(username, excludeUserId);
}

/** 更新资料（保留未提供的字段），返回更新后的安全行 */
export function updateProfile(userId: number, input: { username?: string; bio?: string }): SafeUserRow {
  const current = stmt('SELECT username, bio FROM users WHERE id = ?').get(userId) as
    { username: string; bio: string } | undefined;
  if (!current) throw new Error('用户不存在');

  const newUsername = input.username !== undefined ? input.username : current.username;
  const newBio = input.bio !== undefined ? input.bio : current.bio;
  stmt('UPDATE users SET username = ?, bio = ? WHERE id = ?').run(newUsername, newBio, userId);
  return getSafeUser(userId)!;
}

/** 安全行查询（不含密码） */
export function getSafeUser(userId: number): SafeUserRow | undefined {
  return stmt('SELECT id, username, email, avatar, bio, role, created_at FROM users WHERE id = ?').get(
    userId
  ) as SafeUserRow | undefined;
}

/** 获取当前头像路径 */
export function getAvatar(userId: number): string | null {
  const row = stmt('SELECT avatar FROM users WHERE id = ?').get(userId) as
    { avatar: string | null } | undefined;
  return row?.avatar ?? null;
}

/** 更新头像路径 */
export function updateAvatar(userId: number, avatarUrl: string): SafeUserRow {
  stmt('UPDATE users SET avatar = ? WHERE id = ?').run(avatarUrl, userId);
  return getSafeUser(userId)!;
}

// ============================================================
// 私密图片
// ============================================================

export interface PrivateImageRow {
  id: number;
  user_id: number;
  image_url: string;
  created_at: string;
}

export function listPrivateImages(userId: number): PrivateImageRow[] {
  return stmt('SELECT * FROM private_images WHERE user_id = ? ORDER BY created_at DESC').all(
    userId
  ) as PrivateImageRow[];
}

export function countPrivateImages(userId: number): number {
  return count('SELECT COUNT(*) as count FROM private_images WHERE user_id = ?', userId);
}

export function createPrivateImage(userId: number, imageUrl: string): PrivateImageRow {
  const result = stmt('INSERT INTO private_images (user_id, image_url) VALUES (?, ?)').run(userId, imageUrl);
  return stmt('SELECT * FROM private_images WHERE id = ?').get(result.lastInsertRowid) as PrivateImageRow;
}

export function findOwnPrivateImage(imageId: number, userId: number): PrivateImageRow | undefined {
  return stmt('SELECT * FROM private_images WHERE id = ? AND user_id = ?').get(imageId, userId) as
    PrivateImageRow | undefined;
}

export function deletePrivateImage(imageId: number): void {
  stmt('DELETE FROM private_images WHERE id = ?').run(imageId);
}
