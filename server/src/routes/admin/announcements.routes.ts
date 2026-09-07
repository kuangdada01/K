/**
 * ============================================================
 * 管理后台 - 公告管理路由（/api/admin/announcements，自 routes/admin.ts 拆出）
 * ============================================================
 *
 * API 端点:
 * - POST   /api/admin/announcements     - 创建公告
 * - GET    /api/admin/announcements     - 获取所有公告列表
 * - DELETE /api/admin/announcements/:id - 删除公告
 *
 * 认证 + 管理员权限由组合入口 routes/admin/index.ts 的全局中间件保障。
 * 「先 res 后 notify」时序与拆分前一致（响应先行，实时推送随后）。
 */

import { Router, Request, Response } from 'express';
import { asyncHandler } from '../../middleware/error';
import { validateBody } from '../../validate';
import { notifyUser, notifyAllUsers } from '../../sse';
import { announcementSchema } from '@k/shared';
import * as adminRepo from '../../repositories/admin.repo';

const router = Router();

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
