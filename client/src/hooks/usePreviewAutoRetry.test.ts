/**
 * 预览转码等待 Hook 测试（usePreviewAutoRetry）
 * 生命周期解耦：等待链只由 waiting 驱动（done→retry / pending→继续轮询）；
 * 中间状态（失败标记翻转、metadata 成功等）不影响链——
 * 只有 waiting=false（canplay 确认可播）或 error/上限/卸载才停链。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePreviewAutoRetry, type TempPreviewStatus } from './usePreviewAutoRetry';

interface State {
  active: boolean;
  waiting: boolean;
  intervalMs?: number;
  maxRetries?: number;
}

/** 状态驱动测试台：update() 模拟 React 渲染（依赖变化 → effect 重跑） */
function setup(initial: State, pollStatus?: () => Promise<TempPreviewStatus>) {
  const state: State = { ...initial };
  const retry = vi.fn();
  const { result, rerender, unmount } = renderHook(
    (props: Pick<State, 'active' | 'waiting' | 'intervalMs' | 'maxRetries'>) =>
      usePreviewAutoRetry({
        ...props,
        retry,
        ...(pollStatus ? { pollStatus } : {}),
      }),
    { initialProps: { ...state } }
  );
  const update = (patch: Partial<State>) => {
    Object.assign(state, patch);
    rerender({ ...state });
  };
  return { retry, update, unmount, result };
}

