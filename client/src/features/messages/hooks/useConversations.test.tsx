/**
 * ============================================================
 * 会话 Hook 与侧边栏共用一份收件箱状态（4.3）
 * ============================================================
 * 覆盖:
 * - 两个消费方（Sidebar 的 useInbox + 消息页的 useConversations）同时挂载时，
 *   同一提交内的刷新被单飞合并 → 只打 2 个请求（会话 + 通知），
 *   改前是各打一套（4 个）
 * - 数据同源：在消息页清掉某会话未读后，Sidebar 的角标随之变化
 *   （改前两套算法会不一致）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('../../../api/http', () => ({ default: { get: mocks.get } }));

import { useInbox } from '../../../hooks/useInbox';
import { useConversations } from './useConversations';
import { __resetInboxForTests, selectUnreadTotal } from '../../../state/inboxStore';
import type { Conversation, Notification } from '../../../types';

const row: Conversation = {
  partner_id: 7,
  username: 'partner',
  avatar: null,
  last_message: 'hi',
  last_message_at: '2026-09-11T00:00:00.000Z',
  unread_count: 3,
};

const notice: Notification = {
  id: 1,
  user_id: 1,
  type: 'comment',
  from_user_id: 2,
  post_id: 1,
  comment_id: 1,
  content: 'c',
  read: 0,
  created_at: '2026-09-11T00:00:00.000Z',
  from_username: 'u2',
  from_avatar: null,
};

function serve() {
  mocks.get.mockImplementation((url: string) =>
    Promise.resolve(
      url === '/messages/conversations'
        ? { data: { conversations: [row] } }
        : { data: { notifications: [notice], unread_count: 2 } }
    )
  );
}

beforeEach(() => {
  __resetInboxForTests();
  mocks.get.mockReset();
  serve();
});

afterEach(() => {
  __resetInboxForTests();
});

describe('Sidebar 与消息页共用收件箱', () => {
  it('两个消费方同时挂载只打一次「两个接口」', async () => {
    const { result } = renderHook(() => ({
      sidebar: useInbox(30000),
      messages: useConversations(),
    }));

    await waitFor(() => {
      expect(result.current.sidebar.conversations).toHaveLength(1);
    });

    // 会话 + 通知，各一次（改前两个 Hook 各打一套 = 4 次）
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it('消息页清掉会话未读后，侧边栏角标同源变化', async () => {
    const { result } = renderHook(() => ({
      sidebar: useInbox(30000),
      messages: useConversations(),
    }));

    await waitFor(() => {
      expect(selectUnreadTotal(result.current.sidebar)).toBe(5); // 3 条私信 + 2 条通知
    });

    act(() => {
      result.current.messages.clearLocalUnread(row);
    });

    expect(selectUnreadTotal(result.current.sidebar)).toBe(2); // 只剩通知
    expect(result.current.messages.conversations[0]?.unread_count).toBe(0);
    // 同一份状态：两个消费方拿到的是同一个数组引用（不是各自算出来的副本）
    expect(result.current.messages.conversations).toBe(result.current.sidebar.conversations);
  });
});
