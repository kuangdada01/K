/**
 * ============================================================
 * 私信服务（services/message）
 * ============================================================
 * 自 routes/messages.ts 拆分的编排逻辑：
 * - sendMessage：图片压缩 → 内容/接收者/引用校验 → 失败清理 → 入库 → SSE 推送双方
 * - recallMessage：撤回（仅发送者）→ 磁盘图片清理 → 删行 → SSE 推送双方
 * - clearConversationMessages：清除会话（DB 事务删行）→ 磁盘图片清理 → SSE 推送双方
 *
 * SSE 推送（P1 修复点）必须保留：撤回/清除若不同步推送双方，其他端会残留
 * 幽灵消息/幽灵会话。
 *
 * 路由层负责：multer 绑定、validateBody、参数校验（含目标用户存在性/自对话拦截）、
 * 调用本服务、响应映射（serializers/message.toMessageJson）。
 * ============================================================
 */

import path from 'path';
import { PATHS } from '../config';
import { AppError } from '../middleware/error';
import { compressImage } from '../lib/image';
import { safeDeleteFile } from '../lib/file';
import { notifyUser } from '../sse';
import * as messageRepo from '../repositories/message.repo';
import * as friendRepo from '../repositories/friend.repo';

/**
 * 发送消息编排（文字/图片，可选引用消息）
 *
 * 校验失败（无内容、给自己发消息、接收人不存在）时清理已压缩的图片文件后抛错，
 * 状态码/错误文案与历史路由实现逐字节一致：
 * - 400 '请输入消息内容或发送图片'
 * - 400 '不能给自己发消息'
 * - 404 '接收人不存在'
 *
 * 成功后返回入库的消息行（含引用信息），由路由层序列化响应并返回 201；
 * 实时推送（notifyUser 双方）在本服务内完成，与历史行为一致。
 */
export async function sendMessage(input: {
  senderId: number;
  receiverId: number;
  content: string | undefined;
  quotedMessageId: number | undefined;
  imageFile: Express.Multer.File | undefined;
}): Promise<messageRepo.MessageRow> {
  const { senderId, receiverId } = input;
  // image_url 只存文件名（uploads_private 不做静态暴露）
  // 上传后立即压缩；heic 会转成 jpg，后续清理/入库一律用压缩后的文件名
  const imageFile = input.imageFile
    ? path.basename(
        await compressImage(path.join(PATHS.uploadsPrivate, input.imageFile.filename), { maxWidth: 1280 })
      )
    : null;

  if ((!input.content || !input.content.trim()) && !imageFile) {
    throw new AppError(400, '请输入消息内容或发送图片');
  }

  if (receiverId === senderId) {
    if (imageFile) safeDeleteFile(`/uploads_private/${imageFile}`, 'uploads_private');
    throw new AppError(400, '不能给自己发消息');
  }

  // 验证接收者存在
  const receiver = friendRepo.userExists(receiverId);
  if (!receiver) {
    if (imageFile) safeDeleteFile(`/uploads_private/${imageFile}`, 'uploads_private');
    throw new AppError(404, '接收人不存在');
  }

  // 验证引用消息存在且属于当前对话
  let quotedId: number | null = null;
  if (input.quotedMessageId) {
    if (messageRepo.isValidQuotedMessage(input.quotedMessageId, senderId, receiverId)) {
      quotedId = input.quotedMessageId;
    }
  }

  const message = messageRepo.insertMessage({
    senderId,
    receiverId,
    content: (input.content || '').trim(),
    imageUrl: imageFile,
    quotedMessageId: quotedId,
  });

  // 实时推送：通知接收者和发送者（其他端会话列表实时更新）
  const eventData = { from: senderId, to: receiverId };
  notifyUser(receiverId, 'message', eventData);
  notifyUser(senderId, 'message', eventData);

  return message;
}

/**
 * 撤回单条消息编排（仅消息发送者可以撤回自己的消息）
 *
 * 流程与历史路由实现一致（P1 修复：撤回后必须向双方推送，勿删推送）：
 * 归属校验 → 同步删除私有目录图片 → 删除 DB 行 → SSE 推送双方。
 * 错误文案/状态码不变：
 * - 404 '消息不存在'
 * - 403 '只能撤回自己发送的消息'
 */
export function recallMessage(userId: number, messageId: number): void {
  const message = messageRepo.getMessageMedia(messageId);
  if (!message) {
    throw new AppError(404, '消息不存在');
  }

  if (message.sender_id !== userId) {
    throw new AppError(403, '只能撤回自己发送的消息');
  }

  // 同步删除私有目录中的图片文件
  if (message.image_url) {
    safeDeleteFile(`/uploads_private/${path.basename(message.image_url)}`, 'uploads_private');
  }
  messageRepo.deleteMessage(messageId);

  // 实时推送撤回事件：双方各端立即移除该消息（此前无推送 → 其他端残留幽灵消息）
  const eventData = { from: message.sender_id, to: message.receiver_id, recalled: messageId };
  notifyUser(message.receiver_id, 'message', eventData);
  notifyUser(message.sender_id, 'message', eventData);
}

/**
 * 清除与某用户的所有消息编排
 *
 * 流程与历史路由实现一致（P1 修复：清除后必须向双方推送，勿删推送）：
 * DB 事务删行 → 磁盘私密图片清理 → SSE 推送双方。
 * 目标用户存在性/自对话拦截由路由层在调用前完成。
 */
export function clearConversationMessages(currentUserId: number, otherUserId: number): void {
  // 事务提交（DB 行已删）后清理磁盘私密图片：引用消息共享同一物理文件，
  // 行全删后这些文件必成孤儿，不清会永久累积（safeDeleteFile 限定 uploads_private 内）
  const imageNames = messageRepo.clearConversation(currentUserId, otherUserId);
  for (const name of imageNames) {
    safeDeleteFile(`/uploads_private/${path.basename(name)}`, 'uploads_private');
  }

  // 实时推送清除事件：双方各端立即清空本地会话（此前无推送 → 对方端残留幽灵消息）
  const eventData = { from: currentUserId, to: otherUserId, cleared: true };
  notifyUser(currentUserId, 'message', eventData);
  notifyUser(otherUserId, 'message', eventData);
}
