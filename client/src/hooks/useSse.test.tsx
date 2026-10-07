/**
 * SSE 实时事件 Hook 测试（useSse —— 单例连接 + 一次性票据认证）
 * 覆盖：连接前置条件（userId/token）、票据换连接、消息分发、坏消息容错、
 * 回调引用更新、卸载断开、断线指数退避重连、多消费方共享单连接
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSse, __resetSseForTests } from './useSse';

/** 可控的 EventSource 替身：记录实例以便测试中手动派发消息/错误 */
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private listeners = new Map<string, (() => void)[]>();
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, handler: () => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }
  /** 测试辅助：派发自定义事件（如服务端的 kicked 终止事件） */
  dispatch(type: string) {
    for (const h of this.listeners.get(type) ?? []) h();
  }
  close() {
    this.closed = true;
  }
}

beforeEach(() => {
  vi.stubGlobal('EventSource', MockEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ ticket: 'test-ticket' }) }))
  );
  MockEventSource.instances = [];
  localStorage.setItem('k_token', 'jwt-token');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  // 模块级单例（连接/handler/退避链）不靠「用例自己 unmount 成功」来清理：
  // 用例中途失败时那一步不会执行，残留状态会污染后续用例。
  __resetSseForTests();
});

describe('useSse', () => {
  it('userId 为空时不建立连接', () => {
    renderHook(() => useSse(null, vi.fn()));
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it('localStorage 无 token 时不建立连接', () => {
    localStorage.removeItem('k_token');
    renderHook(() => useSse(1, vi.fn()));
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it('先换票据再连接 /api/events?ticket=，消息 JSON 分发给处理器', async () => {
    const handler = vi.fn();
    const { unmount } = renderHook(() => useSse(1, handler));
    await act(async () => {}); // 冲洗票据请求微任务
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0]!.url).toBe('/api/events?ticket=test-ticket');

    act(() => {
      MockEventSource.instances[0]!.onmessage?.({ data: JSON.stringify({ type: 'notification', id: 3 }) });
    });
    expect(handler).toHaveBeenCalledWith('notification', { type: 'notification', id: 3 });
    unmount();
  });

  it('非 JSON 消息与缺少 type 字段的消息被忽略', async () => {
    const handler = vi.fn();
    const { unmount } = renderHook(() => useSse(1, handler));
    await act(async () => {});
    const es = MockEventSource.instances[0]!;
    act(() => {
      es.onmessage?.({ data: 'heartbeat' });
      es.onmessage?.({ data: JSON.stringify({ foo: 1 }) });
    });
    expect(handler).not.toHaveBeenCalled();
    unmount();
  });

  it('onEvent 回调更新后使用最新引用（ref 同步不丢事件）', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender, unmount } = renderHook(({ cb }) => useSse(1, cb), { initialProps: { cb: first } });
    rerender({ cb: second });
    await act(async () => {});
    const es = MockEventSource.instances[0]!;
    act(() => {
      es.onmessage?.({ data: JSON.stringify({ type: 'message' }) });
    });
    expect(second).toHaveBeenCalled();
    expect(first).not.toHaveBeenCalled();
    unmount();
  });

  it('卸载时关闭连接；在途票据请求作废不再建连', async () => {
    const { unmount } = renderHook(() => useSse(1, vi.fn()));
    unmount(); // 票据请求在途时即卸载
    await act(async () => {}); // 票据响应此时到达，但连接已被取消
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it('onerror 后指数退避重连（1s → 2s），重连成功退避复位', async () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useSse(1, vi.fn()));
    await act(async () => {}); // 首连
    expect(MockEventSource.instances).toHaveLength(1);
    const es1 = MockEventSource.instances[0]!;

    act(() => {
      es1.onerror?.();
    });
    expect(es1.closed).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(MockEventSource.instances).toHaveLength(1); // 退避期内不重连

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(MockEventSource.instances).toHaveLength(2); // 1s 后重连
    expect(MockEventSource.instances[1]!.url).toBe('/api/events?ticket=test-ticket');

    // 第二次断线：退避翻倍到 2s
    act(() => {
      MockEventSource.instances[1]!.onerror?.();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1999);
    });
    expect(MockEventSource.instances).toHaveLength(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(MockEventSource.instances).toHaveLength(3);

    // 重连成功（onopen）后退避复位：下一次断线回到 1s
    act(() => {
      MockEventSource.instances[2]!.onopen?.();
      MockEventSource.instances[2]!.onerror?.();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(MockEventSource.instances).toHaveLength(4);
    unmount();
  });

  it('收到 kicked 终止事件后关闭且不安排重连（防 6+ 标签页互踢震荡）', async () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useSse(1, vi.fn()));
    await act(async () => {}); // 首连
    const es = MockEventSource.instances[0]!;

    act(() => {
      es.dispatch('kicked');
    });
    expect(es.closed).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(MockEventSource.instances).toHaveLength(1); // 被踢后不再退避重连
    unmount();
  });

  it('多消费方共享同一条连接（单例），消息广播给所有处理器', async () => {
    const handlerA = vi.fn();
    const handlerB = vi.fn();
    const a = renderHook(() => useSse(1, handlerA));
    const b = renderHook(() => useSse(1, handlerB));
    await act(async () => {});
    expect(MockEventSource.instances).toHaveLength(1); // 单例：只有一条连接

    act(() => {
      MockEventSource.instances[0]!.onmessage?.({ data: JSON.stringify({ type: 'announcement' }) });
    });
    expect(handlerA).toHaveBeenCalled();
    expect(handlerB).toHaveBeenCalled();

    // A 卸载不影响 B；B 卸载（最后一个）才断开
    a.unmount();
    await act(async () => {});
    expect(MockEventSource.instances[0]!.closed).toBe(false);
    b.unmount();
    await act(async () => {});
    expect(MockEventSource.instances[0]!.closed).toBe(true);
  });
});
