/**
 * ============================================================
 * 收件箱共享状态（会话列表 + 通知）—— 消除重复轮询（4.3）
 * ============================================================
 * 改前：Sidebar（常驻，30s）与 useConversations（消息页，10s）**各自**请求
 * `/messages/conversations` + `/notifications`，各自维护一份 state；而两者又
 * 都订阅同一条 SSE 连接（`useSse` 是全局单例，同步分发给所有消费方）——
 * 于是每来一条新私信/通知，两侧各刷一次：**一次事件打 4 个请求**。在消息页
 * 停留时两条独立轮询还会撞在同一个 tick 上，而且两个并发请求的响应可能乱序
 * 到达，让旧数据覆盖新数据。角标也因此有两套算法（Sidebar 直接读服务器值 +
 * 自己的 pendingReads，消息列表读合并了本地已清除未读的值），会出现
 * 「列表里清了未读、侧边栏角标却回弹」。
 *
 * 改后：只有这一份状态 + 一个定时器。
 * - `refreshInbox()` **单飞**：在途请求未结束时的重复调用复用同一个 promise。
 *   SSE 是同一 tick 内同步分发的，所以「两个消费方同时被唤醒」天然合并成一次
 *   请求。代价：请求在途期间到达的新数据要等下一个触发（消息页 ≤10s，或下一条
 *   SSE）—— 比改前更保守，改前那种乱序覆盖才是真的会丢更新。
 * - `retainInboxPoll(cadence)` **引用计数**：多个消费方要求不同频率时取最小值，
 *   全部释放后停表。消息页 10s，其他页面 30s。
 * - 未读数的**单一事实来源**：`unreadNotifs`（服务器值 − 乐观已读）+
 *   会话列表（已合并本地已清除未读）。Sidebar 角标与消息列表不再各算一套。
 */

import api from '../api/http';
import type { Conversation, Notification } from '../types';

export interface InboxSnapshot {
  /** 会话列表（已合并「本地已清除未读」） */
  conversations: Conversation[];
  notifications: Notification[];
  /** 未读通知数（已扣除乐观已读，服务器确认前不回弹） */
  unreadNotifs: number;
}

const EMPTY: InboxSnapshot = { conversations: [], notifications: [], unreadNotifs: 0 };

// ---- 模块级状态 ----
/** 服务器返回的原始会话行（未经「本地已清除未读」合并） */
let serverConversations: Conversation[] = [];
let serverNotifications: Notification[] = [];
let serverUnreadNotifs = 0;
/** partner_id → 清除时的 unread_count（服务器对账前压制角标回弹） */
const clearedUnread = new Map<number, number>();
/** 已在本地标记已读、服务器尚未确认的通知条数 */
let pendingNotifReads = 0;
/** 上一次看到的服务器未读数（用于回收 pendingNotifReads） */
let lastServerUnreadNotifs = 0;

let conversationsCache: Conversation[] = EMPTY.conversations;
let notificationsCache: Notification[] = EMPTY.notifications;
let snapshot: InboxSnapshot = EMPTY;
const listeners = new Set<() => void>();
let inFlight: Promise<void> | null = null;

/** 逐字段浅比较（用于保持快照引用稳定，避免无变化时重渲染） */
function sameRow<T extends object>(a: T, b: T): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k]);
}

function sameRows<T extends object>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every((row, i) => sameRow(row, b[i]!));
}

/**
 * 合并「本地已清除未读」：
 * - 服务器仍是旧值（≤ 清除时的值）→ 展示 0，继续压制；
 * - 服务器已清零 → 记录作废；
 * - 服务器值更大（清除后又来了新消息）→ 记录作废，展示新角标。
 */
function mergeConversations(rows: Conversation[]): Conversation[] {
  return rows.map((conv) => {
    const cleared = clearedUnread.get(conv.partner_id);
    if (cleared === undefined) return conv;
    if (conv.unread_count === 0) {
      clearedUnread.delete(conv.partner_id);
      return conv;
    }
    if (conv.unread_count <= cleared) return { ...conv, unread_count: 0 };
    clearedUnread.delete(conv.partner_id);
    return conv;
  });
}

/** 服务器确认了部分已读（未读数下降）→ 回收等量的乐观计数 */
function reconcilePendingReads(): void {
  if (serverUnreadNotifs < lastServerUnreadNotifs) {
    pendingNotifReads = Math.max(0, pendingNotifReads - (lastServerUnreadNotifs - serverUnreadNotifs));
  }
  lastServerUnreadNotifs = serverUnreadNotifs;
}

