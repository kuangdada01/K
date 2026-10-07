/**
 * ============================================================
 * SSE 实时推送模块
 * ============================================================
 * 通过 Server-Sent Events 向在线用户推送实时事件
 * （新消息、新通知、新公告），替代高频轮询
 *
 * 使用:
 * - subscribe(userId, res)  注册用户的 SSE 连接
 * - notifyUser(userId, event) 向指定用户推送事件（event 为 @k/shared 的 SseEvent 判别联合）
 * - notifyAllUsers(event) 向所有在线用户推送事件
 * ============================================================
 */

import { Response } from 'express';
import type { SseEvent } from '@k/shared/schemas';
import { logger } from './lib/logger';

/** 订阅者表: userId → 该用户的 SSE 响应集合 */
const subscribers = new Map<number, Set<Response>>();

/** 心跳间隔（25秒，低于多数代理的30秒超时） */
const HEARTBEAT_MS = 25000;

/**
 * 单用户最大并发 SSE 连接数：每条连接一个心跳定时器，无上限的话
 * 单个账号可无限叠加连接耗尽内存/定时器。超出时关闭最早建立的连接
 * （新标签页照常可用，Set 按插入序，values().next() 即最旧）。
 */
const MAX_SSE_PER_USER = 5;

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
  while (list.size >= MAX_SSE_PER_USER) {
    const oldest = list.values().next().value;
    if (!oldest) break;
    list.delete(oldest);
    // 先写 kicked 终止事件再断开：客户端据此不再安排退避重连，打破「6+ 标签页」反复互踢的震荡环
    try {
      oldest.write('event: kicked\ndata: {}\n\n');
    } catch {
      /* 连接已断开 */
    }
    try {
      oldest.end();
    } catch {
      /* 连接已断开 */
    }
  }
  list.add(res);

  /**
   * ★ 诊断：把每条连接的**存活时长**量出来。
   *
   * 排查"App 退到后台就收不到通知"时，头号嫌疑是"长连接在后台保不住"——
   * 而 nginx 只在连接**关闭**时写一条 access log，看不出它活了 5 秒还是 5 分钟。
   * 这里直接量出来，日志里一眼就能判定。
   */
  const openedAt = Date.now();
  logger.info({ userId, connections: list.size }, 'SSE 订阅');

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
    logger.info(
      { userId, aliveSec: Math.round((Date.now() - openedAt) / 1000), rest: set?.size ?? 0 },
      'SSE 断开'
    );
  });
}

/**
 * 向指定用户推送事件
 *
 * 事件形状由 `@k/shared/schemas` 的 **SseEvent 判别联合**约束（P2-4.2）：
 * 错字段/错事件类型在构建期失败，契约测试（sse-contract.test.ts）再校验
 * 运行时发出的 payload 与历史 fixture 都可解析。
 * @param event 判别联合事件对象（`data:` 行 = JSON.stringify(event)）
 */
export function notifyUser(userId: number, event: SseEvent): void {
  const list = subscribers.get(userId);
  if (!list || list.size === 0) {
    /**
     * ★ 用户不在线 = 这条推送**永久丢失**（没有离线补偿，见本文件顶部说明）。
     *
     * "收不到通知"的排查里这是最关键的一条日志：它直接区分
     * 「服务端压根没推出去」和「推到了、但客户端没弹」——
     * 少了它，两边都会认为是对方的问题。
     */
    logger.info({ userId, type: event.type }, 'SSE 推送时无在线连接（事件已丢弃）');
    return;
  }
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of list) {
    try {
      res.write(payload);
    } catch {
      /* 忽略单个失败连接 */
    }
  }
  logger.info({ userId, type: event.type, connections: list.size }, 'SSE 推送完成');
}

/** 向所有在线用户推送事件（如全体公告）。事件形状同样受 SseEvent 约束。 */
export function notifyAllUsers(event: SseEvent): void {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
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

/**
 * 结束全部 SSE 连接（优雅停机用）
 * SSE 是长连接，不主动 end 的话 server.close() 的回调永远不会触发
 */
export function closeAllStreams(): void {
  for (const list of subscribers.values()) {
    for (const res of list) {
      try {
        res.end();
      } catch {
        /* 忽略 */
      }
    }
  }
  subscribers.clear();
}
