/**
 * ============================================================
 * 私信仓库（message.repository）
 * ============================================================
 */

import { getDb, stmt } from '../db/connection';
import { HARD_LIST_CAP, capRows, probeLimit } from '../lib/listLimits';
import { AppError } from '../middleware/error';

export interface ConversationRow {
  partner_id: number;
  username: string;
  avatar: string | null;
  last_message: string;
  last_message_at: string;
  unread_count: number;
  /** 该会话最后一条消息的 id（D1：排序决胜键 + 游标定位键；additive，老客户端忽略） */
  last_id: number;
}

export interface MessageRow {
  id: number;
  sender_id: number;
  receiver_id: number;
  content: string;
  image_url: string | null;
  /** 语音文件名（uploads_private），与 image_url 互斥 */
  audio_url: string | null;
  audio_duration_ms: number | null;
  /** JSON 数组字符串（0-100），序列化层解析成数组 */
  audio_waveform: string | null;
  /** ASR 转写缓存（null = 还没转写过） */
  audio_text: string | null;
  read: number;
  quoted_message_id: number | null;
  created_at: string;
  sender_username: string;
  quoted_content?: string | null;
  quoted_image_url?: string | null;
  quoted_audio_url?: string | null;
  quoted_sender_username?: string | null;
}

// 会话行聚合（D1 抽出共享：全量版与游标版同一条 SELECT）。
// last_id 一并带出：既是排序决胜键，也是游标的定位键（additive 字段，老客户端忽略）。
const CONVERSATION_SELECT = `
  SELECT
    t.partner_id,
    u.username,
    u.avatar,
    CASE
      WHEN m.audio_url IS NOT NULL AND m.audio_url != '' THEN '[语音]'
      WHEN m.image_url IS NOT NULL AND m.image_url != '' AND m.content = '' THEN '[图片]'
      ELSE m.content
    END as last_message,
    m.created_at as last_message_at,
    m.id as last_id,
    t.unread_count
  FROM (
    SELECT
      g.partner_id,
      MAX(g.id) as last_id,
      SUM(CASE WHEN g.sender_id = g.partner_id AND g.read = 0 THEN 1 ELSE 0 END) as unread_count
    FROM (
      SELECT id, sender_id, receiver_id, read,
        CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END as partner_id
      FROM messages
      WHERE sender_id = ? OR receiver_id = ?
    ) g
    GROUP BY g.partner_id
  ) t
  JOIN messages m ON m.id = t.last_id
  JOIN users u ON u.id = t.partner_id
`;

/**
 * 会话列表（按最后消息时间倒序），硬上限见返回值。**全量模式**（不带 cursor 的
 * 轮询全刷客户端依赖它——旧会话的未读数靠每次全量对账刷新）。
 *
 * 实现：**单趟聚合** —— 每个会话一条分组行（MAX(id) 定位最后一条 + 未读计数同组算出），
 * 再 JOIN 回最后一条消息与用户表。此前是「每个 partner 三个相关子查询、每个子查询内部
 * OR 两个方向」，重度用户的会话数线性膨胀时每请求的扫描量是 会话数 × 表大小；
 * 聚合版无论多少会话都只扫一遍 messages（WHERE 走 sender/receiver 两个索引的 OR 优化）。
 */
export function listConversations(
  userId: number,
  cap: number = HARD_LIST_CAP
): { rows: ConversationRow[]; has_more: boolean; next_cursor: string | null } {
  const raw = stmt(`${CONVERSATION_SELECT} ORDER BY m.created_at DESC, m.id DESC LIMIT ?`).all(
    userId,
    userId,
    userId,
    probeLimit(cap)
  ) as ConversationRow[];
  const { rows, has_more } = capRows(raw, cap);
  // 附带 next_cursor（与信息流页码模式同一约定）：游标客户端从全量请求引导后续页
  const last = rows[rows.length - 1];
  return { rows, has_more, next_cursor: has_more && last ? encodeConversationCursor(last) : null };
}

// ---- 游标模式（D1，2026-10-11，形状只增不改）----
// 排序键 = (last_message_at, last_id)；last_id 即该会话最后一条消息的 id。
// 注意 last_message_at 会随新消息变化（与帖子的 created_at 不同）——seek 语义下，
// 翻页期间某旧会话若收到新消息会**跳到列表头**，其旧游标之后不再返回该行
// （不重复；该会话的最新状态由下一次全量对账带入）。这与信息流游标的取舍一致。

