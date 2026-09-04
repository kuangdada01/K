/**
 * ============================================================
 * CORS 中间件
 * ============================================================
 * 从 index.ts 原样搬移（行为保持不变）:
 * - 无 Origin（原生 App、同源 GET）放行
 * - 同源请求（Origin 与 Host 一致，如生产环境静态页面）放行
 * - 白名单（ALLOWED_ORIGINS 环境变量）内的跨域来源放行
 * - 其他来源 → 403 拒绝
 *
 * 注意: 站点经 nginx 反向代理（TLS 终止）时 req.protocol 恒为 http，
 * 无法还原真实协议（https），因此同源判断只比较 host 部分，不比较协议。
 */

import { Request, Response, NextFunction } from 'express';
import { env } from '../config';

/** CORS 白名单：来自 ALLOWED_ORIGINS 环境变量（逗号分隔），默认仅允许开发服务器 */
const allowedOrigins = (env.ALLOWED_ORIGINS || 'http://localhost:5173')
  .split(',').map(s => s.trim()).filter(Boolean);

export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (origin) {
    let originHost = '';
    try { originHost = new URL(origin).host; } catch {}
    const reqHost = req.get('host') || '';
    const sameOrigin = !!originHost && originHost === reqHost;
    if (sameOrigin || allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    } else {
      res.status(403).json({ error: '该来源不在 CORS 白名单中' });
      return;
    }
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
}
