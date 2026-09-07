/**
 * ============================================================
 * 消息数据层 Hook（features/messages/hooks）
 * ============================================================
 * 自 Messages.tsx 拆出：当前会话的消息状态、会话纪元（epoch）、
 * 最新页拉取 + 5s 轮询、向上翻页、SSE 撤回/清除对账。
 *
 * 关键不变量（与原实现一致）：
 * - 会话纪元 sessionEpochRef 在 partnerId 每次变化（含离开）时 +1，
 *   所有在途异步回调 apply state 前校验纪元，杜绝会话串号
 * - 切换会话清空消息用「渲染期 prev 值模式」（历史实现）
 * - 轮询 effect 只在 partnerId 变化时重建（conversations 经 ref 读最新快照）
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import api from '../../../api/http';
import { mergeMessagePages } from '../utils/mergeMessages';
import type { Conversation, Message } from '../../../types';

export interface UseMessagesOptions {
  /** 当前会话对端 id（路由参数解析结果；null = 不在会话页） */
  partnerId: number | null;
  /** conversations 最新快照 ref（骨架用户信息查找用，不进 effect 依赖） */
  conversationsRef: MutableRefObject<Conversation[]>;
  /** 骨架用户信息回填回调（会话列表里没有该用户时） */
  onPartnerInfo: (partnerId: number, username: string, avatar: string | null) => void;
  /** 会话/通知刷新（SSE 对账后同步角标） */
  refreshConversations: () => Promise<void>;
  /** 聊天滚动容器 ref（向上翻页保持滚动位置用） */
  chatMessagesRef: RefObject<HTMLDivElement | null>;
}

