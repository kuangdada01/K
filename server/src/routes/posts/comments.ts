/**
 * ============================================================
 * 帖子路由（/api/posts）- 评论
 * ============================================================
 */

import { Router, Request, Response } from 'express';
import { authMiddleware, optionalAuth } from '../../middleware/auth';
import { asyncHandler, AppError } from '../../middleware/error';
import { validateBody } from '../../validate';
import { commentSchema } from '@k/shared';
import { notifyUser } from '../../sse';
import * as postRepo from '../../repositories/post.repo';
import * as commentRepo from '../../repositories/comment.repo';
import * as notifRepo from '../../repositories/notification.repo';

const router = Router();

/**
 * GET /api/posts/:id/comments - 获取帖子评论列表
 *
 * 认证: 可选（登录用户可看到评论点赞状态）
 *
 * 返回评论列表，包含:
 * - 评论内容、用户信息
 * - 点赞数、点赞状态
 * - 父评论内容（用于显示回复关系）
 */
router.get(
  '/:id/comments',
  optionalAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const postId = parseInt(req.params.id as string);
    const userId = req.user?.id;

    const comments = commentRepo.listComments(postId, userId);

    res.json({ comments });
  })
);

/**
 * POST /api/posts/:id/comments - 发表评论
 *
 * 认证: 必须
 *
 * 请求体:
 * - content: 评论内容（不能为空）
 * - parentId: 父评论ID（可选，用于回复）
 *
 * 自动创建通知:
 * - 回复评论时通知被回复者
 * - 评论帖子时通知帖子作者
 */
router.post(
  '/:id/comments',
  authMiddleware,
  validateBody(commentSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const postId = parseInt(req.params.id as string);
    const { content, parentId } = req.body;

    // 检查帖子是否关闭了评论
    const post = postRepo.getPostById(postId);
    if (!post) {
      throw new AppError(404, '帖子不存在');
    }
    if (post.close_comments && post.user_id !== req.user!.id) {
      throw new AppError(403, '此帖子已关闭评论');
    }

    // B4 修复：校验父评论存在且属于当前帖子，避免跨帖回复、通知串帖
    if (parentId != null) {
      const parent = commentRepo.getCommentPost(parentId);
      if (!parent || parent.post_id !== postId) {
        throw new AppError(400, '父评论不存在或不属于该帖子');
      }
    }

    const comment = commentRepo.createComment(req.user!.id, postId, parentId || null, content);

    // 创建通知: 回复别人的评论时通知被回复的人
    let notifyUserId: number | null = null;
    if (parentId) {
      const parentComment = commentRepo.getCommentAuthor(parentId);
      if (parentComment && parentComment.user_id !== req.user!.id) {
        notifRepo.insertNotification({
          userId: parentComment.user_id,
          type: 'reply',
          fromUserId: req.user!.id,
          postId,
          commentId: comment.id,
          content: content.trim(),
        });
        notifyUserId = parentComment.user_id;
      }
    }

    // 创建通知: 评论别人的帖子时通知帖子作者
    if (!parentId) {
      if (post.user_id !== req.user!.id) {
        notifRepo.insertNotification({
          userId: post.user_id,
          type: 'comment',
          fromUserId: req.user!.id,
          postId,
          commentId: comment.id,
          content: content.trim(),
        });
        notifyUserId = post.user_id;
      }
    }

    // 实时推送通知事件
    if (notifyUserId !== null) {
      notifyUser(notifyUserId, 'notification', { comment_id: comment.id, post_id: postId });
    }

    res.status(201).json(comment);
  })
);

/**
 * DELETE /api/posts/comments/:id - 删除自己的评论
 *
 * 认证: 必须（只能删除自己的评论）
 *
 * 使用递归 CTE 删除评论及其所有子回复的通知
 * 数据库外键级联会自动删除子评论
 */
router.delete(
  '/comments/:id',
  authMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const commentId = parseInt(req.params.id as string);
    const userId = req.user!.id;

    const comment = commentRepo.findOwnComment(commentId, userId);
    if (!comment) {
      throw new AppError(404, '评论不存在或无权删除');
    }

    // 递归删除该评论及其所有子回复的通知（外键级联自动删除子评论）
    commentRepo.deleteComment(commentId);
    res.json({ message: '评论已删除' });
  })
);

// ============================================================
// 评论点赞端点
// ============================================================

/**
 * POST /api/posts/comments/:id/like - 点赞评论
 *
 * 认证: 必须
 */
router.post(
  '/comments/:id/like',
  authMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const commentId = parseInt(req.params.id as string);
    const userId = req.user!.id;

    const likeCount = commentRepo.likeComment(userId, commentId);
    res.json({ liked: true, like_count: likeCount });
  })
);

/**
 * DELETE /api/posts/comments/:id/like - 取消评论点赞
 *
 * 认证: 必须
 */
router.delete(
  '/comments/:id/like',
  authMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const commentId = parseInt(req.params.id as string);
    const userId = req.user!.id;

    const likeCount = commentRepo.unlikeComment(userId, commentId);
    res.json({ liked: false, like_count: likeCount });
  })
);

export default router;
