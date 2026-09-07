/**
 * ============================================================
 * 私信路由模块 (/api/messages)
 * ============================================================
 * 处理用户之间的私信功能
 *
 * API 端点:
 * - GET    /api/messages/conversations    - 获取会话列表（含最后消息、未读数）
 * - PUT    /api/messages/read             - 标记所有消息为已读
 * - GET    /api/messages/:userId          - 获取与某用户的消息历史
 * - POST   /api/messages                  - 发送消息（文字或图片）
 * - DELETE /api/messages/single/:id       - 撤回单条消息（仅发送者）
 * - DELETE /api/messages/:userId          - 清除与某用户的所有消息
 *
 * 拆分说明：编排逻辑（图片压缩、引用校验、磁盘清理、SSE 推送双方）在
 * services/message.service.ts；数据库行 → 响应对象在 serializers/message.ts。
 * 本路由只保留：multer 绑定、validateBody、参数校验（§5.1：目标用户存在性
 * 与自对话拦截）、调用 service、响应映射。中间件顺序 multer → validateBody 不可变。
 * ============================================================
 */

import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { PATHS } from '../config';
import { authMiddleware } from '../middleware/auth';
import { asyncHandler, AppError } from '../middleware/error';
import { imageFileFilter } from '../lib/image';
import { validateBody } from '../validate';
import { sendMessageSchema } from '@k/shared/schemas';
import { createUploader, messageFilename } from '../lib/upload';
import * as messageRepo from '../repositories/message.repo';
import { getSafeUser } from '../repositories/user.repo';
import { toMessageJson } from '../serializers/message';
import * as messageService from '../services/message.service';

const router = Router();

/**
 * 消息图片上传中间件: 限制10MB，仅允许图片
 * 存储在 uploads_private（不在静态服务范围，经 /api/messages/:id/media 鉴权下发）
 * DB 中 image_url 只存文件名
 */
const upload = createUploader({
  dir: PATHS.uploadsPrivate,
  filename: messageFilename,
  maxSize: 10 * 1024 * 1024,
  fileFilter: imageFileFilter,
});

// ============================================================
// 会话端点
// ============================================================

/**
 * GET /api/messages/conversations - 获取会话列表
 *
 * 认证: 必须
 *
 * 返回当前用户的所有对话，按最后消息时间倒序
 * 每个会话包含: 对方用户信息、最后一条消息、未读消息数
 */
router.get(
  '/conversations',
  authMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const conversations = messageRepo.listConversations(userId);
    res.json({ conversations });
  })
);

// ============================================================
// 标记全部已读端点
// ============================================================

/**
 * PUT /api/messages/read - 标记所有消息为已读
 *
 * 认证: 必须
 *
 * 将当前用户收到的所有未读消息标记为已读
 */
router.put(
  '/read',
  authMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.id;
    messageRepo.markAllRead(userId);
    res.json({ success: true });
  })
);

// ============================================================
// 消息历史端点
// ============================================================

/**
 * GET /api/messages/:userId - 获取与某用户的消息历史（游标分页）
 *
 * 认证: 必须
 *
 * 查询参数:
 * - limit: 每页数量（默认50，最大100）
 * - before_id: 游标（返回比该消息ID更早的消息，用于向上翻页）
 *
 * §5.1 校验: 目标用户不存在 → 404 '用户不存在'；自对话（otherUserId === 当前用户）
 * → 400 '参数错误'（此前自对话会返回自己的全部历史，属逻辑缺陷）。
 * 自动将对方发送的未读消息标记为已读。
 * 返回按时间正序排列的消息列表 + has_more（是否还有更早的消息）
 */
router.get(
  '/:userId',
  authMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const currentUserId = req.user!.id;
    const otherUserId = parseInt(req.params.userId as string);
    if (!Number.isInteger(otherUserId)) throw new AppError(400, '参数错误');
    // 目标用户存在性校验 + 自对话拦截（§5.1）
    if (!getSafeUser(otherUserId)) throw new AppError(404, '用户不存在');
    if (otherUserId === currentUserId) throw new AppError(400, '参数错误');
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 100);
    const beforeId = req.query.before_id ? parseInt(req.query.before_id as string) : undefined;

    const { messages, has_more } = messageRepo.listMessageHistory(
      currentUserId,
      otherUserId,
      limit,
      beforeId
    );

    res.json({ messages: messages.map(toMessageJson), has_more });
  })
);

