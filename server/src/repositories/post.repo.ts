/**
 * ============================================================
 * 帖子仓库（post.repository）
 * ============================================================
 * 所有帖子/评论/点赞/收藏/转发/分享相关的 SQL 收敛于此，
 * 路由层不再直接编写 SQL。行类型化，杜绝 as any。
 *
 * 未登录用户传 userId = undefined：EXISTS 状态列用 -1 恒假，
 * 与原"登录/未登录"两套 SQL 的行为完全一致。
 */

import { getDb } from '../db/connection';
import { count, uid } from '../db/helpers';
import { AppError } from '../middleware/error';

// ============================================================
// 行类型定义
// ============================================================

/** posts 表原始行 */
export interface PostRow {
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
}

/** 带作者信息与计数的帖子行（列表/详情响应用） */
export interface PostWithUser extends PostRow {
  username: string;
  avatar: string | null;
  like_count: number;
  comment_count: number;
  /** 当前用户状态（未登录时不存在） */
  liked?: number;
  shared?: number;
  bookmarked?: number;
  reposted?: number;
}

// ============================================================
// 公共查询片段（与原路由 SQL 逐字段一致，保证响应形状不变）
// ============================================================

/**
 * 信息流/搜索查询（登录状态列: liked/shared/reposted）
 * 参数顺序: [userId, userId, userId, ...额外条件]
 * 未登录时 userId = -1，EXISTS 恒假
 */
const POST_FEED_SELECT = `
  SELECT p.*, u.username, u.avatar,
    (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as like_count,
    (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comment_count,
    EXISTS(SELECT 1 FROM likes WHERE post_id = p.id AND user_id = ?) as liked,
    EXISTS(SELECT 1 FROM shares WHERE post_id = p.id AND user_id = ?) as shared,
    EXISTS(SELECT 1 FROM reposts WHERE post_id = p.id AND user_id = ?) as reposted
  FROM posts p
  JOIN users u ON p.user_id = u.id
`;

/**
 * 详情查询（登录状态列: liked/shared/bookmarked/reposted）
 */
const POST_DETAIL_SELECT = `
  SELECT p.*, u.username, u.avatar,
    (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as like_count,
    (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comment_count,
    EXISTS(SELECT 1 FROM likes WHERE post_id = p.id AND user_id = ?) as liked,
    EXISTS(SELECT 1 FROM shares WHERE post_id = p.id AND user_id = ?) as shared,
    EXISTS(SELECT 1 FROM bookmarks WHERE post_id = p.id AND user_id = ?) as bookmarked,
    EXISTS(SELECT 1 FROM reposts WHERE post_id = p.id AND user_id = ?) as reposted
  FROM posts p
  JOIN users u ON p.user_id = u.id
`;

// ============================================================
// 帖子查询
// ============================================================

/** 信息流列表（按创建时间倒序，分页） */
export function listPosts(
  page: number,
  limit: number,
  userId?: number
): { posts: PostWithUser[]; total: number } {
  const total = count('SELECT COUNT(*) as count FROM posts');
  const posts = getDb()
    .prepare(`${POST_FEED_SELECT} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`)
    .all(uid(userId), uid(userId), uid(userId), limit, (page - 1) * limit) as PostWithUser[];
  return { posts, total };
}

/** 搜索帖子：给定话题时按 post_tags 精确匹配，否则按标题/描述模糊匹配 */
export function searchPosts(
  keyword: string,
  page: number,
  limit: number,
  userId?: number,
  tag?: string
): { posts: PostWithUser[]; total: number } {
  if (tag) {
    const total = count(
      'SELECT COUNT(*) as count FROM posts p JOIN post_tags pt ON pt.post_id = p.id WHERE pt.tag = ?',
      tag
    );
    const posts = getDb()
      .prepare(
        `
        ${POST_FEED_SELECT}
        JOIN post_tags pt ON pt.post_id = p.id
        WHERE pt.tag = ?
        ORDER BY p.created_at DESC
        LIMIT ? OFFSET ?
      `
      )
      .all(uid(userId), uid(userId), uid(userId), tag, limit, (page - 1) * limit) as PostWithUser[];
    return { posts, total };
  }

  const escapedKeyword = keyword.replace(/[%_]/g, '\\$&');
  const likePattern = `%${escapedKeyword}%`;
  const total = count(
    "SELECT COUNT(*) as count FROM posts p WHERE p.title LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\'",
    likePattern,
    likePattern
  );
  const posts = getDb()
    .prepare(
      `${POST_FEED_SELECT} WHERE p.title LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\' ORDER BY p.created_at DESC LIMIT ? OFFSET ?`
    )
    .all(
      uid(userId),
      uid(userId),
      uid(userId),
      likePattern,
      likePattern,
      limit,
      (page - 1) * limit
    ) as PostWithUser[];
  return { posts, total };
}

