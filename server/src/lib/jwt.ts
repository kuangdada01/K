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

/**
 * token 有效期。它同时是**绝对上限**与**不活跃超时**：
 * 只要用户在有效期内有已认证的请求，滑动续期（见 TOKEN_REFRESH_AFTER_MS）就会把
 * 有效期整体后移，因此「每天都在用的人」不会因为到点而被登出；
 * 而彻底沉默的会话仍会在这段时间后失效。
 *
 * 为什么不做成「直接改成 30 天」：token 是 localStorage 里的 bearer 凭证，
 * 延长有效期会等比例拉长被盗后的可用窗口，而且不解决「用满就掉线」这个机制问题。
 */
export const TOKEN_TTL = '7d';

/**
 * 滑动续期阈值：token 签发超过该时长后，下一次已认证请求会顺带回下发一张新 token。
 * 取 1 天是个折中：一张 token 最多被续期 7 次就必然轮换，客户端也无需频繁写 localStorage。
 *
 * **这个机制的固有代价（必须知道）**：一直在用的会话会一直续下去，
 * 因此「被盗的 token 只要攻击者持续使用就不会自然过期」—— 与「静默 7 天必过期」相比，
 * 这是把安全性的一部分换给了可用性。现有的兜底是 `users.token_version`：
 * 改密 / 管理员重置密码会让该用户**所有** token（含已续期的）立即失效。
 * 也就是说：**怀疑泄露时的正确处置是让用户改密码**，而不是等它过期。
 * 若日后要更细的吊销粒度（按设备登出），需要引入 refresh token 或会话表，
 * 那是另一个量级的改动（且安卓端要配安全存储），不在当前范围内。
 */
export const TOKEN_REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

/** 滑动续期下发的响应头（客户端在 http.ts 里读取并落盘；跨源端需 CORS 暴露该头） */
export const REFRESHED_TOKEN_HEADER = 'X-Refreshed-Token';

// ============================================================
// 类型
// ============================================================

/** JWT payload（tv = users.token_version，密码变更/重置后递增使旧 token 失效） */
interface TokenPayload {
  id: number;
  username: string;
  role?: string;
  tv?: number;
  /** 签发时间（秒），jsonwebtoken 自动写入；滑动续期据此判断 */
  iat?: number;
}

/** 实时校验结果（role/banned_until/token_version 来自数据库，非 token 冗余） */
export interface LiveToken {
  id: number;
  username: string;
  role: string;
  banned_until: string | null;
  token_version: number;
  /** token 签发时间（秒）；滑动续期按它判断是否需要换发新 token */
  iat: number;
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
  return {
    id: decoded.id,
    username: decoded.username,
    ...state,
    // 缺失 iat（理论上 jwt.sign 必带）按 0 处理 → 不触发续期，保守不折腾
    iat: typeof decoded.iat === 'number' ? decoded.iat : 0,
  };
}

/**
 * 是否需要为该 token 换发新 token（滑动续期）。
 *
 * 只按**签发时间**判断，不看剩余时间：7 天是绝对上限，阈值固定 1 天，
 * 于是「每隔一天用一次」的用户会一直续下去，而一次都不用的会话按原样过期。
 * iat 缺失（0）时不续期 —— 宁可让极端情况走原路径，也不要在缺信息时乱发凭证。
 */
export function shouldRefreshToken(issuedAtSec: number, nowMs: number = Date.now()): boolean {
  if (!issuedAtSec) return false;
  return nowMs - issuedAtSec * 1000 >= TOKEN_REFRESH_AFTER_MS;
}

/**
 * 生成 JWT token
 *
 * @param user - 用户信息对象
 * @param user.id - 用户ID
 * @param user.username - 用户名
 * @param user.role - 用户角色（可选）
 * @param user.tv - 令牌版本（users.token_version，改密后递增）
 * @returns 签名后的 JWT token 字符串（有效期见 TOKEN_TTL：7 天）
 */
export function generateToken(user: { id: number; username: string; role?: string; tv?: number }): string {
  return jwt.sign(user, JWT_SECRET, { expiresIn: TOKEN_TTL, algorithm: 'HS256' });
}

/**
 * 按已校验的实时身份换发一张新 token（滑动续期用）。
 * 字段与登录时签发的一致：role 用数据库实时值、tv 用当前 token_version，
 * 因此续期不会把「已降级/已改密」的旧状态带回去。
 */
export function renewToken(live: LiveToken): string {
  return generateToken({
    id: live.id,
    username: live.username,
    role: live.role,
    tv: live.token_version,
  });
}
