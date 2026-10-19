/**
 * ============================================================
 * 私信响应序列化（serializers/message）
 * ============================================================
 * 自 routes/messages.ts 拆分：数据库行 → 对外响应对象。
 * 文件名改写为鉴权媒体 URL（uploads_private 不经静态服务暴露）。
 *
 * 语音消息（2026-10-19）：`audio_waveform` 在库里是 **JSON 字符串**，
 * 对外统一成 `number[]`（客户端直接画波形，不用各自再解析一次）。
 * ============================================================
 */

import type { MessageRow } from '../repositories/message.repo';

/** 波形数组上限：客户端只会画约 32 根，留一倍余量即可 */
const MAX_WAVEFORM_BARS = 64;

/** 波形 JSON 解析：脏数据一律退化成空数组（UI 画等高柱），不能因此让整条消息 500 */
function parseWaveform(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
      .slice(0, MAX_WAVEFORM_BARS)
      .map((n) => Math.max(0, Math.min(100, Math.round(n))));
  } catch {
    return [];
  }
}

/** 数据库行 → 响应对象（文件名改写为鉴权媒体 URL） */
export function toMessageJson(m: MessageRow) {
  return {
    ...m,
    image_url: m.image_url ? `/api/messages/${m.id}/media` : null,
    audio_url: m.audio_url ? `/api/messages/${m.id}/media` : null,
    audio_duration_ms: m.audio_duration_ms ?? 0,
    audio_waveform: parseWaveform(m.audio_waveform),
    audio_text: m.audio_text ?? null,
    quoted_image_url:
      m.quoted_image_url && m.quoted_message_id ? `/api/messages/${m.quoted_message_id}/media` : null,
    quoted_audio_url:
      m.quoted_audio_url && m.quoted_message_id ? `/api/messages/${m.quoted_message_id}/media` : null,
  };
}
