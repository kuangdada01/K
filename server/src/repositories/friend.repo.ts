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
  /**
   * 这个人**是否也关注了当前查看者**（0/1）。
   *
   * 只在**分页形状**的列表里返回（listFollowersPage / listFollowingPage）——
   * 不带 page/q 的老形状被 `followers-search.test.ts` 钉住「不新增字段」，逐字不动。
   * 看自己的粉丝列表时它恒为 1（列表成员本来就都关注自己），客户端拿它画「关注了你」。
   */
  follows_viewer?: number;
  /**
   * 查看者与这个人**互相关注**（0/1）＝ `is_following && follows_viewer`。
   * 列表按它**优先排序**（共同关注的人排在最前），分页形状专有。
   */
  is_mutual?: number;
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

/**
 * 粉丝列表（谁关注了 target）；硬上限见 HARD_LIST_CAP，`has_more` 表示被截断。
 *
 * ⚠️ 这一版**刻意保持老形状**：不加 follows_viewer / is_mutual、排序仍是 username ASC ——
 * 老 WebView 客户端的弹窗靠它，`followers-search.test.ts` 钉住「不新增字段」。
 * 「共同关注优先」的排序与关系字段只在**分页形状**（listFollowersPage）里。
 */
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
 * 分页列表（两个方向共用）的行查询：在老的三列之外补两个**查看者关系**字段，
 * 并按「共同关注优先」排序。
 *
 * 排序键（依次比较，组内仍按 username/id 升序，保证分页窗口稳定）：
 *  1. `is_mutual DESC`   —— 我和对方互相关注（最强的"认识"信号）；
 *  2. `is_following DESC` —— 我关注了 Ta（粉丝列表里 = 我已回关的粉丝；
 *     关注列表里 = 共同关注的人本身）；
 *  3. `follows_viewer DESC` —— Ta 关注了我（还没回关，但比陌生人近一档）。
 *
 * 与老实现的关系：老实现（listFollowers / listFollowing，不带分页）保持
 * `username ASC` 逐字不动 —— `followers-search.test.ts` 钉住了「老形状不新增字段」，
 * 且老 WebView 客户端的弹窗靠它；分页形状是 Web 弹窗与原生 App 在用的。
 */
function viewerRelationColumns(viewerId: number): { sql: string; params: number[] } {
  // 4 个占位符按顺序绑定：is_following 两处、follows_viewer 两处，全部是查看者 id
  const isFollowing = 'EXISTS(SELECT 1 FROM friends WHERE user_id = ? AND friend_id = u.id)';
  const followsViewer = 'EXISTS(SELECT 1 FROM friends WHERE user_id = u.id AND friend_id = ?)';
  return {
    sql: `
      ${isFollowing} as is_following,
      ${followsViewer} as follows_viewer,
      (${isFollowing} AND ${followsViewer}) as is_mutual`,
    params: [viewerId, viewerId, viewerId, viewerId],
  };
}

/** 共同关注优先的排序（引用上面 SELECT 的别名；组内 username/id 升序保证翻页稳定） */
const MUTUAL_FIRST_ORDER =
  'ORDER BY is_mutual DESC, is_following DESC, follows_viewer DESC, u.username ASC, u.id ASC';

/**
 * 粉丝列表（服务端搜索 + 分页）。
 *
 * 老实现是「取回最多 HARD_LIST_CAP 行 + 弹窗里本地过滤」：粉丝超过上限的账号，
 * 那些粉丝**在搜索框里根本不存在**（搜不到 → 也关注/取关不了）。
 * 排序：共同关注优先（见 viewerRelationColumns），组内 username+id 唯一，
 * 翻页不会重复或漏行。
 */
