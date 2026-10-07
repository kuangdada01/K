/**
 * ============================================================
 * 粉丝/关注弹窗测试（components/profile/FollowersModal）
 * ============================================================
 * 钉住的正是「本地过滤 → 服务端搜索 + 分页」这次改动的契约：
 * - 请求必须带 `page`/`limit`（不带 page 时服务端会退回老形状，分页就没了）
 * - 搜索词防抖后作为 **q 参数**发给服务端，而不是在返回的行里 filter
 * - 「加载更多」按页追加（第二页不能把第一页顶掉）
 * - 只有还有下一页时才显示「加载更多」
 * - 过期响应要被丢弃（慢的旧搜索不能覆盖新结果）
 *
 * 弹窗不走 react-query，所以这里直接 mock api 模块并把 useFollow 需要的
 * QueryClientProvider 包上。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const get = vi.fn();
vi.mock('../../api/http', () => ({
  default: {
    get: (...args: unknown[]) => get(...args),
    post: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../ui/Toast', () => ({ showToast: vi.fn() }));

import FollowersModal from './FollowersModal';

function user(id: number, username: string) {
  return { id, username, avatar: null, bio: '', is_following: 0 };
}

/** 构造响应：page 1 两页、page 2 一页 */
function listResponse(page: number, totalPages = 2) {
  return {
    data: {
      users: page === 1 ? [user(1, 'fan01'), user(2, 'fan02')] : [user(3, 'fan03')],
      total: 3,
      page,
      limit: 20,
      totalPages,
      has_more: page < totalPages,
    },
  };
}

function renderModal(type: 'followers' | 'following' = 'followers') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <FollowersModal type={type} userId={7} onClose={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/** 等首次请求与渲染落地（弹窗内部是 promise 链，用轮询等待而不是固定 sleep） */
async function waitForItems(count: number) {
  for (let i = 0; i < 20; i += 1) {
    if (screen.queryAllByTestId('follower-item').length === count) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  expect(screen.queryAllByTestId('follower-item')).toHaveLength(count);
}

beforeEach(() => {
  get.mockReset();
  get.mockImplementation((_url: string, config?: { params?: { page?: number } }) => {
    const page = config?.params?.page ?? 1;
    return Promise.resolve(listResponse(page));
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('FollowersModal', () => {
  it('★ 首次请求带 page/limit（不带 page 服务端会退回老形状，分页就没了）', async () => {
    renderModal();
    await waitForItems(2);
    expect(get).toHaveBeenCalledWith('/friends/followers/7', {
      params: { page: 1, limit: 20, q: undefined },
    });
  });

  it('渲染返回的行，且此时不带 q', async () => {
    renderModal();
    await waitForItems(2);
    expect(screen.getByText('fan01')).toBeTruthy();
  });

  it('关注列表走 /following 端点', async () => {
    renderModal('following');
    await waitForItems(2);
    expect(get.mock.calls[0]?.[0]).toBe('/friends/following/7');
  });

  it('★ 搜索词防抖后作为 q 参数发给服务端（不是本地过滤）', async () => {
    vi.useFakeTimers();
    renderModal();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(get).toHaveBeenCalledTimes(1);

    // 必须用 fireEvent.change（直接改 input.value + dispatchEvent 不会触发 React 的
    // onChange —— React 的 value tracker 认为值没变，请求根本不会发出）
    fireEvent.change(screen.getByTestId('followers-search'), { target: { value: 'fan03' } });
    // 防抖窗口内不应发请求
    expect(get).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[1]?.[1]).toEqual({ params: { page: 1, limit: 20, q: 'fan03' } });
  });

  it('★ 「加载更多」按页追加，且第二页请求带 page=2', async () => {
    renderModal();
    await waitForItems(2);
    const more = screen.getByTestId('followers-load-more') as HTMLButtonElement;
    await act(async () => {
      more.click();
    });
    await waitForItems(3);
    expect(get.mock.calls[1]?.[1]).toEqual({ params: { page: 2, limit: 20, q: undefined } });
    // 第一页的两行仍在（是追加而不是替换）
    expect(screen.getByText('fan01')).toBeTruthy();
    expect(screen.getByText('fan03')).toBeTruthy();
  });

  it('只有一页时不显示「加载更多」', async () => {
    get.mockImplementation((_url: string, config?: { params?: { page?: number } }) => {
      const page = config?.params?.page ?? 1;
      return Promise.resolve(listResponse(page, 1));
    });
    renderModal();
    await waitForItems(2);
    expect(screen.queryByTestId('followers-load-more')).toBeNull();
  });

  it('★ 过期响应被丢弃：慢的旧搜索不能覆盖新结果', async () => {
    // 第一次（还没输关键词）故意慢；之后带关键词的请求立即返回「新结果」
    let resolveSlow: ((v: unknown) => void) | undefined;
    get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSlow = resolve as (v: unknown) => void;
        })
    );
    get.mockImplementation(() =>
      Promise.resolve({ data: { users: [user(2, 'fresh')], total: 1, page: 1, limit: 20, totalPages: 1 } })
    );

    vi.useFakeTimers();
    renderModal();
    fireEvent.change(screen.getByTestId('followers-search'), { target: { value: 'zzz' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    // 新结果先落地
    expect(screen.getByText('fresh')).toBeTruthy();

    // 现在才让第一次（已过期）的请求返回旧数据 —— 它必须被丢弃
    await act(async () => {
      resolveSlow?.({ data: { users: [user(1, 'stale')], total: 1, page: 1, limit: 20, totalPages: 1 } });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByText('stale')).toBeNull();
    expect(screen.getByText('fresh')).toBeTruthy();
  });
});
