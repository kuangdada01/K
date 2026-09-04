/**
 * ============================================================
 * SSE 实时推送模块
 * ============================================================
 * 通过 Server-Sent Events 向在线用户推送实时事件
 * （新消息、新通知、新公告），替代高频轮询
 *
 * 使用:
 * - subscribe(userId, res)  注册用户的 SSE 连接
 * - notifyUser(userId, type, data) 向指定用户推送事件
 * - notifyAllUsers(type, data) 向所有在线用户推送事件
 * ============================================================
 */

import { Response } from 'express';

/** 订阅者表: userId → 该用户的 SSE 响应集合 */
const subscribers = new Map<number, Set<Response>>();

/** 心跳间隔（25秒，低于多数代理的30秒超时） */
const HEARTBEAT_MS = 25000;

/**
 * 注册用户的 SSE 连接
 * 客户端断开时自动清理
 */
export function subscribe(userId: number, res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  // 初始注释行，确保连接建立
  res.write(': connected\n\n');

  let list = subscribers.get(userId);
  if (!list) {
    list = new Set();
    subscribers.set(userId, list);
  }
  list.add(res);

  // 心跳保持连接
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* 连接已断开 */
    }
  }, HEARTBEAT_MS);

  res.on('close', () => {
    clearInterval(ping);
    const set = subscribers.get(userId);
    if (set) {
      set.delete(res);
      if (set.size === 0) subscribers.delete(userId);
    }
  });
}

/**
 * 向指定用户推送事件
 * @param type 事件类型（message / notification / announcement）
 * @param data 附加数据（尽量精简，客户端据此决定是否刷新）
 */
export function notifyUser(userId: number, type: string, data: Record<string, unknown> = {}): void {
  const list = subscribers.get(userId);
  if (!list || list.size === 0) return;
  const payload = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  for (const res of list) {
    try {
      res.write(payload);
    } catch {
      /* 忽略单个失败连接 */
    }
  }
}

/** 向所有在线用户推送事件（如全体公告） */
export function notifyAllUsers(type: string, data: Record<string, unknown> = {}): void {
  const payload = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  for (const list of subscribers.values()) {
    for (const res of list) {
      try {
        res.write(payload);
      } catch {
        /* 忽略单个失败连接 */
      }
    }
  }
}
