/**
 * ============================================================
 * 通知路由模块 (/api/notifications)
 * ============================================================
 * 处理用户通知（评论通知、回复通知等）
 *
 * API 端点:
 * - GET  /api/notifications         - 获取通知列表（最近50条）
 * - PUT  /api/notifications/read    - 标记所有通知已读
 * - PUT  /api/notifications/:id/read - 标记单条通知已读
 * ============================================================
 */

import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { asyncHandler } from '../middleware/error';
import * as notifRepo from '../repositories/notification.repo';

const router = Router();

/**
 * GET /api/notifications - 获取通知列表
 *
 * 认证: 必须
 *
 * 返回当前用户的最近50条通知，按时间倒序
 * 自动过滤已删除帖子/评论的孤立通知
 *
 * 成功响应 (200):
 * - notifications: 通知数组（含发送者用户名和头像）
 * - unread_count: 未读通知数量
 */
router.get('/', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;

  const notifications = notifRepo.listNotifications(userId);
  const unreadCount = notifRepo.countUnreadNotifications(userId);

  res.json({ notifications, unread_count: unreadCount });
}));

/**
 * PUT /api/notifications/read - 标记所有通知已读
 *
 * 认证: 必须
 *
 * 将当前用户的所有未读通知标记为已读
 */
router.put('/read', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  notifRepo.markAllNotificationsRead(userId);
  res.json({ message: '已全部标记为已读' });
}));

/**
 * PUT /api/notifications/:id/read - 标记单条通知已读
 *
 * 认证: 必须
 *
 * 只能标记自己的通知
 */
router.put('/:id/read', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const notifId = parseInt(req.params.id as string);
  const userId = req.user!.id;
  notifRepo.markNotificationRead(notifId, userId);
  res.json({ message: '已标记为已读' });
}));

export default router;
