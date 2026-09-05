/**
 * ============================================================
 * 语音房间数据访问层
 * ============================================================
 * - 创建者信息使用"快照列"（creator_name / creator_avatar），
 *   支持未登录访客建房（无 users 行可 JOIN），避免 JOIN users 对
 *   负数 creator_id（访客）失效。
 * - creator_ip 仅服务端内部用于访客所有权校验，任何 API 响应
 *   都不得返回该字段（toVoiceRoom 负责剥离）。
 * - 删除房间时同步删除其全部聊天记录（语音房聊天随房销毁）。
 */

import type { Database } from 'better-sqlite3';
import { getDb } from '../db/connection';
import type { VoiceRoom } from '@k/shared';

/** voice_rooms 行（含仅服务端内部使用的列） */
export interface VoiceRoomRow {
  id: number;
  name: string;
  description: string;
  creator_id: number;
  /** 创建者快照：用户名（登录用户为用户表值，访客为占位名） */
  creator_name: string;
  /** 创建者快照：头像 */
  creator_avatar: string | null;
  /** 访客创建者的 IP 锚点（登录用户为 NULL；绝不下发客户端） */
  creator_ip: string | null;
  created_at: string;
}

/** 房间基础列（含快照创建者列，不含 creator_ip） */
const ROOM_COLUMNS =
  'id, name, description, creator_id, creator_name, creator_avatar, creator_ip, created_at';

/** 行 -> 对外 VO 模型（剥离内部列；DB 列名 creator_name 映射为共享类型字段 creator_username） */
export function toVoiceRoom(row: VoiceRoomRow): VoiceRoom {
  const { creator_name, ...rest } = row;
  delete (rest as { creator_ip?: string }).creator_ip;
  return { ...rest, creator_username: creator_name, participantCount: 0 };
}

/** 全部房间（列表按在线人数/创建时间排序由路由层处理） */
export function listRooms(db: Database = getDb()): VoiceRoomRow[] {
  return db
    .prepare(
      `SELECT ${ROOM_COLUMNS} FROM voice_rooms
       ORDER BY created_at DESC`
    )
    .all() as VoiceRoomRow[];
}

export function getRoomById(roomId: number, db: Database = getDb()): VoiceRoomRow | undefined {
  return db.prepare(`SELECT ${ROOM_COLUMNS} FROM voice_rooms WHERE id = ?`).get(roomId) as
    VoiceRoomRow | undefined;
}

export interface CreateVoiceRoomOptions {
  /** 创建者用户名快照（缺省写空串，路由层应总是显式传入） */
  creatorName?: string;
  creatorAvatar?: string | null;
  /** 访客创建者 IP 锚点（登录用户不传） */
  creatorIp?: string | null;
}

export function createRoom(
  creatorId: number,
  name: string,
  description: string,
  opts: CreateVoiceRoomOptions = {},
  db: Database = getDb()
): VoiceRoomRow {
  // 访客负数 id 无法通过 creator_id 外键（生产库 foreign_keys=ON），
  // 落库统一归一为 0 占位；访客房间的所有权判定以 creator_ip 为唯一锚点
  const storedCreatorId = creatorId > 0 ? creatorId : 0;
  const result = db
    .prepare(
      `INSERT INTO voice_rooms (name, description, creator_id, creator_name, creator_avatar, creator_ip)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      name,
      description,
      storedCreatorId,
      opts.creatorName ?? '',
      opts.creatorAvatar ?? null,
      opts.creatorIp ?? null
    );
  const room = getRoomById(Number(result.lastInsertRowid), db);
  if (!room) throw new Error('创建语音房间失败：写入后无法读取');
  return room;
}

/** 删除房间（连同其聊天记录一起清掉） */
export function deleteRoom(roomId: number, db: Database = getDb()): boolean {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM voice_room_messages WHERE room_id = ?').run(roomId);
    const result = db.prepare('DELETE FROM voice_rooms WHERE id = ?').run(roomId);
    return result.changes > 0;
  });
  return tx();
}
