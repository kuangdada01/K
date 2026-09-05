/**
 * ============================================================
 * K 认证中间件
 * ============================================================
 * 提供 JWT (JSON Web Token) 认证功能
 *
 * 包含4个导出函数:
 * 1. authMiddleware    - 必须认证，无效token返回401
 * 2. adminMiddleware   - 管理员权限检查，需配合 authMiddleware 使用
 * 3. optionalAuth      - 可选认证，无效token不报错（用于公开接口获取可选用户信息）
 * 4. generateToken     - 生成JWT token（7天有效期）
 * ============================================================
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getAuthState } from '../repositories/admin.repo';

// ============================================================
// 配置常量
// ============================================================

/**
 * JWT 密钥
 * 生产环境必须通过环境变量 JWT_SECRET 设置强密钥，否则拒绝启动
 * 开发环境使用默认值（方便 clone 即用）
 */
const JWT_SECRET =
  process.env.JWT_SECRET ||
  (() => {
    if (process.env.NODE_ENV === 'production') {
      console.error('FATAL: JWT_SECRET 环境变量未设置，生产环境拒绝启动');
      process.exit(1);
    }
    return 'k-dev-jwt-secret';
  })();

export { JWT_SECRET };

// ============================================================
// 类型声明扩展
// ============================================================

/**
 * 扩展 Express Request 类型，添加 user 属性
 * 由认证中间件解析 token 后注入
 */
/* eslint-disable @typescript-eslint/no-namespace -- Express 类型扩展的标准做法 */
declare global {
  namespace Express {
    interface Request {
      /** 当前认证用户信息（由 authMiddleware 注入） */
      user?: {
        id: number; // 用户ID
        username: string; // 用户名
        role?: string; // 角色: 'user' | 'admin'
      };
    }
  }
}
/* eslint-enable @typescript-eslint/no-namespace */

// ============================================================
// 中间件函数
// ============================================================

/** JWT payload（tv = users.token_version，密码变更/重置后递增使旧 token 失效） */
interface TokenPayload {
  id: number;
  username: string;
  role?: string;
  tv?: number;
}

/** 实时校验结果（role/banned_until/token_version 来自数据库，非 token 冗余） */
export interface LiveToken {
  id: number;
  username: string;
  role: string;
  banned_until: string | null;
  token_version: number;
}

/**
 * 校验 access token：签名 + token_version 与数据库比对。
 * 用户被删除、密码已变更/重置（版本不匹配）均判定失效。
 * authMiddleware / optionalAuth / SSE（events.ts）/ 语音 WS（voice/ws.ts）共用，
 * 返回的 role 为数据库实时值（管理员降级立即生效）。
 */
export function verifyLiveToken(token: string): LiveToken | undefined {
  let decoded: TokenPayload;
  try {
    decoded = jwt.verify(token, JWT_SECRET) as TokenPayload;
  } catch {
    return undefined;
  }
  const state = getAuthState(decoded.id);
  // 缺失 tv 视为版本 0（兼容本字段上线前签发的 token），改密后版本必然 > 0 照样失效
  if (!state || (decoded.tv ?? 0) !== state.token_version) return undefined;
  return { id: decoded.id, username: decoded.username, ...state };
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
  const live = verifyLiveToken(authHeader.split(' ')[1]);
  if (!live) {
    res.status(401).json({ error: 'Invalid token' });
    return;
  }

  // role 用数据库实时值（token 内角色仅为签发时快照）
  req.user = { id: live.id, username: live.username, role: live.role };

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
 * 生成 JWT token
 *
 * @param user - 用户信息对象
 * @param user.id - 用户ID
 * @param user.username - 用户名
 * @param user.role - 用户角色（可选）
 * @param user.tv - 令牌版本（users.token_version，改密后递增）
 * @returns 签名后的 JWT token 字符串（7天有效期）
 */
export function generateToken(user: { id: number; username: string; role?: string; tv?: number }): string {
  return jwt.sign(user, JWT_SECRET, { expiresIn: '7d' });
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
    const live = verifyLiveToken(authHeader.split(' ')[1]);
    if (live) {
      req.user = { id: live.id, username: live.username, role: live.role };
    }
  }

  next();
}
