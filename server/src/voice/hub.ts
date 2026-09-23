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
  /** 共享方声明的采集像素尺寸（随 share-start 上行；语义见 @k/shared 的 VoiceParticipant.width） */
  shareWidth?: number;
  shareHeight?: number;
}

/** roomId -> (userId -> member) 在线状态表 */
const rooms = new Map<number, Map<number, VoiceMember>>();

/**
 * 校验客户端声明的采集尺寸（`share-start` 的 width/height）。
 *
 * 服务端对信令是**零业务校验直转**的，但这两个数会被写进所有观看端（含后进房者）的房间成员信息
 * 并直接决定画面框比例，所以只做最基本的"正整数且量级合理"收口 —— 不合法就当作**未声明**，
 * 让观看端走原来的接收探针路径（这是向后兼容的同一档行为）。
 * 比例本身是否合理不在这里判断：观看端另有自己的退化值兜底（0.05 以下按未知处理）。
 */
export function normalizeShareSize(
  width: unknown,
  height: unknown
): { width: number; height: number } | undefined {
  const ok = (v: unknown): v is number =>
    typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 100_000;
  if (!ok(width) || !ok(height)) return undefined;
  return { width, height };
}

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
    // 采集尺寸只在共享期间有意义：停止共享时 setSharing 已把它清掉，
    // 这里仍显式用 sharing 兜一道，避免"停止后仍带着旧尺寸"的畸形快照
    ...(m.sharing && m.shareWidth && m.shareHeight ? { width: m.shareWidth, height: m.shareHeight } : {}),
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
      // （成员对象已随 room.delete 消失，声明的采集尺寸不需要单独清）
      if (m.sharing) broadcastShareStop(roomId, userId);
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
        if (m.sharing) broadcastShareStop(roomId, uid);
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
 *
 * @param size 共享方声明的采集像素尺寸（可选，来自 share-start 的 width/height，
 *   已经过 normalizeShareSize 收口）。写进成员态后随 share-changed 广播，
 *   并出现在之后进房者的 joined.participants 里 —— 观看端据此在**首帧之前**定下画面比例。
 *   停止共享时一并清除：离开共享态的成员不该再带着旧尺寸。
 */
export function setSharing(
  userId: number,
  active: boolean,
  audio = false,
  size?: { width: number; height: number }
): void {
  for (const [roomId, room] of rooms) {
    const m = room.get(userId);
    if (!m) continue;
    if (active) {
      for (const other of room.values()) {
        if (other.userId === userId || !other.sharing) continue;
        other.sharing = false;
        clearShareSize(other);
        rawSend(other.ws, { type: 'share-force-stop' });
        broadcastShareStop(roomId, other.userId);
      }
    }
    if (!!m.sharing === active) return;
    m.sharing = active;
    if (active && size) {
      m.shareWidth = size.width;
      m.shareHeight = size.height;
    } else if (!active) {
      clearShareSize(m);
    }
    // 尺寸只跟 active=true 一起发：停止共享的广播（含上面的抢占兜底）不带尺寸，
    // 观看端收到 active=false 一律清掉自己缓存的声明值
    if (active) {
      broadcast(roomId, {
        type: 'share-changed',
        userId,
        active: true,
        audio,
        ...(size ? { width: size.width, height: size.height } : {}),
      });
    } else {
      broadcastShareStop(roomId, userId);
    }
    return; // 同一用户同时只在一个房间
  }
}

/** 清掉成员身上声明的采集尺寸（离开共享态时统一走这里，避免两处各清一半） */
function clearShareSize(m: VoiceMember): void {
  delete m.shareWidth;
  delete m.shareHeight;
}

/**
 * 广播"某人已停止共享"。
 *
 * 三处兜底（成员离开 / 断线被顶 / 被新共享者抢占）与主动 share-stop 都走这里：
 * 停止广播的字段形状必须逐字一致（`active:false` + `audio:false`，**不带采集尺寸**
 * —— 尺寸只在共享期间有意义），各写一份迟早会漂移。
 */
function broadcastShareStop(roomId: number, userId: number): void {
  broadcast(roomId, { type: 'share-changed', userId, active: false, audio: false });
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
