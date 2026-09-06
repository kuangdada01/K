/**
 * ============================================================
 * 评论仓库（comment.repository）
 * ============================================================
 * 所有评论/评论点赞相关的 SQL 收敛于此（自 post.repo.ts 拆分而来）。
 */

import { getDb, stmt } from '../db/connection';
import { count, uid } from '../db/helpers';

/** 评论行（含作者与父评论信息） */
export interface CommentRow {
  id: number;
  user_id: number;
  post_id: number;
  parent_id: number | null;
  content: string;
  created_at: string;
  username: string;
  avatar: string | null;
  like_count: number;
  liked?: number;
  parent_content?: string | null;
  parent_username?: string | null;
}

/** 帖子详情内嵌的评论列表（无点赞状态，按时间正序） */
export function listCommentsForPost(postId: number): CommentRow[] {
  return stmt(
    `
    SELECT c.*, u.username, u.avatar,
      (SELECT content FROM comments WHERE id = c.parent_id) as parent_content,
      (SELECT u2.username FROM comments pc JOIN users u2 ON u2.id = pc.user_id WHERE pc.id = c.parent_id) as parent_username
    FROM comments c
    JOIN users u ON c.user_id = u.id
    WHERE c.post_id = ?
    ORDER BY c.created_at ASC
  `
  ).all(postId) as CommentRow[];
}

/** 评论列表端点（含当前用户点赞状态，按父评论+时间排序） */
export function listComments(postId: number, userId?: number): CommentRow[] {
  return stmt(
    `
    SELECT c.*, u.username, u.avatar,
      (SELECT COUNT(*) FROM comment_likes WHERE comment_id = c.id) as like_count,
      EXISTS(SELECT 1 FROM comment_likes WHERE comment_id = c.id AND user_id = ?) as liked,
      (SELECT content FROM comments WHERE id = c.parent_id) as parent_content,
      (SELECT u2.username FROM comments pc JOIN users u2 ON u2.id = pc.user_id WHERE pc.id = c.parent_id) as parent_username
    FROM comments c
    JOIN users u ON c.user_id = u.id
    WHERE c.post_id = ?
    ORDER BY c.parent_id ASC, c.created_at ASC
  `
  ).all(uid(userId), postId) as CommentRow[];
}

/**
 * 分页评论列表：以「顶级评论」为一页单位（每条顶级评论连同其全部回复一起返回），
 * 避免热帖全量拉取导致的响应膨胀。
 * - topLevelAfterId: 升序游标，返回 id 大于该值的顶级评论（缺省从第一条开始）
 * - topLevelLimit:   顶级评论条数上限（1-50，内部收敛）
 * 无参的全量契约请走 listComments（旧客户端兼容）。
 */
export function listCommentsPaged(
  postId: number,
  userId: number | undefined,
  opts: { topLevelAfterId?: number; topLevelLimit: number }
): { comments: CommentRow[]; has_more: boolean; total: number } {
  const limit = Math.min(Math.max(Math.trunc(opts.topLevelLimit), 1), 50);
  const afterId = opts.topLevelAfterId;
  const tops = (
    afterId === undefined
      ? stmt(
          `
      SELECT c.*, u.username, u.avatar,
        (SELECT COUNT(*) FROM comment_likes WHERE comment_id = c.id) as like_count,
        EXISTS(SELECT 1 FROM comment_likes WHERE comment_id = c.id AND user_id = ?) as liked
      FROM comments c
      JOIN users u ON c.user_id = u.id
      WHERE c.post_id = ? AND c.parent_id IS NULL
      ORDER BY c.id ASC LIMIT ?
    `
        ).all(uid(userId), postId, limit + 1)
      : stmt(
          `
      SELECT c.*, u.username, u.avatar,
        (SELECT COUNT(*) FROM comment_likes WHERE comment_id = c.id) as like_count,
        EXISTS(SELECT 1 FROM comment_likes WHERE comment_id = c.id AND user_id = ?) as liked
      FROM comments c
      JOIN users u ON c.user_id = u.id
      WHERE c.post_id = ? AND c.parent_id IS NULL AND c.id > ?
      ORDER BY c.id ASC LIMIT ?
    `
        ).all(uid(userId), postId, afterId, limit + 1)
  ) as CommentRow[];

  const has_more = tops.length > limit;
  const page = has_more ? tops.slice(0, limit) : tops;

  // 本页顶级评论的回复一并返回（客户端 buildVisibleComments 按 parent_id 组树）
  const replies =
    page.length === 0
      ? []
      : (stmt(
          `
      SELECT c.*, u.username, u.avatar,
        (SELECT COUNT(*) FROM comment_likes WHERE comment_id = c.id) as like_count,
        EXISTS(SELECT 1 FROM comment_likes WHERE comment_id = c.id AND user_id = ?) as liked,
        (SELECT content FROM comments WHERE id = c.parent_id) as parent_content,
        (SELECT u2.username FROM comments pc JOIN users u2 ON u2.id = pc.user_id WHERE pc.id = c.parent_id) as parent_username
      FROM comments c
      JOIN users u ON c.user_id = u.id
      WHERE c.post_id = ? AND c.parent_id IN (${page.map(() => '?').join(',')})
      ORDER BY c.parent_id ASC, c.created_at ASC
    `
        ).all(uid(userId), postId, ...page.map((t) => t.id)) as CommentRow[]);

  const total = count('SELECT COUNT(*) as count FROM comments WHERE post_id = ?', postId);
  return { comments: [...page, ...replies], has_more, total };
}

