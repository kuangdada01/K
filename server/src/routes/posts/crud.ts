/**
 * ============================================================
 * 帖子路由（/api/posts）- CRUD 与搜索
 * ============================================================
 */

import { Router, Request, Response } from 'express';
import path from 'path';
import { PATHS } from '../../config';
import { authMiddleware, optionalAuth } from '../../middleware/auth';
import { asyncHandler, AppError } from '../../middleware/error';
import { withImages, imageFileFilter, compressImage } from '../../lib/image';
import { safeDeleteFile, parseImageUrlArray, deletePostMediaFiles } from '../../lib/file';
import { pageQuerySchema, limitQuerySchema, extractTags } from '@k/shared';
import { createUploader, timestampFilename } from '../../lib/upload';
import * as postRepo from '../../repositories/post.repo';
import * as commentRepo from '../../repositories/comment.repo';

const router = Router();

/** 图片压缩参数（帖子图片最大1920px，质量80） */
const POST_IMAGE_MAX = 1920;

/** 帖子图片上传中间件: 限制10MB，仅允许 jpg/png/gif/webp */
const imageUpload = createUploader({
  dir: PATHS.uploads,
  filename: timestampFilename('post'),
  maxSize: 10 * 1024 * 1024,
  fileFilter: imageFileFilter,
});

// ============================================================
// 帖子搜索端点
// ============================================================

/**
 * GET /api/posts/search - 搜索帖子
 *
 * 查询参数:
 * - q: 搜索关键词（标题或描述模糊匹配）
 * - tag: 话题名（不含 #，精确匹配 post_tags，优先于 q）
 * - page: 页码（默认1）
 * - limit: 每页数量（默认20）
 *
 * 认证: 可选（登录用户可看到自己的点赞状态）
 */
router.get('/search', optionalAuth, asyncHandler(async (req: Request, res: Response) => {
  const keyword = (req.query.q as string || '').trim();
  const tag = (req.query.tag as string || '').trim().replace(/^#/, '');
  const page = pageQuerySchema.parse(req.query.page);
  const limit = limitQuerySchema.parse(req.query.limit);
  const userId = req.user?.id;

  if (!keyword && !tag) {
    res.json({ posts: [], total: 0, page, totalPages: 0 });
    return;
  }

  const { posts, total } = postRepo.searchPosts(keyword, page, limit, userId, tag || undefined);

  res.json({
    posts: posts.map((p) => withImages(p)),
    total,
    page,
    totalPages: Math.ceil(total / limit)
  });
}));

// ============================================================
// 帖子 CRUD 端点
// ============================================================

/**
 * GET /api/posts - 获取帖子列表（信息流）
 *
 * 查询参数:
 * - page: 页码（默认1）
 * - limit: 每页数量（默认20）
 *
 * 认证: 可选（登录用户可看到自己的点赞状态）
 */
router.get('/', optionalAuth, asyncHandler(async (req: Request, res: Response) => {
  const page = pageQuerySchema.parse(req.query.page);
  const limit = limitQuerySchema.parse(req.query.limit);
  const userId = req.user?.id;

  const { posts, total } = postRepo.listPosts(page, limit, userId);

  res.json({
    posts: posts.map((p) => withImages(p)),
    total,
    page,
    totalPages: Math.ceil(total / limit)
  });
}));

/**
 * GET /api/posts/bookmarks/me - 获取当前用户收藏的帖子列表
 *
 * 认证: 必须
 * 返回用户收藏的所有帖子（按收藏时间倒序）
 */
router.get('/bookmarks/me', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const posts = postRepo.listBookmarkedPosts(userId);
  res.json({ posts: posts.map(withImages) });
}));

/**
 * GET /api/posts/reposts/me - 获取当前用户转发的帖子列表
 *
 * 认证: 必须
 * 返回用户转发的所有帖子（按转发时间倒序）
 */
router.get('/reposts/me', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const posts = postRepo.listRepostedPosts(userId);
  res.json({ posts: posts.map(withImages) });
}));

/**
 * GET /api/posts/:id - 获取单个帖子详情
 *
 * 认证: 可选
 *
 * 成功响应 (200):
 * - post: 帖子详情（含图片数组、点赞数、评论数）
 * - comments: 评论列表（含嵌套回复信息）
 */
router.get('/:id', optionalAuth, asyncHandler(async (req: Request, res: Response) => {
  const postId = parseInt(req.params.id as string);
  const userId = req.user?.id;

  const post = postRepo.getPostById(postId, userId);

  if (!post) {
    throw new AppError(404, '帖子不存在');
  }

  // 获取评论列表（含父评论信息，用于显示回复关系）
  const comments = commentRepo.listCommentsForPost(postId);

  res.json({ post: withImages(post), comments });
}));

/**
 * POST /api/posts - 创建图文帖子
 *
 * 认证: 必须
 * Content-Type: multipart/form-data
 *
 * 表单字段:
 * - images: 图片文件（最多9张，每张10MB限制）
 * - title: 标题（可选）
 * - description: 描述（可选）
 * - close_comments: 是否关闭评论（'1'=关闭）
 *
 * 成功响应 (201): 创建的帖子对象
 */
