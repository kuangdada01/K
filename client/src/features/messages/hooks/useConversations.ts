/**
 * ============================================================
 * 会话列表 + 通知数据 Hook（features/messages/hooks）
 * ============================================================
 * 自 Messages.tsx 拆出：10s 合并轮询（会话 + 通知）、
 * 本地已清除未读的启发式对账（clearedUnreadRef）、选中会话时的本地角标清除。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../../api/http';
import { events } from '../../../state/events';
import type { Conversation, Notification } from '../../../types';

export function useConversations() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadNotifs, setUnreadNotifs] = useState(0);
  // 本地已清除未读的会话集合: partner_id → 清除时的 unread_count
  const clearedUnreadRef = useRef<Map<number, number>>(new Map());
  // conversations 镜像 ref：供按 partnerId 建立的轮询 effect 读取最新值而不进依赖
  const conversationsRef = useRef<Conversation[]>([]);
  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  // Load conversations and notifications (合并轮询减少请求)
  const refreshConversations = useCallback(async () => {
    try {
      const [convRes, notifRes] = await Promise.all([
        api.get('/messages/conversations'),
        api.get('/notifications'),
      ]);
      // 合并本地已清除的未读状态，防止服务器未及时更新导致角标回弹
      const merged = (convRes.data.conversations as Conversation[]).map((conv) => {
        const clearedAt = clearedUnreadRef.current.get(conv.partner_id);
        if (clearedAt !== undefined) {
          if (conv.unread_count === 0) {
            clearedUnreadRef.current.delete(conv.partner_id);
          } else if (conv.unread_count <= clearedAt) {
            return { ...conv, unread_count: 0 };
          } else {
            // 有新消息到达（count > 清除时），显示新角标
            clearedUnreadRef.current.delete(conv.partner_id);
          }
        }
        return conv;
      });
      setConversations(merged);
      setNotifications(notifRes.data.notifications);
      setUnreadNotifs(notifRes.data.unread_count);
    } catch {}
  }, []);

  useEffect(() => {
    refreshConversations();
    const interval = setInterval(refreshConversations, 10000);
    return () => clearInterval(interval);
  }, [refreshConversations]);

  /** 选中会话时：立即清除该会话的本地未读角标，并用 ref 阻止轮询回弹 */
  const clearLocalUnread = useCallback((c: Conversation) => {
    if (c.unread_count > 0) {
      clearedUnreadRef.current.set(c.partner_id, c.unread_count);
      setConversations((prev) =>
        prev.map((cc) => (cc.partner_id === c.partner_id ? { ...cc, unread_count: 0 } : cc))
      );
      events.emit('badge:changed', { source: 'msg', count: c.unread_count });
    }
  }, []);

  return {
    conversations,
    setConversations,
    conversationsRef,
    notifications,
    setNotifications,
    unreadNotifs,
    setUnreadNotifs,
    refreshConversations,
    clearedUnreadRef,
    clearLocalUnread,
  };
}
