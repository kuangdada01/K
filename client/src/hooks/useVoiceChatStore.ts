/**
 * ============================================================
 * 语音文字聊天 Store Hook（hooks/useVoiceChatStore）
 * ============================================================
 * 自 VoiceContext.tsx 拆出（§3.3）：
 * - 消息列表按 id 去重追加（实时广播与历史拉取竞态不重复）
 * - 历史拉取（2026-10 调整时机）：
 *   · 首拉 —— activeRoomId 一经确定（join 时）立即后台拉取最近 50 条，
 *     与「ICE → 麦克风授权 → WS 握手」并行；配合 VoicePage「connected
 *     才切入房间视图」的闸门，进场时聊天已就绪（不再进去后空一段）
 *   · 追赶 —— connected 时按已见最大 id（after_id 游标）补拉「首拉快照
 *     → WS 订阅生效」的空窗；断线重连（重变 connected）同样走此路径
 *   · 翻页 —— 向上按首条消息 id（before_id）取更早记录
 * - liveMessage：最近一条实时到达的消息（朗读/新消息消费用；历史补拉
 *   不经过它）
 *
 * status/activeRoomId 由会话控制器传入；实时消息回调
 * （onChatMessage/onChatCleared）由 VoiceContext 注入到会话控制器（经 ref，
 * 运行期读取）。
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

  /** 落地一批历史消息：按 id 去重合并（prepend=向上翻页）、推进游标、更新 hasMore。
   *  实时消息与历史拉取之间、并发拉取之间的竞态全部靠这里兜底去重。 */
  const applyFetched = useCallback((fetched: VoiceChatMessage[], hasMore: boolean, prepend = false) => {
    if (fetched.length > 0) {
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        const fresh = fetched.filter((m) => !seen.has(m.id));
        if (fresh.length === 0) return prev;
        return prepend ? [...fresh, ...prev] : [...prev, ...fresh];
      });
      const maxId = Math.max(...fetched.map((m) => m.id));
      if (lastFetchedIdRef.current === null || maxId > lastFetchedIdRef.current) {
        lastFetchedIdRef.current = maxId;
      }
    }
    setChatHasMore(hasMore);
  }, []);

  /** 已首拉的房间（同房间同会话只首拉一次；reset 清除，重进房重新拉） */
  const initialFetchRoomRef = useRef<number | null>(null);
  /** connected 时首拉尚未归来：先记账，待首拉落地后立即追赶 —— 否则会漏掉
   *  「首拉快照时刻 → WS 订阅生效」之间的消息（首拉先于 WS 建连发出） */
  const catchupAfterInitialRef = useRef(false);

  /** 按已见最大 id 追赶补拉（connected 的订阅空窗与断线重连共用） */
  const fetchAfterSeen = useCallback(
    (roomId: number, isStale: () => boolean) => {
      const afterId = lastFetchedIdRef.current;
      if (afterId === null) return;
      getVoiceRoomMessages(roomId, { afterId, limit: 100 })
        .then(({ messages: fetched, has_more }) => {
          if (isStale()) return;
          applyFetched(fetched, has_more);
        })
        .catch(() => {
          // 追赶失败静默：下次重连会再次追赶，实时消息不受影响
        });
    },
    [applyFetched]
  );

  /**
   * 首拉：activeRoomId 一经确定（join 时）立即发起，不等 connected。
   * 进房是「先定房间、后建连」的序列：REST 与「ICE → 麦克风授权 → WS 握手」
   * 并行，聊天先行就绪 —— 配合 VoicePage「connected 才切入房间视图」的闸门，
   * 进场时聊天记录已是满的，消除「进去后空一段再突然刷出」的割裂。
   * 与实时消息、connected 追赶之间全部按 id 去重，先拉不引入一致性问题。
   */
  useEffect(() => {
    if (!activeRoomId) return;
    if (initialFetchRoomRef.current === activeRoomId) return;
    initialFetchRoomRef.current = activeRoomId;
    const roomId = activeRoomId;
    let cancelled = false;
    getVoiceRoomMessages(roomId, { limit: 50 })
      .then(({ messages: fetched, has_more }) => {
        if (cancelled) return;
        applyFetched(fetched, has_more);
        // connected 时首拉还在途 → 落地后立即追赶，补齐订阅空窗
        if (catchupAfterInitialRef.current) {
          catchupAfterInitialRef.current = false;
          fetchAfterSeen(roomId, () => cancelled);
        }
      })
      .catch(() => {
        if (cancelled) return;
        // 首拉失败：放开标记（重连的 connected 会兜底重拉），清掉等待挂账
        initialFetchRoomRef.current = null;
        catchupAfterInitialRef.current = false;
      });
    return () => {
      cancelled = true;
    };
  }, [activeRoomId, applyFetched, fetchAfterSeen]);

  /**
   * connected 时按游标追赶：
   * - 首拉已完成 → 拉「首拉快照 → 现在」的增量（覆盖 WS 订阅生效前的空窗）；
   * - 首拉在途 → 记账，等它落地后立即追赶（游标尚未建立，这里无从拉取）；
   * - 首拉未发出/曾失败 → 兜底拉最近 50 条（等价旧实现的 connected 首拉）；
   * - 断线重连（status 重新变为 connected）同样走这里追赶。
   */
  useEffect(() => {
    if (status !== 'connected' || !activeRoomId) return;
    const roomId = activeRoomId;
    let cancelled = false;
    if (lastFetchedIdRef.current === null) {
      if (initialFetchRoomRef.current === roomId) {
        catchupAfterInitialRef.current = true;
        return;
      }
      initialFetchRoomRef.current = roomId;
      getVoiceRoomMessages(roomId, { limit: 50 })
        .then(({ messages: fetched, has_more }) => {
          if (cancelled) return;
          applyFetched(fetched, has_more);
        })
        .catch(() => {
          // 失败静默：重连的 connected 会再次兜底
        });
      return () => {
        cancelled = true;
      };
    }
    fetchAfterSeen(roomId, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [status, activeRoomId, applyFetched, fetchAfterSeen]);

  /** 向上翻页加载更早的聊天记录（自动按首条消息 id 定位） */
  const loadMoreChat = useCallback(() => {
    const roomId = activeRoomId;
    const first = messagesRef.current[0];
    if (chatLoadingMore || !chatHasMore || !roomId || !first) return;
    setChatLoadingMore(true);
    getVoiceRoomMessages(roomId, { beforeId: first.id, limit: 50 })
      .then(({ messages: older, has_more }) => {
        applyFetched(older, has_more, true);
      })
      .catch(() => {
        // 翻页失败静默：可再次点击重试
      })
      .finally(() => setChatLoadingMore(false));
  }, [activeRoomId, chatHasMore, chatLoadingMore, applyFetched]);

  /** 会话结束/失败：清空聊天状态与游标（leave 与 join 失败共用） */
  const reset = useCallback(() => {
    setMessages([]);
    setChatHasMore(false);
    setChatLoadingMore(false);
    setLiveMessage(null);
    lastFetchedIdRef.current = null;
    initialFetchRoomRef.current = null;
    catchupAfterInitialRef.current = false;
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
