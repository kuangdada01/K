/**
 * ============================================================
 * 管理后台仓库（admin.repository）
 * ============================================================
 */

import { getDb, stmt } from '../db/connection';
import { count, escapeLike } from '../db/helpers';
import { HARD_LIST_CAP, capRows, probeLimit } from '../lib/listLimits';

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

/**
 * 所有用户列表（含帖子数）。硬上限见 HARD_LIST_CAP：
 * 此前无 LIMIT，且每行带一个相关 `COUNT(*)`；客户端还会把整个列表渲染进 DOM
 * 并在本地做搜索过滤 —— 用户量上去后是「一次请求 + 一次渲染」双向失控。
 *
 * ⚠️ 这是**老客户端**（不带 `page` 参数，如已安装的 APK）仍在用的形状：
 * 服务端搜索 + 分页见 listUsersPage，新客户端走那条路。
 * 保留本函数的理由是「只增不改」—— 换形状会让老客户端的本地搜索直接失效。
 */
export function listUsers(cap: number = HARD_LIST_CAP): { rows: AdminUserRow[]; has_more: boolean } {
  const raw = stmt(
    `
    SELECT u.id, u.username, u.email, u.avatar, u.bio, u.role, u.banned_until, u.created_at,
      (SELECT COUNT(*) FROM posts WHERE user_id = u.id) as post_count
    FROM users u ORDER BY u.id ASC LIMIT ?
  `
  ).all(probeLimit(cap)) as AdminUserRow[];
  return capRows(raw, cap);
}

/**
 * 用户列表的服务端搜索条件：用户名/邮箱模糊 + ID 子串。
 *
 * 语义刻意与客户端**原来的本地过滤**对齐（`username`/`email` 的 `includes`、
 * `String(id)` 的 `includes`），这样改成服务端搜索后搜索结果不会变少也不会变多。
 * LIKE 通配符统一经 escapeLike 转义（否则用户名里的 `%`/`_` 会变成通配符，
 * 搜 `a_b` 会命中 `axb`；同类问题此前在 searchUsers 上修过）。
 */
function userSearchWhere(q: string): { sql: string; params: string[] } {
  const keyword = q.trim();
  if (!keyword) return { sql: '', params: [] };
  const like = `%${escapeLike(keyword)}%`;
  return {
    sql:
      "WHERE (u.username LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\'" +
      " OR CAST(u.id AS TEXT) LIKE ? ESCAPE '\\')",
    params: [like, like, like],
  };
}

/** 用户总数（带搜索条件时只统计命中的行，用于算总页数） */
export function countUsers(q = ''): number {
  const { sql, params } = userSearchWhere(q);
  return count(`SELECT COUNT(*) as count FROM users u ${sql}`, ...params);
}

/**
 * 用户列表（服务端搜索 + 分页）。
 *
 * 为什么必须服务端做：老实现一次物化最多 HARD_LIST_CAP 行、每行还带一个相关
 * `COUNT(*)`，且**整个列表要进 DOM**；用户量上去后「超过上限的用户搜不到、
 * 也管不了」（封禁/改密/删除都点不到）。分页把单次代价固定成 `limit` 行，
 * 搜索交给 SQL 的 WHERE，命中多少都能翻到。
 */
export function listUsersPage(input: { q?: string; page: number; limit: number }): {
  rows: AdminUserRow[];
  total: number;
} {
  const { q = '', page, limit } = input;
  const { sql, params } = userSearchWhere(q);
  const total = countUsers(q);
  const rows = stmt(
    `
    SELECT u.id, u.username, u.email, u.avatar, u.bio, u.role, u.banned_until, u.created_at,
      (SELECT COUNT(*) FROM posts WHERE user_id = u.id) as post_count
    FROM users u ${sql} ORDER BY u.id ASC LIMIT ? OFFSET ?
  `
  ).all(...params, limit, (page - 1) * limit) as AdminUserRow[];
  return { rows, total };
}

