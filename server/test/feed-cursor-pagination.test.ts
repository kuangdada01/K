/**
 * ============================================================
 * 信息流游标分页测试（P2-4.3）
 * ============================================================
 * - 翻页序列与 OFFSET 模式逐条一致
 * - ★ 两页之间插入新帖：后续页不跳不重（游标锚定 (created_at,id)，与行数无关）
 * - ★ 两页之间删除一条未读帖子：后续页同样不跳不重
 * - has_more / next_cursor 边界（最后一页 next_cursor=null）
 * - 非法游标 400；页码模式响应保持旧形状并附带新字段
 * - EXPLAIN QUERY PLAN 命中 idx_posts_feed_cursor 索引
 * ============================================================
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { createMemoryDb } from './helpers/memdb';
import { setDbForTests, resetDbForTests, getDb } from '../src/db/connection';
import * as postRepo from '../src/repositories/post.repo';

let db: InstanceType<typeof Database>;
let userId = 0;

const T0 = new Date('2026-01-01T00:00:00.000Z').getTime();

/** 造一条帖子（created_at 显式指定，间隔 1 秒保证排序稳定可预期） */
function insertPost(n: number, at?: number): number {
  const createdAt = new Date(at ?? T0 + n * 1000).toISOString();
  const info = getDb()
    .prepare(
      "INSERT INTO posts (user_id, image_url, title, description, location, close_comments, pinned, created_at) VALUES (?, '[]', ?, ?, '', 0, 0, ?)"
    )
    .run(userId, `t${n}`, `d${n}`, createdAt);
  return Number(info.lastInsertRowid);
}

beforeAll(() => {
  db = createMemoryDb();
  setDbForTests(db);
  userId = Number(
    getDb()
      .prepare(
        "INSERT INTO users (username, email, password_hash, role) VALUES ('u', 'u@t.com', 'x', 'user')"
      )
      .run().lastInsertRowid
  );
  for (let i = 1; i <= 25; i++) insertPost(i);
});

afterAll(() => {
  resetDbForTests();
  db?.close();
});

/** 用游标从头拉到底，返回完整 id 序列 */
function fetchAllByCursor(limit: number): { ids: number[]; pages: number } {
  const ids: number[] = [];
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    const r = postRepo.listPostsByCursor(cursor, limit);
    pages++;
    ids.push(...r.posts.map((p) => p.id));
    if (!r.has_more || r.next_cursor == null) break;
    cursor = r.next_cursor;
    if (pages > 50) throw new Error('游标翻页死循环');
  }
  return { ids, pages };
}

describe('游标分页的正确性', () => {
  it('翻页序列与 OFFSET 模式逐条一致（不同 limit 都对齐）', () => {
    for (const limit of [3, 7, 20, 25, 30]) {
      const cursorIds = fetchAllByCursor(limit).ids;
      const offsetIds: number[] = [];
      for (let page = 1; ; page++) {
        const { posts } = postRepo.listPosts(page, limit);
        offsetIds.push(...posts.map((p) => p.id));
        if (posts.length < limit) break;
      }
      expect(cursorIds, `limit=${limit}`).toEqual(offsetIds);
    }
  });

  it('★ 两页之间插入新帖：后续页不跳不重（新帖不影响已锚定的边界）', () => {
    const first = postRepo.listPostsByCursor(null, 10);
    expect(first.has_more).toBe(true);

    // 在两页之间插入两条“最新”帖子（OFFSET 语义下会把边界整体后移 → 后续页重复）
    insertPost(101, Date.now());
    insertPost(102, Date.now());

    const second = postRepo.listPostsByCursor(first.next_cursor, 10);
    const firstIds = first.posts.map((p) => p.id);
    const secondIds = second.posts.map((p) => p.id);
    // 不重复：第二页不包含第一页的任何一条
    expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);
    // 不跳：与「插入前的旧集合」按 OFFSET 取的对照序列逐条一致
    const dbIds = (
      getDb()
        .prepare(
          "SELECT id FROM posts WHERE description NOT IN ('d101','d102') ORDER BY created_at DESC, id DESC LIMIT 10 OFFSET 10"
        )
        .all() as { id: number }[]
    ).map((r) => r.id);
    expect(secondIds).toEqual(dbIds);

    // 清理插入的两条，避免影响其他用例
    getDb().prepare("DELETE FROM posts WHERE description IN ('d101','d102')").run();
  });

  it('★ 两页之间删除一条未读帖子：后续页不重不跳', () => {
    const first = postRepo.listPostsByCursor(null, 10);
    // 删除第 12 号位（第二页范围）的帖子
    const victim = postRepo.listPostsByCursor(first.next_cursor, 2).posts[1]!;
    getDb().prepare('DELETE FROM posts WHERE id = ?').run(victim.id);

    const second = postRepo.listPostsByCursor(first.next_cursor, 10);
    const ids = [...first.posts.map((p) => p.id), ...second.posts.map((p) => p.id)];
    expect(new Set(ids).size).toBe(ids.length); // 无重复
    // 未删的帖子一条不少（25 - 1 = 24 条全量拉取）
    expect(fetchAllByCursor(20).ids.length).toBe(24);
  });

  it('最后一页 next_cursor=null 且 has_more=false', () => {
    // 24 条（上一用例删了一条）：第一页 20，第二页 4
    const page1 = postRepo.listPostsByCursor(null, 20);
    expect(page1.posts.length).toBe(20);
    expect(page1.has_more).toBe(true);
    expect(page1.next_cursor).not.toBeNull();

    const page2 = postRepo.listPostsByCursor(page1.next_cursor, 20);
    expect(page2.posts.length).toBe(4);
    expect(page2.has_more).toBe(false);
    expect(page2.next_cursor).toBeNull();
  });

  it('非法游标抛 400', () => {
    expect(() => postRepo.listPostsByCursor('garbage', 20)).toThrow(/无效的分页游标/);
    expect(() => postRepo.listPostsByCursor('not-a-date|abc', 20)).toThrow(/无效的分页游标/);
    expect(() => postRepo.listPostsByCursor('2026-01-01T00:00:00.000Z|', 20)).toThrow(/无效的分页游标/);
  });

  it('EXPLAIN QUERY PLAN 命中游标索引（不走全表扫描排序）', () => {
    const boundary = postRepo.decodeFeedCursor(postRepo.listPostsByCursor(null, 5).next_cursor!);
    const plan = getDb()
      .prepare(
        `EXPLAIN QUERY PLAN SELECT p.id FROM posts p
         WHERE (p.created_at < ? OR (p.created_at = ? AND p.id < ?))
         ORDER BY p.created_at DESC, p.id DESC LIMIT 20`
      )
      .all(boundary.createdAt, boundary.createdAt, boundary.id) as { detail: string }[];
    const text = plan.map((r) => r.detail).join('\n');
    expect(text).toContain('idx_posts_feed_cursor');
  });

  it('created_at 相同的并列按 id 决胜（游标不丢并列行）', () => {
    const same = T0 + 5000 * 60;
    const a = insertPost(201, same);
    const b = insertPost(202, same);
    // a 先插（id 小），b 后插；倒序应为 b → a → 原第 1 名之后…
    const first = postRepo.listPostsByCursor(null, 1);
    expect(first.posts[0]!.id).toBe(b);
    const second = postRepo.listPostsByCursor(first.next_cursor, 1);
    expect(second.posts[0]!.id).toBe(a);
    getDb().prepare('DELETE FROM posts WHERE id IN (?, ?)').run(a, b);
  });
});