/** 单个帖子详情 */
export function getPostById(postId: number, userId?: number): PostWithUser | undefined {
  return getDb()
    .prepare(`${POST_DETAIL_SELECT} WHERE p.id = ?`)
    .get(uid(userId), uid(userId), uid(userId), uid(userId), postId) as PostWithUser | undefined;
}

/** 用户帖子列表（公开，无登录状态列；按置顶+时间排序） */
export function listUserPosts(
  targetUserId: number,
  page: number,
  limit: number
): { posts: PostWithUser[]; total: number } {
  const total = count('SELECT COUNT(*) as count FROM posts WHERE user_id = ?', targetUserId);
  const posts = getDb()
    .prepare(
      `
    SELECT p.*, u.username, u.avatar,
      (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as like_count,
      (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comment_count
    FROM posts p
    JOIN users u ON p.user_id = u.id
    WHERE p.user_id = ?
    ORDER BY p.pinned DESC, p.created_at DESC
    LIMIT ? OFFSET ?
  `
    )
    .all(targetUserId, limit, (page - 1) * limit) as PostWithUser[];
  return { posts, total };
}

/** 当前用户收藏的帖子（按收藏时间倒序；登录状态列: liked + bookmarked=1） */
export function listBookmarkedPosts(userId: number): PostWithUser[] {
  return getDb()
    .prepare(
      `
    SELECT p.*, u.username, u.avatar,
      (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as like_count,
      (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comment_count,
      EXISTS(SELECT 1 FROM likes WHERE post_id = p.id AND user_id = ?) as liked,
      1 as bookmarked
    FROM bookmarks b
    JOIN posts p ON b.post_id = p.id
    JOIN users u ON p.user_id = u.id
    WHERE b.user_id = ?
    ORDER BY b.created_at DESC
  `
    )
    .all(userId, userId) as PostWithUser[];
}

/** 当前用户转发的帖子（按转发时间倒序；登录状态列: liked + reposted=1） */
export function listRepostedPosts(userId: number): PostWithUser[] {
  return getDb()
    .prepare(
      `
    SELECT p.*, u.username, u.avatar,
      (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as like_count,
      (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comment_count,
      EXISTS(SELECT 1 FROM likes WHERE post_id = p.id AND user_id = ?) as liked,
      1 as reposted
    FROM reposts r
    JOIN posts p ON r.post_id = p.id
    JOIN users u ON p.user_id = u.id
    WHERE r.user_id = ?
    ORDER BY r.created_at DESC
  `
    )
    .all(userId, userId) as PostWithUser[];
}

// ============================================================
// 帖子写入
// ============================================================

/** 创建图文帖子 */
export function createPost(input: {
  userId: number;
  imageUrl: string;
  title: string;
  description: string;
  closeComments: number;
  pinned: number;
}): PostWithUser {
  const result = getDb()
    .prepare(
      'INSERT INTO posts (user_id, image_url, title, description, close_comments, pinned) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(input.userId, input.imageUrl, input.title, input.description, input.closeComments, input.pinned);
  return getCreatedPost(Number(result.lastInsertRowid))!;
}

/** 创建视频帖子 */
export function createVideoPost(input: {
  userId: number;
  videoUrl: string;
  videoCover: string | null;
  description: string;
  closeComments: number;
  pinned: number;
}): PostWithUser {
  const result = getDb()
    .prepare(
      'INSERT INTO posts (user_id, image_url, title, description, close_comments, pinned, video_url, video_cover) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      input.userId,
      '[]',
      '',
      input.description,
      input.closeComments,
      input.pinned,
      input.videoUrl,
      input.videoCover
    );
  return getCreatedPost(Number(result.lastInsertRowid))!;
}

/** 创建响应形状（计数为 0，无登录状态列——与原路由一致） */
export function getCreatedPost(postId: number): PostWithUser | undefined {
  return getDb()
    .prepare(
      `
    SELECT p.*, u.username, u.avatar,
      0 as like_count, 0 as comment_count
    FROM posts p
    JOIN users u ON p.user_id = u.id
    WHERE p.id = ?
  `
    )
    .get(postId) as PostWithUser | undefined;
}

/** 编辑响应形状（含计数，无登录状态列——与原路由一致） */
export function getPostWithCounts(postId: number): PostWithUser | undefined {
  return getDb()
    .prepare(
      `
    SELECT p.*, u.username, u.avatar,
      (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as like_count,
      (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comment_count
    FROM posts p
    JOIN users u ON p.user_id = u.id
    WHERE p.id = ?
  `
    )
    .get(postId) as PostWithUser | undefined;
}

/** 更新自己的帖子（图片列表/描述/评论开关/置顶） */
export function updatePost(input: {
  postId: number;
  userId: number;
  imageUrl: string;
  description: string;
  closeComments: number;
  pinned: number;
}): PostWithUser | undefined {
  const result = getDb()
    .prepare(
      'UPDATE posts SET image_url = ?, description = ?, close_comments = ?, pinned = ? WHERE id = ? AND user_id = ?'
    )
    .run(input.imageUrl, input.description, input.closeComments, input.pinned, input.postId, input.userId);
  if (result.changes === 0) return undefined;
  return getPostWithCounts(input.postId);
}

/** 查询自己的帖子原始行（编辑/删除前置检查） */
export function findOwnPost(postId: number, userId: number): PostRow | undefined {
  return getDb().prepare('SELECT * FROM posts WHERE id = ? AND user_id = ?').get(postId, userId) as
    PostRow | undefined;
}

/** 删除帖子（外键级联自动删除评论、点赞、通知等） */
export function deletePost(postId: number): void {
  getDb().prepare('DELETE FROM posts WHERE id = ?').run(postId);
}

// ============================================================
// 帖子话题
// ============================================================

/** 同步帖子话题（发帖/编辑后调用：先删后插，与 description 解析结果保持一致） */
export function syncPostTags(postId: number, tags: string[]): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM post_tags WHERE post_id = ?').run(postId);
    const insert = db.prepare('INSERT OR IGNORE INTO post_tags (post_id, tag) VALUES (?, ?)');
    for (const tag of tags) insert.run(postId, tag);
  })();
}

