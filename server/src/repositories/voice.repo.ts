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

import crypto from 'crypto';
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
  /**
   * 访客房间的所有权令牌（登录用户创建的房间为 NULL）。
   * 等价于密码：只在创建响应里回一次，列表/详情一律不下发（见 ROOM_COLUMNS 与 toVoiceRoom）。
   */
  owner_token: string | null;
  created_at: string;
}

/** 房间基础列（含快照创建者列，不含 creator_ip —— 但**含** owner_token，鉴权需要） */
const ROOM_COLUMNS =
  'id, name, description, creator_id, creator_name, creator_avatar, creator_ip, owner_token, created_at';

/** 行 -> 对外 VO 模型（剥离内部列；DB 列名 creator_name 映射为共享类型字段 creator_username） */
export function toVoiceRoom(row: VoiceRoomRow): VoiceRoom {
  const { creator_name, ...rest } = row;
  delete (rest as { creator_ip?: string }).creator_ip;
  // owner_token 等价于访客房间的密码：对外 VO 一律剥离
  // （只有创建响应会用单独字段回传一次，见 routes/voice.ts）
  delete (rest as { owner_token?: string | null }).owner_token;
  return { ...rest, creator_username: creator_name, participantCount: 0 };
}

/** 全部房间（列表按在线人数/创建时间排序由路由层处理；LIMIT 封顶防无界增长） */
export function listRooms(db: Database = getDb()): VoiceRoomRow[] {
  return db
    .prepare(
      `SELECT ${ROOM_COLUMNS} FROM voice_rooms
       ORDER BY created_at DESC, id DESC LIMIT 200`
    )
    .all() as VoiceRoomRow[];
}

/** 创建者（登录用户）名下已有房间数——创建频控用 */
export function countRoomsByCreatorId(creatorId: number, db: Database = getDb()): number {
  return (
    db.prepare('SELECT COUNT(*) AS c FROM voice_rooms WHERE creator_id = ?').get(creatorId) as {
      c: number;
    }
  ).c;
}

/** 创建者（访客按 IP 锚点）名下已有房间数——创建频控用 */
export function countRoomsByCreatorIp(ip: string, db: Database = getDb()): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM voice_rooms WHERE creator_ip = ?').get(ip) as { c: number })
    .c;
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
  // 落库统一归一为 0 占位；访客房间的所有权判定改为**房间级令牌**（见 026 迁移）
  const storedCreatorId = creatorId > 0 ? creatorId : 0;
  // 访客房间签发所有权令牌：等价于密码，客户端保存后在删除/清聊天时带上。
  // 登录用户不需要（按 creator_id 判定），保持 NULL。
  const ownerToken = storedCreatorId > 0 ? null : crypto.randomBytes(24).toString('hex');
  const result = db
    .prepare(
      `INSERT INTO voice_rooms (name, description, creator_id, creator_name, creator_avatar, creator_ip, owner_token)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      name,
      description,
      storedCreatorId,
      opts.creatorName ?? '',
      opts.creatorAvatar ?? null,
      opts.creatorIp ?? null,
      ownerToken
    );
  const room = getRoomById(Number(result.lastInsertRowid), db);
  if (!room) throw new Error('创建语音房间失败：写入后无法读取');
  return room;
}

/**
 * 访客房间所有权校验：比较令牌（**定长恒定时间**比较，避免通过响应时间侧信道爆破）。
 * 房间没有令牌（026 迁移前的存量访客房间）时返回 false —— 由调用方决定是否回退到 IP 判定。
 */
export function matchesOwnerToken(row: VoiceRoomRow, token: string | undefined): boolean {
  if (!row.owner_token || !token) return false;
  const a = Buffer.from(row.owner_token, 'utf8');
  const b = Buffer.from(token, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * 在「创建者房间数上限」校验下创建房间：**校验与插入在同一事务内**。
 *
 * 路由原先分两步（countRoomsByCreator* → createRoom）。better-sqlite3 是同步的，
 * 单次调用之间不会被打断，但两步之间存在一个真实的交错窗口：并发创建
 * （连点、多标签、脚本）会各自读到「还没到上限」而双双插入，越过封顶。
 *
 * @returns 创建好的房间；已达上限返回 null（由路由转 429，文案与状态码保持不变）
 */
export function createRoomWithinLimit(
  input: {
    /** 登录用户 id（>0）或访客的负数/0 占位 id */
    creatorId: number;
    name: string;
    description: string;
    /** 创建者房间数上限 */
    limit: number;
    /** 访客创建者 IP 锚点（登录用户不传） */
    creatorIp?: string | null;
  } & CreateVoiceRoomOptions,
  db: Database = getDb()
): VoiceRoomRow | null {
  return db.transaction(() => {
    const used =
      input.creatorId > 0
        ? countRoomsByCreatorId(input.creatorId, db)
        : countRoomsByCreatorIp(input.creatorIp ?? '', db);
    if (used >= input.limit) return null;
    return createRoom(
      input.creatorId,
      input.name,
      input.description,
      {
        ...(input.creatorName !== undefined ? { creatorName: input.creatorName } : {}),
        ...(input.creatorAvatar !== undefined ? { creatorAvatar: input.creatorAvatar } : {}),
        ...(input.creatorIp !== undefined ? { creatorIp: input.creatorIp } : {}),
      },
      db
    );
  })();
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
