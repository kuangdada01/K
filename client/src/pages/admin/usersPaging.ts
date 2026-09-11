/**
 * ============================================================
 * 管理端用户列表 · 分页纯函数（pages/admin/usersPaging）
 * ============================================================
 * 从 AdminPage 里抽出来的原因：分页有两处**容易算错且错了不易发现**的
 * 逻辑 —— 总页数的边界（0 行 / 恰好整页）与「删掉一行之后页码与总数怎么变」。
 * 抽成纯函数后可以单测，不必去渲染整个管理页（它依赖登录态 + 路由 + Query）。
 *
 * 分页本身由服务端做（见 /api/admin/users?page=&q=），这里只负责：
 * - 请求参数里的每页条数（单一来源，避免请求与服务端默认值不一致）
 * - 把服务端返回的 total 换算成页数
 * - 乐观删除一行后就地修正列表与总数（保持「不整页重载」的历史手感）
 * ============================================================
 */

import type { AdminUser } from './types';

/** 每页条数：与服务端 limitQuerySchema 的默认值一致（服务端上限 50） */
export const ADMIN_USERS_PAGE_SIZE = 20;

/** 管理端用户列表的一页数据（与 /api/admin/users 分页模式响应对齐） */
export interface AdminUsersPage {
  users: AdminUser[];
  total: number;
  totalPages: number;
}

/** 总页数：0 行 → 0 页；恰好整页 → 不虚增一页（ceil 的自然结果，这里显式锁住） */
export function pageCount(total: number, limit: number = ADMIN_USERS_PAGE_SIZE): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.ceil(total / limit);
}

/**
 * 乐观删除：把某一行从当前页摘掉，并把总数一并减一。
 *
 * 为什么不只 setQueryData 过滤数组：分页页脚的「第 x / y 页」由 totalPages 决定，
 * 删人不改它会出现「删到空页还显示有下一页」；也不能简单整页重载 ——
 * 管理端删人是高频操作，重载会丢掉搜索词与当前页。
 */
export function removeUserFromPage(page: AdminUsersPage, userId: number): AdminUsersPage {
  const users = page.users.filter((u) => u.id !== userId);
  // 该行不在当前页（例如在别的页删的、或列表已被重新取过）：原样返回，
  // 不能顺手把 total 减一 —— 那会让页脚数字与实际数据对不上
  if (users.length === page.users.length) return page;
  const total = Math.max(0, page.total - 1);
  return { users, total, totalPages: pageCount(total) };
}

/** 乐观更新某一行（封禁/解封就地改 banned_until，不重取列表） */
export function patchUserInPage(
  page: AdminUsersPage,
  userId: number,
  patch: Partial<AdminUser>
): AdminUsersPage {
  return { ...page, users: page.users.map((u) => (u.id === userId ? { ...u, ...patch } : u)) };
}