// ============================================================
// 点赞
// ============================================================

/** 前置校验帖子存在，不存在则抛 404（替代外键约束导致的 500） */
function requirePost(postId: number): void {
  const exists = getDb().prepare('SELECT 1 FROM posts WHERE id = ?').get(postId);
  if (!exists) throw new AppError(404, '帖子不存在');
}

/** 点赞（INSERT OR IGNORE 防重复），返回最新点赞数 */
export function likePost(userId: number, postId: number): number {
  requirePost(postId);
  getDb().prepare('INSERT OR IGNORE INTO likes (user_id, post_id) VALUES (?, ?)').run(userId, postId);
  return countPostLikes(postId);
}

/** 取消点赞，返回最新点赞数 */
export function unlikePost(userId: number, postId: number): number {
  requirePost(postId);
  getDb().prepare('DELETE FROM likes WHERE user_id = ? AND post_id = ?').run(userId, postId);
  return countPostLikes(postId);
}

function countPostLikes(postId: number): number {
  return count('SELECT COUNT(*) as count FROM likes WHERE post_id = ?', postId);
}

// ============================================================
// 分享
// ============================================================

/** 记录分享（每用户每帖只计一次），返回分享数与状态 */
export function sharePost(userId: number, postId: number): { share_count: number; shared: boolean } {
  requirePost(postId);
  const result = getDb()
    .prepare('INSERT OR IGNORE INTO shares (user_id, post_id) VALUES (?, ?)')
    .run(userId, postId);
  if (result.changes === 1) {
    getDb().prepare('UPDATE posts SET share_count = share_count + 1 WHERE id = ?').run(postId);
  }
  const row = getDb().prepare('SELECT share_count FROM posts WHERE id = ?').get(postId) as
    { share_count: number } | undefined;
  return { share_count: row?.share_count || 0, shared: true };
}

// ============================================================
// 收藏
// ============================================================

/** 收藏帖子 */
export function bookmarkPost(userId: number, postId: number): void {
  requirePost(postId);
  getDb().prepare('INSERT OR IGNORE INTO bookmarks (user_id, post_id) VALUES (?, ?)').run(userId, postId);
}

/** 取消收藏 */
export function unbookmarkPost(userId: number, postId: number): void {
  requirePost(postId);
  getDb().prepare('DELETE FROM bookmarks WHERE user_id = ? AND post_id = ?').run(userId, postId);
}

// ============================================================
// 转发
// ============================================================

/** 转发（每用户每帖只计一次），返回转发数与状态 */
export function repostPost(userId: number, postId: number): { reposted: boolean; repost_count: number } {
  requirePost(postId);
  const result = getDb()
    .prepare('INSERT OR IGNORE INTO reposts (user_id, post_id) VALUES (?, ?)')
    .run(userId, postId);
  if (result.changes === 1) {
    getDb().prepare('UPDATE posts SET repost_count = repost_count + 1 WHERE id = ?').run(postId);
  }
  const row = getDb().prepare('SELECT repost_count FROM posts WHERE id = ?').get(postId) as
    { repost_count: number } | undefined;
  return { reposted: true, repost_count: row?.repost_count || 0 };
}

/** 取消转发，返回转发数与状态 */
export function unrepostPost(userId: number, postId: number): { reposted: boolean; repost_count: number } {
  requirePost(postId);
  const result = getDb().prepare('DELETE FROM reposts WHERE user_id = ? AND post_id = ?').run(userId, postId);
  if (result.changes === 1) {
    getDb().prepare('UPDATE posts SET repost_count = MAX(0, repost_count - 1) WHERE id = ?').run(postId);
  }
  const row = getDb().prepare('SELECT repost_count FROM posts WHERE id = ?').get(postId) as
    { repost_count: number } | undefined;
  return { reposted: false, repost_count: row?.repost_count || 0 };
}
