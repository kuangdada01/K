/**
 * ============================================================
 * 认证仓库（auth.repository）
 * ============================================================
 */

import { getDb } from '../db/connection';

/** users 表完整行（含密码哈希，仅认证流程使用） */
export interface AuthUserRow {
  id: number;
  username: string;
  email: string;
  password_hash: string;
  avatar: string | null;
  bio: string;
  role: string;
  email_verified: number;
  token_version: number;
  created_at: string;
}

// ============================================================
// 验证码
// ============================================================

/** 查询有效验证码（未过期） */
export function findValidCode(email: string, code: string): { id: number; email: string; code: string; expires: string } | undefined {
  return getDb().prepare(
    "SELECT * FROM verification_codes WHERE email = ? AND code = ? AND datetime(expires) > datetime('now')"
  ).get(email, code) as { id: number; email: string; code: string; expires: string } | undefined;
}

/** 60 秒内是否已发送过验证码 */
export function hasRecentCode(email: string): boolean {
  return !!getDb().prepare(
    "SELECT created_at FROM verification_codes WHERE email = ? AND datetime(created_at) > datetime('now', '-60 seconds')"
  ).get(email);
}

/** 写入新验证码（先清旧，顺带清理全部过期记录防表无限膨胀，P1 修复） */
export function saveVerificationCode(email: string, code: string, expires: string): void {
  getDb().prepare("DELETE FROM verification_codes WHERE datetime(expires) < datetime('now')").run();
  getDb().prepare('DELETE FROM verification_codes WHERE email = ?').run(email);
  getDb().prepare('INSERT INTO verification_codes (email, code, expires) VALUES (?, ?, ?)').run(email, code, expires);
}

/** 删除某邮箱的全部验证码（使用后清理） */
export function deleteVerificationCodes(email: string): void {
  getDb().prepare('DELETE FROM verification_codes WHERE email = ?').run(email);
}

// ============================================================
// 用户
// ============================================================

export function findUserByEmail(email: string): AuthUserRow | undefined {
  return getDb().prepare('SELECT * FROM users WHERE email = ?').get(email) as AuthUserRow | undefined;
}

export function findUserByUsernameOrEmail(username: string, email: string): { id: number } | undefined {
  return getDb().prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email) as { id: number } | undefined;
}

/** 创建已验证用户，返回安全行 */
export function createUser(username: string, email: string, passwordHash: string): { id: number; username: string; email: string; avatar: string | null; bio: string; role: string; token_version: number; created_at: string } {
  const result = getDb().prepare(
    'INSERT INTO users (username, email, password_hash, email_verified) VALUES (?, ?, ?, 1)'
  ).run(username, email, passwordHash);
  return getDb().prepare('SELECT id, username, email, avatar, bio, role, token_version, created_at FROM users WHERE id = ?')
    .get(result.lastInsertRowid) as { id: number; username: string; email: string; avatar: string | null; bio: string; role: string; token_version: number; created_at: string };
}

/** 更新用户密码（同时递增 token_version，使该用户已签发的 JWT 全部失效） */
export function updateUserPassword(userId: number, passwordHash: string): void {
  getDb().prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(passwordHash, userId);
}
