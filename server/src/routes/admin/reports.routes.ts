/**
 * ============================================================
 * 举报管理路由（/api/admin/reports，2026-10-24）
 * ============================================================
 * 私信举报的处置通道（挂在 admin 全局 authMiddleware + adminMiddleware 之后）：
 * - GET  /api/admin/reports          - 举报列表（默认只看待处理 open，可传 status=all）
 * - POST /api/admin/reports/:id/resolve - 处置：dismiss（忽略）/ delete（删除消息）
 *
 * delete 复用撤回语义（行保留 + 内容清空 + 附件回收 + SSE 推双方），
 * 客户端不用发新版本就会看到「撤回了一条消息」。
 */

import { Router, Request, Response } from 'express';
import { asyncHandler, AppError } from '../../middleware/error';
import { pageQuerySchema, limitQuerySchema } from '@k/shared/schemas';
import * as reportRepo from '../../repositories/report.repo';
import * as messageService from '../../services/message.service';

const router = Router();

/**
 * GET /api/admin/reports - 举报列表（服务端分页）
 *
 * 查询参数:
 * - page: 页码（默认1）
 * - limit: 每页数量（默认20，上限50）
 * - status: open（默认）/ resolved / all
 *
 * 行内带举报人/被举报人用户名与消息上下文（content / file_name / 是否已撤回）——
 * 被举报消息即便已被发送者撤回，sender_id 冗余也保得住定位。
 */
router.get(
  '/reports',
  asyncHandler(async (req: Request, res: Response) => {
    const page = pageQuerySchema.parse(req.query.page);
    const limit = limitQuerySchema.parse(req.query.limit);
    const statusRaw = req.query.status;
    const status = statusRaw === 'resolved' || statusRaw === 'all' ? statusRaw : ('open' as const);

    const { rows, total } = reportRepo.listReports({ page, limit, status });
    res.json({
      reports: rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      has_more: page * limit < total,
    });
  })
);

/**
 * POST /api/admin/reports/:id/resolve - 处置一条举报
 *
 * body: { action: 'dismiss' | 'delete' }
 * - dismiss：标记已处理，消息不动（误报场景）
 * - delete：删除被举报消息（复用撤回语义，附件一并回收）后标记已处理
 */
router.post(
  '/reports/:id/resolve',
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string);
    if (!Number.isInteger(id)) throw new AppError(400, '参数错误');

    const action = req.body?.action;
    if (action !== 'dismiss' && action !== 'delete') {
      throw new AppError(400, 'action 必须是 dismiss 或 delete');
    }

    const report = reportRepo.getReportById(id);
    if (!report) throw new AppError(404, '举报不存在');

    if (action === 'delete') {
      // 消息可能已被撤回/已被另一条举报删除过：deleteMessageAsAdmin 幂等返回 false
      messageService.deleteMessageAsAdmin(report.message_id);
    }
    reportRepo.resolveReport(id, req.user!.id);
    res.json({ ok: true });
  })
);

export default router;
