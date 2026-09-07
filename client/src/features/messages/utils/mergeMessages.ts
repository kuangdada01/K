/**
 * ============================================================
 * 私信消息页合并工具（features/messages/utils）
 * ============================================================
 * 自 Messages.tsx 拆出的纯函数（行为与原内联实现逐行一致）：
 * 合并消息页，按 id 去重后按 id 升序；无新消息时跳过重渲染。
 */

import type { Message } from '../../../types';

/** 合并消息页：按 id 去重后按 id 升序（loadMessages 与轮询共用） */
export function mergeMessagePages(prev: Message[], newMsgs: Message[]): Message[] {
  const lastPrev = prev[prev.length - 1];
  const lastNew = newMsgs[newMsgs.length - 1];
  // 无新消息：最后一条 ID 相同且已加载数量 ≥ 最新页 → 跳过重渲染（防止滚动位置重置）
  if (lastPrev && lastNew && lastPrev.id === lastNew.id && prev.length >= newMsgs.length) return prev;
  if (prev.length === 0 && newMsgs.length === 0) return prev;
  // 合并：保留已加载的更早消息，用最新页补齐/更新
  const byId = new Map(prev.map((m) => [m.id, m]));
  for (const m of newMsgs) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}
