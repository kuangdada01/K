/**
 * ============================================================
 * 帖子路由（/api/posts）- CRUD 与搜索
 * ============================================================
 * 写路径编排（创建图文帖 / 编辑 / 删除）已移至 services/post.service.ts，
 * 本文件路由层仅保留 multer、认证、参数解析、调用 service 与响应映射。
 */

import { Router, Request, Response } from 'express';
import { PATHS } from '../../config';
import { authMiddleware, optionalAuth } from '../../middleware/auth';
import { asyncHandler, AppError } from '../../middleware/error';
import { withImages, imageFileFilter } from '../../lib/image';
import { pageQuerySchema, limitQuerySchema } from '@k/shared/schemas';
import { MAX_IMAGE_BYTES } from '@k/shared';
import { createUploader, timestampFilename } from '../../lib/upload';
import * as postRepo from '../../repositories/post.repo';
import * as commentRepo from '../../repositories/comment.repo';
import * as postService from '../../services/post.service';

const router = Router();

/** 帖子图片上传中间件: 大小上限见 @k/shared（与客户端校验同一个常量），仅允许 jpg/png/gif/webp */
const imageUpload = createUploader({
  dir: PATHS.uploads,
  filename: timestampFilename('post'),
  maxSize: MAX_IMAGE_BYTES,
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
router.get(
  '/search',
  optionalAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const keyword = ((req.query.q as string) || '').trim();
    const tag = ((req.query.tag as string) || '').trim().replace(/^#/, '');
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
      totalPages: Math.ceil(total / limit),
    });
  })
);

// ============================================================
// 帖子 CRUD 端点
// ============================================================

/**
 * GET /api/posts - 获取帖子列表（信息流）
 *
 * 查询参数:
 * - page: 页码（默认1；旧客户端的 OFFSET 模式，保留兼容）
 * - cursor: 游标（上一页的 next_cursor；**存在即切换到游标模式**，P2-4.3）
 * - limit: 每页数量（默认20）
 *
 * 认证: 可选（登录用户可看到自己的点赞状态）
 *
 * 游标模式响应：`{ posts, next_cursor, has_more }`；页码模式响应保持
 * `{ posts, total, page, totalPages }` 原形状，并附带同样的 `next_cursor`
 * （取本页最后一行）与 `has_more`，供客户端在任意页起切换到游标模式。
 * 游标锚定 (created_at, id)，翻页期间的插入/删除不移动边界（不跳不重）。
 */
router.get(
  '/',
  optionalAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const limit = limitQuerySchema.parse(req.query.limit);
    const userId = req.user?.id;
    const rawCursor = typeof req.query.cursor === 'string' ? req.query.cursor.trim() : '';

    if (rawCursor) {
      const { posts, next_cursor, has_more } = postRepo.listPostsByCursor(rawCursor, limit, userId);
      res.json({
        posts: posts.map((p) => withImages(p)),
        next_cursor,
        has_more,
      });
      return;
    }

    const page = pageQuerySchema.parse(req.query.page);
    const { posts, total } = postRepo.listPosts(page, limit, userId);
    const last = posts[posts.length - 1];

    res.json({
      posts: posts.map((p) => withImages(p)),
      total,
      page,
      totalPages: Math.ceil(total / limit),
      // 旧形状之外的新字段（老客户端只增不改）：本页末行游标 + 是否还有下一页
      next_cursor: last ? postRepo.encodeFeedCursor(last) : null,
      has_more: page < Math.ceil(total / limit),
    });
  })
);

/**
 * GET /api/posts/bookmarks/me - 获取当前用户收藏的帖子列表
 *
 * 认证: 必须
 * 返回收藏的帖子（按收藏时间倒序）。**硬上限** HARD_LIST_CAP 行：
 * 此前无 LIMIT，收藏多的账号一次请求会让同步 SQLite 长时间占住事件循环。
 * 响应新增 `has_more`（数组字段与形状不变，老客户端只增不改）。
 */
router.get(
  '/bookmarks/me',
  authMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const { rows, has_more } = postRepo.listBookmarkedPosts(userId);
    res.json({ posts: rows.map(withImages), has_more });
  })
);

