/**
 * ============================================================
 * 语音房间聊天记录仓库（voice-chat.repository）
 * ============================================================
 * - 聊天记录持久化于 voice_room_messages，随房间删除而清理
 *   （见 voice.repo.ts deleteRoom），无上限、靠游标分页。
 * - 用户名/头像在发送时快照进行内（访客没有 users 行），
 *   保证历史消息不随用户改名/删号而失真。
 */

import type { Database } from 'better-sqlite3';
import { getDb } from '../db/connection';
import type { VoiceChatMessage } from '@k/shared';

/** voice_room_messages 行（字段与共享 VoiceChatMessage 一致） */
export interface VoiceChatMessageRow {
  id: number;
  room_id: number;
  sender_id: number;
  username: string;
  avatar: string | null;
  content: string;
  created_at: string;
}

const MESSAGE_COLUMNS = 'id, room_id, sender_id, username, avatar, content, created_at';

function rowToMessage(row: VoiceChatMessageRow): VoiceChatMessage {
  return { ...row };
}

/**
 * 游标分页读取某房间的聊天记录（按 ID 倒序取一页，再翻转为正序返回）
 * - 无游标：最近 limit 条（首屏），has_more 表示是否还有更早的
 * - before_id：向更早翻页（旧消息）
 * - after_id：向更新翻页（加入房间后补拉增量，通常配合 limit）
 * - before_id 与 after_id 都传时以 before_id 优先
 */
export function listRoomMessages(
  roomId: number,
  opts: { beforeId?: number; afterId?: number; limit: number },
  db: Database = getDb()
): { messages: VoiceChatMessage[]; has_more: boolean } {
  const { beforeId, afterId, limit } = opts;

  let condition: string;
  let params: (number | number)[];

  if (beforeId !== undefined) {
    condition = 'room_id = ? AND id < ?';
    params = [roomId, beforeId];
  } else if (afterId !== undefined) {
    condition = 'room_id = ? AND id > ?';
    params = [roomId, afterId];
  } else {
    condition = 'room_id = ?';
    params = [roomId];
  }

  const page = db
    .prepare(
      `SELECT ${MESSAGE_COLUMNS} FROM voice_room_messages
       WHERE ${condition}
       ORDER BY id ${afterId !== undefined ? 'ASC' : 'DESC'}
       LIMIT ?`
    )
    .all(...params, limit) as VoiceChatMessageRow[];

  // 无游标/向更早翻页：倒序取页再翻转为正序返回（首屏=最近 limit 条）
  const descending = afterId === undefined;
  const messages = (descending ? page.reverse() : page).map(rowToMessage);

  // 判断是否还有更早的消息（before 翻页/首屏才有意义；after 追新已是最新）
  let hasMore = false;
  if (messages.length > 0 && afterId === undefined) {
    const oldestId = messages[0].id;
    hasMore = !!db
      .prepare('SELECT 1 FROM voice_room_messages WHERE room_id = ? AND id < ? LIMIT 1')
      .get(roomId, oldestId);
  }

  return { messages, has_more: hasMore };
}

/** 插入一条聊天记录，返回带服务端 id / created_at 的完整消息 */
export function insertVoiceChatMessage(
  input: {
    roomId: number;
    senderId: number;
    username: string;
    avatar: string | null;
    content: string;
  },
  db: Database = getDb()
): VoiceChatMessage {
  const result = db
    .prepare(
      `INSERT INTO voice_room_messages (room_id, sender_id, username, avatar, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(input.roomId, input.senderId, input.username, input.avatar, input.content, new Date().toISOString());
  const row = db
    .prepare(`SELECT ${MESSAGE_COLUMNS} FROM voice_room_messages WHERE id = ?`)
    .get(result.lastInsertRowid) as VoiceChatMessageRow | undefined;
  if (!row) throw new Error('语音聊天记录写入失败：写入后无法读取');
  return rowToMessage(row);
}

/** 清空某房间的全部聊天记录（房主/管理员操作） */
export function deleteRoomMessages(roomId: number, db: Database = getDb()): void {
  db.prepare('DELETE FROM voice_room_messages WHERE room_id = ?').run(roomId);
}
