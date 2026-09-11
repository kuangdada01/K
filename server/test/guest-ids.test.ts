/**
 * 访客 id 分配器单元测试（按「连接」发号）
 *
 * 修正的语义（原实现让同一 IP 的所有连接共用一个 id，导致同 IP 的两个访客
 * 在 hub 里互相覆盖、并被「同账号」判定无限互踢 —— 线上事故根因之一）：
 * - 新 IP 从 -1 开始分配，进房顺序即排名
 * - 同一 IP **没有活跃连接**时重进：复用原 id（排名不变）
 * - 同一 IP 的**并发**连接：各自拿到独立 id（互不顶号）
 * - 全部连接退出后 10 分钟释放，期间重连保留
 * - 释放的 id 回空闲池，优先复用最接近 -1 的（排名紧凑）
 * - release 幂等（'error' 与 'close' 双触发安全）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GuestIdAllocator, GUEST_IDLE_MS } from '../src/voice/guest-ids';

describe('GuestIdAllocator（按连接发号的访客 id）', () => {
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
    expect(a.acquire('1.1.1.1').id).toBe(-1);
    expect(a.acquire('2.2.2.2').id).toBe(-2);
    expect(a.acquire('3.3.3.3').id).toBe(-3);
  });

  it('同一 IP 顺序重进（先离开再进）复用原 id，排名不变', () => {
    const first = a.acquire('1.1.1.1');
    expect(first.id).toBe(-1);
    first.release(); // 离开
    // 10 分钟倒计时内重进：仍是 -1
    const again = a.acquire('1.1.1.1');
    expect(again.id).toBe(-1);
    expect(again.extra).toBe(false);
  });

  it('★ 同一 IP 的并发连接拿到【不同】id（旧实现会撞同一个 id → 互踢）', () => {
    const laptop = a.acquire('1.1.1.1'); // 主连接
    const phone = a.acquire('1.1.1.1'); // 同一 WiFi 下的第二条连接
    const anotherTab = a.acquire('1.1.1.1');

    expect(laptop.id).toBe(-1);
    // 关键断言：不再复用 -1，否则两条连接在 hub 里互相覆盖 + 被顶号
    expect(phone.id).not.toBe(laptop.id);
    expect(anotherTab.id).not.toBe(laptop.id);
    expect(anotherTab.id).not.toBe(phone.id);
    expect(phone.extra).toBe(true);
    expect(anotherTab.extra).toBe(true);

    // 三条连接并存：IP 数 1、活跃连接数 3
    expect(a.size).toBe(1);
    expect(a.activeCount).toBe(3);
  });

  it('并发连接逐条释放：仍有连接在线时该 IP 的 id 不会被回收', () => {
    const c1 = a.acquire('1.1.1.1'); // 主 -1
    const c2 = a.acquire('1.1.1.1'); // 额外 -2
    c1.release();
    vi.advanceTimersByTime(GUEST_IDLE_MS * 2);
    // c2 仍在线 → 登记不该被清掉、主 id 也不该被别的 IP 抢走
    expect(a.size).toBe(1);
    expect(a.acquire('9.9.9.9').id).toBe(-3);
    // 同一 IP 的下一条连接立即拿回主 id（不必等 10 分钟倒计时）
    const back = a.acquire('1.1.1.1');
    expect(back.id).toBe(-1);
    expect(back.extra).toBe(false);

    c2.release();
    back.release();
    vi.advanceTimersByTime(GUEST_IDLE_MS - 1);
    // 倒计时内重连：保留原 id
    expect(a.acquire('1.1.1.1').id).toBe(-1);
  });

  it('全部退出后超过 10 分钟：id 释放，可被新 IP 复用', () => {
    const g1 = a.acquire('1.1.1.1'); // -1
    a.acquire('2.2.2.2'); // -2
    g1.release();
    vi.advanceTimersByTime(GUEST_IDLE_MS + 1); // 超时
    // 新 IP 复用释放的 -1（排名紧凑）
    expect(a.acquire('3.3.3.3').id).toBe(-1);
    // -2 仍被 2.2.2.2 在线占用，新 IP 继续往下分配
    expect(a.acquire('4.4.4.4').id).toBe(-3);
    expect(a.size).toBe(3);
  });

  it('额外 id 在释放后立即回收（不等 10 分钟）', () => {
    a.acquire('1.1.1.1'); // -1（主，长期在线）
    const extra = a.acquire('1.1.1.1'); // -2（额外）
    expect(extra.id).toBe(-2);

    extra.release();
    // 立即回收：不需要等 GUEST_IDLE_MS
    expect(a.freeSize).toBe(1);
    // 别的 IP 立刻可以拿到 -2
    expect(a.acquire('9.9.9.9').id).toBe(-2);
  });

  it('空闲池优先复用最接近 -1 的 id', () => {
    const l1 = a.acquire('1.1.1.1'); // -1
    a.acquire('2.2.2.2'); // -2
    const l3 = a.acquire('3.3.3.3'); // -3
    l1.release();
    l3.release();
    vi.advanceTimersByTime(GUEST_IDLE_MS + 1);
    // 池中 [-1, -3]，新 IP 应拿 -1
    expect(a.acquire('9.9.9.9').id).toBe(-1);
    // 再拿 -3
    expect(a.acquire('8.8.8.8').id).toBe(-3);
    // 池空，继续递增新 id
    expect(a.acquire('7.7.7.7').id).toBe(-4);
  });

  it('重复 release 幂等（error 后 close 双触发）', () => {
    const lease = a.acquire('1.1.1.1');
    lease.release();
    lease.release(); // 应被忽略：不报错、不产生负计数、不重复放回空闲池
    expect(a.freeSize).toBe(0); // 仍在 10 分钟倒计时内，尚未入池
    vi.advanceTimersByTime(GUEST_IDLE_MS + 1);
    expect(a.freeSize).toBe(1); // 超时后只入池一次
    expect(a.acquire('2.2.2.2').id).toBe(-1);
  });

  it('并发连接的重复 release 也不会把主 id 提前回收', () => {
    const c1 = a.acquire('1.1.1.1');
    a.acquire('1.1.1.1'); // 第二条并发连接（保持在线，用于验证主 id 不被回收）
    c1.release();
    c1.release(); // 幂等
    // 第二条连接在线 → 登记仍保留，主 id 仍属于本 IP
    expect(a.size).toBe(1);
    const next = a.acquire('1.1.1.1');
    expect(next.id).toBe(-1);
    expect(a.activeCount).toBe(2); // 先到的那条额外连接 + 刚 acquire 的这条
  });

  it('reset 清空全部状态与定时器', () => {
    const lease = a.acquire('1.1.1.1');
    lease.release();
    a.reset();
    expect(a.size).toBe(0);
    expect(a.activeCount).toBe(0);
    expect(a.freeSize).toBe(0);
    // 计时器已被清理：推进时间不应抛错
    vi.advanceTimersByTime(GUEST_IDLE_MS * 2);
    expect(a.size).toBe(0);
  });
});