/**
 * GET /api/posts/reposts/me - 获取当前用户转发的帖子列表
 *
 * 认证: 必须
 * 返回转发的帖子（按转发时间倒序）。硬上限与 `has_more` 同上。
 */
router.get(
  '/reposts/me',
  authMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const { rows, has_more } = postRepo.listRepostedPosts(userId);
    res.json({ posts: rows.map(withImages), has_more });
  })
);

/**
 * GET /api/posts/:id - 获取单个帖子详情
 *
 * 认证: 可选
 *
 * 成功响应 (200):
 * - post: 帖子详情（含图片数组、点赞数、评论数）
 * - comments: 评论列表（含嵌套回复信息）
 */
router.get(
  '/:id',
  optionalAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const postId = parseInt(req.params.id as string);
    const userId = req.user?.id;

    const post = postRepo.getPostById(postId, userId);

    if (!post) {
      throw new AppError(404, '帖子不存在');
    }

    // 评论加载策略：
    // - 不带 comment_limit → 全量返回（旧客户端契约不变）
    // - 带 comment_limit（0-50）→ 按顶级评论分页返回第一页 + 总数/是否有更多，
    //   客户端用 /posts/:id/comments?after_id= 续拉
    const commentLimitRaw = parseInt(req.query.comment_limit as string);
    if (!Number.isInteger(commentLimitRaw)) {
      // 全量返回（旧客户端契约不变），但有硬上限；超限时多一个 comments_has_more
      const { rows: comments, has_more } = commentRepo.listCommentsForPost(postId);
      res.json({ post: withImages(post), comments, comments_has_more: has_more });
      return;
    }
    // §5.1 修复: 允许客户端请求 0 条顶级评论（原 `|| 10` 会把 0 吞成默认 10）
    const commentLimit = Math.min(Math.max(commentLimitRaw, 0), 50);
    const paged = commentRepo.listCommentsPaged(postId, userId, { topLevelLimit: commentLimit });
    res.json({
      post: withImages(post),
      comments: paged.comments,
      comments_has_more: paged.has_more,
      comments_total: paged.total,
    });
  })
);

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
 * - location: 位置（可选，自由文本，如「深圳·南山」）
 * - close_comments: 是否关闭评论（'1'=关闭）
 *
 * 成功响应 (201): 创建的帖子对象
 */
router.post(
  '/',
  authMiddleware,
  imageUpload.array('images', 9),
  asyncHandler(async (req: Request, res: Response) => {
    const post = await postService.createPost({
      userId: req.user!.id,
      files: (req.files as Express.Multer.File[]) || [],
      title: req.body.title,
      description: req.body.description,
      location: req.body.location,
      closeComments: req.body.close_comments === '1' ? 1 : 0,
      pinned: req.body.pinned === '1' ? 1 : 0,
    });

    res.status(201).json(withImages(post));
  })
);

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
 * - location: 位置（可选；不传则保持原值）
 * - close_comments: 是否关闭评论
 *
 * 成功响应 (200): 更新后的帖子对象
 */
router.put(
  '/:id',
  authMiddleware,
  imageUpload.array('images', 9),
  asyncHandler(async (req: Request, res: Response) => {
    const postId = parseInt(req.params.id as string);

    const updated = await postService.updatePost({
      postId,
      userId: req.user!.id,
      files: (req.files as Express.Multer.File[]) || [],
      keepImages: req.body.keepImages,
      description: req.body.description,
      location: req.body.location,
      closeComments: req.body.close_comments === '1' ? 1 : 0,
      pinned: req.body.pinned === '1' ? 1 : 0,
    });

    res.json(withImages(updated));
  })
);

/**
 * DELETE /api/posts/:id - 删除自己的帖子
 *
 * 认证: 必须（只能删除自己的帖子）
 *
 * 级联操作:
 * 1. 删除帖子记录（数据库外键会自动删除评论、点赞、通知等）
 * 2. 删除帖子的所有图片/视频/封面文件（DB 成功后再删磁盘）
 */
router.delete(
  '/:id',
  authMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const postId = parseInt(req.params.id as string);

    postService.deletePost(postId, req.user!.id);

    res.json({ message: 'Post deleted' });
  })
);

export default router;
