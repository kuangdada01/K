/**
 * ============================================================
 * 私信请求体 schema（/api/messages）
 * ============================================================
 */

import { z } from 'zod';
import { intCoerce } from './common';
import { MAX_VOICE_MS } from '../constants/upload';

/**
 * 发送消息校验（multipart 表单字段均为字符串，用 coerce 转换数字）。
 *
 * 语音消息（2026-10-19）：
 *  · `durationMs` 与 `waveform` 只在带 `audio` 文件时才有意义；
 *  · `waveform` 是 JSON 数组字符串（0–100，≤64 根），客户端画波形用；
 *  · 两者的语义校验（是否缺、长度是否匹配）在 service 里做 —— 这里只挡类型与上限。
 */
export const sendMessageSchema = z.object({
  receiverId: z.coerce.number({ error: '请选择接收人' }).int().positive({ error: '请选择接收人' }),
  content: z.string().trim().max(5000).optional(),
  quotedMessageId: intCoerce.optional(),
  durationMs: z.coerce.number().int().min(0).max(MAX_VOICE_MS).optional(),
  waveform: z.string().max(2000).optional(),
});

/** 发送消息请求体类型 */
export type SendMessageBody = z.infer<typeof sendMessageSchema>;
