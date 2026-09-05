/**
 * ============================================================
 * 管理后台路由模块 (/api/admin)
 * ============================================================
 * 处理管理员专属功能（所有端点需要 admin 权限）
 *
 * API 端点:
 * - GET    /api/admin/users              - 获取所有用户列表
 * - GET    /api/admin/users/search?q=    - 搜索用户
 * - DELETE /api/admin/users/:id          - 删除用户（级联删除）
 * - PUT    /api/admin/users/:id/password - 重置用户密码
 * - POST   /api/admin/users/:id/ban     - 封禁用户（1天/1周/1月/1年）
 * - POST   /api/admin/users/:id/unban   - 解封用户
 * - GET    /api/admin/posts              - 获取所有帖子（分页）
 * - DELETE /api/admin/posts/:id          - 删除帖子
 * - POST   /api/admin/announcements      - 创建公告
 * - GET    /api/admin/announcements      - 获取所有公告列表
 * - DELETE /api/admin/announcements/:id  - 删除公告
 * ============================================================
 */

import { Router, Request, Response } from 'express';
import path from 'path';
import bcrypt from 'bcryptjs';
import { authMiddleware, adminMiddleware } from '../middleware/auth';
import { asyncHandler, AppError } from '../middleware/error';
import { withImages } from '../lib/image';
import { safeDeleteFile, deletePostMediaFiles } from '../lib/file';
import { validateBody } from '../validate';
import { notifyUser, notifyAllUsers } from '../sse';
import {
  announcementSchema,
  adminResetPasswordSchema,
  adminBanSchema,
  pageQuerySchema,
  limitQuerySchema,
} from '@k/shared';
import * as adminRepo from '../repositories/admin.repo';

const router = Router();

/**
 * 全局中间件: 所有管理员路由需要认证 + 管理员权限
 */
router.use(authMiddleware, adminMiddleware);

// ============================================================
// 用户管理端点
// ============================================================

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
 * 磁盘清理: 头像、帖子媒体、私密图片、私信图片（先收集路径 → 删库 → 删文件，
 * 顺序保证中途失败最多留下孤儿文件，不会产生指向已删文件的死链）
 *
 * 验证: 不能删除自己的账号
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

    // 删库前收集全部磁盘文件引用（级联删除后行已不在，无从查起）
    const postMedia = adminRepo.listUserPostMedia(userId);
    const privateImageNames = adminRepo.listUserPrivateImageNames(userId);
    const messageImageNames = adminRepo.listUserMessageImageNames(userId);

    adminRepo.deleteUser(userId, user.email);

    // 头像
    if (user.avatar) {
      safeDeleteFile(user.avatar, 'uploads/avatars');
    }
    // 帖子媒体（图片/视频/封面）
    for (const media of postMedia) {
      deletePostMediaFiles(media);
    }
    // 私密图片与私信图片（uploads_private，DB 只存文件名）
    for (const name of privateImageNames) {
      safeDeleteFile(`/uploads_private/${path.basename(name)}`, 'uploads_private');
    }
    for (const name of messageImageNames) {
      safeDeleteFile(`/uploads_private/${path.basename(name)}`, 'uploads_private');
    }

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

// ============================================================
// 帖子管理端点
// ============================================================

/**
 * GET /api/admin/posts - 获取所有帖子（分页）
 *
 * 查询参数:
 * - page: 页码（默认1）
 * - limit: 每页数量（默认20）
 */
router.get(
  '/posts',
  asyncHandler(async (req: Request, res: Response) => {
    const page = pageQuerySchema.parse(req.query.page);
    const limit = limitQuerySchema.parse(req.query.limit);

    const { posts, total } = adminRepo.listAllPosts(page, limit);

    // 解析图片JSON
    const postsWithImages = posts.map((p) => withImages(p));

    res.json({ posts: postsWithImages, total, page, totalPages: Math.ceil(total / limit) });
  })
);

/**
 * DELETE /api/admin/posts/:id - 删除帖子
 *
 * 先删除相关通知，再删除帖子；媒体文件（图片/视频/封面）同步清理
 */
router.delete(
  '/posts/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const postId = parseInt(req.params.id as string);
    const media = adminRepo.findPostMedia(postId);
    if (!media) {
      throw new AppError(404, '帖子不存在');
    }
    adminRepo.adminDeletePost(postId);
    deletePostMediaFiles(media);
    res.json({ success: true });
  })
);

// ============================================================
// 公告管理端点
// ============================================================

/**
 * POST /api/admin/announcements - 创建公告
 *
 * 请求体:
 * - title: 公告标题
 * - content: 公告内容
 * - target_user_id: 目标用户ID（可选，为空则为全体公告）
 */
router.post(
  '/announcements',
  validateBody(announcementSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { title, content, target_user_id } = req.body;

    const announcement = adminRepo.createAnnouncement({
      title,
      content,
      targetUserId: target_user_id || null,
      fromUserId: req.user!.id,
    });

    res.status(201).json(announcement);

    // 实时推送公告事件（定向推送目标用户，全体公告推送所有在线用户）
    if (target_user_id) {
      notifyUser(target_user_id, 'announcement', { announcement_id: announcement.id });
    } else {
      notifyAllUsers('announcement', { announcement_id: announcement.id });
    }
  })
);

/**
 * GET /api/admin/announcements - 获取所有公告列表
 *
 * 返回所有公告，包含目标用户名（如有）
 */
router.get(
  '/announcements',
  asyncHandler(async (_req: Request, res: Response) => {
    const announcements = adminRepo.listAllAnnouncements();
    res.json({ announcements });
  })
);

/**
 * DELETE /api/admin/announcements/:id - 删除公告
 */
router.delete(
  '/announcements/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string);
    adminRepo.deleteAnnouncement(id);
    res.json({ success: true });
  })
);

export default router;
