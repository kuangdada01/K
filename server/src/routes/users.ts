/**
 * ============================================================
 * 用户路由模块 (/api/users)
 * ============================================================
 * 处理用户资料、头像上传、用户帖子列表、私密图片管理
 *
 * API 端点:
 * - GET    /api/users/:id                  - 获取用户资料（公开）
 * - PUT    /api/users/me                   - 更新个人资料（需认证）
 * - POST   /api/users/avatar               - 上传头像（需认证）
 * - GET    /api/users/:id/posts            - 获取用户帖子列表（公开）
 * - GET    /api/users/me/private-images    - 获取私密图片列表（需认证）
 * - POST   /api/users/me/private-images    - 上传私密图片（需认证）
 * - DELETE /api/users/me/private-images/:id - 删除私密图片（需认证）
 * ============================================================
 */

import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { PATHS } from '../config';
import { authMiddleware } from '../middleware/auth';
import { asyncHandler, AppError } from '../middleware/error';
import { withImages, imageFileFilter, compressImage } from '../lib/image';
import { safeDeleteFile } from '../lib/file';
import { validateBody } from '../validate';
import { updateProfileSchema, pageQuerySchema, limitQuerySchema } from '@k/shared';
import { createAvatarUploader, createUploader, timestampFilename } from '../lib/upload';
import * as userRepo from '../repositories/user.repo';
import * as postRepo from '../repositories/post.repo';

const router = Router();

/** 头像尺寸限制 */
const AVATAR_MAX = 512;

/** 头像上传中间件: 限制10MB，仅允许图片格式（公开静态目录 uploads/avatars） */
const uploadAvatar = createAvatarUploader(imageFileFilter);

/**
 * 私密图片上传中间件: 限制10MB，仅允许图片格式
 * 存储在 uploads_private（不在静态服务范围，经 /api/users/me/private-images/:id/file 鉴权下发）
 */
const uploadPrivate = createUploader({
  dir: PATHS.uploadsPrivate,
  filename: timestampFilename('pv'),
  maxSize: 10 * 1024 * 1024,
  fileFilter: imageFileFilter,
});

/** 数据库行 → 响应对象（image_url 只存文件名，响应时改写为鉴权 URL） */
function toPrivateImageJson<T extends { id: number; image_url: string }>(img: T) {
  return { ...img, image_url: `/api/users/me/private-images/${img.id}/file` };
}

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
router.get('/:id', asyncHandler(async (req: Request, res: Response) => {
  const userId = parseInt(req.params.id as string);
  const user = userRepo.getPublicProfile(userId);

  if (!user) {
    throw new AppError(404, '用户不存在');
  }

  res.json(user);
}));

/**
 * PUT /api/users/me - 更新个人资料
 *
 * 认证: 必须
 *
 * 请求体:
 * - username: 新用户名（1-30字符，唯一）
 * - bio: 新个人简介
 */
router.put('/me', authMiddleware, validateBody(updateProfileSchema), asyncHandler(async (req: Request, res: Response) => {
  const { username, bio } = req.body;
  const userId = req.user!.id;

  // 验证用户名唯一性
  if (username !== undefined && userRepo.usernameTaken(username, userId)) {
    throw new AppError(400, '用户名已被占用');
  }

  const user = userRepo.updateProfile(userId, { username, bio });
  res.json(user);
}));

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
router.post('/avatar', authMiddleware, uploadAvatar.single('avatar'), asyncHandler(async (req: Request, res: Response) => {
  if (!req.file) {
    throw new AppError(400, '请选择头像图片');
  }

  // 压缩头像（heic 会转成 jpg，以返回文件名为准）
  const avatarPath = await compressImage(path.join(PATHS.avatars, req.file.filename), { maxWidth: AVATAR_MAX });
  const avatarFileName = path.basename(avatarPath);

  const userId = req.user!.id;

  // 删除旧头像文件
  const oldAvatar = userRepo.getAvatar(userId);
  if (oldAvatar) {
    safeDeleteFile(oldAvatar, 'uploads/avatars');
  }

  // 更新头像路径
  const avatarUrl = `/uploads/avatars/${avatarFileName}`;
  const user = userRepo.updateAvatar(userId, avatarUrl);
  res.json(user);
}));

