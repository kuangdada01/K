/**
 * ============================================================
 * 语音文字聊天 Store Hook（hooks/useVoiceChatStore）
 * ============================================================
 * 自 VoiceContext.tsx 拆出（§3.3，行为逐行不变）：
 * - 消息列表按 id 去重追加（实时广播与历史拉取竞态不重复）
 * - 历史拉取：首次进房取最近 50 条；断线重连按已见最大 id（after_id
 *   游标）追赶补拉；向上翻页按首条消息 id（before_id）取更早记录
 * - liveMessage：最近一条实时到达的消息（朗读/新消息消费用；历史补拉
 *   不经过它）
 *
 * status/activeRoomId 由会话控制器传入（进房/重连即拉取，与拆分前同一
 * 时机）；实时消息回调（onChatMessage/onChatCleared）由 VoiceContext
 * 注入到会话控制器（经 ref，运行期读取）。
 * ============================================================
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getVoiceRoomMessages } from '../api/voice';
import type { VoiceChatMessage } from '../types';
import type { VoiceStatus } from '../voice/VoiceSession';

export function useVoiceChatStore({
  status,
  activeRoomId,
}: {
  status: VoiceStatus;
  activeRoomId: number | null;
}) {
  // ---- 文字聊天（历史持久化在服务端，断线/重连后按 after_id 追赶补拉） ----
  const [messages, setMessages] = useState<VoiceChatMessage[]>([]);
  const [chatHasMore, setChatHasMore] = useState(false);
  const [chatLoadingMore, setChatLoadingMore] = useState(false);
  /** 最近一条实时到达的聊天消息（只保留最新；历史补拉不经过它） */
  const [liveMessage, setLiveMessage] = useState<VoiceChatMessage | null>(null);
  /** 已见过（历史拉取或实时收到）的最大消息 id：重连/追补的游标 */
  const lastFetchedIdRef = useRef<number | null>(null);
  /** messages 的镜像 ref：翻页等回调读取首条 id 时避免把 messages 塞进依赖 */
  const messagesRef = useRef<VoiceChatMessage[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  /** 实时消息按 id 去重追加（防与服务端历史拉取竞态重复） */
  const onChatMessage = useCallback((message: VoiceChatMessage) => {
    setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
    if (lastFetchedIdRef.current === null || message.id > lastFetchedIdRef.current) {
      lastFetchedIdRef.current = message.id;
    }
    // 暴露最近一条实时消息（朗读新消息等实时消费；历史补拉不经过这里）
    setLiveMessage(message);
  }, []);

  /** 房间聊天被创建者/管理员清空：本地同步清空（游标保留，后续只追新） */
  const onChatCleared = useCallback(() => {
    setMessages([]);
    setChatHasMore(false);
  }, []);

  /** 文字聊天历史：进入/重连成功时拉取。
   *  首次进房取最近 50 条；断线重连（status 重新变为 connected）按已见最大 id
   *  追赶补拉（after_id），实时消息与历史拉取之间按 id 去重，不重复不丢失。 */
  useEffect(() => {
    if (status !== 'connected' || !activeRoomId) return;
    let cancelled = false;
    const afterId = lastFetchedIdRef.current;
    getVoiceRoomMessages(activeRoomId, afterId === null ? { limit: 50 } : { afterId, limit: 100 })
      .then(({ messages: fetched, has_more }) => {
        if (cancelled) return;
        if (fetched.length > 0) {
          setMessages((prev) => {
            const seen = new Set(prev.map((m) => m.id));
            return [...prev, ...fetched.filter((m) => !seen.has(m.id))];
          });
          const maxId = Math.max(...fetched.map((m) => m.id));
          if (lastFetchedIdRef.current === null || maxId > lastFetchedIdRef.current) {
            lastFetchedIdRef.current = maxId;
          }
        }
        setChatHasMore(has_more);
      })
      .catch(() => {
        // 拉取失败静默：下次重连会再次追赶，实时消息不受影响
      });
    return () => {
      cancelled = true;
    };
  }, [status, activeRoomId]);

  /** 向上翻页加载更早的聊天记录（自动按首条消息 id 定位） */
  const loadMoreChat = useCallback(() => {
    const roomId = activeRoomId;
    const first = messagesRef.current[0];
    if (chatLoadingMore || !chatHasMore || !roomId || !first) return;
    setChatLoadingMore(true);
    getVoiceRoomMessages(roomId, { beforeId: first.id, limit: 50 })
      .then(({ messages: older, has_more }) => {
        setMessages((prev) => {
          const seen = new Set(prev.map((m) => m.id));
          return [...older.filter((m) => !seen.has(m.id)), ...prev];
        });
        setChatHasMore(has_more);
      })
      .catch(() => {
        // 翻页失败静默：可再次点击重试
      })
      .finally(() => setChatLoadingMore(false));
  }, [activeRoomId, chatHasMore, chatLoadingMore]);

  /** 会话结束/失败：清空聊天状态与游标（leave 与 join 失败共用） */
  const reset = useCallback(() => {
    setMessages([]);
    setChatHasMore(false);
    setChatLoadingMore(false);
    setLiveMessage(null);
    lastFetchedIdRef.current = null;
  }, []);

  return {
    messages,
    chatHasMore,
    chatLoadingMore,
    liveMessage,
    loadMoreChat,
    onChatMessage,
    onChatCleared,
    reset,
  };
}
