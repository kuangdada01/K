/**
 * ============================================================
 * JWT 工具模块（lib/jwt）
 * ============================================================
 * 自 middleware/auth.ts 拆分而来：JWT 密钥、token 载荷类型、
 * verifyLiveToken（签名 + token_version 实时校验）与 generateToken 收拢于此。
 * 中间件本身（authMiddleware / adminMiddleware / optionalAuth）留在
 * middleware/auth.ts，从这里导入 verifyLiveToken。
 *
 * 注意：routes/auth.ts、routes/events.ts、voice/ws.ts 及测试仍从
 * '../middleware/auth' 导入本模块符号——auth.ts 保留了兼容 re-export，
 * 新代码请直接改从本模块导入。
 */

import jwt from 'jsonwebtoken';
import { env } from '../config';
import { getAuthState } from '../repositories/admin.repo';

// ============================================================
// 配置常量
// ============================================================

/**
 * JWT 密钥
 * 强校验在 config.ts 的 envSchema：未设置 JWT_SECRET 时进程拒绝启动
 * （任何环境一视同仁——生产环境若漏配 NODE_ENV/JWT_SECRET，
 * 旧实现会静默回退到公开的 dev 密钥，攻击者可用其自签任意 token）
 */
const JWT_SECRET = env.JWT_SECRET;

export { JWT_SECRET };

// ============================================================
// 类型
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

// ============================================================
// 校验与签发
// ============================================================

/**
 * 校验 access token：签名 + token_version 与数据库比对。
 * 用户被删除、密码已变更/重置（版本不匹配）均判定失效。
 * authMiddleware / optionalAuth / SSE（events.ts）/ 语音 WS（voice/ws.ts）共用，
 * 返回的 role 为数据库实时值（管理员降级立即生效）。
 */
export function verifyLiveToken(token: string): LiveToken | undefined {
  let decoded: TokenPayload;
  try {
    // 显式钉死签名算法：即使未来密钥形态变化，也不接受 alg 头指定的其他算法
    decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as TokenPayload;
  } catch {
    return undefined;
  }
  const state = getAuthState(decoded.id);
  // 缺失 tv 视为版本 0（兼容本字段上线前签发的 token），改密后版本必然 > 0 照样失效
  if (!state || (decoded.tv ?? 0) !== state.token_version) return undefined;
  return { id: decoded.id, username: decoded.username, ...state };
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
  return jwt.sign(user, JWT_SECRET, { expiresIn: '7d', algorithm: 'HS256' });
}
