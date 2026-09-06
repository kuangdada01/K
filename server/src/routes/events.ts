/**
 * ============================================================
 * SSE 事件流路由 (/api/events)
 * ============================================================
 * 认证两种方式（EventSource 无法自定义请求头）：
 * - 首选：POST /api/events/ticket（Bearer 认证）换取一次性短时票据，
 *   GET ?ticket= 消费——JWT 不再出现在 URL 查询串，避免被反向代理/访问日志记录
 * - 兼容：旧客户端仍可用 ?token= 直连（URL 带 JWT 的历史行为）
 * 推送事件: message（新私信）、notification（新通知）、announcement（新公告）
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { subscribe } from '../sse';
import { authMiddleware, verifyLiveToken } from '../middleware/auth';

const router = Router();

/** 一次性连接票据：ticket → { userId, expires }（内存态，重启即失效） */
const tickets = new Map<string, { userId: number; expires: number }>();
/** 票据有效期：客户端拿到票据后立即发起 SSE，30s 足够覆盖慢网络 */
const TICKET_TTL_MS = 30_000;

function purgeExpiredTickets(): void {
  const now = Date.now();
  for (const [k, v] of tickets) {
    if (v.expires < now) tickets.delete(k);
  }
}

/** 换取一次性 SSE 连接票据（Bearer 认证） */
router.post('/ticket', authMiddleware, (req: Request, res: Response) => {
  purgeExpiredTickets();
  const ticket = crypto.randomBytes(24).toString('hex');
  tickets.set(ticket, { userId: req.user!.id, expires: Date.now() + TICKET_TTL_MS });
  res.json({ ticket });
});

router.get('/', (req: Request, res: Response) => {
  // 首选路径：一次性票据（读后即删，防重放）
  const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : '';
  if (ticket) {
    const entry = tickets.get(ticket);
    tickets.delete(ticket);
    if (!entry || entry.expires < Date.now()) {
      res.status(401).json({ error: '票据无效或已过期' });
      return;
    }
    subscribe(entry.userId, res);
    return;
  }

  // 兼容旧客户端：token 查询参数直连
  const token = req.query.token as string | undefined;
  if (!token) {
    res.status(401).json({ error: '未提供 token' });
    return;
  }
  // verifyLiveToken: 签名 + token_version 比对（改密后旧 token 不再收到推送）
  const live = verifyLiveToken(token);
  if (!live) {
    res.status(401).json({ error: '无效 token' });
    return;
  }
  subscribe(live.id, res);
});

export default router;
