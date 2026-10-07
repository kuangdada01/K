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
import { REFRESHED_TOKEN_HEADER } from '../lib/jwt';

/**
 * CORS 白名单：来自 ALLOWED_ORIGINS 环境变量（逗号分隔）。
 * 默认（未配置时）允许:
 * - http://localhost:5173 开发服务器
 * - http://localhost 旧 Capacitor 原生包来源（历史保留）
 * - https://appassets.androidplatform.net 原生安卓宿主的 WebView 来源
 *   （页面由 WebViewAssetLoader 从 APK 内 assets 提供；**必须**在 .env 的
 *   ALLOWED_ORIGINS 里显式加上，否则 App 内所有跨源请求都会被 403）
 */
const allowedOrigins = (
  env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost,https://appassets.androidplatform.net'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (origin) {
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch {}
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
  // 预检头白名单必须覆盖客户端**真实发送**的所有自定义头，否则预检失败（403 + 前端表现为网络错误）：
  // - X-Voice-Owner-Token：访客房间所有权令牌（删房/清空聊天，见 client/src/api/voice.ts）
  // - Cache-Control：临时视频状态轮询显式 no-cache（见 client/src/api/posts.ts）
  // 原生 App 以前经 CapacitorHttp 走原生网络栈绕过 CORS，改用自研宿主后全部请求走 WebView 网络栈，
  // 这两个头从"无所谓"变成"缺了就报错"。
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type,Authorization,X-Voice-Owner-Token,Cache-Control'
  );
  // 滑动续期：认证中间件在响应头回一张新 token，跨源端（安卓 WebView / 白名单来源）
  // 必须由服务端显式暴露该头，浏览器的 fetch/XHR 才允许 JS 读取它。
  res.setHeader('Access-Control-Expose-Headers', REFRESHED_TOKEN_HEADER);
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
}
