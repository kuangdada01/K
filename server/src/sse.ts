/**
 * ============================================================
 * SSE 实时推送模块
 * ============================================================
 * 通过 Server-Sent Events 向在线用户推送实时事件
 * （新消息、新通知、新公告），替代高频轮询
 *
 * 使用:
 * - subscribe(userId, res, client)  注册用户的 SSE 连接
 * - notifyUser(userId, event) 向指定用户推送事件（event 为 @k/shared 的 SseEvent 判别联合）
 * - notifyAllUsers(event) 向所有在线用户推送事件
 *
 * ★ 与厂商推送（OPPO PUSH）的分工（2026-10-08，方案二落地）：
 *   SSE 只服务"App 在前台"的实时刷新；**没有 Android 在线连接**时，
 *   notifyUser 会转投一条设备推送（见 lib/oppo-push + services/push.service），
 *   由系统推送服务在后台/被杀时展示通知。判定用"有没有 client=android 的连接"，
 *   而不是"有没有任意连接"—— 只有网页端在线不该压掉手机上的提醒。
 * ============================================================
 */

import { Response } from 'express';
import type { SseEvent } from '@k/shared/schemas';
import { logger } from './lib/logger';
import { pushAnnouncementToAll, pushForOffline, setAndroidOnlineChecker } from './services/push.service';

/**
 * 连接来源类型。
 *
 * `android` 由原生 App 在连接 URL 上显式声明（`?client=android`，见
 * RealtimeClient）—— 它是"设备推送要不要补一条"的唯一判据；
 * 旧版 App / 网页端 / 未知来源一律落到 `unknown`，**不参与该判定**
 * （老客户端没有推送注册，多投一条推送对它们也只是无设备可发的空操作）。
 */
export type SseClientKind = 'android' | 'web' | 'unknown';

/** 订阅者表: userId → 该用户的 SSE 响应集合 */
const subscribers = new Map<number, Set<Response>>();

/** 每条连接的类型（WeakMap：连接关闭后自动回收，不需要手动清理） */
const clientKinds = new WeakMap<Response, SseClientKind>();

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
export function subscribe(userId: number, res: Response, client: SseClientKind = 'unknown'): void {
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
  clientKinds.set(res, client);

  /**
   * ★ 诊断：把每条连接的**存活时长**量出来。
   *
   * 排查"App 退到后台就收不到通知"时，头号嫌疑是"长连接在后台保不住"——
   * 而 nginx 只在连接**关闭**时写一条 access log，看不出它活了 5 秒还是 5 分钟。
   * 这里直接量出来，日志里一眼就能判定。
   */
  const openedAt = Date.now();
  logger.info({ userId, connections: list.size, client }, 'SSE 订阅');

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
  // 客户端异常断开时 write 失败可能以异步 'error' 事件冒出（ERR_STREAM_DESTROYED 类）；
  // 没有监听器的 'error' 事件会一路冒到进程级 uncaughtException —— 订阅即吞掉，
  // 清理交给上面的 'close'（error 后 close 必然到达）。
  res.on('error', () => {});
}

/**
 * 向指定用户推送事件
 *
 * 事件形状由 `@k/shared/schemas` 的 **SseEvent 判别联合**约束（P2-4.2）：
 * 错字段/错事件类型在构建期失败，契约测试（sse-contract.test.ts）再校验
 * 运行时发出的 payload 与历史 fixture 都可解析。
 *
 * ★ 离线补偿（2026-10-08 起）：没有 `client=android` 在线连接时**同时**转投
 * 一条 OPPO 推送（fire-and-forget，失败只记日志）。判定与语义见文件头说明。
 *
 * @param event 判别联合事件对象（`data:` 行 = JSON.stringify(event)）
 */
export function notifyUser(userId: number, event: SseEvent): void {
  const list = subscribers.get(userId);
  if (!list || list.size === 0) {
    /**
     * 没有任何在线连接 → 转投设备推送（OPPO），由系统推送服务展示。
     *
     * 这条日志仍是排查的关键：它直接区分
     * 「服务端压根没转出去」和「转了、但客户端没弹」——
     * 少了它，两边都会认为是对方的问题。
     */
    logger.info({ userId, type: event.type }, 'SSE 推送时无在线连接（转设备推送）');
    pushFallback(userId, event);
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
  // 有连接但全是"非 Android"（网页端/旧客户端）：手机不在线，补一条设备推送。
  // 反过来，只要有一条 Android 连接（= App 在前台），就只走 SSE、绝不重复提醒。
  if (!hasAndroidConnection(list)) {
    logger.info(
      { userId, type: event.type, connections: list.size },
      'SSE 已送达非 Android 端（补设备推送）'
    );
    pushFallback(userId, event);
    return;
  }
  logger.info({ userId, type: event.type, connections: list.size }, 'SSE 推送完成');
}

/** 该用户的连接集合里是否有原生 Android 连接（见 SseClientKind 的说明） */
function hasAndroidConnection(list: Set<Response>): boolean {
  for (const res of list) {
    if (clientKinds.get(res) === 'android') return true;
  }
  return false;
}

// 私信离线推送的合并窗口在"触发时刻"要复查"人回没回来"（见 push.service 的
// setAndroidOnlineChecker）：事件发生时不在线不代表几秒后还不在线。
// 判定器在这里注入 —— push.service 不能反向 import 本模块（会成环）。
setAndroidOnlineChecker((userId) => {
  const list = subscribers.get(userId);
  return !!list && hasAndroidConnection(list);
});

/**
 * 转投设备推送（fire-and-forget）。
 *
 * 刻意不 await：调用方是消息/评论的请求路径，推送不该拖慢（也不该影响）
 * 接口响应；失败在 push.service 内部已全部转为日志。
 */
function pushFallback(userId: number, event: SseEvent): void {
  void pushForOffline(userId, event).catch((err) => {
    logger.warn(
      { userId, type: event.type, err: err instanceof Error ? err.message : String(err) },
      '设备推送分发异常（已忽略）'
    );
  });
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
  // 全体公告：在线用户已走 SSE，其余（不在线的设备）逐台补推送。
  // 排除"有 Android 在线连接"的用户，避免 App 开着还弹一条同样的通知。
  if (event.type === 'announcement') {
    const androidOnlineUsers = new Set<number>();
    for (const [userId, list] of subscribers) {
      if (hasAndroidConnection(list)) androidOnlineUsers.add(userId);
    }
    void pushAnnouncementToAll(event.announcement_id, androidOnlineUsers).catch((err) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        '全体公告推送分发异常（已忽略）'
      );
    });
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
