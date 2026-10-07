/**
 * ============================================================
 * 管理后台 - 用户管理路由（/api/admin/users，自 routes/admin.ts 拆出）
 * ============================================================
 *
 * API 端点:
 * - GET    /api/admin/users              - 用户列表（服务端搜索 + 分页；不带 page/q 时保持老的「上限 + 本地过滤」形状）
 * - GET    /api/admin/users/search?q=    - 搜索用户（公告指定目标用，最多10条）
 * - DELETE /api/admin/users/:id          - 删除用户（级联删除，编排在 userDeletion.service）
 * - PUT    /api/admin/users/:id/password - 重置用户密码
 * - POST   /api/admin/users/:id/ban     - 封禁用户（1天/1周/1月/1年）
 * - POST   /api/admin/users/:id/unban   - 解封用户
 *
 * 认证 + 管理员权限由组合入口 routes/admin/index.ts 的全局中间件保障。
 */

import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { asyncHandler, AppError } from '../../middleware/error';
import { validateBody } from '../../validate';
import {
  adminResetPasswordSchema,
  adminBanSchema,
  pageQuerySchema,
  limitQuerySchema,
  searchQuerySchema,
} from '@k/shared/schemas';
import * as adminRepo from '../../repositories/admin.repo';
import { deleteUser } from '../../services/userDeletion.service';

const router = Router();

/**
 * GET /api/admin/users - 获取用户列表
 *
 * 查询参数:
 * - page: 页码（带此参数即进入**服务端分页 + 服务端搜索**模式，默认1）
 * - limit: 每页数量（默认20，上限50）
 * - q: 搜索关键词（用户名/邮箱模糊 + ID 子串；空则不过滤）
 *
 * 两种形状（**只增不改**）：
 * - 不带 `page`/`q`：老客户端（已安装的 APK）走原来的 `{ users, has_more }`
 *   —— 上限 HARD_LIST_CAP 行 + 客户端本地过滤，行为与改动前逐字一致；
 * - 带 `page` 或 `q`：`{ users, total, page, limit, totalPages, has_more }`，
 *   单次只物化 `limit` 行，搜索交给 SQL —— 用户再多也能搜到、能翻到。
 */
router.get(
  '/users',
  asyncHandler(async (req: Request, res: Response) => {
    const q = searchQuerySchema.parse(req.query.q);

    // 老路径：既没要分页也没搜索 → 保持历史响应形状（老客户端本地搜索依赖它）
    if (req.query.page === undefined && !q) {
      const { rows: users, has_more } = adminRepo.listUsers();
      res.json({ users, has_more });
      return;
    }

    const page = pageQuerySchema.parse(req.query.page);
    const limit = limitQuerySchema.parse(req.query.limit);
    const { rows: users, total } = adminRepo.listUsersPage({ q, page, limit });

    res.json({
      users,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      has_more: page * limit < total,
    });
  })
);

/**
 * GET /api/admin/users/search - 搜索用户（按用户名或ID）
 *
 * 查询参数:
 * - q: 搜索关键词（用户名模糊匹配或ID精确匹配）
 *
 * 最多返回10条结果，用于公告指定用户等场景
 */
router.get(
  '/users/search',
  asyncHandler(async (req: Request, res: Response) => {
    const q = ((req.query.q as string) || '').trim();
    if (!q) {
      res.json({ users: [] });
      return;
    }
    const users = adminRepo.searchUsers(q);
    res.json({ users });
  })
);

/**
 * DELETE /api/admin/users/:id - 删除用户
 *
 * 级联删除: 用户的帖子、评论、点赞、消息等会被数据库外键自动删除
 * 磁盘清理: 头像、帖子媒体、私密图片、私信图片（收集路径 → 删库 → 删文件，
 * 顺序保证中途失败最多留下孤儿文件，不会产生指向已删文件的死链），
 * 编排见 services/userDeletion.service.ts。
 *
 * 验证: 不能删除自己的账号 / 用户不存在 / 不能删除管理员账号
 */
router.delete(
  '/users/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = parseInt(req.params.id as string);
    if (userId === req.user!.id) {
      throw new AppError(400, '不能删除自己的账号');
    }
    const user = adminRepo.findUser(userId);
    if (!user) {
      throw new AppError(404, '用户不存在');
    }
    if (adminRepo.getUserRole(userId) === 'admin') {
      throw new AppError(400, '不能删除管理员账号');
    }

    deleteUser(user);

    res.json({ success: true });
  })
);

/**
 * PUT /api/admin/users/:id/password - 重置用户密码
 *
 * 请求体:
 * - password: 新密码（至少6个字符）
 */
router.put(
  '/users/:id/password',
  validateBody(adminResetPasswordSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = parseInt(req.params.id as string);
    const { password } = req.body;
    const user = adminRepo.findUser(userId);
    if (!user) {
      throw new AppError(404, '用户不存在');
    }
    if (adminRepo.getUserRole(userId) === 'admin') {
      throw new AppError(400, '不能重置管理员账号的密码');
    }
    const hash = await bcrypt.hash(password, 10);
    adminRepo.resetUserPassword(userId, hash);
    res.json({ success: true });
  })
);

/**
 * POST /api/admin/users/:id/ban - 封禁用户
 *
 * 请求体: { days: 1 | 7 | 30 | 365 }
 * 封禁期间用户仅可浏览（GET），所有写操作返回 403
 */
router.post(
  '/users/:id/ban',
  validateBody(adminBanSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = parseInt(req.params.id as string);
    const { days } = req.body;
    const role = adminRepo.getUserRole(userId);
    if (role === undefined) {
      throw new AppError(404, '用户不存在');
    }
    if (role === 'admin') {
      throw new AppError(400, '不能封禁管理员账号');
    }
    const bannedUntil = new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
    adminRepo.setBanStatus(userId, bannedUntil);
    res.json({ success: true, banned_until: bannedUntil });
  })
);

/**
 * POST /api/admin/users/:id/unban - 解封用户
 */
router.post(
  '/users/:id/unban',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = parseInt(req.params.id as string);
    const user = adminRepo.findUser(userId);
    if (!user) {
      throw new AppError(404, '用户不存在');
    }
    adminRepo.setBanStatus(userId, null);
    res.json({ success: true, banned_until: null });
  })
);

export default router;
