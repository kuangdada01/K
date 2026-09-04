/**
 * ============================================================
 * 语音信令 WebSocket 服务 (/api/voice/ws)
 * ============================================================
 * 挂载到现有 HTTP 服务器上，负责:
 * 1. 连接认证（token 查询参数 + verifyLiveToken：签名与 token_version 比对，浏览器 WS 无法自定义请求头，
 *    与 /api/events SSE 同一套方案）
 * 2. 房间加入/离开与人数上限校验
 * 3. WebRTC offer/answer/candidate 的定向中转（mesh 信令）
 * 4. 静音状态广播、成员自报网络质量广播、断线自动清理、30s 心跳
 *
 * 消息协议（JSON）:
 * - C→S: { type: 'join', roomId } / { type: 'leave' }
 *        { type: 'signal', to: userId, data } / { type: 'mute', muted }
 *        { type: 'quality', level: 'good'|'fair'|'poor' }（自报网络质量，节流广播）
 *        { type: 'share-start', audio } / { type: 'share-stop' }（屏幕共享状态，服务端互斥+抢占）
 *        { type: 'chat', content }（文字聊天：校验+节流后入库并广播全房间）
 * - S→C: { type: 'joined', participants } / { type: 'peer-joined', participant }
 *        { type: 'peer-left', userId } / { type: 'signal', from, data }
 *        { type: 'mute-changed', userId, muted } / { type: 'peer-quality', userId, level }
 *        { type: 'share-changed', userId, active, audio } / { type: 'share-force-stop' }
 *        { type: 'chat', message } / { type: 'chat-cleared' }（房主/管理员经 REST 清空后广播）
 *        { type: 'room-closed', reason } / { type: 'error', message }
 */

