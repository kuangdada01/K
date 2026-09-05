/**
 * ============================================================
 * 公告路由模块 (/api/announcements)
 * ============================================================
 * 处理用户端公告查看和已读标记
 *
 * API 端点:
 * - GET  /api/announcements         - 获取当前用户的公告列表
 * - PUT  /api/announcements/:id/read - 标记公告已读
 * ============================================================
 */

import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { asyncHandler } from '../middleware/error';
import * as notifRepo from '../repositories/notification.repo';

const router = Router();

/**
 * GET /api/announcements - 获取当前用户的公告列表
 *
 * 认证: 必须
 *
 * 返回:
 * - 全局公告（target_user_id IS NULL）
 * - 定向推送给当前用户的公告（target_user_id = 当前用户ID）
 *
 * 每条公告包含已读状态（通过 announcement_reads 表判断）
 *
 * 成功响应 (200):
 * - announcements: 公告数组（含发送者信息、已读状态）
 * - unread_count: 未读公告数量
 */
router.get(
  '/',
  authMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.id;

    const announcements = notifRepo.listAnnouncements(userId);

    // 计算未读数量
    const unread_count = announcements.filter((a) => !a.is_read).length;
    res.json({ announcements, unread_count });
  })
);

/**
 * PUT /api/announcements/:id/read - 标记公告已读
 *
 * 认证: 必须
 *
 * 使用 INSERT OR IGNORE 防止重复标记
 * 已读记录存储在 announcement_reads 表中
 */
router.put(
  '/:id/read',
  authMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const announcementId = parseInt(req.params.id as string);
    notifRepo.markAnnouncementRead(announcementId, userId);
    res.json({ success: true });
  })
);

export default router;
