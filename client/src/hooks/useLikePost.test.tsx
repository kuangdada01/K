/**
 * 点赞交互 Hook 测试（useLikePost）
 * 覆盖：登录门槛、乐观更新、取消点赞 API 成功后才更新、失败回滚、事件广播
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useLikePost } from './useLikePost';
import { events } from '../state/events';

const mocks = vi.hoisted(() => ({
  openLoginPrompt: vi.fn(),
  likePost: vi.fn(),
  unlikePost: vi.fn(),
  user: null as { id: number; username: string } | null,
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: mocks.user, openLoginPrompt: mocks.openLoginPrompt }),
}));

vi.mock('../api/posts', () => ({
  likePost: mocks.likePost,
  unlikePost: mocks.unlikePost,
}));

type LikeOptions = Parameters<typeof useLikePost>[1];

function setup(initial: { liked: boolean; likeCount: number }, options?: LikeOptions) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useLikePost(1, options), { wrapper });
  // PostCard/PostDetail 在 effect 中把 props 灌入本地 state，这里等价模拟
  act(() => {
    result.current.setLiked(initial.liked);
    result.current.setLikeCount(initial.likeCount);
  });
  return { qc, result };
}

beforeEach(() => {
  mocks.user = { id: 1, username: 'tester' };
  mocks.likePost.mockResolvedValue({ liked: true, like_count: 1 });
  mocks.unlikePost.mockResolvedValue({ liked: false, like_count: 0 });
});

afterEach(() => {
  events.all.clear();
});

describe('useLikePost', () => {
  it('未登录：弹登录提示，不发请求', async () => {
    mocks.user = null;
    const { result } = setup({ liked: false, likeCount: 0 });
    await act(async () => {
      await result.current.toggle();
    });
    expect(mocks.openLoginPrompt).toHaveBeenCalledTimes(1);
    expect(mocks.likePost).not.toHaveBeenCalled();
  });

  it('点赞：乐观更新立即生效，成功后广播事件并回调 onChange/onToggle', async () => {
    const { qc, result } = setup(
      { liked: false, likeCount: 10 },
      {
        onToggle: vi.fn(),
        onChange: vi.fn(),
      }
    );
    const likeHandler = vi.fn();
    events.on('post:like', likeHandler);

    let promise: Promise<void> | undefined;
    act(() => {
      promise = result.current.toggle();
    });
    // 乐观阶段：请求未返回前 UI 已变红
    expect(result.current.liked).toBe(true);
    expect(result.current.likeCount).toBe(11);
    expect(qc.getQueryData(['cache', 'like', 1])).toEqual({ liked: true, likeCount: 11 });

    await act(async () => {
      await promise;
    });
    expect(mocks.likePost).toHaveBeenCalledWith(1);
    expect(likeHandler).toHaveBeenCalledWith({ postId: 1, liked: true, likeCount: 11 });
  });

  it('点赞成功后调用 onToggle 与 onChange 回调', async () => {
    const onToggle = vi.fn();
    const onChange = vi.fn();
    const { result } = setup({ liked: false, likeCount: 0 }, { onToggle, onChange });
    await act(async () => {
      await result.current.toggle();
    });
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(1, true, 1);
  });

  it('取消点赞：API 成功后才更新状态与缓存', async () => {
    const { qc, result } = setup({ liked: true, likeCount: 11 });
    let promise: Promise<void> | undefined;
    act(() => {
      promise = result.current.toggle();
    });
    // 取消点赞无乐观更新：请求期间保持原状态
    expect(result.current.liked).toBe(true);
    expect(qc.getQueryData(['cache', 'like', 1])).toBeUndefined();

    await act(async () => {
      await promise;
    });
    expect(mocks.unlikePost).toHaveBeenCalledWith(1);
    expect(result.current.liked).toBe(false);
    expect(result.current.likeCount).toBe(10);
    expect(qc.getQueryData(['cache', 'like', 1])).toEqual({ liked: false, likeCount: 10 });
  });

  it('点赞失败：回滚乐观状态与缓存', async () => {
    mocks.likePost.mockRejectedValueOnce(new Error('network'));
    const { qc, result } = setup({ liked: false, likeCount: 10 });
    let promise: Promise<void> | undefined;
    act(() => {
      promise = result.current.toggle();
    });
    expect(result.current.liked).toBe(true); // 乐观置位

    await act(async () => {
      await promise;
    });
    expect(result.current.liked).toBe(false);
    expect(result.current.likeCount).toBe(10); // 回到原值
    expect(qc.getQueryData(['cache', 'like', 1])).toEqual({ liked: false, likeCount: 10 });
  });

  it('取消点赞失败：状态不变（本就无乐观更新）', async () => {
    mocks.unlikePost.mockRejectedValueOnce(new Error('network'));
    const { result } = setup({ liked: true, likeCount: 11 });
    await act(async () => {
      await result.current.toggle();
    });
    expect(result.current.liked).toBe(true);
    expect(result.current.likeCount).toBe(11);
  });
});