export function listFollowersPage(
  targetId: number,
  viewerId: number,
  opts: { q?: string; page: number; limit: number }
): { rows: FriendUserRow[]; total: number } {
  const { q = '', page, limit } = opts;
  const { sql, params } = friendSearchWhere(q);
  const rel = viewerRelationColumns(viewerId);
  const total = count(
    `SELECT COUNT(*) as count FROM friends f JOIN users u ON u.id = f.user_id WHERE f.friend_id = ? ${sql}`,
    targetId,
    ...params
  );
  const rows = stmt(
    `
    SELECT u.id, u.username, u.avatar, u.bio,
      ${rel.sql}
    FROM friends f
    JOIN users u ON u.id = f.user_id
    WHERE f.friend_id = ? ${sql}
    ${MUTUAL_FIRST_ORDER}
    LIMIT ? OFFSET ?
  `
  ).all(...rel.params, targetId, ...params, limit, (page - 1) * limit) as FriendUserRow[];
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
  const rel = viewerRelationColumns(viewerId);
  const total = count(
    `SELECT COUNT(*) as count FROM friends f JOIN users u ON u.id = f.friend_id WHERE f.user_id = ? ${sql}`,
    targetId,
    ...params
  );
  const rows = stmt(
    `
    SELECT u.id, u.username, u.avatar, u.bio,
      ${rel.sql}
    FROM friends f
    JOIN users u ON u.id = f.friend_id
    WHERE f.user_id = ? ${sql}
    ${MUTUAL_FIRST_ORDER}
    LIMIT ? OFFSET ?
  `
  ).all(...rel.params, targetId, ...params, limit, (page - 1) * limit) as FriendUserRow[];
  return { rows, total };
}

/** 关注列表（target 关注了谁）；硬上限同上，**同样保持老形状**（见 listFollowers 的注释） */
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

/** 单页候选：从 fromId 起按 id 升序取 limit 个（登录用户排除自己与已关注） */
function recommendedPage(userId: number | undefined, fromId: number, limit: number): FriendUserRow[] {
  if (userId) {
    return stmt(
      `
      SELECT u.id, u.username, u.avatar
      FROM users u
      WHERE u.id >= ? AND u.id != ?
        AND u.id NOT IN (SELECT friend_id FROM friends WHERE user_id = ?)
      ORDER BY u.id
      LIMIT ?
    `
    ).all(fromId, userId, userId, limit) as FriendUserRow[];
  }
  return stmt(
    `
    SELECT u.id, u.username, u.avatar
    FROM users u
    WHERE u.id >= ?
    ORDER BY u.id
    LIMIT ?
  `
  ).all(fromId, limit) as FriendUserRow[];
}

/**
 * 随机推荐（登录用户排除已关注，游客纯随机；最多5条）。
 *
 * 实现：**随机起点探测**而非 `ORDER BY RANDOM()` —— 后者每请求物化全部 users 行
 * 再排序（O(N) 内存 + 排序，且该端点匿名可调），前者用 id 主键索引从随机起点向后
 * 取 5 个；自增 id 有空洞（删号），起点之后不足 5 个时从头部补齐并去重。
 * 随机性：起点在 [MIN(id), MAX(id)] 上均匀采样，对自增分布足够均匀。
 */
export function listRecommended(userId?: number): FriendUserRow[] {
  const bounds = stmt('SELECT MIN(id) AS minId, MAX(id) AS maxId FROM users').get() as {
    minId: number | null;
    maxId: number | null;
  };
  if (bounds.minId === null || bounds.maxId === null) return []; // 空库
  const want = 5;
  const start = bounds.minId + Math.floor(Math.random() * (bounds.maxId - bounds.minId + 1));
  const picked = recommendedPage(userId, start, want);
  if (picked.length >= want) return picked;
  // 起点之后不足：从头部补齐（去掉与已选重复的）
  const seen = new Set(picked.map((p) => p.id));
  const head = recommendedPage(userId, bounds.minId, want * 2);
  for (const row of head) {
    if (picked.length >= want) break;
    if (!seen.has(row.id)) {
      picked.push(row);
      seen.add(row.id);
    }
  }
  return picked;
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
