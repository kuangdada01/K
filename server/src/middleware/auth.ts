/**
 * ============================================================
 * K 认证中间件
 * ============================================================
 * 提供 JWT (JSON Web Token) 认证功能
 *
 * 包含3个导出函数:
 * 1. authMiddleware    - 必须认证，无效token返回401
 * 2. adminMiddleware   - 管理员权限检查，需配合 authMiddleware 使用
 * 3. optionalAuth      - 可选认证，无效token不报错（用于公开接口获取可选用户信息）
 *
 * JWT 密钥/校验/签发逻辑已拆分到 ../lib/jwt（verifyLiveToken / generateToken /
 * LiveToken / JWT_SECRET）；Express Request.user 类型扩展在 ../types/express.d.ts。
 * 下方保留兼容 re-export：routes/auth.ts、routes/events.ts、voice/ws.ts 及
 * 测试文件仍从本模块导入上述符号（路径未变），新代码请直接改从 '../lib/jwt' 导入。
 * ============================================================
 */

import { Request, Response, NextFunction } from 'express';
import { verifyLiveToken, shouldRefreshToken, renewToken, REFRESHED_TOKEN_HEADER } from '../lib/jwt';

// 兼容导出（历史调用方继续从本模块取 JWT 符号，行为不变）
export { JWT_SECRET, generateToken, verifyLiveToken } from '../lib/jwt';
export type { LiveToken } from '../lib/jwt';

// ============================================================
// 中间件函数
// ============================================================

/**
 * 滑动续期：token 签发超过阈值时，顺带回一张新 token（响应头）。
 *
 * 放在中间件而非单个路由：只有覆盖**全部**已认证请求，才能兑现
 * 「活跃用户不会因为 token 到点被登出」——长开的标签页、后台轮询都会经过这里；
 * 只挂 `/auth/me` 的话，一个开着页面不动、只靠轮询的活动会话仍会到点失效。
 *
 * 客户端（api/http.ts）收到该头后落盘；跨源端（安卓 WebView）依赖
 * CORS 的 Access-Control-Expose-Headers 才能读到，见 middleware/cors.ts。
 */
function maybeRefreshToken(res: Response, live: { iat: number } & Parameters<typeof renewToken>[0]): void {
  if (!shouldRefreshToken(live.iat)) return;
  res.setHeader(REFRESHED_TOKEN_HEADER, renewToken(live));
}

/**
 * 必须认证中间件
 * 从请求头 Authorization: Bearer <token> 解析用户信息
 *
 * 使用方式: router.get('/protected', authMiddleware, handler)
 *
 * 错误响应:
 * - 401: 未提供 token 或 token 无效/已过期/已失效
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  // 检查 Authorization 头是否存在且格式正确
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'No token provided' });
    return;
  }

  // 提取 token（去掉 "Bearer " 前缀），签名 + token_version 一并校验
  const live = verifyLiveToken(authHeader.slice('Bearer '.length));
  if (!live) {
    res.status(401).json({ error: 'Invalid token' });
    return;
  }

  // role 用数据库实时值（token 内角色仅为签发时快照）
  req.user = { id: live.id, username: live.username, role: live.role };

  // 滑动续期（成功认证后即可下发，与后续 403 封禁判定无关）
  maybeRefreshToken(res, live);

  // 封禁拦截：封禁期间只读（GET/OPTIONS 放行，写操作一律 403）
  if (req.method !== 'GET' && req.method !== 'OPTIONS' && live.role !== 'admin') {
    if (live.banned_until && live.banned_until > new Date().toISOString()) {
      res.status(403).json({
        error: `账号已被封禁（解封时间: ${live.banned_until.slice(0, 10)}），封禁期间仅可浏览`,
        banned: true,
      });
      return;
    }
  }

  next();
}

/**
 * 管理员权限中间件
 * 必须在 authMiddleware 之后使用，检查 req.user.role === 'admin'
 *
 * 使用方式: router.delete('/admin/resource', authMiddleware, adminMiddleware, handler)
 *
 * 错误响应:
 * - 403: 权限不足（非管理员用户）
 */
export function adminMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({ error: '权限不足' });
    return;
  }
  next();
}

/**
 * 可选认证中间件
 * 尝试解析 token，但不强制要求提供 token
 * 适用于公开接口（如帖子列表），登录用户可获取额外信息（如点赞状态）
 *
 * 使用方式: router.get('/public', optionalAuth, handler)
 *
 * 行为:
 * - 有有效 token: 解析用户信息到 req.user
 * - 无 token 或 token 无效/已失效: 静默跳过，req.user 为 undefined
 */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const live = verifyLiveToken(authHeader.slice('Bearer '.length));
    if (live) {
      req.user = { id: live.id, username: live.username, role: live.role };
    }
  }

  next();
}
