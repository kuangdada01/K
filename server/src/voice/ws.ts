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
import { getAuthState } from '../repositories/admin.repo';
import { getSafeUser } from '../repositories/user.repo';
import { insertVoiceChatMessage } from '../repositories/voice-chat.repo';
import { getClientIp } from '../lib/client-ip';
import { logger } from '../lib/logger';
import * as hub from './hub';
import { guestIds } from './guest-ids';
import { voiceTickets } from './tickets';
import { tryAcquire, release, countFor, type VoiceConnKind } from './ip-connections';
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

    const url = new URL(req.url ?? '/', 'http://localhost');
    const ticket = url.searchParams.get('ticket');
    const token = url.searchParams.get('token');
    const ip = getClientIp(req);
    let user: { id: number; username: string; avatar: string | null } | undefined;
    /** 是否已认证（票据或 token）——访客的负数 id 不是认证身份，不能参与顶号判定 */
    let authenticated = false;
    /** 封禁到期时间（认证用户才有；访客为 null） */
    let bannedUntil: string | null = null;
    /** 访客连接的 id 租约（按连接释放，见下方 close 处理） */
    let guestLease: ReturnType<typeof guestIds.acquire> | undefined;

    // ---- 每 IP 并发上限（P2-29）----
    // 类型在此**无副作用地**判定：有 ticket/token 就算「已认证」（无效凭证随后仍会 4001），
    // 无凭证才是访客。这样超限拒绝发生在消耗一次性票据、分配访客 id、读库**之前**。
    const kind: VoiceConnKind = ticket || token ? 'authenticated' : 'guest';
    const acquired = tryAcquire(ip, kind);
    if (!acquired) {
      const usage = countFor(ip);
      logger.warn(
        { ip, kind, total: usage.total, guests: usage.guests },
        '语音：该 IP 的并发连接已达上限，拒绝连接（4004）'
      );
      ws.send(JSON.stringify({ type: 'error', message: '同一网络下的语音连接过多，请稍后再试' }));
      // 4004 是**终止类**关闭码：客户端据此结束会话，不再按 3s 间隔重连。
      // 取新码而不是复用 4001：4001 会被展示成「认证失败」，与真实原因不符。
      ws.close(4004, 'too many connections');
      return;
    }

    // 断开清理：归还 IP 席位、从房间移除并广播 peer-left、访客归还 id 租约。
    // 注册在认证之前，因此认证失败/封禁等所有提前返回路径都会归还席位。
    //
    // 租约只在 'close' 归还，不在 'error' 归还：'error' 时 socket 可能还没真正断开，
    // 提前归还会让 id 进入倒计时、10 分钟后被回收给别的访客，而这个连接仍在房间成员表里
    // ——那就又变成两条连接共用一个 id 的互踢场景。ws 在 'error' 之后必然补发 'close'，
    // 所以只挂 'close' 是完备的；release 本身也做了幂等，双触发也安全。
    ws.on('close', () => {
      release(ip, kind);
      hub.removeBySocket(ws);
      guestLease?.release();
    });
    ws.on('error', () => {
      // 只做房间清理，不动租约（等随后的 close）
      hub.removeBySocket(ws);
    });

    // ---- 认证（三种形态，优先级：一次性票据 > token 查询参数 > 访客）----
    // 未登录用户也允许进房：作为访客（负数 id + "未登录-N" 显示名）参与语音。
    // 有 token 但无效/过期仍按原逻辑拒绝（避免本地残留 token 被误判为访客）。
    if (ticket) {
      // 首选路径：一次性票据（读后即删，防重放；有效期 30s）
      const userId = voiceTickets.consume(ticket);
      // 票据只带 userId，因此这里重新读一次实时状态：签发到消费之间有 30s 窗口，
      // 期间用户可能被封禁 —— 封禁判定必须用当下值，不能用签发时的快照
      const state = userId === undefined ? undefined : getAuthState(userId);
      const safe = userId === undefined ? undefined : getSafeUser(userId);
      if (userId === undefined || !state || !safe) {
        logger.warn(
          { ip, reason: userId === undefined ? 'invalid-ticket' : 'user-not-found' },
          '语音：连接票据无效或已过期，拒绝连接（4001）'
        );
        ws.send(JSON.stringify({ type: 'error', message: '认证失败或账号封禁中' }));
        ws.close(4001, 'unauthorized');
        return;
      }
      user = safe;
      bannedUntil = state.banned_until;
      authenticated = true;
    } else if (token) {
      // verifyLiveToken: 签名 + token_version 比对（改密后旧 token 视同无效）
      const live: LiveToken | undefined = verifyLiveToken(token);
      if (live) user = getSafeUser(live.id);
      if (!user) {
        // 语音侧的 token 失效此前完全没有日志（线上故障时无从定位）：记一条便于排查
        logger.warn(
          { ip, tokenLen: token.length, reason: live ? 'user-not-found' : 'invalid-token' },
          '语音：token 无效或已过期，拒绝连接（4001）'
        );
        ws.send(JSON.stringify({ type: 'error', message: '认证失败或账号封禁中' }));
        ws.close(4001, 'unauthorized');
        return;
      }
      bannedUntil = live?.banned_until ?? null;
      authenticated = true;
      // 兼容路径：旧客户端（已发布 APK / 缓存网页）仍把 JWT 放在查询串里。
      // 记一条以便判断何时可以下线它 —— JWT 出现在 URL 里会进 nginx access log。
      logger.info({ userId: user.id, ip }, '语音：客户端仍用已废弃的 ?token= 建连（未迁移到一次性票据）');
    } else {
      // 无凭证 = 未登录访客：按 IP 分配/复用负数 id（同 IP 10 分钟内重进保持排名）。
      // 注意：同一 IP 的**并发**连接会各自拿到独立 id（见 guest-ids.ts 的说明）——
      // 共用 id 会让两条连接在 hub 里互相覆盖、并被下面的「同账号」判定互相顶掉。
      guestLease = guestIds.acquire(ip);
      user = { id: guestLease.id, username: `未登录-${-guestLease.id}`, avatar: null };
      logger.info(
        { ip, guestId: guestLease.id, extra: guestLease.extra, guestActive: guestIds.activeCount },
        guestLease.extra ? '语音：同 IP 并发访客（已分配独立 id）' : '语音：访客连接已分配 id'
      );
    }
    if (bannedUntil && bannedUntil > new Date().toISOString()) {
      ws.send(JSON.stringify({ type: 'error', message: '认证失败或账号封禁中' }));
      ws.close(4001, 'unauthorized');
      return;
    }

    // 该用户已在线（另一个标签页/另一台设备）：通知旧连接后由 joinRoom 覆盖成员身份。
    //
    // **只对已认证用户生效**：访客的负数 id 只是「按 IP 发号」的展示/排名标识，
    // 不是经过认证的身份，不能拿来当账号互相顶。否则同一公网 IP 下的两个访客
    // （典型：同一个人的浏览器 + 安卓 App）会被判定成「同账号」而无限互踢 ——
    // 这正是线上「有人一直被踢出房间」的成因之一。
    const stale = authenticated ? hub.findMember(user.id) : undefined;
    if (stale) {
      logger.warn(
        { userId: user.id, username: user.username, roomId: hub.getMemberRoomId(user.id) },
        '语音：新连接顶掉同账号的旧连接（单点在线）'
      );
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
  });

  return wss;
}
