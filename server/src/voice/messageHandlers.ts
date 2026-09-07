/**
 * ============================================================
 * 语音信令消息处理（8 类 C→S 消息的纯逻辑）
 * ============================================================
 * 从 voice/ws.ts 的连接生命周期（认证/心跳/断开清理）中拆出，
 * 每个 case 的处理体与拆分前逐字节一致（错误文案、节流间隔、
 * 信令令牌桶参数、静默忽略分支、broadcast 目标均不变）。
 *
 * 依赖注入约定：hub 与 insertVoiceChatMessage 经 ctx 传入（纯函数、
 * 可独立测试）；连接级状态（lastChatAt / signalTokens / signalLastRefill）
 * 挂在 ctx.ws（VoiceWs）上，随连接生命周期释放，语义与拆分前一致。
 */

import type WebSocket from 'ws';
import { getRoomById } from '../repositories/voice.repo';
import { insertVoiceChatMessage } from '../repositories/voice-chat.repo';
import * as hub from './hub';
import { CONTROL_CHAR_RE, VOICE_MAX_ROOM_SIZE, voiceChatSchema } from '@k/shared';

/** 文字聊天发送节流（每条消息间隔下限，防刷屏；状态挂在连接上，断开即释放） */
const CHAT_THROTTLE_MS = 400;

/**
 * 信令转发限流（令牌桶）：允许 ICE 候选/SDP 的短时突发（SIGNAL_BURST 条），
 * 持续速率上限 SIGNAL_REFILL_PER_SEC 条/秒。信令是机器节奏的消息，不能用聊天那种
 * 固定最小间隔节流，否则会误杀 trickle ICE 突发导致建联失败。
 */
const SIGNAL_BURST = 40;
const SIGNAL_REFILL_PER_SEC = 20;

/**
 * 带存活标记的连接（心跳用；guestIp 为访客连接的来源 IP，断开时归还引用；
 * lastChatAt/signalTokens/signalLastRefill 为消息处理挂在连接上的节流/限流状态）。
 * 自 voice/ws.ts 移入本模块（ws.ts 引用此类型，保持连接层类型严格）。
 */
export type VoiceWs = WebSocket & {
  isAlive?: boolean;
  guestIp?: string;
  lastChatAt?: number;
  /** 信令令牌桶状态（见 SIGNAL_BURST/SIGNAL_REFILL_PER_SEC） */
  signalTokens?: number;
  signalLastRefill?: number;
};

/**
 * 处理一条入站信令（对应 ws.ts 中 ws.on('message') 的 8 类 switch）。
 *
 * @param ctx.user  已解析的认证用户（登录用户或访客负数 id；见 ws.ts 认证段）
 * @param ctx.ws    当前连接（节流/限流状态挂在此连接上）
 * @param ctx.hub   语音房间内存状态中心（广播/定点转发/成员态）
 * @param ctx.insertVoiceChatMessage 聊天消息入库（chat 分支使用）
 * @param msg       按 case 内窄化校验的原始消息（JSON.parse 产物）
 */
