/**
 * ============================================================
 * 管理端列表 · 分页纯函数（pages/admin/adminPaging）
 * ============================================================
 * 从 AdminPage 里抽出来的原因：分页有两处**容易算错且错了不易发现**的
 * 逻辑 —— 总页数的边界（0 行 / 恰好整页）与「删掉一行之后页码与总数怎么变」。
 * 抽成纯函数后可以单测，不必去渲染整个管理页（它依赖登录态 + 路由 + Query）。
 *
 * 分页与搜索都由服务端做（`/api/admin/users?page=&q=`、`/api/admin/posts?page=&q=`），
 * 这里只负责：
 * - 请求参数里的每页条数（单一来源，避免请求与服务端默认值不一致）
 * - 把服务端返回的 total 换算成页数
 * - 乐观删除一行后就地修正列表与总数（保持「不整页重载」的历史手感）
 * ============================================================
 */

import type { AdminAnnouncement, AdminPost, AdminUser } from './types';

/** 用户列表每页条数：与服务端 limitQuerySchema 的默认值一致（服务端上限 50） */
export const ADMIN_USERS_PAGE_SIZE = 20;

/** 帖子列表每页条数（服务端同样默认 20） */
export const ADMIN_POSTS_PAGE_SIZE = 20;

/** 公告列表每页条数（服务端同样默认 20） */
export const ADMIN_ANNOUNCEMENTS_PAGE_SIZE = 20;

/** 管理端用户列表的一页数据（与 /api/admin/users 分页模式响应对齐） */
export interface AdminUsersPage {
  users: AdminUser[];
  total: number;
  totalPages: number;
}

/** 管理端帖子列表的一页数据（与 /api/admin/posts 响应对齐） */
export interface AdminPostsPage {
  posts: AdminPost[];
  total: number;
  totalPages: number;
}

/** 管理端公告列表的一页数据（与 /api/admin/announcements 分页模式响应对齐） */
export interface AdminAnnouncementsPage {
  announcements: AdminAnnouncement[];
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

/** 乐观删除帖子（与用户列表同款语义；命中才减总数） */
export function removePostFromPage(page: AdminPostsPage, postId: number): AdminPostsPage {
  const posts = page.posts.filter((p) => p.id !== postId);
  if (posts.length === page.posts.length) return page;
  const total = Math.max(0, page.total - 1);
  return { posts, total, totalPages: pageCount(total, ADMIN_POSTS_PAGE_SIZE) };
}

/** 乐观删除公告（同上） */
export function removeAnnouncementFromPage(
  page: AdminAnnouncementsPage,
  announcementId: number
): AdminAnnouncementsPage {
  const announcements = page.announcements.filter((a) => a.id !== announcementId);
  if (announcements.length === page.announcements.length) return page;
  const total = Math.max(0, page.total - 1);
  return { announcements, total, totalPages: pageCount(total, ADMIN_ANNOUNCEMENTS_PAGE_SIZE) };
}

/** 乐观更新某一行（封禁/解封就地改 banned_until，不重取列表） */
export function patchUserInPage(
  page: AdminUsersPage,
  userId: number,
  patch: Partial<AdminUser>
): AdminUsersPage {
  return { ...page, users: page.users.map((u) => (u.id === userId ? { ...u, ...patch } : u)) };
}
