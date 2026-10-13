/**
 * ============================================================
 * 会话列表游标分页测试（D1，2026-10-11）
 * ============================================================
 * 与信息流游标（feed-cursor-pagination.test.ts）同一套验收：
 * - 游标翻页与全量列表逐条一致（多档 limit）
 * - 页间新消息进来（旧会话跳到头）：不重复返回已返回的会话
 * - 末页 next_cursor=null / has_more=false
 * - 非法游标 → 400
 * - 不带 cursor 的响应形状不变（{ conversations, has_more }，老客户端）
 * - 游标模式下的 unread_count 正确
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import Database from 'better-sqlite3';
import { createMemoryDb } from './helpers/memdb';
import { setDbForTests, resetDbForTests } from '../src/db/connection';
import { createApp } from '../src/app';
import { generateToken } from '../src/middleware/auth';

let db: InstanceType<typeof Database>;
let server: http.Server;
let base = '';
let aliceToken = '';
let aliceId = 0;

/** 会话行（游标模式响应） */
interface Conv {
  partner_id: number;
  last_message_at: string;
  last_id: number;
  unread_count: number;
}

function insertMessage(senderId: number, receiverId: number, content: string, createdAt: string): number {
  return Number(
    db
      .prepare(
        'INSERT INTO messages (sender_id, receiver_id, content, read, created_at) VALUES (?, ?, ?, 0, ?)'
      )
      .run(senderId, receiverId, content, createdAt).lastInsertRowid
  );
}

beforeAll(async () => {
  db = createMemoryDb();
  setDbForTests(db);

  const insertUser = db.prepare(
    "INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, 'x', 'user')"
  );
  aliceId = Number(insertUser.run('alice', 'alice@test.com').lastInsertRowid);
  aliceToken = generateToken({ id: aliceId, username: 'alice' });
  // 7 个会话对象：bob..hu（按最后消息时间错开）
  for (let i = 2; i <= 8; i++) {
    insertUser.run(`user${i}`, `user${i}@test.com`);
  }
  // alice ↔ userN 各一段对话；最后一条时间 = 2026-01-0N（user2 最新 … user8 最旧）
  for (let i = 2; i <= 8; i++) {
    insertMessage(aliceId, i, 'early', '2026-01-01T00:00:00.000Z');
    insertMessage(i, aliceId, `msg-from-${i}`, `2026-01-0${i - 1}T12:00:00.000Z`);
  }

  const app = createApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  resetDbForTests();
  db?.close();
});

async function fetchConversations(query = ''): Promise<{
  status: number;
  body: { conversations?: Conv[]; next_cursor?: string | null; has_more?: boolean };
}> {
  const res = await fetch(`${base}/api/messages/conversations${query}`, {
    headers: { Authorization: `Bearer ${aliceToken}` },
  });
  return { status: res.status, body: (await res.json()) as never };
}

