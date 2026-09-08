/**
 * 解码看门狗 Hook 测试（usePreviewDecodeWatchdog）
 * 覆盖：arm 启动超时判定、clear 解除、arm=false 不启动、重复 arm 重启、卸载清理。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePreviewDecodeWatchdog } from './usePreviewDecodeWatchdog';

function setup(initial: { arm: boolean; timeoutMs?: number; restartKey?: unknown }) {
  const onTimeout = vi.fn();
  const { result, rerender, unmount } = renderHook(
    (props: { arm: boolean; timeoutMs?: number; restartKey?: unknown }) =>
      usePreviewDecodeWatchdog({ ...props, onTimeout }),
    { initialProps: initial }
  );
  const update = (patch: Partial<{ arm: boolean; timeoutMs?: number; restartKey?: unknown }>) =>
    rerender({ ...initial, ...patch });
  return { onTimeout, update, unmount, result };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('usePreviewDecodeWatchdog', () => {
  it('armed 时超时触发 onTimeout（解码挂起判定）', () => {
    const { onTimeout } = setup({ arm: true, timeoutMs: 6000 });
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('canplay 确认（clear）解除看门狗，不再触发超时', () => {
    const { onTimeout, result } = setup({ arm: true, timeoutMs: 6000 });
    act(() => {
      result.current(); // 解码器就绪
    });
    act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('未 armed（无 src / 失败面板态）不启动看门狗', () => {
    const { onTimeout } = setup({ arm: false });
    act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('src/key 变化（restartKey 变化）会重启超时窗口', () => {
    const { onTimeout, update } = setup({ arm: true, timeoutMs: 6000, restartKey: 'k1' });
    // 第一次挂载：5s 时（未到 6s）发生 key 变化 → 重启
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    update({ arm: true, restartKey: 'k2' }); // 重新挂载（React key 变化）
    act(() => {
      vi.advanceTimersByTime(5000); // 距重启 5s，仍不到 6s
    });
    expect(onTimeout).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1000); // 距重启满 6s
    });
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('卸载时清理定时器（不泄漏）', () => {
    const { onTimeout, unmount } = setup({ arm: true });
    act(() => {
      unmount();
    });
    act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(onTimeout).not.toHaveBeenCalled();
  });
});