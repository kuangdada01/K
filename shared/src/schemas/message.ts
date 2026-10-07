/**
 * ============================================================
 * 私信请求体 schema（/api/messages）
 * ============================================================
 */

import { z } from 'zod';
import { intCoerce } from './common';

/** 发送消息校验（multipart 表单字段均为字符串，用 coerce 转换数字） */
export const sendMessageSchema = z.object({
  receiverId: z.coerce.number({ error: '请选择接收人' }).int().positive({ error: '请选择接收人' }),
  content: z.string().trim().max(5000).optional(),
  quotedMessageId: intCoerce.optional(),
});

/** 发送消息请求体类型 */
export type SendMessageBody = z.infer<typeof sendMessageSchema>;
