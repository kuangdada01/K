/**
 * 回归验证：B3（搜索 %/_ 转义）与 B4（不存在资源 404 / parentId 校验）
 * 内存库注入，不触碰真实 k.db。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryDb } from './helpers/memdb';
import { setDbForTests, resetDbForTests } from '../src/db/connection';
import * as postRepo from '../src/repositories/post.repo';
import * as friendRepo from '../src/repositories/friend.repo';
import * as adminRepo from '../src/repositories/admin.repo';
import * as commentRepo from '../src/repositories/comment.repo';
import { AppError } from '../src/middleware/error';

let db: ReturnType<typeof createMemoryDb>;

function insertUser(username: string): number {
  const r = db
    .prepare("INSERT INTO users (username, email, password_hash, email_verified) VALUES (?, ?, 'x', 1)")
    .run(username, `${username}@test.com`);
  return Number(r.lastInsertRowid);
}

function insertPost(userId: number, title = '', description = ''): number {
  const r = db
    .prepare('INSERT INTO posts (user_id, image_url, title, description) VALUES (?, ?, ?, ?)')
    .run(userId, '[]', title, description);
  return Number(r.lastInsertRowid);
}

beforeAll(() => {
  db = createMemoryDb();
  setDbForTests(db);
});

afterAll(() => {
  resetDbForTests();
});

beforeEach(() => {
  db.exec(
    'DELETE FROM posts; DELETE FROM users; DELETE FROM notifications; DELETE FROM comments; DELETE FROM likes; DELETE FROM shares; DELETE FROM bookmarks; DELETE FROM reposts;'
  );
});

describe('B3 搜索含 %/_ 关键词', () => {
  it('搜索 "100%" 应命中含 "100%" 的帖子', () => {
    const u = insertUser('alice');
    insertPost(u, '进度到 100% 了', '');
    insertPost(u, '普通帖子', '');
    const { posts, total } = postRepo.searchPosts('100%', 1, 20, u);
    expect(total).toBe(1);
    expect(posts[0]!.title).toBe('进度到 100% 了');
  });

  it('搜索 "100_" 不应命中含 "100%" 的帖子（% 不是通配符）', () => {
    const u = insertUser('alice');
    insertPost(u, '进度到 100% 了', '');
    const { posts, total } = postRepo.searchPosts('100_', 1, 20, u);
    expect(total).toBe(0);
    expect(posts).toHaveLength(0);
  });

  it('搜索 "100_" 应命中标题真含 "100_" 的帖子', () => {
    const u = insertUser('alice');
    insertPost(u, '编号100_xyz', '');
    const { posts, total } = postRepo.searchPosts('100_', 1, 20, u);
    expect(total).toBe(1);
    expect(posts[0]!.title).toBe('编号100_xyz');
  });

  it('描述中含 % 也能命中', () => {
    const u = insertUser('alice');
    insertPost(u, '', '优惠 50% 折扣');
    const { posts, total } = postRepo.searchPosts('50%', 1, 20, u);
    expect(total).toBe(1);
    expect(posts[0]!.description).toBe('优惠 50% 折扣');
  });

  it('friend.repo 用户搜索含 %/_ 的用户名', () => {
    const u = insertUser('alice');
    insertUser('bob_100%');
    insertUser('bob_200');
    // 搜索 bob_100% → 只应命中真含该串的用户，_ 与 % 均按字面匹配
    const r1 = friendRepo.searchUsers('bob_100%', u);
    expect(r1.length).toBe(1);
    expect(r1[0]!.username).toBe('bob_100%');
    // 搜索 bob_ → 命中两个（字面下划线），而不是把所有下划线当通配
    const r2 = friendRepo.searchUsers('bob_', u);
    expect(r2.map((x) => x.username).sort()).toEqual(['bob_100%', 'bob_200']);
  });

  it('admin.repo 用户搜索含 %/_ 的用户名（转义 + ESCAPE）', () => {
    insertUser('alice');
    insertUser('weird%user');
    const r = adminRepo.searchUsers('weird%');
    expect(r.length).toBe(1);
    expect(r[0]!.username).toBe('weird%user');
    const r2 = adminRepo.searchUsers('weird_');
    expect(r2.length).toBe(0);
  });
});

describe('B4 不存在资源返回 404 而非 500', () => {
  /**
   * 断言 fn 抛出 status 匹配的 AppError。
   *
   * 原实现把 expect 写在 `try { fn() } catch (e) { expect(...) }` 里：
   * fn 一旦不抛错，一条 expect 都不会执行，用例照样通过 ——
   * 整个「404 而非 500」回归网可以静默失效。
   */
  function expectAppError(fn: () => unknown, status: number): void {
    let caught: unknown;
    try {
      fn();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).status).toBe(status);
  }

  it('点赞不存在的帖子抛 404', () => {
    const u = insertUser('alice');
    expectAppError(() => postRepo.likePost(u, 999999), 404);
  });

  it('取消点赞不存在的帖子抛 404', () => {
    const u = insertUser('alice');
    expectAppError(() => postRepo.unlikePost(u, 999999), 404);
  });

  it('分享不存在的帖子抛 404', () => {
    const u = insertUser('alice');
    expectAppError(() => postRepo.sharePost(u, 999999), 404);
  });

  it('收藏/取消收藏不存在的帖子抛 404', () => {
    const u = insertUser('alice');
    expectAppError(() => postRepo.bookmarkPost(u, 999999), 404);
    expectAppError(() => postRepo.unbookmarkPost(u, 999999), 404);
  });

  it('转发/取消转发不存在的帖子抛 404', () => {
    const u = insertUser('alice');
    expectAppError(() => postRepo.repostPost(u, 999999), 404);
    expectAppError(() => postRepo.unrepostPost(u, 999999), 404);
  });

  it('存在的帖子操作正常（不误伤）', () => {
    const u = insertUser('alice');
    const p = insertPost(u, 't', 'd');
    expect(postRepo.likePost(u, p)).toBe(1);
    expect(postRepo.unlikePost(u, p)).toBe(0);
    expect(postRepo.sharePost(u, p).share_count).toBe(1);
    postRepo.bookmarkPost(u, p);
    expect(postRepo.repostPost(u, p).repost_count).toBe(1);
  });

  it('getCommentPost 返回父评论真实所属帖子（路由 parentId 校验的数据基础）', () => {
    const u = insertUser('alice');
    const p1 = insertPost(u, 'a', '');
    insertPost(u, 'b', '');
    const c1 = commentRepo.createComment(u, p1, null, 'p1 的评论');

    expect(commentRepo.getCommentPost(c1.id)).toEqual({ post_id: p1 });
    // 不存在的父评论：路由据此判 400（真实 HTTP 断言见 comment-endpoints.test.ts）
    expect(commentRepo.getCommentPost(999999)).toBeUndefined();
  });
});
