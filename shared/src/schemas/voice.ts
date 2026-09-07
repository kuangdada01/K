/**
 * ============================================================
 * 语音房间请求体 schema（/api/voice）
 * ============================================================
 * 常量（VOICE_MAX_ROOM_SIZE / VOICE_CHAT_MAX_LEN）定义于
 * constants/voice.ts（双端主入口可用），此处 re-export 保持
 * @k/shared/schemas 导出面不变。
 */

import { z } from 'zod';
import { VOICE_MAX_ROOM_SIZE, VOICE_CHAT_MAX_LEN } from '../constants/voice';

export { VOICE_MAX_ROOM_SIZE, VOICE_CHAT_MAX_LEN };

/** 创建语音房间校验 */
export const createVoiceRoomSchema = z.object({
  name: z.string().trim().min(1, '房间名不能为空').max(30, '房间名最多30个字符'),
  description: z.string().trim().max(100, '房间简介最多100个字符').optional(),
});

/** 创建语音房间请求体类型 */
export type CreateVoiceRoomBody = z.infer<typeof createVoiceRoomSchema>;

/** 语音房间聊天消息校验（信令 WS 发送时复用；控制字符剔除在服务端消息处理层） */
export const voiceChatSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, '消息不能为空')
    .max(VOICE_CHAT_MAX_LEN, `消息最多${VOICE_CHAT_MAX_LEN}个字符`),
});

/** 语音房间聊天消息请求体类型 */
export type VoiceChatBody = z.infer<typeof voiceChatSchema>;
