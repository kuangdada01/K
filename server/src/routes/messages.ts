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
import { MAX_IMAGE_BYTES } from '@k/shared';
import { createUploader, messageFilename } from '../lib/upload';
import * as messageRepo from '../repositories/message.repo';
import { getSafeUser } from '../repositories/user.repo';
import { toMessageJson } from '../serializers/message';
import * as messageService from '../services/message.service';
import { AsrFailedError, AsrNotConfiguredError, transcribeAudioFile } from '../lib/asr';
import rateLimit from 'express-rate-limit';

const router = Router();

/**
 * 消息图片上传中间件: 大小上限见 @k/shared（与客户端校验同一个常量），仅允许图片
 * 存储在 uploads_private（不在静态服务范围，经 /api/messages/:id/media 鉴权下发）
 * DB 中 image_url 只存文件名
 */
/** 语音扩展名/类型（录音端固定 m4a；其余是给将来 Web 录音留的口子） */
const AUDIO_EXT_RE = /\.(m4a|mp4|aac|mp3|ogg|wav|3gp)$/i;
const AUDIO_MIME_RE = /^audio\/(mp4|m4a|x-m4a|aac|mpeg|mp3|ogg|wav|3gpp)$/i;

/**
 * 消息附件过滤器：`image` 走原来的图片白名单，`audio` 走音频白名单。
 * 超过上限（图片 10MB / 语音 5MB）由 multer 与服务端二次校验分别兜住。
 */
const messageFileFilter = (
  req: Express.Request,
  file: Express.Multer.File,
  cb: (error: Error | null, acceptFile?: boolean) => void
) => {
  if (file.fieldname === 'audio') {
    const extOk = AUDIO_EXT_RE.test(path.extname(file.originalname).toLowerCase());
    const mimeOk = AUDIO_MIME_RE.test(file.mimetype);
    if (extOk && mimeOk) {
      cb(null, true);
    } else {
      cb(new Error('Only audio files (m4a, aac, mp3, ogg, wav) are allowed'));
    }
    return;
  }
  imageFileFilter(req, file, cb);
};

const upload = createUploader({
  dir: PATHS.uploadsPrivate,
  filename: messageFilename,
  // 上限取图片的 10MB；语音的 5MB 在 service 里按 MAX_VOICE_BYTES 再校验
  maxSize: MAX_IMAGE_BYTES,
  fileFilter: messageFileFilter,
});

// ============================================================
// 会话端点
// ============================================================

/**
 * GET /api/messages/conversations - 获取会话列表
 *
 * 认证: 必须
 *
 * 返回当前用户的所有对话，按最后消息时间倒序（硬上限 500 条 + has_more，
 * 与其他无分页列表同一套约定：超限时截断并如实标注，数组形状不变）。
 * 每个会话包含: 对方用户信息、最后一条消息、未读消息数
 */
router.get(
  '/conversations',
  authMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.id;
    // cursor 存在即游标模式（D1，与信息流 4.3 同一形状约定）：
    //   游标模式 → { conversations, next_cursor, has_more }（单页有界）
    //   无 cursor → { conversations, has_more }（全量，硬上限 500，老客户端不变）
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor.trim() : '';
    if (cursor) {
      const limitRaw = parseInt(req.query.limit as string, 10);
      const limit = Number.isInteger(limitRaw) ? limitRaw : 50;
      const { rows, has_more, next_cursor } = messageRepo.listConversationsByCursor(userId, {
        limit,
        cursor,
      });
      res.json({ conversations: rows.map((r) => withRecallPreview(r, userId)), next_cursor, has_more });
      return;
    }
    const { rows, has_more, next_cursor } = messageRepo.listConversations(userId);
    res.json({ conversations: rows.map((r) => withRecallPreview(r, userId)), has_more, next_cursor });
  })
);

/**
 * 会话列表的「最后一条」预览：撤回要显示成 QQ/微信那样的系统提示。
 *
 * 放在路由层而不是 SQL：文案依赖**看的人是谁**（自己撤回的 = 你，对方撤回的 = 对方），
 * 塞进那条被两个查询共用的 SELECT 里就得再加一个位置参数，容易和游标参数错位。
 */