/** 搜索用户（按用户名或ID，最多10条，用于公告指定用户等场景） */
export function searchUsers(q: string): { id: number; username: string; avatar: string | null }[] {
  const isId = /^\d+$/.test(q);
  // 统一转义 LIKE 通配符并配合 ESCAPE 子句（B3 修复：含 %/_ 的用户名可正确匹配）
  const escaped = escapeLike(q);
  const likePattern = `%${escaped}%`;
  if (isId) {
    return stmt(
      "SELECT id, username, avatar FROM users WHERE id = ? OR username LIKE ? ESCAPE '\\' LIMIT 10"
    ).all(parseInt(q), likePattern) as { id: number; username: string; avatar: string | null }[];
  }
  return stmt("SELECT id, username, avatar FROM users WHERE username LIKE ? ESCAPE '\\' LIMIT 10").all(
    likePattern
  ) as { id: number; username: string; avatar: string | null }[];
}

/** 按 ID 查用户（含 email、avatar，删除/重置密码/删号清文件用） */
export function findUser(userId: number): { id: number; email: string; avatar: string | null } | undefined {
  return stmt('SELECT id, email, avatar FROM users WHERE id = ?').get(userId) as
    { id: number; email: string; avatar: string | null } | undefined;
}

/** 查询用户角色（封禁前置校验: 不能封禁管理员） */
export function getUserRole(userId: number): string | undefined {
  const row = stmt('SELECT role FROM users WHERE id = ?').get(userId) as { role: string } | undefined;
  return row?.role;
}

/** 删除用户（外键级联删除关联数据）+ 清理验证码记录（事务保证两删同生共死） */
export function deleteUser(userId: number, email: string): void {
  getDb().transaction(() => {
    stmt('DELETE FROM users WHERE id = ?').run(userId);
    stmt('DELETE FROM verification_codes WHERE email = ?').run(email);
  })();
}