/** 游标编码：`last_message_at|last_id`（与信息流游标同一风格） */
export function encodeConversationCursor(row: { last_message_at: string; last_id: number }): string {
  return `${row.last_message_at}|${row.last_id}`;
}

/** 解析游标；格式非法抛 400（AppError 由路由层直接对外） */
export function decodeConversationCursor(cursor: string): { createdAt: string; lastMessageId: number } {
  const sep = cursor.lastIndexOf('|');
  if (sep <= 0 || sep === cursor.length - 1) {
    throw new AppError(400, '无效的分页游标');
  }
  const createdAt = cursor.slice(0, sep);
  const lastMessageId = Number(cursor.slice(sep + 1));
  // 与 decodeFeedCursor 同口径：兼容 T（ISO）与空格（CURRENT_TIMESTAMP）两种时间分隔符，
  // 老库存量消息的 last_message_at 是空格格式，严格要求 T 会让私信会话第二页必 400
  if (!Number.isInteger(lastMessageId) || lastMessageId <= 0 || !/^\d{4}-\d{2}-\d{2}[T ]/.test(createdAt)) {
    throw new AppError(400, '无效的分页游标');
  }
  return { createdAt, lastMessageId };
}

/**
 * 会话列表**游标模式**：单页只物化 limit 行（响应体积有界），seek 条件避免
 * 深页 OFFSET。返回 `next_cursor`/`has_more` 供客户端续拉。
 */
export function listConversationsByCursor(
  userId: number,
  opts: { limit: number; cursor: string }
): { rows: ConversationRow[]; has_more: boolean; next_cursor: string | null } {
  const boundary = decodeConversationCursor(opts.cursor);
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit)), HARD_LIST_CAP);
  const raw = stmt(
    `${CONVERSATION_SELECT}
     WHERE (m.created_at < ? OR (m.created_at = ? AND m.id < ?))
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT ?`
  ).all(
    userId,
    userId,
    userId,
    boundary.createdAt,
    boundary.createdAt,
    boundary.lastMessageId,
    limit + 1 // 多取一行判断 has_more（与信息流同一口径）
  ) as (ConversationRow & { last_id: number })[];
  const has_more = raw.length > limit;
  const rows = has_more ? raw.slice(0, limit) : raw;
  const last = rows[rows.length - 1];
  return {
    rows,
    has_more,
    next_cursor: has_more && last ? encodeConversationCursor(last) : null,
  };
}

/**
 * 某发送者发给某接收者的**最后一条**消息（含发送者昵称）。
 * 离线推送摘要用（push.service）——SQL 自 push.service 原样下沉（A2）。
 */
export function latestReceivedMessage(
  senderId: number,
  receiverId: number
): { name: string; content: string; image_url: string | null; audio_url: string | null } | undefined {
  return stmt(
    `
    SELECT u.username AS name, m.content AS content, m.image_url AS image_url,
           m.audio_url AS audio_url
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    WHERE m.sender_id = ? AND m.receiver_id = ?
    ORDER BY m.id DESC
    LIMIT 1
  `
  ).get(senderId, receiverId) as
    { name: string; content: string; image_url: string | null; audio_url: string | null } | undefined;
}

/** 某发送者发给某接收者的未读消息数（离线推送的「(N条新消息)」计数标题用） */
export function countUnreadFrom(senderId: number, receiverId: number): number {
  return (
    stmt('SELECT COUNT(*) AS c FROM messages WHERE sender_id = ? AND receiver_id = ? AND read = 0').get(
      senderId,
      receiverId
    ) as { c: number }
  ).c;
}

/** 标记当前用户收到的所有未读消息为已读 */
export function markAllRead(userId: number): void {
  stmt('UPDATE messages SET read = 1 WHERE receiver_id = ? AND read = 0').run(userId);
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
  stmt('UPDATE messages SET read = 1 WHERE sender_id = ? AND receiver_id = ?').run(
    otherUserId,
    currentUserId
  );

  // 获取双向消息记录（含被引用消息信息），按 ID 倒序取一页再翻转成正序
  let page: MessageRow[];
  if (beforeId) {
    page = stmt(
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
    ).all(currentUserId, otherUserId, otherUserId, currentUserId, beforeId, limit) as MessageRow[];
  } else {
    page = stmt(
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
    ).all(currentUserId, otherUserId, otherUserId, currentUserId, limit) as MessageRow[];
  }

  // 翻转成正序（新→旧 变 旧→新）
  const messages = page.reverse();

  // 判断是否还有更早的消息
  let hasMore = false;
  if (messages.length > 0) {
    const oldestId = messages[0]!.id;
    hasMore = !!stmt(
      `
      SELECT 1 FROM messages
      WHERE ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))
        AND id < ?
      LIMIT 1
    `
    ).get(currentUserId, otherUserId, otherUserId, currentUserId, oldestId);
  }

  return { messages, has_more: hasMore };
}

