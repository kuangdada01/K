/**
 * ============================================================
 * 管理后台 - 用户管理路由（/api/admin/users，自 routes/admin.ts 拆出）
 * ============================================================
 *
 * API 端点:
 * - GET    /api/admin/users              - 获取所有用户列表
 * - GET    /api/admin/users/search?q=    - 搜索用户
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
import { adminResetPasswordSchema, adminBanSchema } from '@k/shared/schemas';
import * as adminRepo from '../../repositories/admin.repo';
import { deleteUser } from '../../services/userDeletion.service';

const router = Router();

/**
 * GET /api/admin/users - 获取所有用户列表
 *
 * 返回所有用户信息，包含每个用户的帖子数量
 */
router.get(
  '/users',
  asyncHandler(async (_req: Request, res: Response) => {
    const users = adminRepo.listUsers();
    res.json({ users });
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
