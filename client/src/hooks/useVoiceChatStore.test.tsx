/**
 * ============================================================
 * 语音聊天 Store 单测（hooks/useVoiceChatStore.test）
 * ============================================================
 * mock 掉 getVoiceRoomMessages 验证（§3.3）：
 * - 首次进房取最近 50 条、重连按 after_id 游标追赶补拉（100 条）
 * - 实时消息/历史拉取按 id 去重（竞态不重复）
 * - 向上翻页 before_id 前置去重；hasMore/loadingMore 守卫
 * - 房间切换时在途响应丢弃（cancelled 标志）
 * - reset 清空全部聊天状态与游标
 * ============================================================
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useVoiceChatStore } from './useVoiceChatStore';
import { getVoiceRoomMessages } from '../api/voice';
import type { VoiceChatMessage } from '../types';

vi.mock('../api/voice', () => ({
  getVoiceRoomMessages: vi.fn(),
}));

const mockFetch = vi.mocked(getVoiceRoomMessages);

function msg(id: number, content = `m${id}`): VoiceChatMessage {
  return {
    id,
    room_id: 1,
    sender_id: 2,
    username: 'u2',
    avatar: null,
    content,
    created_at: new Date().toISOString(),
  };
}

describe('useVoiceChatStore', () => {
  let resolveFetch: ((v: { messages: VoiceChatMessage[]; has_more: boolean }) => void) | null = null;

  function setup(status: string, activeRoomId: number | null) {
    return renderHook(({ s, r }) => useVoiceChatStore({ status: s as never, activeRoomId: r }), {
      initialProps: { s: status, r: activeRoomId },
    });
  }

  beforeEach(() => {
    resolveFetch = null;
    mockFetch.mockReset();
    // 默认挂起，测试手动 resolve（验证 cancelled/时序）
    mockFetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        })
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('首次进房（connected + roomId）：取最近 50 条并置 hasMore，游标更新', async () => {
    const h = setup('connected', 1);
    expect(mockFetch).toHaveBeenCalledWith(1, { limit: 50 });
    await act(async () => {
      resolveFetch?.({ messages: [msg(1), msg(2)], has_more: true });
    });
    expect(h.result.current.messages.map((m) => m.id)).toEqual([1, 2]);
    expect(h.result.current.chatHasMore).toBe(true);
  });

  it('未连接/无房间：不发请求', () => {
    setup('idle', null);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('断线重连：按已见最大 id 追赶补拉（after_id + limit 100），与既有消息去重', async () => {
    const h = setup('connected', 1);
    await act(async () => {
      resolveFetch?.({ messages: [msg(1), msg(2)], has_more: true });
    });
    mockFetch.mockReset();
    mockFetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        })
    );
    // 重连：status 先回 idle 再回 connected
    act(() => h.rerender({ s: 'idle', r: 1 }));
    act(() => h.rerender({ s: 'connected', r: 1 }));
    expect(mockFetch).toHaveBeenCalledWith(1, { afterId: 2, limit: 100 });
    await act(async () => {
      resolveFetch?.({ messages: [msg(2), msg(3)], has_more: false });
    });
    expect(h.result.current.messages.map((m) => m.id)).toEqual([1, 2, 3]); // 2 不重复
    expect(h.result.current.chatHasMore).toBe(false);
  });

  it('实时消息：按 id 去重追加 + 游标更新 + liveMessage', () => {
    const h = setup('connected', 1);
    act(() => h.result.current.onChatMessage(msg(5)));
    act(() => h.result.current.onChatMessage(msg(5))); // 重复广播
    act(() => h.result.current.onChatMessage(msg(6)));
    expect(h.result.current.messages.map((m) => m.id)).toEqual([5, 6]);
    expect(h.result.current.liveMessage?.id).toBe(6);
    // 重连后游标从 6 开始追赶
    act(() => h.rerender({ s: 'idle', r: 1 }));
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ messages: [], has_more: false });
    act(() => h.rerender({ s: 'connected', r: 1 }));
    expect(mockFetch).toHaveBeenCalledWith(1, { afterId: 6, limit: 100 });
  });

  it('向上翻页：按首条消息 id 前置去重；无更多/加载中/无消息时守卫', async () => {
    const h = setup('connected', 1);
    await act(async () => {
      resolveFetch?.({ messages: [msg(3), msg(4)], has_more: true });
    });
    act(() => h.result.current.loadMoreChat());
    expect(mockFetch).toHaveBeenCalledWith(1, { beforeId: 3, limit: 50 });
    await act(async () => {
      resolveFetch?.({ messages: [msg(1), msg(3)], has_more: false });
    });
    expect(h.result.current.messages.map((m) => m.id)).toEqual([1, 3, 4]); // 3 不重复
    expect(h.result.current.chatHasMore).toBe(false);
    mockFetch.mockClear(); // 清掉前面的历史调用，验证守卫不再发请求
    act(() => h.result.current.loadMoreChat()); // hasMore=false → 守卫
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('房间切换：在途响应被 cancelled 丢弃（不污染新房间消息）', async () => {
    const h = setup('connected', 1);
    // 旧房间（room 1）的请求仍在途（resolveFetch 来自 beforeEach 的挂起实现）
    mockFetch.mockReset();
    mockFetch.mockImplementation(() => new Promise(() => {})); // 新房间请求保持挂起
    act(() => h.rerender({ s: 'connected', r: 2 })); // 换房间 → 旧请求 cancelled
    await act(async () => {
      resolveFetch?.({ messages: [msg(10)], has_more: false }); // 旧响应迟到
    });
    expect(h.result.current.messages).toEqual([]); // 旧响应被丢弃
  });

  it('onChatCleared：清空本地列表与 hasMore（游标保留只追新）', async () => {
    const h = setup('connected', 1);
    await act(async () => {
      resolveFetch?.({ messages: [msg(1)], has_more: true });
    });
    act(() => h.result.current.onChatCleared());
    expect(h.result.current.messages).toEqual([]);
    expect(h.result.current.chatHasMore).toBe(false);
  });

  it('reset：清空全部聊天状态与游标（重连后从零开始取 50 条）', async () => {
    const h = setup('connected', 1);
    await act(async () => {
      resolveFetch?.({ messages: [msg(1)], has_more: true });
    });
    act(() => h.result.current.onChatMessage(msg(2)));
    act(() => h.result.current.reset());
    expect(h.result.current.messages).toEqual([]);
    expect(h.result.current.liveMessage).toBeNull();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ messages: [], has_more: false });
    act(() => h.rerender({ s: 'idle', r: 1 }));
    act(() => h.rerender({ s: 'connected', r: 1 }));
    expect(mockFetch).toHaveBeenCalledWith(1, { limit: 50 }); // 游标已清 → 从头拉
  });
});
