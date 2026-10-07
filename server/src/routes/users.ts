/**
 * ============================================================
 * 用户路由模块 (/api/users)
 * ============================================================
 * 处理用户资料、头像上传、用户帖子列表
 *
 * API 端点:
 * - GET    /api/users/:id                  - 获取用户资料（公开）
 * - PUT    /api/users/me                   - 更新个人资料（需认证）
 * - POST   /api/users/avatar               - 上传头像（需认证）
 * - GET    /api/users/:id/posts            - 获取用户帖子列表（公开）
 * - GET    /api/users/:id/reposts          - 获取用户转发列表（可选认证）
 *
 * 「私密图片」（`/me/private-images`）已在 09-18 随该功能一起删除。
 * 注意 `PATHS.uploadsPrivate` **不能跟着删** —— 私信图片也存在那里（见 routes/messages.ts）。
 * ============================================================
 */

import { Router, Request, Response } from 'express';
import path from 'path';
import { PATHS } from '../config';
import { authMiddleware, optionalAuth } from '../middleware/auth';
import { asyncHandler, AppError } from '../middleware/error';
import { withImages, imageFileFilter, compressImage } from '../lib/image';
import { safeDeleteFile } from '../lib/file';
import { validateBody } from '../validate';
import { updateProfileSchema, pageQuerySchema, limitQuerySchema } from '@k/shared/schemas';
import { createAvatarUploader } from '../lib/upload';
import * as userRepo from '../repositories/user.repo';
import * as postRepo from '../repositories/post.repo';

const router = Router();

/** 头像尺寸限制 */
const AVATAR_MAX = 512;

/** 头像上传中间件: 限制10MB，仅允许图片格式（公开静态目录 uploads/avatars） */
const uploadAvatar = createAvatarUploader(imageFileFilter);

// ============================================================
// 用户资料端点
// ============================================================

/**
 * GET /api/users/:id - 获取用户资料
 *
 * 认证: 不需要（公开接口）
 *
 * 成功响应 (200):
 * - 用户基本信息 + post_count, followers_count, following_count
 */
router.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = parseInt(req.params.id as string);
    const user = userRepo.getPublicProfile(userId);

    if (!user) {
      throw new AppError(404, '用户不存在');
    }

    res.json(user);
  })
);

/**
 * PUT /api/users/me - 更新个人资料
 *
 * 认证: 必须
 *
 * 请求体:
 * - username: 新用户名（1-30字符，唯一）
 * - bio: 新个人简介
 */
router.put(
  '/me',
  authMiddleware,
  validateBody(updateProfileSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { username, bio } = req.body;
    const userId = req.user!.id;

    // 验证用户名唯一性
    if (username !== undefined && userRepo.usernameTaken(username, userId)) {
      throw new AppError(400, '用户名已被占用');
    }

    const user = userRepo.updateProfile(userId, { username, bio });
    res.json(user);
  })
);

/**
 * POST /api/users/avatar - 上传头像
 *
 * 认证: 必须
 * Content-Type: multipart/form-data
 *
 * 表单字段:
 * - avatar: 头像图片文件（10MB限制）
 *
 * 自动删除旧头像文件
 */
router.post(
  '/avatar',
  authMiddleware,
  uploadAvatar.single('avatar'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) {
      throw new AppError(400, '请选择头像图片');
    }

    // 压缩头像（heic 会转成 jpg，以返回文件名为准）
    //
    // `square: true` = 服务端直接产出**正方形**头像文件（居中裁切，见 compressImage）。
    // 客户端一律用 `ContentScale.Crop` / `object-fit: cover` 圆裁，长方形原图虽然
    // 观感上没问题，但每次显示都要按比例裁一遍；直接存方图则"存储形态 = 展示形态"，
    // 不会出现"同一张头像在不同宽高比的容器里取景不一致"。
    const avatarPath = await compressImage(path.join(PATHS.avatars, req.file.filename), {
      maxWidth: AVATAR_MAX,
      square: true,
    });
    const avatarFileName = path.basename(avatarPath);

    const userId = req.user!.id;

    // 先写库、成功后再删旧头像文件（顺序反转：DB 失败不会留下指向已删文件的死链）
    const oldAvatar = userRepo.getAvatar(userId);
    const avatarUrl = `/uploads/avatars/${avatarFileName}`;
    const user = userRepo.updateAvatar(userId, avatarUrl);
    if (oldAvatar) {
      safeDeleteFile(oldAvatar, 'uploads/avatars');
    }
    res.json(user);
  })
);

/**
 * GET /api/users/:id/posts - 获取用户的帖子列表
 *
 * 认证: 不需要（公开接口）
 *
 * 查询参数:
 * - page: 页码（默认1）
 * - limit: 每页数量（默认20）
 */
router.get(
  '/:id/posts',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = parseInt(req.params.id as string);
    const page = pageQuerySchema.parse(req.query.page);
    const limit = limitQuerySchema.parse(req.query.limit);

    const { posts, total } = postRepo.listUserPosts(userId, page, limit);

    res.json({
      posts: posts.map((p) => withImages(p)),
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  })
);

/**
 * GET /api/users/:id/reposts - 获取某个用户**转发**的帖子列表
 *
 * 认证: 可选（`optionalAuth` —— 登录用户能看到自己的 liked / reposted 状态；
 * 匿名请求也照常返回列表，与 `/users/:id/posts` 一样的"公开可看"）
 *
 * 用途：他人主页的「转发」标签（设计稿上这一页有两个标签：帖子 / 转发）。
 * 在此之前服务端**只有** `/api/posts/reposts/me`（"我的"），
 * 所以客户端要么画一个点开恒为空的标签，要么干脆不画 —— 两条都不好。
 *
 * 参数顺序注意：本路由必须声明在 `'/:id'` 之后也没关系（Express 按注册顺序匹配，
 * 但这两个路径段数不同，`/:id` 只吃一段），不过**必须早于任何 `/:id/xxx` 的通配写法**。
 *
 * 响应形状与 `/users/:id/posts` 一致（`{ posts, has_more }`）；
 * 转发列表没有分页（硬上限截断，见 listLimits.ts），所以给的是 `has_more` 而不是 totalPages。
 */
router.get(
  '/:id/reposts',
  optionalAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = parseInt(req.params.id as string);
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new AppError(400, '用户ID无效');
    }

    const { rows, has_more } = postRepo.listUserReposts(userId, req.user?.id);
    res.json({ posts: rows.map((p) => withImages(p)), has_more });
  })
);

export default router;
