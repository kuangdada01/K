/**
 * ============================================================
 * 帖子路由（/api/posts）- 点赞/分享/收藏/转发
 * ============================================================
 */

import { Router, Request, Response } from 'express';
import { authMiddleware } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/error';
import * as postRepo from '../../repositories/post.repo';

const router = Router();

// ============================================================
// 帖子点赞端点
// ============================================================

/**
 * POST /api/posts/:id/like - 点赞帖子
 *
 * 认证: 必须
 * 使用 INSERT OR IGNORE 防止重复点赞
 */
router.post('/:id/like', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const postId = parseInt(req.params.id as string);
  const userId = req.user!.id;

  const likeCount = postRepo.likePost(userId, postId);
  res.json({ liked: true, like_count: likeCount });
}));

/**
 * DELETE /api/posts/:id/like - 取消点赞帖子
 *
 * 认证: 必须
 */
router.delete('/:id/like', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const postId = parseInt(req.params.id as string);
  const userId = req.user!.id;

  const likeCount = postRepo.unlikePost(userId, postId);
  res.json({ liked: false, like_count: likeCount });
}));

// ============================================================
// 帖子分享端点
// ============================================================

/**
 * POST /api/posts/:id/share - 记录分享并返回分享次数
 *
 * 每个用户对每篇帖子只计一次，重复分享不增加计数
 * 需要登录
 */
router.post('/:id/share', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const postId = parseInt(req.params.id as string);
  const userId = req.user!.id;

  const result = postRepo.sharePost(userId, postId);
  res.json(result);
}));

// ============================================================
// 帖子收藏端点
// ============================================================

/**
 * POST /api/posts/:id/bookmark - 收藏帖子
 *
 * 认证: 必须
 * 使用 INSERT OR IGNORE 防止重复收藏
 */
router.post('/:id/bookmark', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const postId = parseInt(req.params.id as string);
  const userId = req.user!.id;

  postRepo.bookmarkPost(userId, postId);
  res.json({ bookmarked: true });
}));

/**
 * DELETE /api/posts/:id/bookmark - 取消收藏帖子
 *
 * 认证: 必须
 */
router.delete('/:id/bookmark', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const postId = parseInt(req.params.id as string);
  const userId = req.user!.id;

  postRepo.unbookmarkPost(userId, postId);
  res.json({ bookmarked: false });
}));

// ============================================================
// 帖子转发端点
// ============================================================

/**
 * POST /api/posts/:id/repost - 转发帖子
 *
 * 认证: 必须
 * 使用 INSERT OR IGNORE 防止重复转发
 */
router.post('/:id/repost', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const postId = parseInt(req.params.id as string);
  const userId = req.user!.id;

  const result = postRepo.repostPost(userId, postId);
  res.json(result);
}));

/**
 * DELETE /api/posts/:id/repost - 取消转发
 *
 * 认证: 必须
 */
router.delete('/:id/repost', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const postId = parseInt(req.params.id as string);
  const userId = req.user!.id;

  const result = postRepo.unrepostPost(userId, postId);
  res.json(result);
}));

export default router;
