/**
 * 帖子详情数据层 Hook 测试（usePostDetailData，C1 迁 React Query 后）
 *
 * 覆盖：
 * - 首次打开拉取并播种本地状态（post/comments/分享/关注回填）
 * - ★ 30s 内重开同一帖命中缓存：getPost 只调用一次（C1 的核心收益）
 * - 过期后重开重新拉取（staleTime 之外不吞请求）
 * - 高亮变体与普通打开是不同的 key（全量 vs 分页，各拉各的）
 * - 拉取失败 → loadError
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { usePostDetailData } from './usePostDetailData';

const mocks = vi.hoisted(() => ({
  getPost: vi.fn(),
  apiGet: vi.fn(),
}));

vi.mock('../api/posts', () => ({
  getPost: mocks.getPost,
}));

vi.mock('../api/http', () => ({
  default: { get: mocks.apiGet },
}));

/** 构造 getPost 响应（形状与 postsApi.getPost 一致的必要子集） */
function makeResponse(id: number) {
  return {
    post: {
      id,
      user_id: 2,
      liked: 0,
      like_count: 5,
      share_count: 1,
      shared: 0,
      bookmarked: 0,
      reposted: 0,
      repost_count: 0,
    },
    comments: [],
    comments_has_more: false,
    comments_total: 0,
  };
}

function setup(overrides: Partial<Parameters<typeof usePostDetailData>[0]> = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const noop = vi.fn();
  const defaults = {
    postId: 1,
    userId: 1,
    highlightCommentId: null,
    getFollowStatus: () => undefined as boolean | undefined,
    setFollowStatus: noop,
    getLikeInfo: () => undefined,
    getBookmarked: () => undefined as boolean | undefined,
    getReposted: () => undefined as boolean | undefined,
    setLiked: noop,
    setLikeCount: noop,
    setBookmarked: noop,
    setReposted: noop,
    setRepostCount: noop,
    onHighlight: noop,
    ...overrides,
  };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper, defaults };
}

beforeEach(() => {
  mocks.apiGet.mockResolvedValue({ data: { is_following: false } });
});

describe('usePostDetailData', () => {
  it('首次打开：拉取并播种（post 落地、分享数回填）', async () => {
    mocks.getPost.mockResolvedValue(makeResponse(1));
    const { wrapper, defaults } = setup();
    const { result } = renderHook((props) => usePostDetailData(props), {
      wrapper,
      initialProps: defaults,
    });

    await waitFor(() => expect(result.current.post).not.toBeNull());
    expect(result.current.post?.id).toBe(1);
    expect(result.current.shareCount).toBe(1);
    expect(mocks.getPost).toHaveBeenCalledTimes(1);
  });

  it('★ 30s 内关闭再重开同一帖：命中缓存，getPost 仍只有一次', async () => {
    mocks.getPost.mockResolvedValue(makeResponse(1));
    const { wrapper, defaults } = setup();

    // 第一次打开（PostDetail 卸载 = unmount；queryClient 保留缓存）
    const first = renderHook((props) => usePostDetailData(props), {
      wrapper,
      initialProps: defaults,
    });
    await waitFor(() => expect(first.result.current.post).not.toBeNull());
    first.unmount();
    expect(mocks.getPost).toHaveBeenCalledTimes(1);

    // 第二次打开（同一 queryClient → 同一缓存树）：缓存命中时 data 首帧就在，
    // 播种经微任务落地（无网络等待）
    const second = renderHook((props) => usePostDetailData(props), {
      wrapper,
      initialProps: defaults,
    });
    await waitFor(() => expect(second.result.current.post).not.toBeNull());
    expect(second.result.current.post?.id).toBe(1);
    expect(mocks.getPost).toHaveBeenCalledTimes(1); // 关键断言：没有第二次网络请求
  });

  it('超过 staleTime 后重开：重新拉取（第二次 getPost）', async () => {
    vi.useFakeTimers();
    try {
      mocks.getPost.mockResolvedValue(makeResponse(1));
      const { wrapper, defaults } = setup();
      const first = renderHook((props) => usePostDetailData(props), {
        wrapper,
        initialProps: defaults,
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      first.unmount();
      expect(mocks.getPost).toHaveBeenCalledTimes(1);

      // 推进 31s：缓存过期
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000);
      });
      renderHook((props) => usePostDetailData(props), { wrapper, initialProps: defaults });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(mocks.getPost).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('高亮打开与普通打开是不同 key（各自拉取，缓存互不命中）', async () => {
    mocks.getPost.mockResolvedValue(makeResponse(1));
    const { wrapper, defaults } = setup();
    const first = renderHook((props) => usePostDetailData(props), {
      wrapper,
      initialProps: defaults,
    });
    await waitFor(() => expect(first.result.current.post).not.toBeNull());
    expect(mocks.getPost).toHaveBeenCalledTimes(1);
    expect(mocks.getPost).toHaveBeenLastCalledWith(1, { commentLimit: 10 });

    // 带 highlightCommentId 打开同一帖：全量变体，独立请求
    first.rerender({ ...defaults, highlightCommentId: 7 });
    await waitFor(() => expect(mocks.getPost).toHaveBeenCalledTimes(2));
    expect(mocks.getPost).toHaveBeenLastCalledWith(1, undefined);
  });

  it('拉取失败 → loadError 为真', async () => {
    mocks.getPost.mockRejectedValue(new Error('network'));
    const { wrapper, defaults } = setup();
    const { result } = renderHook((props) => usePostDetailData(props), {
      wrapper,
      initialProps: defaults,
    });
    await waitFor(() => expect(result.current.loadError).toBe(true));
  });
});
