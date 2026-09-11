/**
 * ============================================================
 * 共享收件箱 Hook（useInbox）
 * ============================================================
 * 订阅 `state/inboxStore` 的单份会话/通知状态，并按 `cadenceMs` 参与
 * **合并轮询**（多个消费方只有一个定时器，取最小间隔）。
 *
 * 见 `state/inboxStore.ts` 顶部注释：改前 Sidebar 与消息页各拉一份同样的
 * 两个接口、各自订阅同一条 SSE，一次事件会打 4 个请求。
 */

import { useEffect, useSyncExternalStore } from 'react';
import {
  getInboxSnapshot,
  refreshInbox,
  retainInboxPoll,
  subscribeInbox,
  type InboxSnapshot,
} from '../state/inboxStore';

export function useInbox(cadenceMs: number): InboxSnapshot {
  const snapshot = useSyncExternalStore(subscribeInbox, getInboxSnapshot);

  useEffect(() => {
    // 挂载即拉一次（同一提交内两个消费方同时挂载时会被单飞请求合并）
    void refreshInbox();
    return retainInboxPoll(cadenceMs);
  }, [cadenceMs]);

  return snapshot;
}
