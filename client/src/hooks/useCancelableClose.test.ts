/**
 * useCancelableClose 行为单测：
 * - requestClose 先延迟 fadeDelayMs 再置 closing（双击窗口内第二下到达前不播动画），
 *   双击窗口 + 余量后执行最终 onClose
 * - 窗口内 cancelClose 撤销：不触发 onClose，closing 复位（动画开始前后均可撤销）
 * - requestClose 幂等（关闭流程中重复调用不重置定时器）
 * - 组件提前卸载清理定时器，绝不延迟回调 onClose
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  useCancelableClose,
  CANCELABLE_CLOSE_KEEP_MS,
  CANCELABLE_CLOSE_FADE_DELAY_MS,
} from './useCancelableClose';

afterEach(() => {
  vi.useRealTimers();
});

describe('useCancelableClose', () => {
  it('requestClose 延迟 fadeDelayMs 置 closing（双击窗口内不播动画），keepMs 后执行 onClose', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { result } = renderHook(() => useCancelableClose(onClose));

    act(() => {
      result.current.requestClose();
    });
    // 动画延迟窗口内：不播淡出（双击第二下到达前无闪烁）
    expect(result.current.closing).toBe(false);

    act(() => {
      vi.advanceTimersByTime(CANCELABLE_CLOSE_FADE_DELAY_MS);
    });
    expect(result.current.closing).toBe(true);

    act(() => {
      vi.advanceTimersByTime(CANCELABLE_CLOSE_KEEP_MS - CANCELABLE_CLOSE_FADE_DELAY_MS);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(result.current.closing).toBe(false);
  });

  it('动画开始前 cancelClose 撤销：不触发 onClose，closing 保持 false', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { result } = renderHook(() => useCancelableClose(onClose));

    act(() => {
      result.current.requestClose();
    });
    expect(result.current.closing).toBe(false);

    act(() => {
      result.current.cancelClose();
    });
    // 窗口期过后也不应触发 onClose（定时器已清除）
    act(() => {
      vi.advanceTimersByTime(CANCELABLE_CLOSE_KEEP_MS * 2);
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(result.current.closing).toBe(false);
  });

  it('动画开始后 cancelClose 撤销：瞬间回弹（closing 复位），仍不触发 onClose', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { result } = renderHook(() => useCancelableClose(onClose));

    act(() => {
      result.current.requestClose();
    });
    act(() => {
      vi.advanceTimersByTime(CANCELABLE_CLOSE_FADE_DELAY_MS + 40); // 淡出进行中
    });
    expect(result.current.closing).toBe(true);

    act(() => {
      result.current.cancelClose();
    });
    expect(result.current.closing).toBe(false);
    act(() => {
      vi.advanceTimersByTime(CANCELABLE_CLOSE_KEEP_MS * 2);
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('requestClose 幂等：关闭流程中重复调用不重置定时器、不提前 onClose', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { result } = renderHook(() => useCancelableClose(onClose));

    act(() => {
      result.current.requestClose();
    });
    act(() => {
      result.current.requestClose();
    });
    act(() => {
      vi.advanceTimersByTime(CANCELABLE_CLOSE_KEEP_MS - 50);
    });
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('卸载兜底：关闭流程中卸载组件后，onClose 永不被延迟触发', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { result, unmount } = renderHook(() => useCancelableClose(onClose));

    act(() => {
      result.current.requestClose();
    });
    unmount();
    act(() => {
      vi.advanceTimersByTime(CANCELABLE_CLOSE_KEEP_MS * 3);
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('cancelClose 在非关闭状态下调用是安全 no-op', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { result } = renderHook(() => useCancelableClose(onClose));

    act(() => {
      result.current.cancelClose();
    });
    expect(result.current.closing).toBe(false);
    act(() => {
      vi.advanceTimersByTime(CANCELABLE_CLOSE_KEEP_MS * 2);
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});
