/**
 * ============================================================
 * 语音房间路由模块 (/api/voice)
 * ============================================================
 * 房间元数据 CRUD + 聊天记录读写 + ICE 服务器配置下发；
 * 实时信令走同路径下的 WebSocket（voice/ws.ts，/api/voice/ws）
 *
 * API 端点:
 * - GET    /api/voice/rooms                - 房间列表（合并实时在线人数 + 逐查看者 isCreator）
 * - POST   /api/voice/rooms                - 创建房间（登录用户或未登录访客均可）
 * - DELETE /api/voice/rooms/:id            - 删除房间（创建者或管理员，在线成员会被请出）
 * - GET    /api/voice/rooms/:id/messages   - 聊天记录（游标分页 before_id/after_id/limit）
 * - DELETE /api/voice/rooms/:id/messages   - 清空聊天记录（权限同删除房间，在线成员收 chat-cleared）
 * - GET    /api/voice/ice                  - WebRTC ICE 服务器配置
 *
 * 认证策略:
 * - GET 列表/聊天/ICE：可选认证（无效 token 静默跳过）
 * - POST/DELETE：voiceAuth —— 有 token 时按必须认证处理（无效/过期 → 401，
 *   封禁中禁止写操作），无 token 时按访客处理（IP 分配负数 id，与语音 WS 同一身份）
 * ============================================================
 */

import { Router, Request, Response } from 'express';
import { verifyLiveToken, optionalAuth } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/error';
import { validateBody } from '../validate';
import * as voiceRepo from '../repositories/voice.repo';
import type { VoiceRoomRow } from '../repositories/voice.repo';
import * as voiceChatRepo from '../repositories/voice-chat.repo';
import { getSafeUser } from '../repositories/user.repo';
import * as voiceHub from '../voice/hub';
import { guestIds } from '../voice/guest-ids';
import { getClientIp } from '../lib/client-ip';
import { env } from '../config';
import { createVoiceRoomSchema } from '@k/shared';

const router = Router();

/** ICE 服务器基础配置（STUN 部分，静态不变；urls 兼容单地址字符串与数组两种形态） */
const ICE_BASE_SERVERS: { urls: string | string[]; username?: string; credential?: string }[] = [
  { urls: ['stun:stun.qq.com:3478', 'stun:stun.miwifi.com:3478', 'stun:stun.l.google.com:19302'] },
];

/** voiceAuth 注入的访客来源 IP（请求结束释放 guestIds 引用后即失效） */
interface VoiceAuthRequest extends Request {
  voiceGuestIp?: string;
}

/**
 * 认证或访客中间件（语音写操作专用）
 *
 * 行为:
 * - 带 Authorization: Bearer <token>：按必须认证处理——token 缺失/无效/过期 → 401
 *   （绝不当成访客，避免本地残留 token 被误判）；封禁中的账号禁止写操作 → 403
 * - 无 token：视为未登录访客，按来源 IP 分配负数 id（与语音 WS 同池同身份），
 *   响应结束（finish/close）即归还引用计数（10 分钟窗口内复用原 id）
 */
function voiceAuth(req: Request, res: Response, next: () => void): void {
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const live = verifyLiveToken(authHeader.split(' ')[1]);
    if (!live) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }
    req.user = { id: live.id, username: live.username, role: live.role };
    // 封禁拦截：与 authMiddleware 一致，封禁期间写操作一律 403
    if (live.role !== 'admin' && live.banned_until && live.banned_until > new Date().toISOString()) {
      res.status(403).json({
        error: `账号已被封禁（解封时间: ${live.banned_until.slice(0, 10)}），封禁期间仅可浏览`,
        banned: true,
      });
      return;
    }
    next();
    return;
  }

  // 无 token = 未登录访客：按 IP 分配/复用负数 id（同 IP 10 分钟内保持同一身份）
  const ip = getClientIp(req);
  const { id } = guestIds.acquire(ip);
  req.user = { id, username: `未登录-${-id}` };
  (req as VoiceAuthRequest).voiceGuestIp = ip;
  // 请求结束即归还引用计数（release 内部有计数防御，finish/close 双触发重复调用安全）
  const release = () => guestIds.release(ip);
  res.on('finish', release);
  res.on('close', release);
  next();
}

/**
 * 房间所有权判定（删除房间 / 清空聊天记录共用）
 * - 管理员恒有权限
 * - 登录用户：creator_id 匹配本人（正数 id）
 * - 访客：creator_ip 与请求来源 IP 一致（负数 id 无法落库（外键），
 *   且访客 id 会随 guestIds 释放而失效，因此访客所有权以 IP 为唯一准绳；
 *   creator_ip 仅访客建房时写入，登录用户建房为 NULL，判定天然互斥）
 */
function isRoomOwner(req: Request, room: VoiceRoomRow): boolean {
  if (req.user?.role === 'admin') return true;
  if (!req.user) return false;
  if (req.user.id > 0) return room.creator_id === req.user.id;
  return room.creator_ip !== null && room.creator_ip === getClientIp(req);
}

/**
 * GET /api/voice/rooms - 房间列表
 *
 * 认证: 可选（无效 token 静默跳过）
 * 在线人数来自 WS 内存态；有人的房间排前，同级按创建时间倒序。
 * isCreator 逐查看者计算（登录用户比 creator_id，访客比 creator_ip），服务端不泄露 creator_ip。
 */
