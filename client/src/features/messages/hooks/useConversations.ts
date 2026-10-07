/**
 * ============================================================
 * 会话列表 + 通知数据 Hook（features/messages/hooks）
 * ============================================================
 * 自 Messages.tsx 拆出的**共享**收件箱视图（4.3）：数据本体在
 * `state/inboxStore`，与 Sidebar 角标共用同一份快照与同一个轮询定时器
 * （消息页 10s、其他页面 30s，取最小间隔）。
 *
 * 改前：本 Hook 与 Sidebar 各自请求 `/messages/conversations` +
 * `/notifications`，各自订阅 SSE，一次事件打 4 个请求。
 */

import { useCallback, useEffect, useRef } from 'react';
import { clearConversationUnread, refreshInbox } from '../../../state/inboxStore';
import { useInbox } from '../../../hooks/useInbox';
import { events } from '../../../state/events';
import type { Conversation } from '../../../types';

/** 消息页停留时的轮询间隔（其他页面由 Sidebar 的 30s 决定） */
const MESSAGES_POLL_MS = 10000;

export function useConversations() {
  const { conversations, notifications, unreadNotifs } = useInbox(MESSAGES_POLL_MS);

  // conversations 镜像 ref：供按 partnerId 建立的轮询 effect 读取最新值而不进依赖
  const conversationsRef = useRef<Conversation[]>(conversations);
  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  /** 选中会话时：立即清除该会话的本地未读角标，并让服务器值尽快对账 */
  const clearLocalUnread = useCallback((c: Conversation) => {
    if (c.unread_count > 0) {
      clearConversationUnread(c.partner_id, c.unread_count);
      events.emit('badge:changed', { source: 'msg', count: c.unread_count });
    }
  }, []);

  return {
    conversations,
    conversationsRef,
    notifications,
    unreadNotifs,
    refreshConversations: refreshInbox,
    clearLocalUnread,
  };
}