/** 创建评论，返回完整评论行 */
export function createComment(
  userId: number,
  postId: number,
  parentId: number | null,
  content: string
): CommentRow {
  const result = stmt('INSERT INTO comments (user_id, post_id, parent_id, content) VALUES (?, ?, ?, ?)').run(
    userId,
    postId,
    parentId || null,
    content.trim()
  );
  return stmt(
    `
    SELECT c.*, u.username, u.avatar,
      0 as like_count, 0 as liked,
      (SELECT content FROM comments WHERE id = c.parent_id) as parent_content,
      (SELECT u2.username FROM comments pc JOIN users u2 ON u2.id = pc.user_id WHERE pc.id = c.parent_id) as parent_username
    FROM comments c
    JOIN users u ON c.user_id = u.id
    WHERE c.id = ?
  `
  ).get(result.lastInsertRowid) as CommentRow;
}

/** 查询自己的评论（删除前置检查） */
export function findOwnComment(commentId: number, userId: number): { id: number } | undefined {
  return stmt('SELECT id FROM comments WHERE id = ? AND user_id = ?').get(commentId, userId) as
    { id: number } | undefined;
}

/** 查询父评论作者（回复通知用） */
export function getCommentAuthor(commentId: number): { user_id: number } | undefined {
  return stmt('SELECT user_id FROM comments WHERE id = ?').get(commentId) as { user_id: number } | undefined;
}

/** 查询父评论所属帖子（用于校验回复不属于同一帖子） */
export function getCommentPost(commentId: number): { post_id: number } | undefined {
  return stmt('SELECT post_id FROM comments WHERE id = ?').get(commentId) as { post_id: number } | undefined;
}

/** 删除评论（先递归删除其子孙评论的通知，外键级联删除子评论；事务保证两删同生共死） */
export function deleteComment(commentId: number): void {
  getDb().transaction(() => {
    stmt(
      `
    WITH RECURSIVE descendants AS (
      SELECT id FROM comments WHERE id = ?
      UNION ALL
      SELECT c.id FROM comments c JOIN descendants d ON c.parent_id = d.id
    )
    DELETE FROM notifications WHERE comment_id IN (SELECT id FROM descendants)
  `
    ).run(commentId);
    stmt('DELETE FROM comments WHERE id = ?').run(commentId);
  })();
}

/** 点赞评论，返回最新点赞数 */
export function likeComment(userId: number, commentId: number): number {
  stmt('INSERT OR IGNORE INTO comment_likes (user_id, comment_id) VALUES (?, ?)').run(userId, commentId);
  return countCommentLikes(commentId);
}

/** 取消评论点赞，返回最新点赞数 */
export function unlikeComment(userId: number, commentId: number): number {
  stmt('DELETE FROM comment_likes WHERE user_id = ? AND comment_id = ?').run(userId, commentId);
  return countCommentLikes(commentId);
}

function countCommentLikes(commentId: number): number {
  return count('SELECT COUNT(*) as count FROM comment_likes WHERE comment_id = ?', commentId);
}
