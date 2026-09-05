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
    if (typeof fwd === 'string') ip = fwd.split(',')[0].trim();
    else if (Array.isArray(fwd) && fwd.length > 0) ip = fwd[0].trim();
  }
  if (!ip) ip = req.socket.remoteAddress ?? 'unknown';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}
