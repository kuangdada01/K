/**
 * 关注操作 Hook 测试（useFollowUser）
 * 覆盖：登录门槛、关注/取关的 API 调用 + 缓存同步 + 事件广播
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useFollowUser } from './useFollowUser';
import { events } from '../state/events';

const mocks = vi.hoisted(() => ({
  openLoginPrompt: vi.fn(),
  follow: vi.fn(),
  unfollow: vi.fn(),
  user: null as { id: number; username: string } | null,
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: mocks.user, openLoginPrompt: mocks.openLoginPrompt }),
}));

vi.mock('../api/friends', () => ({
  follow: mocks.follow,
  unfollow: mocks.unfollow,
}));

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, ...renderHook(() => useFollowUser(), { wrapper }) };
}

beforeEach(() => {
  mocks.user = { id: 1, username: 'tester' };
  mocks.follow.mockResolvedValue({ is_following: true, followers_count: 9 });
  mocks.unfollow.mockResolvedValue({ is_following: false, followers_count: 8 });
});

afterEach(() => {
  events.all.clear();
});

describe('useFollowUser', () => {
  it('requireLogin：未登录弹登录提示并返回 false', () => {
    mocks.user = null;
    const { result } = setup();
    let ok: boolean | undefined;
    act(() => { ok = result.current.requireLogin(); });
    expect(ok).toBe(false);
    expect(mocks.openLoginPrompt).toHaveBeenCalledTimes(1);
  });

  it('requireLogin：已登录返回 true 且不弹窗', () => {
    const { result } = setup();
    let ok: boolean | undefined;
    act(() => { ok = result.current.requireLogin(); });
    expect(ok).toBe(true);
    expect(mocks.openLoginPrompt).not.toHaveBeenCalled();
  });

  it('follow：调用 API、写入关注缓存、广播事件、返回粉丝数', async () => {
    const { qc, result } = setup();
    const handler = vi.fn();
    events.on('follow:changed', handler);
    let res: { is_following: boolean; followers_count: number } | undefined;
    await act(async () => { res = await result.current.follow(7); });
    expect(mocks.follow).toHaveBeenCalledWith(7);
    expect(qc.getQueryData(['cache', 'follow', 7])).toBe(true);
    expect(handler).toHaveBeenCalledWith(7);
    expect(res).toEqual({ is_following: true, followers_count: 9 });
  });

  it('unfollow：调用 API、清除关注缓存、广播事件', async () => {
    const { qc, result } = setup();
    qc.setQueryData(['cache', 'follow', 7], true); // 预置已关注
    const handler = vi.fn();
    events.on('follow:changed', handler);
    await act(async () => { await result.current.unfollow(7); });
    expect(mocks.unfollow).toHaveBeenCalledWith(7);
    expect(qc.getQueryData(['cache', 'follow', 7])).toBe(false);
    expect(handler).toHaveBeenCalledWith(7);
  });

  it('notifyChanged：只广播事件不调 API', () => {
    const { result } = setup();
    const handler = vi.fn();
    events.on('follow:changed', handler);
    result.current.notifyChanged(5);
    expect(handler).toHaveBeenCalledWith(5);
    expect(mocks.follow).not.toHaveBeenCalled();
    expect(mocks.unfollow).not.toHaveBeenCalled();
  });
});
