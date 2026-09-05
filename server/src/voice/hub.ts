/**
 * ============================================================
 * 语音房间内存状态中心（Voice Hub）
 * ============================================================
 * 维护"哪个房间里有谁在线"的内存态（不入库），
 * 并提供房间内广播 / 定点转发能力，供 WS 信令层调用。
 *
 * 设计约定:
 * - 每个用户同一时刻只在一个房间（重复加入先移出旧房间）
 * - 同一用户重复连接（第二个标签页）时，旧连接被移除时不影响新连接
 * - 房间元数据（名称/简介）持久在 voice_rooms 表，在线态随进程重启清空
 */

import type WebSocket from 'ws';
import type { VoiceParticipant } from '@k/shared';

/** 房间内成员（含 WS 连接引用，仅服务端内部使用） */
export interface VoiceMember {
  userId: number;
  username: string;
  avatar: string | null;
  muted: boolean; // 用户主动关闭麦克风
  listener: boolean; // 无麦克风权限、仅收听
  ws: WebSocket;
  /** 成员自报的网络质量（客户端约 4s 一报；undefined = 尚未上报） */
  quality?: 'good' | 'fair' | 'poor';
  qualityAt?: number;
  /** 正在共享屏幕（同一时刻每房间最多一人，由 setSharing 互斥保证） */
  sharing?: boolean;
}

/** roomId -> (userId -> member) 在线状态表 */
const rooms = new Map<number, Map<number, VoiceMember>>();

/** 统一序列化发送 */
function rawSend(ws: WebSocket, message: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

/** 裁剪为下发客户端的参与者信息（去掉 ws 引用） */
export function toParticipant(m: VoiceMember): VoiceParticipant {
  return {
    userId: m.userId,
    username: m.username,
    avatar: m.avatar,
    muted: m.muted,
    listener: m.listener,
    sharing: !!m.sharing,
  };
}

/** 房间内广播（可排除某个成员） */
export function broadcast(roomId: number, message: unknown, excludeUserId?: number): void {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const m of room.values()) {
    if (m.userId !== excludeUserId) rawSend(m.ws, message);
  }
}

/** 定点发送（按 userId 在任意房间查找） */
export function sendToUser(userId: number, message: unknown): void {
  const m = findMember(userId);
  if (m) rawSend(m.ws, message);
}

/** 在任意房间中查找成员 */
export function findMember(userId: number): VoiceMember | undefined {
  for (const room of rooms.values()) {
    const m = room.get(userId);
    if (m) return m;
  }
  return undefined;
}

/** 查找成员当前所在房间 id（未在任何房间返回 undefined） */
export function getMemberRoomId(userId: number): number | undefined {
  for (const [roomId, room] of rooms) {
    if (room.has(userId)) return roomId;
  }
  return undefined;
}

/** 房间当前在线人数 */
export function getRoomCount(roomId: number): number {
  return rooms.get(roomId)?.size ?? 0;
}

/** 全部房间在线人数快照（REST 列表接口用） */
export function getOccupancy(): Map<number, number> {
  const counts = new Map<number, number>();
  for (const [roomId, room] of rooms) counts.set(roomId, room.size);
  return counts;
}

/**
 * 加入房间：先移除该用户在任意旧房间的成员身份（广播 peer-left），
 * 返回加入前的既有成员列表（新加入者据此向他们逐一发起 offer）。
 */
export function joinRoom(roomId: number, member: VoiceMember): VoiceParticipant[] {
  removeMember(member.userId);
  let room = rooms.get(roomId);
  if (!room) {
    room = new Map();
    rooms.set(roomId, room);
  }
  const existing = [...room.values()].map(toParticipant);
  room.set(member.userId, member);
  broadcast(roomId, { type: 'peer-joined', participant: toParticipant(member) }, member.userId);
  return existing;
}

/** 主动离开当前所在房间（广播 peer-left） */
export function leaveRoom(userId: number): void {
  removeMember(userId);
}

