/**
 * ============================================================
 * SSE 事件契约测试（P2-4.2）
 * ============================================================
 * 服务端发出的每一条 SSE payload 都必须能被 `@k/shared/schemas` 的
 * **SseEvent 判别联合**解析 —— 事件形状从此有三层保障：
 *  1. 构建期：notifyUser/notifyAllUsers 的参数类型就是 SseEvent（错字段编译失败）；
 *  2. 本契约测试：真实写出的 `data:` 行逐条过 schema；
 *  3. 兼容性：历史 JSON fixture（旧客户端时代的真实形态）也必须可解析
 *     —— 新 schema 只能做兼容性新增，破坏性变更需三端同步版本化。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { subscribe, notifyUser, notifyAllUsers, closeAllStreams } from '../src/sse';
import { sseEventSchema } from '@k/shared/schemas';
import type { SseEvent } from '@k/shared/schemas';

/** 最小 Response 替身（与 sse-subscribers.test.ts 同一套） */
function fakeRes() {
  const writes: string[] = [];
  let closeHandler: (() => void) | null = null;
  const fireClose = () => {
    const h = closeHandler;
    closeHandler = null;
    h?.();
  };
  return {
    writes,
    res: {
      setHeader: () => {},
      flushHeaders: () => {},
      write: (chunk: string) => {
        writes.push(chunk);
        return true;
      },
      end: () => fireClose(),
      on: (event: string, handler: () => void) => {
        if (event === 'close') closeHandler = handler;
      },
    } as unknown as import('express').Response,
    fireClose,
  };
}

/** 从替身写出的块里解析全部 data: 行的 JSON */
function dataEvents(writes: string[]): unknown[] {
  return writes.filter((w) => w.startsWith('data: ')).map((w) => JSON.parse(w.slice('data: '.length).trim()));
}

let sub: ReturnType<typeof fakeRes>;

beforeEach(() => {
  sub = fakeRes();
  subscribe(7, sub.res);
});

afterEach(() => {
  closeAllStreams();
});

describe('服务端发出的 payload 符合 SseEvent 契约', () => {
  it('message：新消息', () => {
    notifyUser(7, { type: 'message', from: 2, to: 7 });
    const events = dataEvents(sub.writes);
    expect(events).toHaveLength(1);
    expect(sseEventSchema.parse(events[0])).toEqual({ type: 'message', from: 2, to: 7 });
  });

  it('message：撤回（recalled）', () => {
    notifyUser(7, { type: 'message', from: 2, to: 7, recalled: 123 });
    const parsed = sseEventSchema.parse(dataEvents(sub.writes)[0]) as Extract<SseEvent, { type: 'message' }>;
    expect(parsed.recalled).toBe(123);
  });

  it('message：会话清空（cleared）', () => {
    notifyUser(7, { type: 'message', from: 2, to: 7, cleared: true });
    const parsed = sseEventSchema.parse(dataEvents(sub.writes)[0]) as Extract<SseEvent, { type: 'message' }>;
    expect(parsed.cleared).toBe(true);
  });

  it('notification：评论互动', () => {
    notifyUser(7, { type: 'notification', comment_id: 5, post_id: 9 });
    expect(sseEventSchema.parse(dataEvents(sub.writes)[0])).toEqual({
      type: 'notification',
      comment_id: 5,
      post_id: 9,
    });
  });

  it('announcement：全体广播（notifyAllUsers）', () => {
    notifyAllUsers({ type: 'announcement', announcement_id: 3 });
    expect(sseEventSchema.parse(dataEvents(sub.writes)[0])).toEqual({
      type: 'announcement',
      announcement_id: 3,
    });
  });

  it('契约收紧：错字段/错类型会被 schema 拒绝（防未来的形状漂移）', () => {
    expect(!sseEventSchema.safeParse({ type: 'message', from: 'x', to: 7 }).success).toBe(true);
    expect(!sseEventSchema.safeParse({ type: 'notification', comment_id: 1 }).success).toBe(true);
    expect(!sseEventSchema.safeParse({ type: 'unknown-kind' }).success).toBe(true);
  });
});

describe('历史 JSON fixture 仍可解析（兼容旧客户端）', () => {
  /** 旧客户端时代真实出现过的 payload 形态（采集自 sse.ts 旧实现） */
  const fixtures: unknown[] = [
    { type: 'message', from: 2, to: 7 },
    { type: 'message', from: 2, to: 7, recalled: 123 },
    { type: 'message', from: 2, to: 7, cleared: true },
    { type: 'notification', comment_id: 5, post_id: 9 },
    { type: 'announcement', announcement_id: 3 },
  ];

  it('每条 fixture 都通过 schema', () => {
    for (const f of fixtures) {
      expect(sseEventSchema.safeParse(f).success, JSON.stringify(f)).toBe(true);
    }
  });
});