/** 重置用户密码（同时递增 token_version，使该用户已签发的 JWT 全部失效） */
export function resetUserPassword(userId: number, passwordHash: string): void {
  stmt('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(
    passwordHash,
    userId
  );
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

/**
 * 管理端帖子列表的服务端搜索条件：作者用户名模糊 + 作者 ID 子串。
 *
 * 与用户列表同一套语义（`userSearchWhere` 的镜像）：字段集合刻意与客户端
 * **原来的本地过滤**一致（`p.username.includes` / `String(p.user_id).includes`），
 * 换成服务端搜索后结果不会变少也不会变多。LIKE 通配符同样经 escapeLike 转义。
 */
function postSearchWhere(q: string): { sql: string; params: string[] } {
  const keyword = q.trim();
  if (!keyword) return { sql: '', params: [] };
  const like = `%${escapeLike(keyword)}%`;
  return {
    sql: "WHERE (u.username LIKE ? ESCAPE '\\' OR CAST(p.user_id AS TEXT) LIKE ? ESCAPE '\\')",
    params: [like, like],
  };
}

/** 帖子总数（带搜索条件时只统计命中的行，用于算总页数） */
export function countPosts(q = ''): number {
  const { sql, params } = postSearchWhere(q);
  return count(`SELECT COUNT(*) as count FROM posts p JOIN users u ON p.user_id = u.id ${sql}`, ...params);
}

/**
 * 所有帖子（分页 + 服务端搜索，管理视图）。
 *
 * `q` 可选且默认空 —— 不传时与改动前**逐字相同**（响应形状也没变：本接口本来
 * 就是分页的，所以这里只是给已有分页加了个 WHERE，没有契约变更）。
 * 此前搜索在客户端做，而客户端手里只有**当前这一页的 20 行**：
 * 搜一个不在当前页的帖子会得到空表。
 */
export function listAllPosts(page: number, limit: number, q = ''): { posts: AdminPostRow[]; total: number } {
  const { sql, params } = postSearchWhere(q);
  const total = countPosts(q);
  const posts = stmt(
    `
    SELECT p.*, u.username, u.avatar
    FROM posts p JOIN users u ON p.user_id = u.id
    ${sql}
    ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?
  `
  ).all(...params, limit, (page - 1) * limit) as AdminPostRow[];
  return { posts, total };
}

/** 管理员删除帖子（先删通知再删帖子，事务保证原子性） */
export function adminDeletePost(postId: number): void {
  getDb().transaction(() => {
    stmt('DELETE FROM notifications WHERE post_id = ?').run(postId);
    stmt('DELETE FROM posts WHERE id = ?').run(postId);
  })();
}

// ============================================================
// 删号/删帖前的磁盘文件收集（文件路径删库后无从查起，必须先查后删）
// ============================================================

/** 帖子媒体字段 */
export interface PostMediaRow {
  image_url: string;
  video_url: string | null;
  video_cover: string | null;
}

/** 查询单帖媒体字段（管理端删帖前收集文件路径用） */
export function findPostMedia(postId: number): PostMediaRow | undefined {
  return stmt('SELECT image_url, video_url, video_cover FROM posts WHERE id = ?').get(postId) as
    PostMediaRow | undefined;
}

/** 查询某用户全部帖子的媒体字段（删号前收集文件路径用） */
export function listUserPostMedia(userId: number): PostMediaRow[] {
  return stmt('SELECT image_url, video_url, video_cover FROM posts WHERE user_id = ?').all(
    userId
  ) as PostMediaRow[];
}

/** 查询某用户私密图片文件名列表（uploads_private，DB 只存文件名） */
export function listUserPrivateImageNames(userId: number): string[] {
  return (
    stmt('SELECT image_url FROM private_images WHERE user_id = ?').all(userId) as {
      image_url: string;
    }[]
  ).map((r) => r.image_url);
}

/** 查询某用户发出的带图私信文件名列表（uploads_private，DB 只存文件名） */
export function listUserMessageImageNames(userId: number): string[] {
  return (
    stmt('SELECT image_url FROM messages WHERE sender_id = ? AND image_url IS NOT NULL').all(userId) as {
      image_url: string;
    }[]
  ).map((r) => r.image_url);
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
  const result = stmt(
    'INSERT INTO announcements (title, content, target_user_id, from_user_id) VALUES (?, ?, ?, ?)'
  ).run(input.title, input.content, input.targetUserId || null, input.fromUserId);
  return stmt('SELECT * FROM announcements WHERE id = ?').get(result.lastInsertRowid) as AdminAnnouncementRow;
}

/** 所有公告列表（含目标用户名）；硬上限见 HARD_LIST_CAP */
export function listAllAnnouncements(cap: number = HARD_LIST_CAP): {
  rows: AdminAnnouncementRow[];
  has_more: boolean;
} {
  const raw = stmt(
    `
    SELECT a.*, u.username as target_username
    FROM announcements a
    LEFT JOIN users u ON a.target_user_id = u.id
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ?
  `
  ).all(probeLimit(cap)) as AdminAnnouncementRow[];
  return capRows(raw, cap);
}

/** 删除公告 */
export function deleteAnnouncement(id: number): void {
  stmt('DELETE FROM announcements WHERE id = ?').run(id);
}

/** 封禁/解封用户（bannedUntil 为 ISO-8601 时间或 null） */
export function setBanStatus(userId: number, bannedUntil: string | null): void {
  stmt('UPDATE users SET banned_until = ? WHERE id = ?').run(bannedUntil, userId);
}

/** 实时认证状态（单查询供 authMiddleware / SSE / 语音 WS 校验用） */
export interface AuthStateRow {
  role: string;
  banned_until: string | null;
  token_version: number;
}

/** 查询用户实时认证状态：角色、封禁截止时间、令牌版本（用户不存在返回 undefined） */
export function getAuthState(userId: number): AuthStateRow | undefined {
  return stmt('SELECT role, banned_until, token_version FROM users WHERE id = ?').get(userId) as
    AuthStateRow | undefined;
}
