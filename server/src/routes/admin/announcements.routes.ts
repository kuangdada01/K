/**
 * ============================================================
 * 管理后台 - 公告管理路由（/api/admin/announcements，自 routes/admin.ts 拆出）
 * ============================================================
 *
 * API 端点:
 * - POST   /api/admin/announcements     - 创建公告
 * - GET    /api/admin/announcements     - 公告列表（服务端搜索 + 分页；不带 page/q 时保持老的「上限 + has_more」形状）
 * - DELETE /api/admin/announcements/:id - 删除公告
 *
 * 认证 + 管理员权限由组合入口 routes/admin/index.ts 的全局中间件保障。
 * 「先 res 后 notify」时序与拆分前一致（响应先行，实时推送随后）。
 */

import { Router, Request, Response } from 'express';
import { asyncHandler } from '../../middleware/error';
import { validateBody } from '../../validate';
import { notifyUser, notifyAllUsers } from '../../sse';
import { announcementSchema, pageQuerySchema, limitQuerySchema, searchQuerySchema } from '@k/shared/schemas';
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
 * GET /api/admin/announcements - 公告列表
 *
 * 查询参数:
 * - page: 页码（带此参数即进入**服务端分页 + 服务端搜索**模式，默认1）
 * - limit: 每页数量（默认20，上限50）
 * - q: 搜索关键词（标题/内容/目标用户名/公告 ID 子串；空则不过滤）
 *
 * 两种形状（**只增不改**）：
 * - 不带 `page`/`q`：`{ announcements, has_more }` —— 老客户端（已安装的 APK）
 *   行为逐字不变（上限 HARD_LIST_CAP 行）；
 * - 带 `page` 或 `q`：`{ announcements, total, page, limit, totalPages, has_more }`。
 */
router.get(
  '/announcements',
  asyncHandler(async (req: Request, res: Response) => {
    const q = searchQuerySchema.parse(req.query.q);

    // 老路径：没要分页也没搜索 → 保持历史形状
    if (req.query.page === undefined && !q) {
      const { rows: announcements, has_more } = adminRepo.listAllAnnouncements();
      res.json({ announcements, has_more });
      return;
    }

    const page = pageQuerySchema.parse(req.query.page);
    const limit = limitQuerySchema.parse(req.query.limit);
    const { rows: announcements, total } = adminRepo.listAnnouncementsPage({ q, page, limit });

    res.json({
      announcements,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      has_more: page * limit < total,
    });
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
