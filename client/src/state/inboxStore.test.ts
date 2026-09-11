/**
 * ============================================================
 * 共享收件箱 store 测试（4.3 合并重复轮询）
 * ============================================================
 * 覆盖:
 * - 单飞：同一 tick 内多次 refresh 只发一次请求（SSE 同步分发给两个消费方
 *   时的去重，此前是一侧一次、一次事件 4 个请求）
 * - 引用计数轮询：多个消费方只有一个定时器、按最小间隔走；全部释放后停表
 * - 未读合并：本地已清除未读在服务器对账前压制回弹；清除后又有新消息则展示新值
 * - 乐观已读：通知已读立刻回落，服务器确认前不被旧快照顶回去
 * - 无变化时不通知订阅者（快照引用稳定 → 不重渲染）
 * - 请求失败保留上一次快照
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('../api/http', () => ({ default: { get: mocks.get } }));

import {
  __resetInboxForTests,
  clearConversationUnread,
  getInboxSnapshot,
  markNotificationReadLocal,
  refreshInbox,
  retainInboxPoll,
  selectUnreadTotal,
  subscribeInbox,
} from './inboxStore';
import type { Conversation, Notification } from '../types';

function conv(partnerId: number, unreadCount: number): Conversation {
  return {
    partner_id: partnerId,
    username: `u${partnerId}`,
    avatar: null,
    last_message: 'hi',
    last_message_at: '2026-09-11T00:00:00.000Z',
    unread_count: unreadCount,
  };
}

function notif(id: number, read = 0): Notification {
  return {
    id,
    user_id: 1,
    type: 'comment',
    from_user_id: 2,
    post_id: 1,
    comment_id: 1,
    content: 'c',
    read,
    created_at: '2026-09-11T00:00:00.000Z',
    from_username: 'u2',
    from_avatar: null,
  };
}

/** 让 mock 的 api.get 按路径返回给定数据 */
function serve(conversations: Conversation[], notifications: Notification[], unreadCount: number) {
  mocks.get.mockImplementation((url: string) =>
    Promise.resolve(
      url === '/messages/conversations'
        ? { data: { conversations } }
        : { data: { notifications, unread_count: unreadCount } }
    )
  );
}

beforeEach(() => {
  __resetInboxForTests();
  mocks.get.mockReset();
  serve([], [], 0);
});

afterEach(() => {
  __resetInboxForTests();
  vi.useRealTimers();
});

describe('refreshInbox 单飞', () => {
  it('同一 tick 内多次调用只发一次请求，且复用同一个 promise', async () => {
    serve([conv(1, 2)], [notif(1)], 1);

    const p1 = refreshInbox();
    const p2 = refreshInbox();
    expect(p2).toBe(p1);

    await p1;
    expect(mocks.get).toHaveBeenCalledTimes(2); // 会话 + 通知各一次
    expect(mocks.get).toHaveBeenCalledWith('/messages/conversations', { kRetry: false });
    expect(mocks.get).toHaveBeenCalledWith('/notifications', { kRetry: false });
  });

  it('请求结束后可以再次刷新', async () => {
    await refreshInbox();
    await refreshInbox();
    expect(mocks.get).toHaveBeenCalledTimes(4);
  });

  it('失败时保留上一次快照（角标不被清空）', async () => {
    serve([conv(1, 3)], [notif(1)], 2);
    await refreshInbox();
    const before = getInboxSnapshot();
    expect(selectUnreadTotal(before)).toBe(5); // 3 条私信 + 2 条通知

    mocks.get.mockRejectedValue(new Error('network'));
    await refreshInbox();

    expect(getInboxSnapshot()).toBe(before);
    expect(selectUnreadTotal(getInboxSnapshot())).toBe(5);
  });
});

