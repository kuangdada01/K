/**
 * ============================================================
 * 一次性连接票据（lib/oneTimeTicket）
 * ============================================================
 * 用途：EventSource 与 WebSocket 都无法自定义请求头，因此浏览器必须把凭证放进 URL。
 * 直接放 JWT 会经由 nginx access log、Referer、浏览器历史等渠道泄露，
 * 于是改为「先用 Bearer 换一张 30 秒、只能用一次的票据，再把它放进 URL」。
 *
 * 语义（与 SSE 侧既有实现逐字一致，抽出来是为了让语音复用同一套）：
 * - `issue` 时顺带清理过期票据（惰性，无定时器）
 * - `consume` **先删除再校验**：过期票据同样被移除，且天然防重放
 * - 内存态：进程重启即全部失效（与「连接」这种短生命周期凭证相符）
 *
 * 语音与 SSE 各用一个独立实例：票据不通用于两种协议（跨协议复用没有收益，
 * 只会让「这张票是干什么的」变得含糊）。
 * ============================================================
 */

import crypto from 'crypto';

export interface OneTimeTicketStore {
  /** 签发一张票据（返回随机串） */
  issue(userId: number): string;
  /** 消费票据：返回 userId；无效/过期/已用过的票据返回 undefined */
  consume(ticket: string): number | undefined;
}

/** 票据有效期默认 30 秒：客户端拿到后立即发起连接，够覆盖慢网络 */
export const DEFAULT_TICKET_TTL_MS = 30_000;

export function createOneTimeTicketStore(ttlMs: number = DEFAULT_TICKET_TTL_MS): OneTimeTicketStore {
  const tickets = new Map<string, { userId: number; expires: number }>();

  const purgeExpired = (): void => {
    const now = Date.now();
    for (const [k, v] of tickets) {
      if (v.expires < now) tickets.delete(k);
    }
  };

  return {
    issue(userId: number): string {
      purgeExpired();
      const ticket = crypto.randomBytes(24).toString('hex');
      tickets.set(ticket, { userId, expires: Date.now() + ttlMs });
      return ticket;
    },
    consume(ticket: string): number | undefined {
      const entry = tickets.get(ticket);
      // 先删再校验：读后即删，过期条目也一并回收
      tickets.delete(ticket);
      if (!entry || entry.expires < Date.now()) return undefined;
      return entry.userId;
    },
  };
}
