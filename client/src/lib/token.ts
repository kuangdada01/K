/**
 * ============================================================
 * 客户端 token 小工具（lib/token）
 * ============================================================
 * 只服务于「滑动续期」：服务端在已认证响应里用响应头回一张新 token，
 * 客户端需要判断它是不是真的更新（并发请求下多张新 token 会乱序到达，
 * 不能盲写，否则可能把更新的那张覆盖成更旧的）。
 *
 * 这里**不做任何校验**（签名/过期一律由服务端判定，客户端解 payload 只为读 iat）：
 * 客户端解析 JWT 不构成信任边界，写错也只会退化成「不续期」，不影响安全性。
 */

/** 读取 JWT 的签发时间（秒）；格式异常一律返回 0（视为未知 → 不续期） */
export function parseTokenIssuedAt(token: string | null | undefined): number {
  if (!token) return 0;
  const payload = token.split('.')[1];
  if (!payload) return 0;
  try {
    // JWT 用 base64url，且可能省略 padding；先补齐再解
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    // 用 TextDecoder 而不是直接用 atob 结果：payload 里的 username 可能是中文，
    // 直接 JSON.parse 二进制串会得到乱码（虽然通常仍能解析出 iat，但不该依赖这个巧合）
    const json = new TextDecoder().decode(bytes);
    const data = JSON.parse(json) as { iat?: unknown };
    return typeof data.iat === 'number' ? data.iat : 0;
  } catch {
    return 0;
  }
}

/**
 * 落盘滑动续期下发的新 token。
 *
 * 两个闸门：
 *  1. **本地必须已有 token**：本地已清空（登出后）说明当前没有会话，
 *     迟到的续期响应**不得**把凭证凭空写回来（P1-3.1）；
 *  2. **iat 不早于本地**：同时发出的多个请求会各自带回一张新 token
 *     （同一秒内签发的 iat 相同），盲写一旦乱序就会把较新的覆盖成较旧的，
 *     下次续期判断随之失真。
 *
 * 会话代次（登出/换号隔离）由 http.ts 的拦截器在调用前检查，这里只管
 * token 本身的写入规则。
 *
 * @returns 是否真的写入了
 */
export function storeRefreshedToken(newToken: string | null | undefined): boolean {
  if (!newToken) return false;
  const current = localStorage.getItem('k_token');
  if (!current) return false;
  const nextIat = parseTokenIssuedAt(newToken);
  const currentIat = parseTokenIssuedAt(current);
  if (!nextIat || nextIat < currentIat) return false;
  localStorage.setItem('k_token', newToken);
  return true;
}
