/**
 * ============================================================
 * Express Request 类型扩展（自 middleware/auth.ts 拆分）
 * ============================================================
 * 认证中间件解析 token 后注入 req.user。
 * 本文件为全局类型声明（tsconfig include 覆盖 src/**\/*，自动生效），
 * declare global 需要模块上下文，故末尾加 export {}。
 */
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

export {};
