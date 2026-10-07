/**
 * ============================================================
 * 语音会话控制器 Hook 测试（useVoiceSessionController）
 * ============================================================
 * 锁死 2026-09 线上事故的两个**客户端**成因（服务端修复见 voice-guest.test.ts）：
 *
 * 1) 登录过期时静默退房：语音 WS 在 token 还有效时建连，服务端不会因 token 过期断它，
 *    于是客户端只是悄悄 leave()，用户只知道「突然被踢出房间」；再点加入还会以访客身份
 *    进房（同 IP 撞 id → 被自己另一条连接顶掉）。现在必须给出明确提示。
 * 2) 会话终结后 sessionRef 不清空：被踢/房间关闭后 join() 开头的
 *    `if (sessionRef.current) return` 让「重新加入」变成静默空操作。
 *
 * 另覆盖：访客会话不因 user=null 被踢、主动登出退房但不弹过期提示、卸载时释放会话。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVoiceSessionController } from './useVoiceSessionController';
import type { SessionChatActions } from './useVoiceSessionController';

/** 假会话的最小形状（只覆盖控制器实际用到的成员；类型仅供测试内断言使用） */
interface FakeSession {
  self: { userId: number; username: string; avatar: string | null };
  cb: {
    onStatus: (s: string, detail?: string) => void;
  };
  joined: number[];
  leaveCalls: number;
}

/** 提升到模块顶部：vi.mock 工厂函数会被提升，不能直接闭包引用普通变量 */
const h = vi.hoisted(() => ({
  sessions: [] as FakeSession[],
  showToast: vi.fn(),
}));

vi.mock('../voice/VoiceSession', () => {
  class FakeVoiceSession {
    self: FakeSession['self'];
    cb: FakeSession['cb'];
    joined: number[] = [];
    leaveCalls = 0;
    constructor(self: FakeSession['self'], cb: FakeSession['cb']) {
      this.self = self;
      this.cb = cb;
      h.sessions.push(this);
    }
    join(roomId: number): Promise<void> {
      this.joined.push(roomId);
      return Promise.resolve();
    }
    leave(): void {
      this.leaveCalls += 1;
    }
    getShareQuality(): string {
      return '1080p60';
    }
    getShareSharpText(): boolean {
      return false;
    }
    getShareMuted(): boolean {
      return true;
    }
  }
  return {
    VoiceSession: FakeVoiceSession,
    NOISE_REDUCTION_KEY: 'voice:noiseReduction',
    MUSIC_MODE_KEY: 'voice:musicMode',
  };
});

vi.mock('../components/ui/Toast', () => ({ showToast: h.showToast }));

const chatReset = vi.fn();
/** 稳定的 chatActions 工厂（引用不变 → 不会让依赖它的 effect 反复重跑） */
const chatActions = (): SessionChatActions => ({
  onChatMessage: vi.fn(),
  onChatCleared: vi.fn(),
  reset: chatReset,
});

const USER = { id: 7, username: 'alice', avatar: null };
const EXPIRED_TOAST = '登录已过期，请重新登录后再加入语音';

beforeEach(() => {
  h.sessions = [];
  h.showToast.mockClear();
  chatReset.mockClear();
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useVoiceSessionController：登录过期（P1-1）', () => {
  it('★ 已登录会话收到 auth:expired 后：弹提示 + 退房（不再静默被踢）', () => {
    const { result, rerender } = renderHook(({ u }) => useVoiceSessionController(u, chatActions), {
      initialProps: { u: USER as typeof USER | null },
    });
    act(() => result.current.join(1));
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]!.self.userId).toBe(USER.id);

    // 401 拦截器派发 token 过期事件，随后 AuthContext 把 user 置空
    act(() => {
      window.dispatchEvent(new CustomEvent('auth:expired'));
    });
    rerender({ u: null });

    expect(h.showToast).toHaveBeenCalledWith(EXPIRED_TOAST);
    expect(h.sessions[0]!.leaveCalls).toBe(1);
    // 提示只弹一次，不会随重渲染重复弹
    act(() => {
      window.dispatchEvent(new CustomEvent('auth:expired'));
    });
    expect(h.showToast).toHaveBeenCalledTimes(1);
  });

  it('主动登出（无 auth:expired）只退房、不弹过期提示', () => {
    const { result, rerender } = renderHook(({ u }) => useVoiceSessionController(u, chatActions), {
      initialProps: { u: USER as typeof USER | null },
    });
    act(() => result.current.join(1));
    rerender({ u: null });

    expect(h.sessions[0]!.leaveCalls).toBe(1);
    expect(h.showToast).not.toHaveBeenCalled();
  });

  it('访客会话（user 始终为 null）不会被登出逻辑踢出、也不弹提示', () => {
    const { result, rerender } = renderHook(({ u }) => useVoiceSessionController(u, chatActions), {
      initialProps: { u: null as typeof USER | null },
    });
    act(() => result.current.join(1));
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]!.self.username).toBe('未登录');

    rerender({ u: null });
    expect(h.sessions[0]!.leaveCalls).toBe(0);
    expect(h.showToast).not.toHaveBeenCalled();
  });
});

describe('useVoiceSessionController：会话终结后重新进房（P2-1）', () => {
  it('★ 会话 ended（被踢/房间关闭）后可再次 join，不再是静默空操作', () => {
    const { result } = renderHook(() => useVoiceSessionController(USER, chatActions));
    act(() => result.current.join(1));
    expect(h.sessions).toHaveLength(1);

    // 会话未终结时重复进房仍被忽略（防止重复建连）
    act(() => result.current.join(2));
    expect(h.sessions).toHaveLength(1);

    // 服务端踢出 → 状态终结
    act(() => h.sessions[0]!.cb.onStatus('ended'));

    act(() => result.current.join(2));
    expect(h.sessions).toHaveLength(2);
    expect(h.sessions[1]!.joined).toEqual([2]);
  });

  it('ended 只清掉自身引用，不会误清此后新建的会话', () => {
    const { result } = renderHook(() => useVoiceSessionController(USER, chatActions));
    act(() => result.current.join(1));
    const first = h.sessions[0]!;

    act(() => first.cb.onStatus('ended'));
    act(() => result.current.join(3));
    const second = h.sessions[1]!;

    // 旧会话迟到的 ended 回调不应把新会话的引用清掉
    act(() => first.cb.onStatus('ended'));
    act(() => result.current.join(4));
    expect(h.sessions).toHaveLength(2); // 仍被忽略（新会话还在）
    expect(second.leaveCalls).toBe(0);
  });
});

describe('useVoiceSessionController：卸载清理（P2-2）', () => {
  it('卸载时释放会话（否则服务端留下无法移除的僵尸成员）', () => {
    const { result, unmount } = renderHook(() => useVoiceSessionController(USER, chatActions));
    act(() => result.current.join(1));
    expect(h.sessions[0]!.leaveCalls).toBe(0);

    unmount();
    expect(h.sessions[0]!.leaveCalls).toBe(1);
  });

  it('未进房时卸载不报错', () => {
    const { unmount } = renderHook(() => useVoiceSessionController(USER, chatActions));
    expect(() => unmount()).not.toThrow();
  });
});
