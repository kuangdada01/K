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
  CANCELABLE_CLOSE_FADE_DELAY_MS,
  CANCELABLE_CLOSE_FADE_MS,
  CANCELABLE_CLOSE_KEEP_MS,
} from './useCancelableClose';
import { DOUBLE_TAP_MS } from './useImagePinchZoom';

afterEach(() => {
  vi.useRealTimers();
});

describe('关闭时序不变量（防「双击闪烁、漏出下层页面」回归）', () => {
  // 回归背景：淡出曾设为 110ms（早于 300ms 双击窗口）。第一次轻点后遮罩开始
  // 变透明，窗口内第二次轻点撤销时用户看到「遮罩变淡 → 露出下层页面 → 再淡回」。
  it('淡出必须晚于双击判定窗口，撤销路径上才不存在半透明状态', () => {
    expect(CANCELABLE_CLOSE_FADE_DELAY_MS).toBeGreaterThan(DOUBLE_TAP_MS);
  });

  it('卸载等待时长必须容得下「淡出延迟 + 淡出时长」，淡出不会被截断', () => {
    expect(CANCELABLE_CLOSE_KEEP_MS).toBeGreaterThanOrEqual(
      CANCELABLE_CLOSE_FADE_DELAY_MS + CANCELABLE_CLOSE_FADE_MS
    );
  });

  it('卸载等待时长必须 ≥ 双击窗口，否则第二次轻点到达时组件已卸载', () => {
    expect(CANCELABLE_CLOSE_KEEP_MS).toBeGreaterThanOrEqual(DOUBLE_TAP_MS);
  });

  it('整个双击窗口内都不会播淡出（逐点检查）', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { result } = renderHook(() => useCancelableClose(onClose));
    act(() => {
      result.current.requestClose();
    });
    // 从 0 到双击窗口末端，closing 必须始终为 false（遮罩透明度不变）
    for (let t = 0; t <= DOUBLE_TAP_MS; t += 20) {
      act(() => {
        vi.advanceTimersByTime(20);
      });
      expect(result.current.closing, `t=${t}ms 时不应开始淡出`).toBe(false);
    }
    expect(onClose).not.toHaveBeenCalled();
  });
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
