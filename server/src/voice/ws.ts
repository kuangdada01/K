/**
 * ============================================================
 * 语音信令 WebSocket 服务 (/api/voice/ws)
 * ============================================================
 * 挂载到现有 HTTP 服务器上，负责:
 * 1. 连接认证（token 查询参数 + verifyLiveToken：签名与 token_version 比对，浏览器 WS 无法自定义请求头，
 *    与 /api/events SSE 同一套方案）
 * 2. 连接生命周期：心跳（30s pong）、maxPayload 限制、断开清理
 * 3. 消息分发：JSON.parse 后交给 ./messageHandlers 的 handleVoiceMessage 处理
 *    （join/leave/mute/quality/share-start/share-stop/chat/signal 8 类消息，
 *    含房间加入/人数上限、WebRTC 信令定向中转、静音/质量/共享广播、聊天入库）
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
import { WebSocketServer } from 'ws';
import { verifyLiveToken, type LiveToken } from '../middleware/auth';
import { getSafeUser } from '../repositories/user.repo';
import { insertVoiceChatMessage } from '../repositories/voice-chat.repo';
import { getClientIp } from '../lib/client-ip';
import * as hub from './hub';
import { guestIds } from './guest-ids';
import { handleVoiceMessage, type VoiceWs } from './messageHandlers';

/** 心跳间隔（客户端需在 30s 内响应 pong，超时断开） */
const HEARTBEAT_MS = 30_000;

/**
 * 把语音 WS 服务挂到 HTTP 服务器上（index.ts 启动时调用一次）。
 * 与 Express app 解耦：测试可自建 http server 挂载。
 */
export function attachVoiceWs(server: Server): WebSocketServer {
  const wss = new WebSocketServer({
    server,
    path: '/api/voice/ws',
    // 未认证连接也能到达这里（访客可进房），必须限制单帧大小：
    // ws 库默认 100MiB，不设限的话一条垃圾帧就能造成内存尖峰 + 主线程解析阻塞。
    // 真实信令（SDP offer/answer + ICE 候选）远小于 64KB。
    maxPayload: 64 * 1024,
  });

  // 心跳：标记存活 → ping，下轮仍存活则强制断开
  const interval = setInterval(() => {
    for (const client of wss.clients) {
      const ws = client as VoiceWs;
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  wss.on('close', () => clearInterval(interval));

  wss.on('connection', (raw, req) => {
    const ws = raw as VoiceWs;
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

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

    // ---- 消息处理（各消息 case 的逻辑见 ./messageHandlers）----
    ws.on('message', (raw) => {
      // 入站信令的最小形状：具体字段在各 case 内按需窄化校验
      let msg: { type?: string; [key: string]: unknown } | undefined;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      handleVoiceMessage({ user, ws, hub, insertVoiceChatMessage }, msg);
    });

    // 断开清理：从房间移除并广播 peer-left；访客归还 IP 引用计数（触发 10 分钟释放倒计时）
    // 注意：error 后通常还会触发 close，release 内部有计数防御，重复调用安全
    const releaseGuest = () => {
      const ip = (ws as VoiceWs).guestIp;
      if (ip) guestIds.release(ip);
    };
    ws.on('close', () => {
      hub.removeBySocket(ws);
      releaseGuest();
    });
    ws.on('error', () => {
      hub.removeBySocket(ws);
      releaseGuest();
    });
  });

  return wss;
}