export function handleVoiceMessage(
  ctx: {
    user: { id: number; username: string; avatar: string | null };
    ws: VoiceWs;
    hub: typeof hub;
    insertVoiceChatMessage: typeof insertVoiceChatMessage;
  },
  msg: { type?: string; [key: string]: unknown } | undefined
): void {
  switch (msg?.type) {
    case 'join': {
      const roomId = Number(msg.roomId);
      const room = Number.isInteger(roomId) ? getRoomById(roomId) : undefined;
      if (!room) {
        ctx.ws.send(JSON.stringify({ type: 'error', message: '房间不存在' }));
        return;
      }
      if (ctx.hub.getRoomCount(roomId) >= VOICE_MAX_ROOM_SIZE) {
        ctx.ws.send(JSON.stringify({ type: 'error', message: `房间已满（最多${VOICE_MAX_ROOM_SIZE}人）` }));
        return;
      }
      const listener = msg.listener === true;
      const existing = ctx.hub.joinRoom(roomId, {
        userId: ctx.user.id,
        username: ctx.user.username,
        avatar: ctx.user.avatar,
        muted: !!msg.muted || listener,
        listener,
        ws: ctx.ws,
      });
      // 返回既有成员：由新加入者主动发起 offer（确定性规则，避免协商冲突）
      // self：回传本次连接的完整身份——访客（无 token）的负数 id 由服务端分配，
      // 客户端需用它校正占位身份（WebRTC 完美协商/信号路由都依赖该 id）
      ctx.ws.send(
        JSON.stringify({
          type: 'joined',
          roomId,
          participants: existing,
          self: { userId: ctx.user.id, username: ctx.user.username, avatar: ctx.user.avatar },
        })
      );
      break;
    }
    case 'leave':
      ctx.hub.leaveRoom(ctx.user.id);
      break;
    case 'mute':
      ctx.hub.setMuted(ctx.user.id, !!msg.muted);
      break;
    case 'quality': {
      const level = msg.level;
      if (level === 'good' || level === 'fair' || level === 'poor') {
        ctx.hub.setQuality(ctx.user.id, level);
      }
      break;
    }
    case 'share-start':
      ctx.hub.setSharing(ctx.user.id, true, msg.audio === true);
      break;
    case 'share-stop':
      ctx.hub.setSharing(ctx.user.id, false);
      break;
    case 'chat': {
      // 文字聊天：校验 → 节流 → 入库 → 广播（含发送者本人，客户端按 id 去重/回显）
      const { content } = voiceChatSchema.safeParse({
        content: typeof msg.content === 'string' ? msg.content : '',
      }).data ?? { content: '' };
      if (!content) return;
      const roomId = ctx.hub.getMemberRoomId(ctx.user.id);
      if (!roomId) return;
      // 防刷屏：同一连接 400ms 内只收一条
      const now = Date.now();
      if (ctx.ws.lastChatAt !== undefined && now - ctx.ws.lastChatAt < CHAT_THROTTLE_MS) return;
      ctx.ws.lastChatAt = now;
      // 剔除控制字符（保留 \n）后再 trim，二次校验避免“纯控制字符”消息入库
      const cleaned = content.replace(CONTROL_CHAR_RE, '').trim();
      if (!cleaned) return;
      const message = ctx.insertVoiceChatMessage({
        roomId,
        senderId: ctx.user.id,
        username: ctx.user.username,
        avatar: ctx.user.avatar,
        content: cleaned,
      });
      ctx.hub.broadcast(roomId, { type: 'chat', message });
      break;
    }
    case 'signal': {
      const to = Number(msg.to);
      if (!Number.isInteger(to)) return;
      // 令牌桶限流：突发额度内全放行，超出后按持续速率补充
      const now = Date.now();
      if (ctx.ws.signalTokens === undefined || ctx.ws.signalLastRefill === undefined) {
        ctx.ws.signalTokens = SIGNAL_BURST;
        ctx.ws.signalLastRefill = now;
      }
      ctx.ws.signalTokens = Math.min(
        SIGNAL_BURST,
        ctx.ws.signalTokens + ((now - ctx.ws.signalLastRefill) / 1000) * SIGNAL_REFILL_PER_SEC
      );
      ctx.ws.signalLastRefill = now;
      if (ctx.ws.signalTokens < 1) return;
      // 只在已加入房间后、且收发双方同房间时转发：
      // 否则可向任意在线用户定向灌包并探测其在线状态
      const roomId = ctx.hub.getMemberRoomId(ctx.user.id);
      if (roomId === undefined || ctx.hub.getMemberRoomId(to) !== roomId) return;
      ctx.ws.signalTokens -= 1;
      ctx.hub.sendToUser(to, { type: 'signal', from: ctx.user.id, data: msg.data });
      break;
    }
    default:
      break;
  }
}
