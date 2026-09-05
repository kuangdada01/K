/**
 * ============================================================
 * 通知与公告仓库（notification/announcement repository）
 * ============================================================
 */

import { getDb } from '../db/connection';
import { count } from '../db/helpers';

// ============================================================
// 通知
// ============================================================

export interface NotificationRow {
  id: number;
  user_id: number;
  type: string;
  from_user_id: number;
  post_id: number | null;
  comment_id: number | null;
  content: string;
  read: number;
  created_at: string;
  from_username: string;
  from_avatar: string | null;
}

/** 通知列表（最近50条，自动过滤已删除帖子/评论的孤立通知） */
export function listNotifications(userId: number): NotificationRow[] {
  return getDb()
    .prepare(
      `
    SELECT n.*, u.username as from_username, u.avatar as from_avatar
    FROM notifications n
    JOIN users u ON u.id = n.from_user_id
    WHERE n.user_id = ?
      AND (n.post_id IS NULL OR EXISTS (SELECT 1 FROM posts WHERE id = n.post_id))
      AND (n.comment_id IS NULL OR EXISTS (SELECT 1 FROM comments WHERE id = n.comment_id))
    ORDER BY n.created_at DESC
    LIMIT 50
  `
    )
    .all(userId) as NotificationRow[];
}

export function countUnreadNotifications(userId: number): number {
  return count('SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND read = 0', userId);
}

export function markAllNotificationsRead(userId: number): void {
  getDb().prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(userId);
}

export function markNotificationRead(notifId: number, userId: number): void {
  getDb().prepare('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?').run(notifId, userId);
}

/** 插入通知（评论/回复时） */
export function insertNotification(input: {
  userId: number;
  type: 'reply' | 'comment';
  fromUserId: number;
  postId: number;
  commentId: number;
  content: string;
}): void {
  getDb()
    .prepare(
      'INSERT INTO notifications (user_id, type, from_user_id, post_id, comment_id, content) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(input.userId, input.type, input.fromUserId, input.postId, input.commentId, input.content);
}

// ============================================================
// 公告
// ============================================================

export interface AnnouncementRow {
  id: number;
  title: string;
  content: string;
  target_user_id: number | null;
  from_user_id: number;
  created_at: string;
  from_username: string;
  from_avatar: string | null;
  is_read: number;
}

/** 用户可见的公告列表（全局 + 定向），含已读状态 */
export function listAnnouncements(userId: number): AnnouncementRow[] {
  return getDb()
    .prepare(
      `
    SELECT a.*, u.username as from_username, u.avatar as from_avatar,
      CASE WHEN ar.id IS NOT NULL THEN 1 ELSE 0 END as is_read
    FROM announcements a
    JOIN users u ON a.from_user_id = u.id
    LEFT JOIN announcement_reads ar ON ar.announcement_id = a.id AND ar.user_id = ?
    WHERE a.target_user_id IS NULL OR a.target_user_id = ?
    ORDER BY a.created_at DESC
  `
    )
    .all(userId, userId) as AnnouncementRow[];
}

/** 标记公告已读（INSERT OR IGNORE 防重复） */
export function markAnnouncementRead(announcementId: number, userId: number): void {
  getDb()
    .prepare('INSERT OR IGNORE INTO announcement_reads (announcement_id, user_id) VALUES (?, ?)')
    .run(announcementId, userId);
}
