/**
 * ============================================================
 * 私信消息页合并工具（features/messages/utils）
 * ============================================================
 * 自 Messages.tsx 拆出的纯函数（行为与原内联实现逐行一致）：
 * 合并消息页，按 id 去重后按 id 升序；无新消息时跳过重渲染。
 */

import type { Message } from '../../../types';

/**
 * 页面对照签名：id + 撤回时间。
 *
 * 撤回是**原地改一条**（同一 id，`recalled_at` 由空变有值），只比 last id 会让
 * "撤回后轮询"误判成"没有新消息"而不更新，重进会话才看到提示 —— 正是用户反馈的现象。
 */
function pageSignature(list: Message[]): string {
  return list.map((m) => `${m.id}:${m.recalled_at ?? ''}`).join('|');
}

/** 合并消息页：按 id 去重后按 id 升序（loadMessages 与轮询共用） */
export function mergeMessagePages(prev: Message[], newMsgs: Message[]): Message[] {
  // 内容完全一致：跳过重渲染（防止滚动位置重置）
  if (prev.length >= newMsgs.length && pageSignature(prev) === pageSignature(newMsgs)) return prev;
  if (prev.length === 0 && newMsgs.length === 0) return prev;
  // 合并：保留已加载的更早消息，用最新页补齐/更新（同 id 以服务端为准）
  const byId = new Map(prev.map((m) => [m.id, m]));
  for (const m of newMsgs) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}