router.get(
  '/rooms',
  optionalAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const viewerIp = req.user ? undefined : getClientIp(req);
    const occupancy = voiceHub.getOccupancy();
    const rooms = voiceRepo.listRooms().map((row) => {
      const room = voiceRepo.toVoiceRoom(row);
      room.participantCount = occupancy.get(row.id) ?? 0;
      room.isCreator = req.user
        ? row.creator_id === req.user.id
        : row.creator_ip !== null && row.creator_ip === viewerIp;
      return room;
    });
    rooms.sort((a, b) => b.participantCount! - a.participantCount! || (b.created_at > a.created_at ? 1 : -1));
    res.json({ rooms });
  })
);

/**
 * POST /api/voice/rooms - 创建房间
 *
 * 认证: voiceAuth（登录用户或未登录访客均可创建）
 * 创建者快照: 登录用户取 users 表实时值；访客取占位名并以 IP 作为所有权锚点。
 */
router.post(
  '/rooms',
  voiceAuth,
  validateBody(createVoiceRoomSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { name, description } = req.body;
    const user = req.user!;
    let row: VoiceRoomRow;
    if (user.id > 0) {
      const safe = getSafeUser(user.id);
      row = voiceRepo.createRoom(user.id, name, description ?? '', {
        creatorName: safe?.username ?? user.username,
        creatorAvatar: safe?.avatar ?? null,
      });
    } else {
      row = voiceRepo.createRoom(user.id, name, description ?? '', {
        creatorName: user.username,
        creatorAvatar: null,
        creatorIp: (req as VoiceAuthRequest).voiceGuestIp,
      });
    }
    res.status(201).json({ room: { ...voiceRepo.toVoiceRoom(row), participantCount: 0 } });
  })
);

/**
 * DELETE /api/voice/rooms/:id - 删除房间
 *
 * 认证: voiceAuth（创建者或管理员；访客以 IP 判定所有权）
 * 房间内在线成员会收到 room-closed 并被断开；聊天记录随房间一起清除。
 */
router.delete(
  '/rooms/:id',
  voiceAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw new AppError(400, '参数错误');
    const room = voiceRepo.getRoomById(id);
    if (!room) throw new AppError(404, '房间不存在');
    if (!isRoomOwner(req, room)) throw new AppError(403, '只有房间创建者或管理员可以删除房间');
    voiceRepo.deleteRoom(id);
    voiceHub.closeRoom(id, '房间已被删除');
    res.json({ success: true });
  })
);

/**
 * GET /api/voice/rooms/:id/messages - 聊天记录（持久化历史）
 *
 * 认证: 可选（访客可读）
 * 游标分页: before_id 向更早翻、after_id 向更新翻（加入房间后补拉增量），
 * limit 默认 50、上限 100。房间不存在返回 404。
 */
router.get(
  '/rooms/:id/messages',
  asyncHandler(async (req: Request, res: Response) => {
    const roomId = Number(req.params.id);
    if (!Number.isInteger(roomId)) throw new AppError(400, '参数错误');
    const room = voiceRepo.getRoomById(roomId);
    if (!room) throw new AppError(404, '房间不存在');

    const limitRaw = Number(req.query.limit ?? 50);
    const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 50;
    const beforeId = parseCursor(req.query.before_id, 'before_id');
    const afterId = parseCursor(req.query.after_id, 'after_id');

    const { messages, has_more } = voiceChatRepo.listRoomMessages(roomId, {
      beforeId,
      afterId,
      limit,
    });
    res.json({ messages, has_more });
  })
);

/**
 * DELETE /api/voice/rooms/:id/messages - 清空聊天记录
 *
 * 认证: voiceAuth（权限同删除房间）
 * 在线成员即时收到 { type: 'chat-cleared' } 清空本地列表（离线成员下次进房自然看不到旧记录）。
 */
router.delete(
  '/rooms/:id/messages',
  voiceAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const roomId = Number(req.params.id);
    if (!Number.isInteger(roomId)) throw new AppError(400, '参数错误');
    const room = voiceRepo.getRoomById(roomId);
    if (!room) throw new AppError(404, '房间不存在');
    if (!isRoomOwner(req, room)) throw new AppError(403, '只有房间创建者或管理员可以清空聊天记录');
    voiceChatRepo.deleteRoomMessages(roomId);
    voiceHub.broadcast(roomId, { type: 'chat-cleared' });
    res.json({ success: true });
  })
);

/**
 * GET /api/voice/ice - WebRTC ICE 服务器配置
 *
 * 认证: 可选（公开；仅 STUN/TURN 地址，无敏感信息）
 * 服务端配了 TURN 环境变量时追加中继配置。
 */
router.get(
  '/ice',
  asyncHandler(async (_req: Request, res: Response) => {
    // 每次请求构建新数组返回（历史 bug：曾向模块级数组 push TURN 条目，
    // 每请求一次叠加一条，客户端 ICE 候选收集被重复项拖慢）
    const iceServers = [...ICE_BASE_SERVERS];
    if (env.VOICE_TURN_URL) {
      iceServers.push({
        urls: env.VOICE_TURN_URL,
        ...(env.VOICE_TURN_USERNAME ? { username: env.VOICE_TURN_USERNAME } : {}),
        ...(env.VOICE_TURN_CREDENTIAL ? { credential: env.VOICE_TURN_CREDENTIAL } : {}),
      });
    }
    res.json({ iceServers });
  })
);

/** 解析游标查询参数（正整数，非法值报 400；缺省返回 undefined） */
function parseCursor(raw: unknown, name: string): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw === '') return undefined;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 1) throw new AppError(400, `${name} 参数无效`);
  return v;
}

export default router;
