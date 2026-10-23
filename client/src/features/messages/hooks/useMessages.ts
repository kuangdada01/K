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
        // 后台标签跳过 tick：锁屏/切走时 5s 一轮的 50 条全量拉取纯属浪费
        // （回到前台后下一 tick 自然恢复）
        if (document.hidden) return;
        // 5s 轮询：失败不重试（下一个 tick 自然会再问；见 api/retry.ts）
        const res = await api.get(`/messages/${partnerId}`, {
          params: { limit: 50 },
          kRetry: false,
        });
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
   * 原地标记一条消息为「已撤回」。
   *
   * 只改 `recalled_at` 与内容/媒体字段（服务端同样会清空），**不删行**：
   * 删掉的话时间轴会少一条、重进会话也查不到 —— 而 QQ/微信是留一条系统提示。
   * 服务端权威数据随后由 [loadMessages] 覆盖（撤回时间以服务端为准）。
   */
  const markRecalled = useCallback((id: number) => {
    const now = new Date().toISOString();
    setMessages((prev) =>
      prev.map((m) =>
        m.id === id
          ? {
              ...m,
              content: '',
              image_url: null,
              audio_url: null,
              audio_duration_ms: 0,
              audio_waveform: [],
              audio_text: null,
              file_url: null,
              file_name: null,
              file_size: 0,
              file_mime: null,
              quoted_message_id: null,
              quoted_content: null,
              quoted_image_url: null,
              quoted_audio_url: null,
              quoted_file_name: null,
              recalled_at: m.recalled_at ?? now,
            }
          : m
      )
    );
  }, []);

  /**
   * SSE 'message' 事件处理：
   * - recalled（撤回）：服务端**保留行并标记 recalled_at**（双方都要看到提示），
   *   本地先乐观标一下，再重拉一次拿到权威数据（正文/媒体已被服务端清空）
   * - cleared（清除会话）：本地清空并复位分页游标
   * - 其余（新消息）：涉及当前对话时重拉最新页；一律刷新会话列表角标
   */
  const handleSseMessage = useCallback(
    (data: Record<string, unknown>) => {
      const epoch = sessionEpochRef.current;
      const { from, to, recalled, cleared } = data;
      const matchesCurrent = partnerId !== null && (Number(from) === partnerId || Number(to) === partnerId);
      // 撤回推送：不是"删掉本地这条"，而是换成一条「撤回了一条消息」的系统提示
      // （服务端现在会留痕，重进会话也还在 —— QQ/微信的行为）
      if (typeof recalled === 'number' && matchesCurrent) {
        if (epoch !== sessionEpochRef.current) return;
        markRecalled(recalled);
        loadMessages();
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
    [partnerId, loadMessages, refreshConversations, markRecalled]
  );

  /**
   * 发送成功后追加（文字/图片/文件共用）。
   *
   * **必须按 id 去重**：服务端的 SSE 广播在 HTTP 响应之前发出，5s 轮询可能先把
   * 这条拉回来；此时无脑 push 会出现同一个 id 两条 → React 重复 key（列表错位、
   * 气泡闪烁）。已存在就原位替换（服务端数据为准），不存在才追加。
   */
  const appendMessage = useCallback((m: Message) => {
    setMessages((prev) => {
      const idx = prev.findIndex((x) => x.id === m.id);
      if (idx >= 0) {
        const next = prev.slice();
        next[idx] = m;
        return next;
      }
      return [...prev, m];
    });
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
    markRecalled,
    clearMessagesLocal,
  };
}
