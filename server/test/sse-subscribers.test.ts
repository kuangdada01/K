/**
 * ============================================================
 * SSE 订阅层单测（sse.ts）
 * ============================================================
 * 该模块此前只有「客户端侧」测试（useSse.test.tsx），服务端这一半零覆盖，
 * 而它管着两件容易出事的事：
 * - 单用户并发连接上限（MAX_SSE_PER_USER=5）：无上限时单账号可无限叠加连接，
 *   每条连接一个心跳定时器 → 内存与定时器耗尽
 * - 超限时先发 `kicked` 终止事件再断开：客户端据此不再退避重连，
 *   否则「新标签页顶掉旧连接、旧连接又重连顶回」会形成无限震荡
 * 另外覆盖连接关闭后的清理（心跳定时器必须停、空集合必须从 Map 移除）。
 * ============================================================
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { subscribe, notifyUser, notifyAllUsers, closeAllStreams } from '../src/sse';

/** 最小 Response 替身：只保留 sse.ts 用到的那部分 */
function fakeRes() {
  const writes: string[] = [];
  let ended = false;
  let closeHandler: (() => void) | null = null;
  const headers: Record<string, string> = {};
  const fireClose = () => {
    const h = closeHandler;
    closeHandler = null;
    h?.();
  };
  return {
    writes,
    get ended() {
      return ended;
    },
    res: {
      setHeader: (k: string, v: string) => {
        headers[k] = v;
      },
      flushHeaders: () => {},
      write: (chunk: string) => {
        writes.push(chunk);
        return true;
      },
      end: () => {
        ended = true;
        // 忠实模拟 Node：ServerResponse 响应结束后会 emit 'close'。
        // sse.ts 正是靠这个事件去 clearInterval 心跳定时器；
        // 若替身不发，就会误判成「被踢的连接泄漏了定时器」。
        fireClose();
      },
      on: (event: string, handler: () => void) => {
        if (event === 'close') closeHandler = handler;
      },
    } as unknown as import('express').Response,
    headers,
    /** 模拟客户端断开 */
    fireClose,
  };
}

beforeEach(() => {
  // sse.ts 是模块级单例（subscribers Map），用例间必须清干净
  closeAllStreams();
  vi.useFakeTimers();
});

afterEach(() => {
  closeAllStreams();
  vi.useRealTimers();
});

describe('subscribe', () => {
  it('建立连接时下发 SSE 必需响应头与初始注释行', () => {
    const c = fakeRes();
    subscribe(1, c.res);

    expect(c.headers['Content-Type']).toBe('text/event-stream');
    expect(c.headers['Cache-Control']).toBe('no-cache, no-transform');
    expect(c.headers['X-Accel-Buffering']).toBe('no'); // 防 nginx 缓冲住流
    expect(c.writes[0]).toBe(': connected\n\n');
  });

  it('心跳按间隔下发，连接关闭后停止（不泄漏定时器）', () => {
    const c = fakeRes();
    subscribe(1, c.res);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(25_000);
    expect(c.writes.filter((w) => w === ': ping\n\n')).toHaveLength(1);

    vi.advanceTimersByTime(25_000);
    expect(c.writes.filter((w) => w === ': ping\n\n')).toHaveLength(2);

    c.fireClose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(100_000);
    // 关闭后不再有心跳
    expect(c.writes.filter((w) => w === ': ping\n\n')).toHaveLength(2);
  });

  it('同一用户最多 5 条连接：第 6 条顶掉最早的一条，且被顶者先收到 kicked 再断开', () => {
    const conns = Array.from({ length: 6 }, () => fakeRes());
    for (const c of conns) subscribe(1, c.res);

    // 最早的那条被踢：先写 kicked 事件，再 end（顺序很重要——客户端靠它停止重连）
    const oldest = conns[0]!;
    const kickedIdx = oldest.writes.indexOf('event: kicked\ndata: {}\n\n');
    expect(kickedIdx).toBeGreaterThanOrEqual(0);
    expect(oldest.ended).toBe(true);

    // 第 2~6 条都还活着
    for (const c of conns.slice(1)) expect(c.ended).toBe(false);

    // 上限是「每用户」：心跳定时器恰好 5 个（被踢的那条已清）
    expect(vi.getTimerCount()).toBe(5);
  });

  it('上限按用户隔离：一个用户占满不影响另一个用户', () => {
    for (let i = 0; i < 5; i++) subscribe(1, fakeRes().res);
    const other = fakeRes();
    subscribe(2, other.res);
    expect(other.ended).toBe(false);
    expect(vi.getTimerCount()).toBe(6);
  });
});

describe('notifyUser', () => {
  it('只推给目标用户，载荷为 data: {json}', () => {
    const a = fakeRes();
    const b = fakeRes();
    subscribe(1, a.res);
    subscribe(2, b.res);
    a.writes.length = 0;
    b.writes.length = 0;

    notifyUser(1, 'message', { from: 2 });

    expect(a.writes).toEqual(['data: {"type":"message","from":2}\n\n']);
    expect(b.writes).toEqual([]);
  });

  it('单条连接写入抛错不影响其他连接（忽略失败连接）', () => {
    const a = fakeRes();
    const b = fakeRes();
    subscribe(1, a.res);
    subscribe(1, b.res);
    // 让 a 的 write 抛错（模拟已断开的 socket）
    (a.res as unknown as { write: () => void }).write = () => {
      throw new Error('socket closed');
    };
    b.writes.length = 0;

    expect(() => notifyUser(1, 'notification', {})).not.toThrow();
    expect(b.writes).toEqual(['data: {"type":"notification"}\n\n']);
  });

  it('无订阅者时静默返回', () => {
    expect(() => notifyUser(999, 'message', {})).not.toThrow();
  });
});

describe('notifyAllUsers / closeAllStreams', () => {
  it('广播给所有在线用户的每一条连接', () => {
    const a = fakeRes();
    const b = fakeRes();
    const c = fakeRes();
    subscribe(1, a.res);
    subscribe(1, b.res);
    subscribe(2, c.res);
    for (const x of [a, b, c]) x.writes.length = 0;

    notifyAllUsers('announcement', { id: 7 });

    for (const x of [a, b, c]) {
      expect(x.writes).toEqual(['data: {"type":"announcement","id":7}\n\n']);
    }
  });

  it('closeAllStreams 结束全部连接并清空订阅表（优雅停机依赖它触发 server.close 回调）', () => {
    const a = fakeRes();
    const b = fakeRes();
    subscribe(1, a.res);
    subscribe(2, b.res);

    closeAllStreams();

    expect(a.ended).toBe(true);
    expect(b.ended).toBe(true);
    expect(vi.getTimerCount()).toBe(0); // 心跳定时器全部清理
    // 订阅表已清空：再推送不会有人收到
    a.writes.length = 0;
    notifyUser(1, 'message', {});
    notifyAllUsers('announcement', {});
    expect(a.writes).toEqual([]);
  });
});
