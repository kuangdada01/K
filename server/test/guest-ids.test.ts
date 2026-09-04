/**
 * 访客 id 分配器（IP 绑定式）单元测试
 * - 新 IP 从 -1 开始分配，进房顺序即排名
 * - 同 IP 重进复用原 id（排名不变）
 * - 全部连接退出后 10 分钟释放，期间重连保留
 * - 释放的 id 回空闲池，优先复用最接近 -1 的（排名紧凑）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GuestIdAllocator, GUEST_IDLE_MS } from '../src/voice/guest-ids';

describe('GuestIdAllocator（IP 绑定式访客 id）', () => {
  let a: GuestIdAllocator;

  beforeEach(() => {
    vi.useFakeTimers();
    a = new GuestIdAllocator();
  });

  afterEach(() => {
    a.reset();
    vi.useRealTimers();
  });

  it('新 IP 从 -1 开始按进房顺序分配', () => {
    expect(a.acquire('1.1.1.1')).toEqual({ id: -1, isNew: true });
    expect(a.acquire('2.2.2.2')).toEqual({ id: -2, isNew: true });
    expect(a.acquire('3.3.3.3')).toEqual({ id: -3, isNew: true });
  });

  it('同 IP 重进复用原 id，且不触发释放', () => {
    a.acquire('1.1.1.1');
    const again = a.acquire('1.1.1.1');
    expect(again).toEqual({ id: -1, isNew: false });
  });

  it('多连接引用计数：关一个不释放，全关才进入倒计时', () => {
    a.acquire('1.1.1.1'); // conn=1
    a.acquire('1.1.1.1'); // conn=2
    a.release('1.1.1.1'); // conn=1，未归零
    vi.advanceTimersByTime(GUEST_IDLE_MS * 2);
    // 仍在册（可复用原 id）
    expect(a.acquire('1.1.1.1').id).toBe(-1);
    a.release('1.1.1.1'); // conn=0 → 启动倒计时
    vi.advanceTimersByTime(GUEST_IDLE_MS - 1);
    // 倒计时内重连：保留原 id，取消释放
    expect(a.acquire('1.1.1.1')).toEqual({ id: -1, isNew: false });
  });

  it('全部退出后超过 10 分钟：id 释放，可被新 IP 复用', () => {
    a.acquire('1.1.1.1'); // -1
    a.acquire('2.2.2.2'); // -2
    a.release('1.1.1.1');
    vi.advanceTimersByTime(GUEST_IDLE_MS + 1); // 超时
    // 新 IP 复用释放的 -1（排名紧凑）
    expect(a.acquire('3.3.3.3')).toEqual({ id: -1, isNew: true });
    // -2 仍被 2.2.2.2 在线占用，新 IP 继续往下分配
    expect(a.acquire('4.4.4.4')).toEqual({ id: -3, isNew: true });
    expect(a.size).toBe(3);
  });

  it('空闲池优先复用最接近 -1 的 id', () => {
    a.acquire('1.1.1.1'); // -1
    a.acquire('2.2.2.2'); // -2
    a.acquire('3.3.3.3'); // -3
    a.release('1.1.1.1');
    a.release('3.3.3.3');
    vi.advanceTimersByTime(GUEST_IDLE_MS + 1);
    // 池中 [-1, -3]，新 IP 应拿 -1
    expect(a.acquire('9.9.9.9')).toEqual({ id: -1, isNew: true });
    // 再拿 -3
    expect(a.acquire('8.8.8.8')).toEqual({ id: -3, isNew: true });
    // 池空，继续递增新 id
    expect(a.acquire('7.7.7.7')).toEqual({ id: -4, isNew: true });
  });

  it('重复 release 安全（error 后 close 双触发）', () => {
    a.acquire('1.1.1.1');
    a.release('1.1.1.1');
    a.release('1.1.1.1'); // 应被防御，不报错、不产生负计数
    vi.advanceTimersByTime(GUEST_IDLE_MS + 1);
    expect(a.acquire('2.2.2.2')).toEqual({ id: -1, isNew: true });
  });
});
