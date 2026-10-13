/**
 * ============================================================
 * 转设备推送的判定（sse.ts，2026-10-08）
 * ============================================================
 * SSE 与 OPPO 推送的分工只有一条判据：
 * **该用户有没有 `client=android` 的在线连接** ——
 *  · 有（App 在前台）→ 只走 SSE，绝不重复提醒；
 *  · 没有（App 退后台/被杀，或只有网页端在线）→ 转投一条设备推送。
 *
 * 这层判定错了的两个后果都很具体：
 *  · 误判为"在线"→ 后台彻底收不到提醒（静默丢失，本项目最贵的历史故障）；
 *  · 误判为"不在线"→ App 开着还弹系统通知（重复打扰）。
 *
 * 测试把 services/push.service 整个 mock 掉：这里只验证**调用决策**，
 * 不触发真实网络/数据库（另见 push.test.ts 的各层单测）。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/services/push.service', () => ({
  pushForOffline: vi.fn(async () => {}),
  pushAnnouncementToAll: vi.fn(async () => {}),
  // sse.ts 模块加载时会把"Android 在线判定"注入给 push.service（合并窗口触发时复查用）
  setAndroidOnlineChecker: vi.fn(),
}));

import { subscribe, notifyUser, notifyAllUsers, closeAllStreams } from '../src/sse';
import { pushForOffline, pushAnnouncementToAll } from '../src/services/push.service';

/** 最小 Response 替身（与 sse-subscribers.test.ts 同款） */
function fakeRes() {
  const writes: string[] = [];
  let closeHandler: (() => void) | null = null;
  return {
    writes,
    res: {
      setHeader: () => {},
      flushHeaders: () => {},
      write: (chunk: string) => {
        writes.push(chunk);
        return true;
      },
      end: () => {
        closeHandler?.();
      },
      on: (event: string, handler: () => void) => {
        if (event === 'close') closeHandler = handler;
      },
    } as unknown as import('express').Response,
  };
}

const USER = 7;
const MSG = { type: 'message', from: 3, to: USER } as const;

beforeEach(() => {
  closeAllStreams();
  vi.mocked(pushForOffline).mockClear();
  vi.mocked(pushAnnouncementToAll).mockClear();
});

describe('notifyUser 的转推判定', () => {
  it('没有任何在线连接 → 转设备推送', () => {
    notifyUser(USER, MSG);
    expect(pushForOffline).toHaveBeenCalledTimes(1);
    expect(pushForOffline).toHaveBeenCalledWith(USER, MSG);
  });

  it('只有网页端在线 → 仍然转设备推送（网页在线不该压掉手机提醒）', () => {
    const web = fakeRes();
    subscribe(USER, web.res, 'web');
    notifyUser(USER, MSG);
    expect(pushForOffline).toHaveBeenCalledTimes(1);
    // 网页端照常收到 SSE
    expect(web.writes.some((w) => w.includes('"type":"message"'))).toBe(true);
  });

  it('旧客户端（未声明来源）在线 → 也转推送（它们没有推送注册，自然是空操作）', () => {
    const unknown = fakeRes();
    subscribe(USER, unknown.res); // 默认 unknown
    notifyUser(USER, MSG);
    expect(pushForOffline).toHaveBeenCalledTimes(1);
  });

  it('有 Android 在线连接 → 只走 SSE，绝不转推', () => {
    const android = fakeRes();
    subscribe(USER, android.res, 'android');
    notifyUser(USER, MSG);
    expect(pushForOffline).not.toHaveBeenCalled();
    expect(android.writes.some((w) => w.includes('"type":"message"'))).toBe(true);
  });

  it('Android 与网页同时在线 → 不转推（只要有一台 Android 在前台）', () => {
    const android = fakeRes();
    const web = fakeRes();
    subscribe(USER, android.res, 'android');
    subscribe(USER, web.res, 'web');
    notifyUser(USER, MSG);
    expect(pushForOffline).not.toHaveBeenCalled();
  });

  it('连接关闭（退后台断连）后再有事件 → 恢复转推', () => {
    const android = fakeRes();
    subscribe(USER, android.res, 'android');
    // 模拟客户端断开：触发 sse.ts 的 close 清理
    (android.res as unknown as { end: () => void }).end();
    notifyUser(USER, MSG);
    expect(pushForOffline).toHaveBeenCalledTimes(1);
  });
});

describe('notifyAllUsers 的全体公告推送', () => {
  it('排除"有 Android 在线"的用户，其余设备逐台推', () => {
    const online = fakeRes();
    subscribe(USER, online.res, 'android');
    notifyAllUsers({ type: 'announcement', announcement_id: 42 });

    expect(pushAnnouncementToAll).toHaveBeenCalledTimes(1);
    const [announcementId, exclude] = vi.mocked(pushAnnouncementToAll).mock.calls[0]!;
    expect(announcementId).toBe(42);
    expect(exclude).toBeInstanceOf(Set);
    expect((exclude as Set<number>).has(USER)).toBe(true);
  });

  it('非公告事件不触发全体推送', () => {
    notifyAllUsers({ type: 'message', from: 1, to: 2 });
    expect(pushAnnouncementToAll).not.toHaveBeenCalled();
  });
});
