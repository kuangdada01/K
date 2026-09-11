/**
 * ============================================================
 * 语音每 IP 并发上限单测（voice/ip-connections —— P2-29）
 * ============================================================
 * 为什么这两道闸门必须存在：在「访客 id 按连接发号」（第 7 章 P0）之前，
 * 同 IP 的访客共用一个负数 id、在 hub 里会塌缩成一个成员，无意中限制了同 IP 占用；
 * 修复之后一个 IP 开 10 个标签页就能占满一个房间，不入房的连接更是完全无上限。
 *
 * 覆盖:
 * - 访客上限 = 房间上限（一个 IP 最多占满一个房间的访客席位）
 * - 总连接上限（含已登录连接）
 * - 两类计数互不混淆（已认证连接不吃访客名额）
 * - release 幂等、归零后清理、按 IP 隔离
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  tryAcquire,
  release,
  countFor,
  ipCount,
  reset,
  MAX_VOICE_CONNECTIONS_PER_IP,
  MAX_VOICE_GUEST_CONNECTIONS_PER_IP,
} from '../src/voice/ip-connections';
import { VOICE_MAX_ROOM_SIZE } from '@k/shared';

const IP = '203.0.113.9';
const OTHER = '198.51.100.7';

beforeEach(() => {
  reset();
});

describe('访客上限', () => {
  it('访客上限等于房间上限（一个 IP 最多占满一个房间的访客席位）', () => {
    expect(MAX_VOICE_GUEST_CONNECTIONS_PER_IP).toBe(VOICE_MAX_ROOM_SIZE);
  });

  it('占满房间席位后拒绝新的访客连接', () => {
    for (let i = 0; i < MAX_VOICE_GUEST_CONNECTIONS_PER_IP; i++) {
      expect(tryAcquire(IP, 'guest'), `第 ${i + 1} 条访客连接应被接受`).toBe(true);
    }
    expect(tryAcquire(IP, 'guest')).toBe(false);
    expect(countFor(IP)).toEqual({
      total: MAX_VOICE_GUEST_CONNECTIONS_PER_IP,
      guests: MAX_VOICE_GUEST_CONNECTIONS_PER_IP,
    });
  });

  it('已认证连接不占用访客名额（NAT 后多人登录不受访客上限影响）', () => {
    for (let i = 0; i < MAX_VOICE_GUEST_CONNECTIONS_PER_IP; i++) tryAcquire(IP, 'authenticated');
    // 访客名额仍是满的（0 个访客），所以访客连接照样可以进
    expect(countFor(IP).guests).toBe(0);
    expect(tryAcquire(IP, 'guest')).toBe(true);
  });
});

describe('总连接上限', () => {
  it('达到总上限后拒绝任何新连接（含已认证）', () => {
    for (let i = 0; i < MAX_VOICE_CONNECTIONS_PER_IP; i++) {
      expect(tryAcquire(IP, 'authenticated')).toBe(true);
    }
    expect(tryAcquire(IP, 'authenticated')).toBe(false);
    expect(tryAcquire(IP, 'guest')).toBe(false);
  });

  it('总上限明显高于访客上限（NAT 场景留出空间）', () => {
    expect(MAX_VOICE_CONNECTIONS_PER_IP).toBeGreaterThan(MAX_VOICE_GUEST_CONNECTIONS_PER_IP);
  });
});

describe('释放与隔离', () => {
  it('release 归还席位后可再次接入', () => {
    for (let i = 0; i < MAX_VOICE_GUEST_CONNECTIONS_PER_IP; i++) tryAcquire(IP, 'guest');
    expect(tryAcquire(IP, 'guest')).toBe(false);

    release(IP, 'guest');
    expect(countFor(IP).guests).toBe(MAX_VOICE_GUEST_CONNECTIONS_PER_IP - 1);
    expect(tryAcquire(IP, 'guest')).toBe(true);
  });

  it('release 幂等：多调不会把计数减成负数', () => {
    tryAcquire(IP, 'guest');
    release(IP, 'guest');
    release(IP, 'guest');
    release(IP, 'guest');
    expect(countFor(IP)).toEqual({ total: 0, guests: 0 });
  });

  it('未登记过的 IP 调 release 不报错', () => {
    expect(() => release('10.0.0.1', 'guest')).not.toThrow();
    expect(countFor('10.0.0.1')).toEqual({ total: 0, guests: 0 });
  });

  it('归零后该 IP 从表里移除（长跑进程不会无限累积 key）', () => {
    tryAcquire(IP, 'guest');
    expect(ipCount()).toBe(1);
    release(IP, 'guest');
    expect(ipCount()).toBe(0);
  });

  it('按 IP 隔离：一个 IP 到顶不影响另一个 IP', () => {
    for (let i = 0; i < MAX_VOICE_GUEST_CONNECTIONS_PER_IP; i++) tryAcquire(IP, 'guest');
    expect(tryAcquire(IP, 'guest')).toBe(false);
    expect(tryAcquire(OTHER, 'guest')).toBe(true);
    expect(countFor(OTHER)).toEqual({ total: 1, guests: 1 });
  });

  it('访客与已认证混合计数：总数与访客数各自准确', () => {
    tryAcquire(IP, 'guest');
    tryAcquire(IP, 'authenticated');
    tryAcquire(IP, 'guest');
    expect(countFor(IP)).toEqual({ total: 3, guests: 2 });

    release(IP, 'authenticated');
    expect(countFor(IP)).toEqual({ total: 2, guests: 2 });
    release(IP, 'guest');
    expect(countFor(IP)).toEqual({ total: 1, guests: 1 });
  });
});
