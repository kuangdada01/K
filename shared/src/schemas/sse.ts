/**
 * ============================================================
 * SSE 事件契约（P2-4.2）
 * ============================================================
 * 服务端（server/src/sse.ts 的 notifyUser/notifyAllUsers）与客户端
 * （client/src/hooks/useSse.ts、Android RealtimeClient）此前各自手写事件形状，
 * 字段漂移不会有任何报错 —— 这里把**判别联合**定为唯一事实来源：
 * 服务端的推送参数直接以 SseEvent 类型约束（错字段在构建期失败），
 * sseEventSchema 用于契约测试（服务端真实发出的 payload 必须可解析，
 * 历史 JSON fixture 也必须可解析 —— 兼容旧客户端）。
 *
 * 传输形态：默认 message 通道，`data:` 行是 `JSON.stringify(事件对象)`，
 * 判别字段为 `type`。`kicked` 是**命名事件**（`event: kicked`），不走该联合。
 */

import { z } from 'zod';

/** 私信事件：新消息 / 撤回（recalled = 被撤回的消息 id）/ 会话清空（cleared） */
export const sseMessageEventSchema = z.object({
  type: z.literal('message'),
  from: z.number().int(),
  to: z.number().int(),
  recalled: z.number().int().optional(),
  cleared: z.boolean().optional(),
});

/** 互动通知事件（评论等）：定位用的两个内容 id */
export const sseNotificationEventSchema = z.object({
  type: z.literal('notification'),
  comment_id: z.number().int(),
  post_id: z.number().int(),
});

/** 公告事件（新公告 / 公告删除都复用，只带定位 id） */
export const sseAnnouncementEventSchema = z.object({
  type: z.literal('announcement'),
  announcement_id: z.number().int(),
});

/** SSE 事件判别联合（唯一事实来源；新增事件类型必须三端同改） */
export const sseEventSchema = z.discriminatedUnion('type', [
  sseMessageEventSchema,
  sseNotificationEventSchema,
  sseAnnouncementEventSchema,
]);

export type SseMessageEvent = z.infer<typeof sseMessageEventSchema>;
export type SseNotificationEvent = z.infer<typeof sseNotificationEventSchema>;
export type SseAnnouncementEvent = z.infer<typeof sseAnnouncementEventSchema>;
export type SseEvent = z.infer<typeof sseEventSchema>;
