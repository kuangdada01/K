/**
 * ============================================================
 * 私信响应序列化（serializers/message）
 * ============================================================
 * 自 routes/messages.ts 拆分：数据库行 → 对外响应对象。
 * 文件名改写为鉴权媒体 URL（uploads_private 不经静态服务暴露）。
 * ============================================================
 */

import type { MessageRow } from '../repositories/message.repo';

/** 数据库行 → 响应对象（文件名改写为鉴权媒体 URL） */
export function toMessageJson(m: MessageRow) {
  return {
    ...m,
    image_url: m.image_url ? `/api/messages/${m.id}/media` : null,
    quoted_image_url:
      m.quoted_image_url && m.quoted_message_id ? `/api/messages/${m.quoted_message_id}/media` : null,
  };
}