/** 推进一轮轮询：触发上一轮调度的 timer + flush 微任务（调度下一轮 timer） */
async function advanceOne(ms = 3000) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('usePreviewAutoRetry（轮询状态驱动）', () => {
  it('waiting 期间轮询，done 才触发 retry', async () => {
    let status: TempPreviewStatus = 'pending';
    const pollStatus = vi.fn(() => Promise.resolve(status));
    const { retry } = setup({ active: true, waiting: true, intervalMs: 3000 }, pollStatus);

    await act(async () => {
      await Promise.resolve();
    });
    expect(pollStatus).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();

    // 转码中：持续轮询，不重载
    for (let i = 0; i < 3; i++) {
      await advanceOne(3000);
    }
    expect(retry).not.toHaveBeenCalled();
    expect(pollStatus.mock.calls.length).toBeGreaterThanOrEqual(3);

    // 转码完成：done → retry
    status = 'done';
    await advanceOne(3000);
    expect(retry).toHaveBeenCalledTimes(1);

    // 即使 retry 后失败标记反复翻转（waiting 仍 true）→ 链继续，done 再次 retry
    await advanceOne(3000);
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it('★ 失败信号翻转（metadata 成功清标记等中间状态）不影响等待链', async () => {
    const pollStatus = vi.fn(() => Promise.resolve('pending' as TempPreviewStatus));
    const { retry, update } = setup({ active: true, waiting: true, intervalMs: 1000 }, pollStatus);
    await advanceOne(1000);
    const callsBefore = pollStatus.mock.calls.length;

    // 模拟 video 元素加载触发 metadata 成功等——即使 update 携带任意
    // 其他状态变化（这里以 active 波动模拟），waiting 保持 true 链就不死
    update({ active: true });
    update({ active: true });
    for (let i = 0; i < 5; i++) {
      await advanceOne(1000);
    }
    expect(pollStatus.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(retry).not.toHaveBeenCalled(); // pending 期间不重载
  });

  it('waiting=false（canplay 确认可播）停止轮询', async () => {
    const pollStatus = vi.fn(() => Promise.resolve('pending' as TempPreviewStatus));
    const { update } = setup({ active: true, waiting: true, intervalMs: 1000 }, pollStatus);
    await advanceOne(1000);
    const callsBefore = pollStatus.mock.calls.length;

    update({ waiting: false }); // 可播放：停链
    for (let i = 0; i < 5; i++) {
      await advanceOne(1000);
    }
    expect(pollStatus.mock.calls.length).toBe(callsBefore);
  });

  it('pollStatus 返回 error：停止自动等待（保留手动重试）', async () => {
    const pollStatus = vi.fn(() => Promise.resolve('error' as TempPreviewStatus));
    const { retry } = setup({ active: true, waiting: true, intervalMs: 1000 }, pollStatus);
    await advanceOne(1000);
    for (let i = 0; i < 5; i++) {
      await advanceOne(1000);
    }
    expect(retry).not.toHaveBeenCalled();
    expect(pollStatus).toHaveBeenCalledTimes(1); // 查一次即停
  });

  it('pollStatus 网络异常：按 pending 继续下一轮（不打断链）', async () => {
    const pollStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce('pending' as TempPreviewStatus)
      .mockResolvedValueOnce('done' as TempPreviewStatus);
    const { retry } = setup({ active: true, waiting: true, intervalMs: 1000 }, pollStatus);
    await act(async () => {
      await Promise.resolve(); // flush 初始 poll#1（reject → 调度下一轮）
    });
    await advanceOne(1000); // poll#2（pending，链未被打断）
    expect(pollStatus).toHaveBeenCalledTimes(2); // 立即 1 次 + 本轮 1 次
    await advanceOne(1000); // poll#3（done → retry）
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('达到最大等待次数后停止', async () => {
    const pollStatus = vi.fn(() => Promise.resolve('pending' as TempPreviewStatus));
    const { retry } = setup({ active: true, waiting: true, intervalMs: 1000, maxRetries: 3 }, pollStatus);
    for (let i = 0; i < 20; i++) {
      await advanceOne(1000);
    }
    expect(retry).not.toHaveBeenCalled();
    expect(pollStatus).toHaveBeenCalledTimes(3);
  });

  it('reset() 复位计数：再次等待重新计满上限', async () => {
    const pollStatus = vi.fn(() => Promise.resolve('pending' as TempPreviewStatus));
    const { result, update } = setup(
      { active: true, waiting: true, intervalMs: 1000, maxRetries: 2 },
      pollStatus
    );
    await advanceOne(1000);
    await advanceOne(1000);
    expect(pollStatus).toHaveBeenCalledTimes(2); // 达上限

    act(() => {
      result.current(); // 复位
    });
    update({ waiting: false });
    update({ waiting: true });
    await advanceOne(1000);
    await advanceOne(1000);
    expect(pollStatus).toHaveBeenCalledTimes(4); // 重新获得 2 次
  });

  it('通道未激活（blob 正常）不启动轮询', async () => {
    const pollStatus = vi.fn(() => Promise.resolve('pending' as TempPreviewStatus));
    const { update } = setup({ active: false, waiting: true }, pollStatus);
    for (let i = 0; i < 3; i++) {
      await advanceOne(1000);
    }
    expect(pollStatus).not.toHaveBeenCalled();

    update({ active: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(pollStatus).toHaveBeenCalledTimes(1);
  });

  it('卸载时清理等待链（不泄漏）', async () => {
    const pollStatus = vi.fn(() => Promise.resolve('pending' as TempPreviewStatus));
    const { unmount } = setup({ active: true, waiting: true }, pollStatus);
    act(() => {
      unmount();
    });
    for (let i = 0; i < 3; i++) {
      await advanceOne(1000);
    }
    expect(pollStatus).toHaveBeenCalledTimes(1); // 仅立即查询一次，链已死
  });
});

describe('usePreviewAutoRetry（盲重试降级：无 pollStatus）', () => {
  it('waiting 期间按间隔盲重试，waiting=false 停止', () => {
    const { retry, update } = setup({ active: true, waiting: true, intervalMs: 5000 });
    // 初始进入等待态立即盲重试一次，之后每间隔一次
    expect(retry).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(retry).toHaveBeenCalledTimes(2);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(retry).toHaveBeenCalledTimes(3);

    update({ waiting: false }); // 可播放：停止
    act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(retry).toHaveBeenCalledTimes(3);
  });
});