describe('未读数合并', () => {
  it('清除会话未读后，服务器仍返回旧值时不回弹', async () => {
    serve([conv(1, 4)], [], 0);
    await refreshInbox();
    expect(selectUnreadTotal(getInboxSnapshot())).toBe(4);

    clearConversationUnread(1, 4);
    expect(selectUnreadTotal(getInboxSnapshot())).toBe(0);

    // 服务器还没跟上（仍是 4）→ 依然是 0
    await refreshInbox();
    expect(selectUnreadTotal(getInboxSnapshot())).toBe(0);
  });

  it('清除后又有新消息（服务器值更大）→ 展示新角标', async () => {
    serve([conv(1, 2)], [], 0);
    await refreshInbox();
    clearConversationUnread(1, 2);
    expect(selectUnreadTotal(getInboxSnapshot())).toBe(0);

    serve([conv(1, 5)], [], 0);
    await refreshInbox();
    expect(selectUnreadTotal(getInboxSnapshot())).toBe(5);
  });

  it('通知已读：乐观回落，服务器未确认前的旧快照不顶回角标', async () => {
    serve([], [notif(1), notif(2)], 2);
    await refreshInbox();
    expect(selectUnreadTotal(getInboxSnapshot())).toBe(2);

    markNotificationReadLocal(1);
    expect(selectUnreadTotal(getInboxSnapshot())).toBe(1);
    expect(getInboxSnapshot().notifications.find((n) => n.id === 1)?.read).toBe(1);

    // 服务器仍返回 2 → 乐观计数抵消，角标保持在 1
    await refreshInbox();
    expect(selectUnreadTotal(getInboxSnapshot())).toBe(1);

    // 服务器确认（降到 1）→ 乐观计数回收，角标仍为 1
    serve([], [notif(1, 1), notif(2)], 1);
    await refreshInbox();
    expect(selectUnreadTotal(getInboxSnapshot())).toBe(1);

    // 再标一条已读 → 0
    markNotificationReadLocal(2);
    expect(selectUnreadTotal(getInboxSnapshot())).toBe(0);
  });

  it('已读的通知重复点击不会重复扣减', async () => {
    serve([], [notif(1, 1)], 0);
    await refreshInbox();
    markNotificationReadLocal(1);
    markNotificationReadLocal(1);
    expect(selectUnreadTotal(getInboxSnapshot())).toBe(0);
    expect(getInboxSnapshot().unreadNotifs).toBe(0);
  });
});

describe('订阅通知', () => {
  it('数据无变化时不通知订阅者（快照引用不变）', async () => {
    serve([conv(1, 1)], [notif(1)], 1);
    const listener = vi.fn();
    subscribeInbox(listener);

    await refreshInbox();
    expect(listener).toHaveBeenCalledTimes(1);
    const after1 = getInboxSnapshot();

    await refreshInbox();
    expect(getInboxSnapshot()).toBe(after1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('有变化时通知一次，且快照引用变化', async () => {
    const listener = vi.fn();
    subscribeInbox(listener);

    serve([conv(1, 1)], [], 0);
    await refreshInbox();
    const first = getInboxSnapshot();
    expect(listener).toHaveBeenCalledTimes(1);

    serve([conv(1, 2)], [], 0);
    await refreshInbox();
    expect(getInboxSnapshot()).not.toBe(first);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('引用计数轮询', () => {
  it('两个消费方只有一个定时器，按最小间隔走；释放后恢复较慢的间隔', async () => {
    vi.useFakeTimers();
    const releaseSlow = retainInboxPoll(30000);
    const releaseFast = retainInboxPoll(10000);

    await vi.advanceTimersByTimeAsync(10000);
    expect(mocks.get).toHaveBeenCalledTimes(2); // 只按 10s 走了一次刷新

    await vi.advanceTimersByTimeAsync(10000);
    expect(mocks.get).toHaveBeenCalledTimes(4);

    // 释放 10s 消费方（消息页离开）→ 回到 30s
    releaseFast();
    await vi.advanceTimersByTimeAsync(20000);
    expect(mocks.get).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(10000);
    expect(mocks.get).toHaveBeenCalledTimes(6);

    // 全部释放 → 停表
    releaseSlow();
    await vi.advanceTimersByTimeAsync(120000);
    expect(mocks.get).toHaveBeenCalledTimes(6);
  });

  it('定时器不重复创建：重复 retain 同一间隔仍是单一节奏', async () => {
    vi.useFakeTimers();
    const releaseA = retainInboxPoll(10000);
    const releaseB = retainInboxPoll(10000);

    await vi.advanceTimersByTimeAsync(10000);
    expect(mocks.get).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(10000);
    expect(mocks.get).toHaveBeenCalledTimes(4);

    releaseA();
    releaseB();
  });
});
