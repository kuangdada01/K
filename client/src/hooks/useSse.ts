/**
 * ============================================================
 * SSE 实时事件 Hook (useSse) —— 全局单例连接
 * ============================================================
 * 通过 EventSource 连接 /api/events，接收服务端实时推送
 * 事件类型: message（新私信）、notification（新通知）、announcement（新公告）
 *
 * 单例语义：所有消费方共享一条连接（此前每个 useSse 各开一条，
 * 进私信页会同页双连两条 /api/events）。最后一个消费方卸载时才真正断开。
 *
 * 认证：连接凭一次性短时票据（POST /events/ticket，Bearer 认证换取），
 * JWT 不再进 URL 查询串，避免被反向代理/服务端访问日志记录。
 * 票据一次性消费 ⇒ EventSource 原生自动重连不可用（重放同 URL 会 401），
 * 改为手动指数退避重连（1s 起，封顶 30s，连接成功后复位）。
 */

import { useEffect, useRef } from 'react';
import { getApiBaseUrl } from '../config';

/** SSE 事件处理器 */
export type SseEventHandler = (type: string, data: Record<string, unknown>) => void;

// ---- 模块级单例状态（跨所有 useSse 消费方共享） ----
let es: EventSource | null = null;
/** 当前需要连接的用户（null = 不需要连接） */
let wantedUserId: number | null = null;
/** 取消令牌：关闭/更换连接时作废在途的票据请求与重连链 */
let connToken = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 1000;
const handlers = new Set<SseEventHandler>();

function dispatch(type: string, data: Record<string, unknown>): void {
  for (const h of handlers) h(type, data);
}

/** 关闭连接并作废在途重连（最后一个消费方卸载 / 用户切换时调用） */
function closeConnection(): void {
  connToken += 1;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  es?.close();
  es = null;
  wantedUserId = null;
}

/** 安排一次退避重连（指数退避，封顶 30s） */
function scheduleReconnect(userId: number, token: number): void {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (token === connToken && wantedUserId === userId && handlers.size > 0) {
      retryDelay = Math.min(retryDelay * 2, 30_000);
      void openConnection(userId);
    }
  }, retryDelay);
}

async function openConnection(userId: number): Promise<void> {
  const token = connToken;
  let ticket: string;
  try {
    // 用裸 fetch 而非 axios 实例：SSE 是后台保活连接，token 失效时不应触发
    // 全局 401 拦截器的登出流程（auth:expired），这里只做退避重试
    const tokenJwt = localStorage.getItem('k_token');
    const res = await fetch(`${getApiBaseUrl()}/events/ticket`, {
      method: 'POST',
      headers: tokenJwt ? { Authorization: `Bearer ${tokenJwt}` } : {},
    });
    if (!res.ok) {
      scheduleReconnect(userId, token);
      return;
    }
    ticket = ((await res.json()) as { ticket: string }).ticket;
  } catch {
    // 票据获取失败（网络波动）：退避后重试
    scheduleReconnect(userId, token);
    return;
  }
  if (token !== connToken || wantedUserId !== userId) return;

  const source = new EventSource(`${getApiBaseUrl()}/events?ticket=${encodeURIComponent(ticket)}`);
  es = source;
  source.onopen = () => {
    retryDelay = 1000; // 连接成功，复位退避
  };
  source.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data && typeof data.type === 'string') dispatch(data.type, data);
    } catch {
      // 忽略非 JSON 消息（心跳等）
    }
  };
  source.onerror = () => {
    if (token !== connToken) return;
    source.close();
    if (es === source) es = null;
    scheduleReconnect(userId, token);
  };
  // 被服务端主动踢出（同账号超过 5 条并发连接）：关闭且不安排重连，
  // 避免新标签页反复顶掉旧连接、旧连接又重连顶回新连接的震荡环
  source.addEventListener('kicked', () => {
    if (token !== connToken) return;
    source.close();
    if (es === source) es = null;
  });
}

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

    const wrapped: SseEventHandler = (type, data) => handlerRef.current(type, data);
    handlers.add(wrapped);
    if (!es && wantedUserId !== userId) {
      wantedUserId = userId;
      void openConnection(userId);
    }

    return () => {
      handlers.delete(wrapped);
      if (handlers.size === 0) closeConnection();
    };
  }, [userId]);
}
