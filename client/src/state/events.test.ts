/**
 * 全局事件总线测试（state/events）
 * 验证 mitt 封装：类型化订阅、广播、退订、通配符
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { events } from './events';

afterEach(() => {
  events.all.clear();
});

describe('events（mitt 事件总线）', () => {
  it('订阅后收到广播的类型化 payload', () => {
    const handler = vi.fn();
    events.on('post:like', handler);
    events.emit('post:like', { postId: 1, liked: true, likeCount: 3 });
    expect(handler).toHaveBeenCalledWith({ postId: 1, liked: true, likeCount: 3 });
  });

  it('off 退订后不再接收', () => {
    const handler = vi.fn();
    events.on('follow:changed', handler);
    events.off('follow:changed', handler);
    events.emit('follow:changed', 42);
    expect(handler).not.toHaveBeenCalled();
  });

  it('通配符订阅收到所有事件', () => {
    const handler = vi.fn();
    events.on('*', handler);
    events.emit('post:created', undefined);
    events.emit('badge:changed', { source: 'notif', count: 1 });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('同一事件可注册多个处理器', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    events.on('post:comment', h1);
    events.on('post:comment', h2);
    events.emit('post:comment', { postId: 7, commentCount: 1 });
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it('无订阅者时 emit 不抛错', () => {
    expect(() => events.emit('music:pause', undefined)).not.toThrow();
  });
});
