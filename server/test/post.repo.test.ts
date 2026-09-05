/**
 * 帖子仓库测试（内存 SQLite，通过连接注入隔离，不触碰真实数据库）
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryDb } from './helpers/memdb';
import { setDbForTests, resetDbForTests } from '../src/db/connection';
import * as postRepo from '../src/repositories/post.repo';
import * as commentRepo from '../src/repositories/comment.repo';

let db: ReturnType<typeof createMemoryDb>;

/** 插入测试用户，返回 id */
function insertUser(username: string): number {
  const r = db
    .prepare("INSERT INTO users (username, email, password_hash, email_verified) VALUES (?, ?, 'x', 1)")
    .run(username, `${username}@test.com`);
  return Number(r.lastInsertRowid);
}

/** 插入测试帖子，返回 id */
function insertPost(userId: number, description = '', imageUrl = '[]'): number {
  const r = db
    .prepare('INSERT INTO posts (user_id, image_url, description) VALUES (?, ?, ?)')
    .run(userId, imageUrl, description);
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
  // 清理数据，保持用例独立
  db.exec('DELETE FROM posts; DELETE FROM users; DELETE FROM notifications;');
});

describe('listPosts / searchPosts', () => {
  it('分页与计数正确', () => {
    const u = insertUser('alice');
    for (let i = 0; i < 25; i++) insertPost(u, `post ${i}`);
    const page1 = postRepo.listPosts(1, 20, u);
    expect(page1.posts.length).toBe(20);
    expect(page1.total).toBe(25);
    const page2 = postRepo.listPosts(2, 20, u);
    expect(page2.posts.length).toBe(5);
    // 响应形状：feed 无 bookmarked 字段
    expect(page1.posts[0]).not.toHaveProperty('bookmarked');
    expect(page1.posts[0]).toHaveProperty('liked');
  });

  it('搜索关键词匹配标题/描述', () => {
    const u = insertUser('alice');
    insertPost(u, 'hello world');
    insertPost(u, 'other');
    const { posts, total } = postRepo.searchPosts('hello', 1, 20, u);
    expect(total).toBe(1);
    expect(posts[0].description).toBe('hello world');
  });
});

describe('点赞/收藏/转发/分享', () => {
  it('点赞去重且计数正确', () => {
    const u = insertUser('alice');
    const v = insertUser('bob');
    const p = insertPost(u);
    expect(postRepo.likePost(v, p)).toBe(1);
    expect(postRepo.likePost(v, p)).toBe(1); // 重复点赞不增加
    expect(postRepo.unlikePost(v, p)).toBe(0);
  });

  it('分享每个用户只计一次', () => {
    const u = insertUser('alice');
    const v = insertUser('bob');
    const p = insertPost(u);
    expect(postRepo.sharePost(v, p).share_count).toBe(1);
    expect(postRepo.sharePost(v, p).share_count).toBe(1);
  });

  it('收藏与转发列表', () => {
    const u = insertUser('alice');
    const v = insertUser('bob');
    const p = insertPost(u);
    postRepo.bookmarkPost(v, p);
    postRepo.repostPost(v, p);
    const bm = postRepo.listBookmarkedPosts(v);
    const rp = postRepo.listRepostedPosts(v);
    expect(bm.length).toBe(1);
    expect(bm[0].bookmarked).toBe(1);
    expect(rp.length).toBe(1);
    expect(rp[0].reposted).toBe(1);
  });
});

describe('评论', () => {
  it('创建/列表/嵌套回复与父评论信息', () => {
    const u = insertUser('alice');
    const v = insertUser('bob');
    const p = insertPost(u);
    const c1 = commentRepo.createComment(u, p, null, '顶层评论');
    commentRepo.createComment(v, p, c1.id, '回复评论');
    const list = commentRepo.listComments(p, u);
    expect(list.length).toBe(2);
    const reply = list.find((c) => c.parent_id === c1.id)!;
    expect(reply.parent_content).toBe('顶层评论');
    expect(reply.parent_username).toBe('alice');
  });

  it('删除评论级联清理子孙通知', () => {
    const u = insertUser('alice');
    const p = insertPost(u);
    const c1 = commentRepo.createComment(u, p, null, 'root');
    db.prepare(
      "INSERT INTO notifications (user_id, type, from_user_id, post_id, comment_id, content) VALUES (?, 'reply', ?, ?, ?, '')"
    ).run(u, u, p, c1.id);
    commentRepo.deleteComment(c1.id);
    const n = db.prepare('SELECT COUNT(*) as c FROM notifications').get() as { c: number };
    expect(n.c).toBe(0);
    const c = db.prepare('SELECT COUNT(*) as c FROM comments').get() as { c: number };
    expect(c.c).toBe(0);
  });
});

describe('帖子 CRUD', () => {
  it('创建图文帖子返回 0 计数形状', () => {
    const u = insertUser('alice');
    const post = postRepo.createPost({
      userId: u,
      imageUrl: JSON.stringify(['/uploads/a.jpg']),
      title: 't',
      description: 'd',
      closeComments: 0,
      pinned: 0,
    });
    expect(post.like_count).toBe(0);
    expect(post.comment_count).toBe(0);
    expect(post).not.toHaveProperty('liked');
  });

  it('更新与删除自己的帖子', () => {
    const u = insertUser('alice');
    const v = insertUser('bob');
    const p = insertPost(u);
    const updated = postRepo.updatePost({
      postId: p,
      userId: u,
      imageUrl: '[]',
      description: 'new',
      closeComments: 0,
      pinned: 1,
    });
    expect(updated!.description).toBe('new');
    expect(updated!.pinned).toBe(1);
    // 非作者更新失败
    expect(
      postRepo.updatePost({
        postId: p,
        userId: v,
        imageUrl: '[]',
        description: 'x',
        closeComments: 0,
        pinned: 0,
      })
    ).toBeUndefined();
    postRepo.deletePost(p);
    expect(postRepo.getPostById(p)).toBeUndefined();
  });
});
