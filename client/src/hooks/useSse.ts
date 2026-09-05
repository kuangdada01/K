/**
 * ============================================================
 * SSE 实时事件 Hook (useSse)
 * ============================================================
 * 通过 EventSource 连接 /api/events，接收服务端实时推送
 * 事件类型: message（新私信）、notification（新通知）、announcement（新公告）
 *
 * 断线自动重连（5秒），组件卸载时清理
 * ============================================================
 */

import { useEffect, useRef } from 'react';
import { getApiBaseUrl } from '../config';

/** SSE 事件处理器 */
export type SseEventHandler = (type: string, data: Record<string, unknown>) => void;

export function useSse(userId: number | null | undefined, onEvent: SseEventHandler): void {
  const handlerRef = useRef(onEvent);
  // ref 同步放在 effect 中，避免渲染期访问 ref（react-hooks/refs）
  useEffect(() => {
    handlerRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    if (!userId) return;
    const token = localStorage.getItem('k_token');
    if (!token) return;

    const url = `${getApiBaseUrl()}/events?token=${encodeURIComponent(token)}`;
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      if (closed) return;
      es = new EventSource(url);
      es.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data && typeof data.type === 'string') {
            handlerRef.current(data.type, data);
          }
        } catch {
          // 忽略非 JSON 消息（心跳等）
        }
      };
      es.onerror = () => {
        es?.close();
        es = null;
        if (!closed) {
          retryTimer = setTimeout(connect, 5000);
        }
      };
    };

    connect();
    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      es?.close();
    };
  }, [userId]);
}