// ============================================================
// 消息图片下发端点
// ============================================================

/**
 * GET /api/messages/:id/media - 获取消息图片
 *
 * 认证: 必须（仅消息的发送者/接收者可访问）
 * 图片存储在 uploads_private，不经静态服务暴露
 */
router.get(
  '/:id/media',
  authMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const messageId = parseInt(req.params.id as string);
    const media = messageRepo.getMessageMedia(messageId);

    if (!media || !media.image_url) {
      throw new AppError(404, '图片不存在');
    }
    if (media.sender_id !== req.user!.id && media.receiver_id !== req.user!.id) {
      throw new AppError(403, '无权访问该图片');
    }

    const filePath = path.join(PATHS.uploadsPrivate, path.basename(media.image_url));
    if (!fs.existsSync(filePath)) {
      throw new AppError(404, '图片不存在');
    }

    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.sendFile(filePath);
  })
);

// ============================================================
// 发送消息端点
// ============================================================

/**
 * POST /api/messages - 发送消息
 *
 * 认证: 必须
 * Content-Type: multipart/form-data
 *
 * 表单字段:
 * - receiverId: 接收者ID
 * - content: 文字内容（可选）
 * - image: 图片文件（可选，10MB限制）
 * - quotedMessageId: 被引用消息ID（可选）
 *
 * 中间件顺序: authMiddleware → upload.single('image') → validateBody(sendMessageSchema)
 * （multer → validateBody 顺序不可变：validateBody 失败时按已落盘文件清理）。
 * 编排（压缩/校验/清理/入库/SSE 推送）在 messageService.sendMessage。
 */
router.post(
  '/',
  authMiddleware,
  upload.single('image'),
  validateBody(sendMessageSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { receiverId, content, quotedMessageId } = req.body;
    const message = await messageService.sendMessage({
      senderId: req.user!.id,
      receiverId,
      content,
      quotedMessageId,
      imageFile: req.file,
    });
    res.status(201).json(toMessageJson(message));
  })
);

// ============================================================
// 撤回单条消息端点
// ============================================================

/**
 * DELETE /api/messages/single/:id - 撤回单条消息
 *
 * 认证: 必须
 *
 * 仅消息发送者可以撤回自己的消息
 * 撤回后删除该消息记录（磁盘图片清理 + SSE 推送双方在 messageService.recallMessage）
 */
router.delete(
  '/single/:id',
  authMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const messageId = parseInt(req.params.id as string);
    if (!Number.isInteger(messageId)) throw new AppError(400, '参数错误');

    messageService.recallMessage(userId, messageId);
    res.json({ message: '消息已撤回' });
  })
);

// ============================================================
// 清除消息端点
// ============================================================

/**
 * DELETE /api/messages/:userId - 清除与某用户的所有消息
 *
 * 认证: 必须
 *
 * §5.1 校验: 目标用户不存在 → 404 '用户不存在'；自对话 → 400 '参数错误'
 * （此前自对话会把当前用户自己的历史全删掉，属逻辑缺陷）。
 * 删除双方之间的所有消息记录，并同步删除这些消息引用的磁盘私密图片
 * （引用消息共享同一物理文件；文件删除失败最多留下孤儿文件，不影响业务）。
 * 编排（DB 删行 + 磁盘清理 + SSE 推送双方）在 messageService.clearConversationMessages。
 */
router.delete(
  '/:userId',
  authMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const currentUserId = req.user!.id;
    const otherUserId = parseInt(req.params.userId as string);
    if (!Number.isInteger(otherUserId)) throw new AppError(400, '参数错误');
    // 目标用户存在性校验 + 自对话拦截（§5.1）
    if (!getSafeUser(otherUserId)) throw new AppError(404, '用户不存在');
    if (otherUserId === currentUserId) throw new AppError(400, '参数错误');

    messageService.clearConversationMessages(currentUserId, otherUserId);
    res.json({ message: '消息已清除' });
  })
);

export default router;