function publish(): void {
  const merged = mergeConversations(serverConversations);
  if (!sameRows(conversationsCache, merged)) conversationsCache = merged;
  if (!sameRows(notificationsCache, serverNotifications)) notificationsCache = serverNotifications;
  const unreadNotifs = Math.max(0, serverUnreadNotifs - pendingNotifReads);
  if (
    conversationsCache === snapshot.conversations &&
    notificationsCache === snapshot.notifications &&
    unreadNotifs === snapshot.unreadNotifs
  ) {
    return; // 无变化：快照引用不变，订阅者不重渲染
  }
  snapshot = { conversations: conversationsCache, notifications: notificationsCache, unreadNotifs };
  for (const listener of listeners) listener();
}

// ---- 对外：数据 ----

/**
 * 拉取会话 + 通知并更新共享状态。**单飞**：在途期间重复调用复用同一个 promise
 * （SSE 同步分发给多个消费方时，这就是去重的关键）。失败静默保留上一次快照。
 */
export function refreshInbox(): Promise<void> {
  if (inFlight) return inFlight;
  const promise = (async () => {
    try {
      const [convRes, notifRes] = await Promise.all([
        // 后台轮询：失败不重试（下一个 tick 自然会再问一次，见 api/retry.ts）
        api.get('/messages/conversations', { kRetry: false }),
        api.get('/notifications', { kRetry: false }),
      ]);
      serverConversations = (convRes.data.conversations as Conversation[] | undefined) ?? [];
      serverNotifications = (notifRes.data.notifications as Notification[] | undefined) ?? [];
      serverUnreadNotifs = (notifRes.data.unread_count as number | undefined) || 0;
      reconcilePendingReads();
      publish();
    } catch {
      // 轮询/SSE 抖动：保留上一次快照，不要把角标清空
    } finally {
      inFlight = null;
    }
  })();
  inFlight = promise;
  return promise;
}

export function subscribeInbox(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getInboxSnapshot(): InboxSnapshot {
  return snapshot;
}

/** 未读总数（私信 + 通知），Sidebar 角标用 */
export function selectUnreadTotal(snap: InboxSnapshot): number {
  let messages = 0;
  for (const conv of snap.conversations) messages += conv.unread_count;
  return snap.unreadNotifs + messages;
}

// ---- 对外：动作 ----

/** 选中会话：本地立即清该会话未读，并在服务器确认前压制回弹 */
export function clearConversationUnread(partnerId: number, unreadCount: number): void {
  if (unreadCount > 0) clearedUnread.set(partnerId, unreadCount);
  publish();
}

/** 点击通知：本地标记已读（乐观角标，服务器确认后回收） */
export function markNotificationReadLocal(id: number): void {
  const target = serverNotifications.find((n) => n.id === id);
  if (!target || target.read) return;
  serverNotifications = serverNotifications.map((n) => (n.id === id ? { ...n, read: 1 } : n));
  pendingNotifReads += 1;
  publish();
}

// ---- 对外：轮询 ----

const retains = new Map<number, number>();
let retainSeq = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let timerCadence = 0;

function minCadence(): number {
  let min = 0;
  for (const cadence of retains.values()) min = min === 0 ? cadence : Math.min(min, cadence);
  return min;
}

function syncTimer(): void {
  const cadence = minCadence();
  const running = timer !== null;
  if (cadence === timerCadence && running === cadence > 0) return;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  timerCadence = cadence;
  if (cadence > 0) {
    timer = setInterval(() => {
      void refreshInbox();
    }, cadence);
  }
}

/**
 * 注册一个轮询消费方，返回释放函数。
 * 多个消费方要求不同频率时只有**一个**定时器，按最小间隔走；
 * 全部释放后停表（消息页离开后回到 30s，退出登录后不再轮询）。
 */
export function retainInboxPoll(cadenceMs: number): () => void {
  retainSeq += 1;
  const id = retainSeq;
  retains.set(id, cadenceMs);
  syncTimer();
  return () => {
    retains.delete(id);
    syncTimer();
  };
}

/** 仅供测试：清空模块级状态与定时器 */
export function __resetInboxForTests(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  timerCadence = 0;
  retains.clear();
  listeners.clear();
  inFlight = null;
  serverConversations = [];
  serverNotifications = [];
  serverUnreadNotifs = 0;
  pendingNotifReads = 0;
  lastServerUnreadNotifs = 0;
  clearedUnread.clear();
  conversationsCache = EMPTY.conversations;
  notificationsCache = EMPTY.notifications;
  snapshot = EMPTY;
}