export function useMessages({
  partnerId,
  conversationsRef,
  onPartnerInfo,
  refreshConversations,
  chatMessagesRef,
}: UseMessagesOptions) {
  const [messages, setMessages] = useState<Message[]>([]);
  // 分页相关
  const messagesRef = useRef<Message[]>([]);
  const hasMoreRef = useRef(false);
  const loadingOlderRef = useRef(false);
  // 会话纪元：partnerId 每次切换 +1，作废旧会话在途异步回调的 state 应用（防会话串号）
  const sessionEpochRef = useRef(0);
  /** 首次加载标记：column-reverse 天然从底部开始，无需 JS 滚动 */
  const initialScrollRef = useRef(true);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // 切换会话必须清空上一会话的消息（渲染期 prev 值模式，替代 effect 内同步 setState）：
  // pollMessages 用 mergeMessagePages 按 id 合并 prev，不清空会把旧会话消息混入新会话
  const [prevPartnerId, setPrevPartnerId] = useState<number | null>(null);
  if (partnerId !== prevPartnerId) {
    setPrevPartnerId(partnerId);
    setMessages([]);
  }

  // 拉取最新消息页并合并（保留已加载的更早历史）
  const loadMessages = useCallback(async () => {
    if (partnerId === null) return;
    const epoch = sessionEpochRef.current;
    try {
      const res = await api.get(`/messages/${partnerId}`, { params: { limit: 50 } });
      if (epoch !== sessionEpochRef.current) return;
      const newMsgs = res.data.messages as Message[];
      hasMoreRef.current = !!res.data.has_more;
      setMessages((prev) => mergeMessagePages(prev, newMsgs));
    } catch {}
  }, [partnerId]);

  // Load messages when partner selected + poll for new messages
  useEffect(() => {
    // 会话纪元 +1：使上一会话所有在途异步回调失效
    sessionEpochRef.current += 1;
    const epoch = sessionEpochRef.current;
    if (partnerId === null) return;
    initialScrollRef.current = true;
    // 分页游标同步重置（ref 写入允许在 effect 内）
    messagesRef.current = [];
    hasMoreRef.current = false;

    // 骨架 partner（本体已在渲染期同步）：用户名/头像异步填充
    const conv = conversationsRef.current.find((c) => c.partner_id === partnerId);
    if (!conv) {
      api.get(`/users/${partnerId}`).then((res) => {
        if (epoch !== sessionEpochRef.current) return;
        onPartnerInfo(partnerId, res.data.username, res.data.avatar);
      });
    }

    // 拉取 + 轮询：async 函数定义在 effect 内，await 边界可被规则正确识别
    const pollMessages = async () => {
      try {
        const res = await api.get(`/messages/${partnerId}`, { params: { limit: 50 } });
        if (epoch !== sessionEpochRef.current) return;
        const newMsgs = res.data.messages as Message[];
        hasMoreRef.current = !!res.data.has_more;
        setMessages((prev) => mergeMessagePages(prev, newMsgs));
      } catch {}
    };
    pollMessages();
    const interval = setInterval(pollMessages, 5000);

    return () => clearInterval(interval);
    // 历史实现仅在 partnerId 变化时重建（conversations 通过 ref 读取当时的快照）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partnerId]);

  // 向上翻页加载更早消息（保持滚动位置）
  const loadOlder = useCallback(async () => {
    if (partnerId === null || loadingOlderRef.current || !hasMoreRef.current) return;
    const epoch = sessionEpochRef.current;
    const oldest = messagesRef.current[0];
    if (!oldest) return;
    const el = chatMessagesRef.current;
    const prevScrollTop = el ? el.scrollTop : 0;
    const prevScrollHeight = el ? el.scrollHeight : 0;
    loadingOlderRef.current = true;
    try {
      const res = await api.get(`/messages/${partnerId}`, { params: { limit: 50, before_id: oldest.id } });
      if (epoch !== sessionEpochRef.current) return;
      const olderMsgs = res.data.messages as Message[];
      hasMoreRef.current = !!res.data.has_more;
      if (olderMsgs.length > 0) {
        setMessages((prev) => {
          const byId = new Map(prev.map((m) => [m.id, m]));
          for (const m of olderMsgs) byId.set(m.id, m);
          return [...byId.values()].sort((a, b) => a.id - b.id);
        });
        requestAnimationFrame(() => {
          if (el) {
            el.scrollTop = prevScrollTop + (el.scrollHeight - prevScrollHeight);
          }
        });
      }
    } catch {
    } finally {
      loadingOlderRef.current = false;
    }
  }, [partnerId, chatMessagesRef]);

  /**
   * SSE 'message' 事件处理：
   * - recalled（撤回）：服务器已删记录，本地直接过滤，避免幽灵消息
   * - cleared（清除会话）：本地清空并复位分页游标
   * - 其余（新消息）：涉及当前对话时重拉最新页；一律刷新会话列表角标
   */
  const handleSseMessage = useCallback(
    (data: Record<string, unknown>) => {
      const epoch = sessionEpochRef.current;
      const { from, to, recalled, cleared } = data;
      const matchesCurrent = partnerId !== null && (Number(from) === partnerId || Number(to) === partnerId);
      // 撤回推送
      if (typeof recalled === 'number' && matchesCurrent) {
        if (epoch !== sessionEpochRef.current) return;
        setMessages((prev) => prev.filter((m) => m.id !== recalled));
        refreshConversations();
        return;
      }
      // 清除推送
      if (cleared === true && matchesCurrent) {
        if (epoch !== sessionEpochRef.current) return;
        setMessages([]);
        hasMoreRef.current = false;
        refreshConversations();
        return;
      }
      // 仅当事件涉及当前对话或自身时刷新
      if (matchesCurrent) {
        loadMessages();
      }
      refreshConversations();
    },
    [partnerId, loadMessages, refreshConversations]
  );

  /** 发送成功后追加（handleSend/handleSendImage 共用） */
  const appendMessage = useCallback((m: Message) => {
    setMessages((prev) => [...prev, m]);
  }, []);

  /** 撤回成功/SSE 撤回后移除 */
  const removeMessageById = useCallback((id: number) => {
    setMessages((prev) => prev.filter((m) => m.id !== id));
  }, []);

  /** 清除会话后本地清空 + 复位分页游标 */
  const clearMessagesLocal = useCallback(() => {
    setMessages([]);
    hasMoreRef.current = false;
  }, []);

  return {
    messages,
    setMessages,
    messagesRef,
    hasMoreRef,
    loadingOlderRef,
    sessionEpochRef,
    initialScrollRef,
    loadMessages,
    loadOlder,
    handleSseMessage,
    appendMessage,
    removeMessageById,
    clearMessagesLocal,
  };
}