function withRecallPreview<T extends messageRepo.ConversationRow>(row: T, viewerId: number): T {
  if (!row.last_recalled_at) return row;
  return {
    ...row,
    last_message: row.last_sender_id === viewerId ? '你撤回了一条消息' : '对方撤回了一条消息',
  };
}

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

    // 图片与语音共用这一个鉴权端点（DB 里两条字段互斥，取有值的那个）
    const name = media?.audio_url || media?.image_url;
    if (!media || !name) {
      throw new AppError(404, '媒体不存在');
    }
    if (media.sender_id !== req.user!.id && media.receiver_id !== req.user!.id) {
      throw new AppError(403, '无权访问该媒体');
    }

    const filePath = path.join(PATHS.uploadsPrivate, path.basename(name));
    if (!fs.existsSync(filePath)) {
      throw new AppError(404, '媒体不存在');
    }

    res.setHeader('Cache-Control', 'private, max-age=86400');
    // 拖动语音进度要 Range（ExoPlayer / <audio> 都会发）；sendFile 原生支持，
    // 这里显式声明接受范围，部分客户端据此决定是否启用按需加载。
    res.setHeader('Accept-Ranges', 'bytes');
    if (media.audio_url) {
      // .m4a 在不同 mime 库里的映射不一致，显式钉成 audio/mp4（浏览器与 ExoPlayer 都认）
      res.setHeader('Content-Type', 'audio/mp4');
    }
    res.sendFile(filePath);
  })
);

/**
 * POST /api/messages/:id/transcribe - 语音转文字
 *
 * 认证: 必须（仅收发双方）；结果落库缓存，重复点击不再调用上游。
 * 返回: { text }
 * 错误: 404 不是语音消息 | 403 无权 | 503 服务端未配置 ASR | 502 上游失败
 */
const transcribeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  keyGenerator: (req) => `u:${req.user?.id ?? 0}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '转文字太过频繁，请稍后再试' },
});

router.post(
  '/:id/transcribe',
  authMiddleware,
  transcribeLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const messageId = parseInt(req.params.id as string);
    if (!Number.isInteger(messageId)) throw new AppError(400, '参数错误');

    const media = messageRepo.getMessageMedia(messageId);
    if (!media || !media.audio_url) throw new AppError(404, '这条消息不是语音');
    if (media.sender_id !== req.user!.id && media.receiver_id !== req.user!.id) {
      throw new AppError(403, '无权访问该语音');
    }
    // 已经转写过：直接返回缓存（不重复花上游额度）
    if (media.audio_text?.trim()) {
      res.json({ text: media.audio_text });
      return;
    }

    const filePath = path.join(PATHS.uploadsPrivate, path.basename(media.audio_url));
    if (!fs.existsSync(filePath)) throw new AppError(404, '语音文件不存在');

    try {
      const text = await transcribeAudioFile(filePath);
      messageRepo.setMessageAudioText(messageId, text);
      res.json({ text });
    } catch (e) {
      if (e instanceof AsrNotConfiguredError) throw new AppError(503, e.message);
      throw new AppError(502, e instanceof AsrFailedError ? e.message : '语音转写失败');
    }
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
 * - audio: 语音文件（可选，m4a/AAC，服务端按 5MB / 60s 校验；与 image 互斥）
 * - durationMs: 语音时长（毫秒，带 audio 时必填且 ≥1000）
 * - waveform: 波形 JSON 数组字符串（0–100，≤64 根；画柱状图用）
 * - quotedMessageId: 被引用消息ID（可选）
 *
 * 中间件顺序: authMiddleware → upload.fields(image/audio) → validateBody(sendMessageSchema)
 * （multer → validateBody 顺序不可变：validateBody 失败时按已落盘文件清理）。
 * 编排（压缩/校验/清理/入库/SSE 推送）在 messageService.sendMessage。
 */
router.post(
  '/',
  authMiddleware,
  upload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'audio', maxCount: 1 },
  ]),
  validateBody(sendMessageSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { receiverId, content, quotedMessageId, durationMs, waveform } = req.body;
    const files = (req.files ?? {}) as Record<string, Express.Multer.File[] | undefined>;
    const message = await messageService.sendMessage({
      senderId: req.user!.id,
      receiverId,
      content,
      quotedMessageId,
      imageFile: files.image?.[0],
      audioFile: files.audio?.[0],
      audioDurationMs: durationMs,
      audioWaveform: waveform,
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
 * 撤回后**保留该行**并标记 recalled_at（双方都能看到「撤回了一条消息」，重进会话也在），
 * 内容/媒体字段清空、磁盘文件删除、SSE 推送双方（见 messageService.recallMessage）
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