import type { Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { verifyLiveToken, type LiveToken } from '../middleware/auth';
import { getSafeUser } from '../repositories/user.repo';
import { getRoomById } from '../repositories/voice.repo';
import { insertVoiceChatMessage } from '../repositories/voice-chat.repo';
import { getClientIp } from '../lib/client-ip';
import * as hub from './hub';
import { guestIds } from './guest-ids';
import { VOICE_MAX_ROOM_SIZE, voiceChatSchema } from '@k/shared';

/** 心跳间隔（客户端需在 30s 内响应 pong，超时断开） */
const HEARTBEAT_MS = 30_000;

/** 文字聊天发送节流（每条消息间隔下限，防刷屏；状态挂在连接上，断开即释放） */
const CHAT_THROTTLE_MS = 400;

/** 控制字符（除 \n 换行外）剔除：入库前清理，防协议/显示污染 */
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** 带存活标记的连接（心跳用；guestIp 为访客连接的来源 IP，断开时归还引用） */
type VoiceWs = WebSocket & { isAlive?: boolean; guestIp?: string; lastChatAt?: number };

/**
 * 把语音 WS 服务挂到 HTTP 服务器上（index.ts 启动时调用一次）。
 * 与 Express app 解耦：测试可自建 http server 挂载。
 */
export function attachVoiceWs(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/api/voice/ws' });

  // 心跳：标记存活 → ping，下轮仍存活则强制断开
  const interval = setInterval(() => {
    for (const client of wss.clients) {
      const ws = client as VoiceWs;
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  wss.on('close', () => clearInterval(interval));

  wss.on('connection', (raw, req) => {
    const ws = raw as VoiceWs;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    // ---- 认证（token 走查询参数，同 /api/events）----
    // 未登录用户也允许进房：作为访客（负数 id + "未登录-N" 显示名）参与语音。
    // 有 token 但无效/过期仍按原逻辑拒绝（避免本地残留 token 被误判为访客）。
    const url = new URL(req.url ?? '/', 'http://localhost');
    const token = url.searchParams.get('token');
    let user: { id: number; username: string; avatar: string | null } | undefined;
    let live: LiveToken | undefined;
    if (token) {
      // verifyLiveToken: 签名 + token_version 比对（改密后旧 token 视同无效）
      live = verifyLiveToken(token);
      if (live) user = getSafeUser(live.id);
      if (!user) {
        ws.send(JSON.stringify({ type: 'error', message: '认证失败或账号封禁中' }));
        ws.close(4001, 'unauthorized');
        return;
      }
    } else {
      // 无 token = 未登录访客：按 IP 分配/复用负数 id（同 IP 10 分钟内重进保持排名）
      const ip = getClientIp(req);
      const { id } = guestIds.acquire(ip);
      user = { id, username: `未登录-${-id}`, avatar: null };
      // 记录 IP，连接关闭时归还引用计数（触发 10 分钟释放倒计时）
      (ws as VoiceWs).guestIp = ip;
    }
    const bannedUntil = live?.banned_until ?? null;
    if (bannedUntil && bannedUntil > new Date().toISOString()) {
      ws.send(JSON.stringify({ type: 'error', message: '认证失败或账号封禁中' }));
      ws.close(4001, 'unauthorized');
      return;
    }

    // 该用户已在线（另一个标签页）：通知旧连接后由 joinRoom 覆盖成员身份
    const stale = hub.findMember(user.id);
    if (stale) {
      stale.ws.send(JSON.stringify({ type: 'error', message: '账号在其他地方进入语音' }));
      stale.ws.close(4002, 'replaced');
    }

    // ---- 消息处理 ----
    ws.on('message', (raw) => {
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      switch (msg?.type) {
        case 'join': {
          const roomId = Number(msg.roomId);
          const room = Number.isInteger(roomId) ? getRoomById(roomId) : undefined;
          if (!room) {
            ws.send(JSON.stringify({ type: 'error', message: '房间不存在' }));
            return;
          }
          if (hub.getRoomCount(roomId) >= VOICE_MAX_ROOM_SIZE) {
            ws.send(JSON.stringify({ type: 'error', message: `房间已满（最多${VOICE_MAX_ROOM_SIZE}人）` }));
            return;
          }
          const listener = msg.listener === true;
          const existing = hub.joinRoom(roomId, {
            userId: user.id,
            username: user.username,
            avatar: user.avatar,
            muted: !!msg.muted || listener,
            listener,
            ws,
          });
          // 返回既有成员：由新加入者主动发起 offer（确定性规则，避免协商冲突）
          // self：回传本次连接的完整身份——访客（无 token）的负数 id 由服务端分配，
          // 客户端需用它校正占位身份（WebRTC 完美协商/信号路由都依赖该 id）
          ws.send(JSON.stringify({
            type: 'joined',
            roomId,
            participants: existing,
            self: { userId: user.id, username: user.username, avatar: user.avatar },
          }));
          break;
        }
        case 'leave':
          hub.leaveRoom(user.id);
          break;
        case 'mute':
          hub.setMuted(user.id, !!msg.muted);
          break;
        case 'quality': {
          const level = msg.level;
          if (level === 'good' || level === 'fair' || level === 'poor') {
            hub.setQuality(user.id, level);
          }
          break;
        }
        case 'share-start':
          hub.setSharing(user.id, true, msg.audio === true);
          break;
        case 'share-stop':
          hub.setSharing(user.id, false);
          break;
        case 'chat': {
          // 文字聊天：校验 → 节流 → 入库 → 广播（含发送者本人，客户端按 id 去重/回显）
          const { content } = voiceChatSchema.safeParse({
            content: typeof msg.content === 'string' ? msg.content : '',
          }).data ?? { content: '' };
          if (!content) return;
          const roomId = hub.getMemberRoomId(user.id);
          if (!roomId) return;
          // 防刷屏：同一连接 400ms 内只收一条
          const now = Date.now();
          if (ws.lastChatAt !== undefined && now - ws.lastChatAt < CHAT_THROTTLE_MS) return;
          ws.lastChatAt = now;
          // 剔除控制字符（保留 \n）后再 trim，二次校验避免“纯控制字符”消息入库
          const cleaned = content.replace(CONTROL_CHAR_RE, '').trim();
          if (!cleaned) return;
          const message = insertVoiceChatMessage({
            roomId,
            senderId: user.id,
            username: user.username,
            avatar: user.avatar,
            content: cleaned,
          });
          hub.broadcast(roomId, { type: 'chat', message });
          break;
        }
        case 'signal': {
          const to = Number(msg.to);
          if (!Number.isInteger(to)) return;
          hub.sendToUser(to, { type: 'signal', from: user.id, data: msg.data });
          break;
        }
        default:
          break;
      }
    });

    // 断开清理：从房间移除并广播 peer-left；访客归还 IP 引用计数（触发 10 分钟释放倒计时）
    // 注意：error 后通常还会触发 close，release 内部有计数防御，重复调用安全
    const releaseGuest = () => {
      const ip = (ws as VoiceWs).guestIp;
      if (ip) guestIds.release(ip);
    };
    ws.on('close', () => { hub.removeBySocket(ws); releaseGuest(); });
    ws.on('error', () => { hub.removeBySocket(ws); releaseGuest(); });
  });

  return wss;
}
