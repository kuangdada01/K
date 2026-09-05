/**
 * SSE 实时事件 Hook 测试（useSse）
 * 覆盖：连接前置条件（userId/token）、消息分发、坏消息容错、卸载清理、断线重连
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSse } from './useSse';

/** 可控的 EventSource 替身：记录实例以便测试中手动派发消息/错误 */
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  close() { this.closed = true; }
}

beforeEach(() => {
  vi.stubGlobal('EventSource', MockEventSource);
  MockEventSource.instances = [];
  localStorage.setItem('k_token', 'jwt-token');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
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

  it('带 token 连接 /api/events，消息 JSON 分发给处理器', () => {
    const handler = vi.fn();
    const onEvent = (type: string, data: Record<string, unknown>) => handler(type, data);
    renderHook(() => useSse(1, onEvent));
    const es = MockEventSource.instances[0];
    expect(es.url).toBe('/api/events?token=jwt-token');

    act(() => { es.onmessage?.({ data: JSON.stringify({ type: 'notification', id: 3 }) }); });
    expect(handler).toHaveBeenCalledWith('notification', { type: 'notification', id: 3 });
  });

  it('非 JSON 消息与缺少 type 字段的消息被忽略', () => {
    const handler = vi.fn();
    renderHook(() => useSse(1, handler));
    const es = MockEventSource.instances[0];
    act(() => {
      es.onmessage?.({ data: 'heartbeat' });
      es.onmessage?.({ data: JSON.stringify({ foo: 1 }) });
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('onEvent 回调更新后使用最新引用（ref 同步不丢事件）', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ cb }) => useSse(1, cb), { initialProps: { cb: first } });
    rerender({ cb: second });
    const es = MockEventSource.instances[0];
    act(() => { es.onmessage?.({ data: JSON.stringify({ type: 'message' }) }); });
    expect(second).toHaveBeenCalled();
    expect(first).not.toHaveBeenCalled();
  });

  it('卸载时关闭连接且不再重连', () => {
    const { unmount } = renderHook(() => useSse(1, vi.fn()));
    const es = MockEventSource.instances[0];
    unmount();
    expect(es.closed).toBe(true);
  });

  it('onerror 后 5 秒重连', async () => {
    vi.useFakeTimers();
    renderHook(() => useSse(1, vi.fn()));
    expect(MockEventSource.instances).toHaveLength(1);
    const es = MockEventSource.instances[0];

    act(() => { es.onerror?.(); });
    expect(es.closed).toBe(true);
    expect(MockEventSource.instances).toHaveLength(1); // 立即不重连

    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(MockEventSource.instances).toHaveLength(2); // 重连成功
    expect(MockEventSource.instances[1].url).toBe('/api/events?token=jwt-token');
  });
});
