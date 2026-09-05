/**
 * ============================================================
 * 私信仓库（message.repository）
 * ============================================================
 */

import { getDb } from '../db/connection';

export interface ConversationRow {
  partner_id: number;
  username: string;
  avatar: string | null;
  last_message: string;
  last_message_at: string;
  unread_count: number;
}

export interface MessageRow {
  id: number;
  sender_id: number;
  receiver_id: number;
  content: string;
  image_url: string | null;
  read: number;
  quoted_message_id: number | null;
  created_at: string;
  sender_username: string;
  quoted_content?: string | null;
  quoted_image_url?: string | null;
  quoted_sender_username?: string | null;
}

/** 会话列表（按最后消息时间倒序） */
export function listConversations(userId: number): ConversationRow[] {
  return getDb()
    .prepare(
      `
    SELECT
      partner_id,
      u.username,
      u.avatar,
      (SELECT CASE
        WHEN m2.image_url IS NOT NULL AND m2.image_url != '' AND m2.content = '' THEN '[图片]'
        ELSE m2.content END
       FROM messages m2
       WHERE (m2.sender_id = ? AND m2.receiver_id = partner_id)
          OR (m2.sender_id = partner_id AND m2.receiver_id = ?)
       ORDER BY m2.created_at DESC LIMIT 1) as last_message,
      (SELECT m3.created_at FROM messages m3
       WHERE (m3.sender_id = ? AND m3.receiver_id = partner_id)
          OR (m3.sender_id = partner_id AND m3.receiver_id = ?)
       ORDER BY m3.created_at DESC LIMIT 1) as last_message_at,
      (SELECT COUNT(*) FROM messages m4
       WHERE m4.sender_id = partner_id AND m4.receiver_id = ? AND m4.read = 0) as unread_count
    FROM (
      SELECT DISTINCT
        CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END as partner_id
      FROM messages
      WHERE sender_id = ? OR receiver_id = ?
    ) sub
    JOIN users u ON u.id = partner_id
    ORDER BY last_message_at DESC
  `
    )
    .all(userId, userId, userId, userId, userId, userId, userId, userId) as ConversationRow[];
}

/** 标记当前用户收到的所有未读消息为已读 */
export function markAllRead(userId: number): void {
  getDb().prepare('UPDATE messages SET read = 1 WHERE receiver_id = ? AND read = 0').run(userId);
}

/**
 * 消息历史（游标分页）
 * - 自动将对方发来的未读消息标记为已读
 * - 按 ID 倒序取一页后翻转为正序返回
 */
export function listMessageHistory(
  currentUserId: number,
  otherUserId: number,
  limit: number,
  beforeId?: number
): { messages: MessageRow[]; has_more: boolean } {
  // 自动标记对方发来的消息为已读
  getDb()
    .prepare('UPDATE messages SET read = 1 WHERE sender_id = ? AND receiver_id = ?')
    .run(otherUserId, currentUserId);

  // 获取双向消息记录（含被引用消息信息），按 ID 倒序取一页再翻转成正序
  let page: MessageRow[];
  if (beforeId) {
    page = getDb()
      .prepare(
        `
      SELECT m.*, u.username as sender_username,
             qm.content as quoted_content,
             qm.image_url as quoted_image_url,
             qu.username as quoted_sender_username
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      LEFT JOIN messages qm ON m.quoted_message_id = qm.id
      LEFT JOIN users qu ON qm.sender_id = qu.id
      WHERE ((m.sender_id = ? AND m.receiver_id = ?)
         OR (m.sender_id = ? AND m.receiver_id = ?))
        AND m.id < ?
      ORDER BY m.id DESC
      LIMIT ?
    `
      )
      .all(currentUserId, otherUserId, otherUserId, currentUserId, beforeId, limit) as MessageRow[];
  } else {
    page = getDb()
      .prepare(
        `
      SELECT m.*, u.username as sender_username,
             qm.content as quoted_content,
             qm.image_url as quoted_image_url,
             qu.username as quoted_sender_username
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      LEFT JOIN messages qm ON m.quoted_message_id = qm.id
      LEFT JOIN users qu ON qm.sender_id = qu.id
      WHERE (m.sender_id = ? AND m.receiver_id = ?)
         OR (m.sender_id = ? AND m.receiver_id = ?)
      ORDER BY m.id DESC
      LIMIT ?
    `
      )
      .all(currentUserId, otherUserId, otherUserId, currentUserId, limit) as MessageRow[];
  }

  // 翻转成正序（新→旧 变 旧→新）
  const messages = page.reverse();

  // 判断是否还有更早的消息
  let hasMore = false;
  if (messages.length > 0) {
    const oldestId = messages[0].id;
    hasMore = !!getDb()
      .prepare(
        `
      SELECT 1 FROM messages
      WHERE ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))
        AND id < ?
      LIMIT 1
    `
      )
      .get(currentUserId, otherUserId, otherUserId, currentUserId, oldestId);
  }

  return { messages, has_more: hasMore };
}

/** 验证引用消息存在且属于当前对话 */
export function isValidQuotedMessage(quotedMessageId: number, senderId: number, receiverId: number): boolean {
  const quoted = getDb()
    .prepare(
      `
    SELECT id FROM messages WHERE id = ? AND (
      (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
    )
  `
    )
    .get(quotedMessageId, senderId, receiverId, receiverId, senderId) as { id: number } | undefined;
  return !!quoted;
}

/** 插入消息，返回完整消息行（含引用信息） */
export function insertMessage(input: {
  senderId: number;
  receiverId: number;
  content: string;
  imageUrl: string | null;
  quotedMessageId: number | null;
}): MessageRow {
  const result = getDb()
    .prepare(
      'INSERT INTO messages (sender_id, receiver_id, content, image_url, quoted_message_id) VALUES (?, ?, ?, ?, ?)'
    )
    .run(input.senderId, input.receiverId, input.content, input.imageUrl, input.quotedMessageId);

  return getDb()
    .prepare(
      `
    SELECT m.*, u.username as sender_username,
           qm.content as quoted_content,
           qm.image_url as quoted_image_url,
           qu.username as quoted_sender_username
    FROM messages m
    JOIN users u ON m.sender_id = u.id
    LEFT JOIN messages qm ON m.quoted_message_id = qm.id
    LEFT JOIN users qu ON qm.sender_id = qu.id
    WHERE m.id = ?
  `
    )
    .get(result.lastInsertRowid) as MessageRow;
}

/** 查询单条消息的图片与收发双方（媒体下发归属校验 + 撤回清理用） */
export function getMessageMedia(
  messageId: number
): { id: number; sender_id: number; receiver_id: number; image_url: string | null } | undefined {
  return getDb()
    .prepare('SELECT id, sender_id, receiver_id, image_url FROM messages WHERE id = ?')
    .get(messageId) as
    { id: number; sender_id: number; receiver_id: number; image_url: string | null } | undefined;
}

/** 撤回（删除）单条消息 */
export function deleteMessage(messageId: number): void {
  getDb().prepare('DELETE FROM messages WHERE id = ?').run(messageId);
}

/** 清除两人之间的所有消息（不删除磁盘上的图片文件） */
export function clearConversation(currentUserId: number, otherUserId: number): void {
  getDb()
    .prepare(
      `
    DELETE FROM messages
    WHERE (sender_id = ? AND receiver_id = ?)
       OR (sender_id = ? AND receiver_id = ?)
  `
    )
    .run(currentUserId, otherUserId, otherUserId, currentUserId);
}