/** 内部移除：按 userId 找到并删除，清空房间时顺带删除 Map 条目 */
function removeMember(userId: number): void {
  for (const [roomId, room] of rooms) {
    const m = room.get(userId);
    if (!m) continue;
    room.delete(userId);
    if (room.size === 0) rooms.delete(roomId);
    else {
      broadcast(roomId, { type: 'peer-left', userId });
      // 共享者离开：广播共享结束，观成员的舞台随之关闭
      if (m.sharing) broadcast(roomId, { type: 'share-changed', userId, active: false, audio: false });
    }
    return;
  }
}

/** 连接断开清理：仅当该成员仍持有此连接时移除（防止旧连接的 close 误踢新连接） */
export function removeBySocket(ws: WebSocket): void {
  for (const [roomId, room] of rooms) {
    for (const [uid, m] of room) {
      if (m.ws !== ws) continue;
      room.delete(uid);
      if (room.size === 0) rooms.delete(roomId);
      else {
        broadcast(roomId, { type: 'peer-left', userId: uid });
        if (m.sharing) broadcast(roomId, { type: 'share-changed', userId: uid, active: false, audio: false });
      }
      return;
    }
  }
}

/** 更新静音状态并广播 */
export function setMuted(userId: number, muted: boolean): void {
  const m = findMember(userId);
  if (!m || m.muted === muted) return;
  m.muted = muted;
  for (const [roomId, room] of rooms) {
    if (room.has(userId)) broadcast(roomId, { type: 'mute-changed', userId, muted });
  }
}

/**
 * 更新屏幕共享状态并广播。
 * - active=true：抢占式——同房间其他共享者先被停（向其发 share-force-stop，
 *   客户端收到后停止采集），再广播新共享者，保证同一时刻全房间只有一人共享。
 * - active=false：仅当该成员确为当前共享者时生效（防止误清他人的共享状态）。
 * - 成员离开/断线/被顶号：由 removeMember / removeBySocket 广播 share-changed(false)。
 */
export function setSharing(userId: number, active: boolean, audio = false): void {
  for (const [roomId, room] of rooms) {
    const m = room.get(userId);
    if (!m) continue;
    if (active) {
      for (const other of room.values()) {
        if (other.userId === userId || !other.sharing) continue;
        other.sharing = false;
        rawSend(other.ws, { type: 'share-force-stop' });
        broadcast(roomId, { type: 'share-changed', userId: other.userId, active: false, audio: false });
      }
    }
    if (!!m.sharing === active) return;
    m.sharing = active;
    broadcast(roomId, { type: 'share-changed', userId, active, audio: active ? audio : false });
    return; // 同一用户同时只在一个房间
  }
}

/** 质量广播最小间隔（客户端约 4s 一报，这里兜底节流，防异常客户端刷屏） */
const QUALITY_MIN_INTERVAL_MS = 2000;

/**
 * 成员自报网络质量：节流 + 等级去重后向所在房间广播（含自己，自己卡片同步展示）。
 * 圆点语义 = 该成员自身的网络状况，供其他人判断"是谁的网络有问题"。
 */
export function setQuality(userId: number, level: 'good' | 'fair' | 'poor'): void {
  const m = findMember(userId);
  if (!m || m.quality === level) return;
  const now = Date.now();
  if (m.qualityAt !== undefined && now - m.qualityAt < QUALITY_MIN_INTERVAL_MS) return;
  m.quality = level;
  m.qualityAt = now;
  for (const [roomId, room] of rooms) {
    if (!room.has(userId)) continue;
    broadcast(roomId, { type: 'peer-quality', userId, level });
    return; // 同一用户同时只在一个房间
  }
}

/** 房间被删除：通知所有在线成员并断开连接 */
export function closeRoom(roomId: number, reason: string): void {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const m of room.values()) {
    rawSend(m.ws, { type: 'room-closed', reason });
    m.ws.close(4003, reason);
  }
  rooms.delete(roomId);
}