/**
 * GET /api/users/:id/posts - 获取用户的帖子列表
 *
 * 认证: 不需要（公开接口）
 *
 * 查询参数:
 * - page: 页码（默认1）
 * - limit: 每页数量（默认20）
 */
router.get('/:id/posts', asyncHandler(async (req: Request, res: Response) => {
  const userId = parseInt(req.params.id as string);
  const page = pageQuerySchema.parse(req.query.page);
  const limit = limitQuerySchema.parse(req.query.limit);

  const { posts, total } = postRepo.listUserPosts(userId, page, limit);

  res.json({
    posts: posts.map((p) => withImages(p)),
    total,
    page,
    totalPages: Math.ceil(total / limit)
  });
}));

// ============================================================
// 私密图片端点
// ============================================================

/**
 * GET /api/users/me/private-images - 获取私密图片列表
 *
 * 认证: 必须
 *
 * 返回当前用户的所有私密图片，按创建时间倒序
 */
router.get('/me/private-images', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const images = userRepo.listPrivateImages(userId);
  res.json({ images: images.map(toPrivateImageJson) });
}));

/**
 * GET /api/users/me/private-images/:id/file - 获取私密图片文件
 *
 * 认证: 必须（只能访问自己的图片）
 * 图片存储在 uploads_private，不经静态服务暴露
 */
router.get('/me/private-images/:id/file', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const imageId = parseInt(req.params.id as string);

  const image = userRepo.findOwnPrivateImage(imageId, userId);
  if (!image) {
    throw new AppError(404, '图片不存在');
  }

  const filePath = path.join(PATHS.uploadsPrivate, path.basename(image.image_url));
  if (!fs.existsSync(filePath)) {
    throw new AppError(404, '图片不存在');
  }

  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(filePath);
}));

/**
 * POST /api/users/me/private-images - 上传私密图片
 *
 * 认证: 必须
 * 限制: 每个用户最多10张
 */
router.post('/me/private-images', authMiddleware, uploadPrivate.single('image'), asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;

  // 检查数量限制
  const count = userRepo.countPrivateImages(userId);
  if (count >= 10) {
    // multer 已保存文件，清理避免孤儿文件
    if (req.file) safeDeleteFile(`/uploads_private/${req.file.filename}`, 'uploads_private');
    throw new AppError(400, '最多存储10张图片');
  }

  if (!req.file) {
    throw new AppError(400, '请选择图片');
  }

  // 压缩私密图片（heic 会转成 jpg，以返回文件名为准）
  const finalPath = await compressImage(path.join(PATHS.uploadsPrivate, req.file.filename));

  // image_url 只存文件名（响应时由 toPrivateImageJson 改写为鉴权 URL）
  const image = userRepo.createPrivateImage(userId, path.basename(finalPath));
  res.status(201).json(toPrivateImageJson(image));
}));

/**
 * DELETE /api/users/me/private-images/:id - 删除私密图片
 *
 * 认证: 必须（只能删除自己的图片）
 *
 * 同时删除磁盘上的文件
 */
router.delete('/me/private-images/:id', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const imageId = parseInt(req.params.id as string);

  const image = userRepo.findOwnPrivateImage(imageId, userId);
  if (!image) {
    throw new AppError(404, '图片不存在');
  }

  // 删除文件（uploads_private 目录）
  safeDeleteFile(`/uploads_private/${path.basename(image.image_url)}`, 'uploads_private');

  userRepo.deletePrivateImage(imageId);
  res.json({ message: '图片已删除' });
}));

export default router;