router.post('/', authMiddleware, imageUpload.array('images', 9), asyncHandler(async (req: Request, res: Response) => {
  const files = req.files as Express.Multer.File[];
  if (!files || files.length === 0) {
    throw new AppError(400, '请选择图片');
  }

  // 上传后压缩（并行处理，减少响应等待；heic 会转成 jpg，以返回路径为准）
  const processedFiles = await Promise.all(files.map(f =>
    compressImage(path.join(PATHS.uploads, f.filename), { maxWidth: POST_IMAGE_MAX })
  ));

  // 将所有图片路径转为 JSON 数组存储
  const imageUrls = processedFiles.map(p => `/uploads/${path.basename(p)}`);
  const imageUrl = JSON.stringify(imageUrls);
  const title = req.body.title || '';
  const description = req.body.description || '';
  const closeComments = req.body.close_comments === '1' ? 1 : 0;
  const pinned = req.body.pinned === '1' ? 1 : 0;

  const post = postRepo.createPost({
    userId: req.user!.id,
    imageUrl,
    title,
    description,
    closeComments,
    pinned,
  });
  postRepo.syncPostTags(post.id, extractTags(description));

  res.status(201).json(withImages(post));
}));

/**
 * PUT /api/posts/:id - 编辑自己的帖子
 *
 * 认证: 必须（只能编辑自己的帖子）
 * Content-Type: multipart/form-data
 *
 * 表单字段:
 * - images: 新增图片文件
 * - keepImages: 保留的图片URL（JSON数组字符串）
 * - description: 新描述
 * - close_comments: 是否关闭评论
 *
 * 成功响应 (200): 更新后的帖子对象
 */
router.put('/:id', authMiddleware, imageUpload.array('images', 9), asyncHandler(async (req: Request, res: Response) => {
  const postId = parseInt(req.params.id as string);
  const post = postRepo.findOwnPost(postId, req.user!.id);

  if (!post) {
    throw new AppError(404, '帖子不存在或无权编辑');
  }

  const description = req.body.description;
  const keepImages: string[] = req.body.keepImages ? JSON.parse(req.body.keepImages) : [];

  // 删除不再保留的图片文件
  const oldImages = parseImageUrlArray(post.image_url);
  for (const url of oldImages) {
    if (!keepImages.includes(url)) {
      safeDeleteFile(url);
    }
  }

  // 合并保留的图片和新上传的图片（新图先压缩，heic 转 jpg 后以返回路径为准）
  const processedNew = await Promise.all((req.files as Express.Multer.File[] || []).map(f =>
    compressImage(path.join(PATHS.uploads, f.filename), { maxWidth: POST_IMAGE_MAX })
  ));
  const newFiles = processedNew.map(p => `/uploads/${path.basename(p)}`);
  const allImages = [...keepImages, ...newFiles];

  // 视频帖子允许空图片（image_url 为 '[]'），仅图文帖子要求至少一张
  const isVideoPost = !!post.video_url;
  if (allImages.length === 0 && !isVideoPost) {
    // 清理本次新上传的文件，避免孤儿文件
    for (const url of newFiles) {
      safeDeleteFile(url);
    }
    throw new AppError(400, '至少需要一张图片');
  }
  // 视频帖子保持 image_url 为 '[]'，避免存成 '["[]"]' 这种脏数据
  const finalImageUrl = isVideoPost && allImages.length === 0 ? '[]' : JSON.stringify(allImages);

  const closeComments = req.body.close_comments === '1' ? 1 : 0;
  const pinned = req.body.pinned === '1' ? 1 : 0;

  const updated = postRepo.updatePost({
    postId,
    userId: req.user!.id,
    imageUrl: finalImageUrl,
    description: description || '',
    closeComments,
    pinned,
  });

  if (!updated) {
    throw new AppError(404, '帖子不存在或无权编辑');
  }
  postRepo.syncPostTags(postId, extractTags(updated.description));

  res.json(withImages(updated));
}));

/**
 * DELETE /api/posts/:id - 删除自己的帖子
 *
 * 认证: 必须（只能删除自己的帖子）
 *
 * 级联操作:
 * 1. 删除帖子的所有图片文件
 * 2. 删除视频文件和封面（如有）
 * 3. 删除相关通知
 * 4. 删除帖子记录（数据库外键会自动删除评论、点赞等）
 */
router.delete('/:id', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const postId = parseInt(req.params.id as string);
  const post = postRepo.findOwnPost(postId, req.user!.id);

  if (!post) {
    throw new AppError(404, '帖子不存在或无权删除');
  }

  // 删除媒体文件（图片/视频/封面），再删记录（外键级联会自动删除评论、点赞、通知等）
  deletePostMediaFiles(post);
  postRepo.deletePost(postId);
  res.json({ message: 'Post deleted' });
}));

export default router;
