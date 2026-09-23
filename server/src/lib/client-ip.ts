/**
 * ============================================================
 * 客户端真实 IP 提取（REST 与 WS 共用）
 * ============================================================
 * - 仅在显式配置 TRUST_PROXY 时才信任 x-forwarded-for（防止直连场景客户端伪造 IP）
 * - 否则取 TCP socket 对端地址
 * - 统一归一化 IPv6 映射前缀：::ffff:1.2.3.4 -> 1.2.3.4
 *
 * 用途：未登录访客的唯一标识（访客 id 分配、房间所有权校验锚点）。
 */

import type { IncomingMessage } from 'http';
import { env } from '../config';

export function getClientIp(req: IncomingMessage): string {
  let ip: string | undefined;
  if (env.TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string') ip = fwd.split(',')[0]?.trim();
    else if (Array.isArray(fwd) && fwd.length > 0) ip = fwd[0]?.trim();

    // XFF 缺失时回落到 X-Real-IP。
    //
    // 2026-09-19 线上事故：nginx 的 `location /api/voice/ws` 只配了 X-Real-IP、
    // 漏了 X-Forwarded-For，而本函数只读 XFF —— 于是 **WS 链路的访客 IP 全部退化成
    // 反代内网地址 127.0.0.1**（REST 链路因 `location /` 配了 XFF 反而正常）。
    // 后果：所有访客挤进同一个 IP 条目 → 掉线重连与他人进房撞同一个负数 id →
    // hub 成员表互相覆盖 → 「进房后看不见别人」。日志里只表现为 ip 字段是 127.0.0.1，
    // 不看不知道。两个头都读，nginx 配哪个都能拿到真实 IP。
    if (!ip) {
      const real = req.headers['x-real-ip'];
      if (typeof real === 'string') ip = real.trim() || undefined;
      else if (Array.isArray(real) && real.length > 0) ip = real[0]?.trim() || undefined;
    }
  }
  if (!ip) ip = req.socket.remoteAddress ?? 'unknown';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}