/** 验证引用消息存在且属于当前对话 */
export function isValidQuotedMessage(quotedMessageId: number, senderId: number, receiverId: number): boolean {
  const quoted = stmt(
    `
    SELECT id FROM messages WHERE id = ? AND (
      (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
    )
  `
  ).get(quotedMessageId, senderId, receiverId, receiverId, senderId) as { id: number } | undefined;
  return !!quoted;
}

/** 插入消息，返回完整消息行（含引用信息） */
export function insertMessage(input: {
  senderId: number;
  receiverId: number;
  content: string;
  imageUrl: string | null;
  /** 语音相关字段（与 imageUrl 互斥；普通文字/图片消息传 null/0） */
  audioUrl?: string | null;
  audioDurationMs?: number;
  audioWaveform?: string | null;
  quotedMessageId: number | null;
}): MessageRow {
  const result = stmt(
    `INSERT INTO messages
       (sender_id, receiver_id, content, image_url, audio_url, audio_duration_ms, audio_waveform, quoted_message_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.senderId,
    input.receiverId,
    input.content,
    input.imageUrl,
    input.audioUrl ?? null,
    input.audioDurationMs ?? 0,
    input.audioWaveform ?? null,
    input.quotedMessageId
  );

  return stmt(
    `
    SELECT m.*, u.username as sender_username,
           qm.content as quoted_content,
           qm.image_url as quoted_image_url,
           qm.audio_url as quoted_audio_url,
           qu.username as quoted_sender_username
    FROM messages m
    JOIN users u ON m.sender_id = u.id
    LEFT JOIN messages qm ON m.quoted_message_id = qm.id
    LEFT JOIN users qu ON qm.sender_id = qu.id
    WHERE m.id = ?
  `
  ).get(result.lastInsertRowid) as MessageRow;
}

/** 查询单条消息的媒体与收发双方（媒体下发归属校验 + 撤回清理 + 转写用） */
export function getMessageMedia(messageId: number):
  | {
      id: number;
      sender_id: number;
      receiver_id: number;
      image_url: string | null;
      audio_url: string | null;
      audio_text: string | null;
    }
  | undefined {
  return stmt(
    'SELECT id, sender_id, receiver_id, image_url, audio_url, audio_text FROM messages WHERE id = ?'
  ).get(messageId) as
    | {
        id: number;
        sender_id: number;
        receiver_id: number;
        image_url: string | null;
        audio_url: string | null;
        audio_text: string | null;
      }
    | undefined;
}

/** 写入语音转写缓存（ASR 成功后调用；只存第一条结果，不重复烧上游额度） */
export function setMessageAudioText(messageId: number, text: string): void {
  stmt('UPDATE messages SET audio_text = ? WHERE id = ?').run(text, messageId);
}

/** 撤回（删除）单条消息 */
export function deleteMessage(messageId: number): void {
  stmt('DELETE FROM messages WHERE id = ?').run(messageId);
}

/**
 * 清除两人之间的所有消息（双向），返回被删消息引用的**私密媒体文件名**（图片 + 语音，去重）。
 * 引用消息共享被引用行的物理文件，二者都随会话删除，因此删除全部行后
 * 这些文件必然成为孤儿——由路由层在事务提交后统一删磁盘文件。
 */
export function clearConversation(currentUserId: number, otherUserId: number): string[] {
  const names: string[] = [];
  getDb().transaction(() => {
    const rows = stmt(
      `
      SELECT DISTINCT image_url AS name FROM messages
      WHERE image_url IS NOT NULL
        AND ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))
      UNION
      SELECT DISTINCT audio_url AS name FROM messages
      WHERE audio_url IS NOT NULL
        AND ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))
    `
    ).all(
      currentUserId,
      otherUserId,
      otherUserId,
      currentUserId,
      currentUserId,
      otherUserId,
      otherUserId,
      currentUserId
    ) as { name: string }[];
    names.push(...rows.map((r) => r.name));
    stmt(
      `
      DELETE FROM messages
      WHERE (sender_id = ? AND receiver_id = ?)
         OR (sender_id = ? AND receiver_id = ?)
    `
    ).run(currentUserId, otherUserId, otherUserId, currentUserId);
  })();
  return names;
}