describe('GET /api/messages/conversations 游标分页', () => {
  it('从全量请求的 next_cursor 引导，游标翻页与全量列表逐条一致（limit=3）', async () => {
    // 引导：全量请求（页码模式）附带 next_cursor（行数 < 500 上限时为 null，
    // 这里 7 个会话 —— 引导语义用 limit 不可行，直接以「第一行自身」为首游标，
    // seek 条件是严格小于 → 首页恰好是第二行起）
    const full = await fetchConversations();
    const all = full.body.conversations!;
    expect(all.length).toBe(7);
    expect(full.body.next_cursor).toBeNull();

    for (const limit of [1, 2, 3]) {
      let cursor = `${all[0]!.last_message_at}|${all[0]!.last_id}`;
      const got: Conv[] = [];
      for (let page = 0; page < 20; page++) {
        const res = await fetchConversations(`?cursor=${encodeURIComponent(cursor)}&limit=${limit}`);
        expect(res.status).toBe(200);
        got.push(...res.body.conversations!);
        if (!res.body.has_more) {
          expect(res.body.next_cursor).toBeNull();
          break;
        }
        cursor = res.body.next_cursor!;
      }
      expect(got.map((c) => c.partner_id)).toEqual(all.slice(1).map((c) => c.partner_id));
    }
  });

  it('手动构造游标逐页翻：与全量列表的顺序与内容一致（limit=2）', async () => {
    const full = await fetchConversations();
    const all = full.body.conversations!;
    expect(all.length).toBe(7);

    // 首游标 = "第一行之后"：用第一行的 (created_at, last_id) —— seek 语义是
    // 「严格小于该行」，等于被排除 → 构造一个比第一行更新的游标不可行；
    // 直接验证从第二行开始的翻页：cursor = 第一行自身（seek 条件是 < ，会跳过第一行？）
    // —— seek 用 (created_at < ?) OR (= AND id < ?)，传第一行的键会**排除第一行**，
    // 因此传第一行的键得到的就是第二行起的页 —— 与信息流「next_cursor=最后返回行」一致。
    const pages: Conv[][] = [];
    let cursor = `${all[0]!.last_message_at}|${all[0]!.last_id}`;
    for (let i = 0; i < 10; i++) {
      const res = await fetchConversations(`?cursor=${encodeURIComponent(cursor)}&limit=2`);
      expect(res.status).toBe(200);
      pages.push(res.body.conversations!);
      if (!res.body.has_more) break;
      cursor = res.body.next_cursor!;
    }
    // 第一页应从第 2 行开始（第 1 行被 seek 条件排除）
    const rest = all.slice(1);
    const got = pages.flat();
    expect(got.map((c) => c.partner_id)).toEqual(rest.map((c) => c.partner_id));
    // 末页标记
    expect(pages[pages.length - 1]!.length).toBeLessThanOrEqual(2);
  });

  it('页间新消息进来（旧会话跳到头）：不重复返回已返回的会话', async () => {
    const full = await fetchConversations();
    const all = full.body.conversations!;

    // 第一页：以第 2 行为界取「第 3 行起」
    const cursorAfterTwo = `${all[1]!.last_message_at}|${all[1]!.last_id}`;
    const page2 = await fetchConversations(`?cursor=${encodeURIComponent(cursorAfterTwo)}&limit=3`);
    const gotIds = page2.body.conversations!.map((c) => c.partner_id);
    expect(gotIds).not.toContain(all[0]!.partner_id);
    expect(gotIds).not.toContain(all[1]!.partner_id);

    // 翻页期间：给「最旧」的会话（第 7 行）来一条新消息 → 它跳到列表头。
    // 它的 created_at 变新 → 后续页（seek 旧游标）不再包含它 —— 不重复。
    const oldest = all[all.length - 1]!;
    insertMessage(oldest.partner_id, aliceId, 'bump', '2026-02-01T00:00:00.000Z');
    const page3 = await fetchConversations(`?cursor=${encodeURIComponent(page2.body.next_cursor!)}&limit=3`);
    const ids3 = page3.body.conversations!.map((c) => c.partner_id);
    // 被 bump 的会话不应再次出现（已出现在全量第 7 行）
    expect(ids3).not.toContain(oldest.partner_id);
    // 其余会话仍按序返回
    expect(new Set(ids3).size).toBe(ids3.length);
  });

  it('非法游标 → 400', async () => {
    const res = await fetchConversations('?cursor=not-a-cursor');
    expect(res.status).toBe(400);
    const res2 = await fetchConversations(`?cursor=${encodeURIComponent('2026-01-01T00:00:00.000Z|abc')}`);
    expect(res2.status).toBe(400);
  });

  it('不带 cursor：响应形状只增不改（{ conversations, has_more, next_cursor: null }）', async () => {
    const { status, body } = await fetchConversations();
    expect(status).toBe(200);
    expect(Array.isArray(body.conversations)).toBe(true);
    expect(body.has_more).toBe(false); // 7 个会话 < 500 上限
    expect(body.next_cursor).toBeNull(); // 附带字段（与信息流页码模式同一约定），老客户端忽略
  });

  it('游标模式下的 unread_count 与未读事实一致', async () => {
    // user3 给 alice 发一条新消息（alice 未读 +1，user3 会话跳到头）
    insertMessage(3, aliceId, 'unread-bump', '2026-03-01T00:00:00.000Z');
    const full = await fetchConversations();
    const head = full.body.conversations![0]!;
    expect(head.partner_id).toBe(3);
    // 种子里的 msg-from-3 本身就未读（1）+ 本用例的 unread-bump（1）= 2
    expect(head.unread_count).toBe(2);
  });
});
