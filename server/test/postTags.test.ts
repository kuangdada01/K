/**
 * ============================================================
 * 话题（#标签）功能测试
 * ============================================================
 * 覆盖:
 * - shared extractTags 解析规则（中英文、截断、去重、超长忽略、数量上限）
 * - postRepo.syncPostTags 同步（先删后插、编辑后重同步、删帖级联）
 * - postRepo.searchPosts 按 tag 精确匹配（不误命中前缀相似话题）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../src/db/schema';
import { setDbForTests, resetDbForTests } from '../src/db/connection';
import * as postRepo from '../src/repositories/post.repo';
import { extractTags } from '@k/shared';

let db: InstanceType<typeof Database>;

beforeAll(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  setDbForTests(db);

  const insertUser = db.prepare(
    "INSERT INTO users (username, email, password_hash) VALUES (?, ?, 'x')"
  );
  insertUser.run('alice', 'alice@test.com');
  insertUser.run('bob', 'bob@test.com');
});

afterAll(() => {
  resetDbForTests();
  db.close();
});

function createPostWithTags(userId: number, description: string) {
  const post = postRepo.createPost({
    userId,
    imageUrl: '["/uploads/test.jpg"]',
    title: '',
    description,
    closeComments: 0,
    pinned: 0,
  });
  postRepo.syncPostTags(post.id, extractTags(description));
  return post;
}

function tagsOf(postId: number): string[] {
  return (db.prepare('SELECT tag FROM post_tags WHERE post_id = ? ORDER BY id').all(postId) as { tag: string }[])
    .map(r => r.tag);
}

describe('extractTags 解析规则', () => {
  it('解析中文与英文话题', () => {
    expect(extractTags('今天去了#杭州 西湖 #travel')).toEqual(['杭州', 'travel']);
  });

  it('遇空格、标点、下一个 # 截断', () => {
    expect(extractTags('#美食，#旅行。#a#b')).toEqual(['美食', '旅行', 'a', 'b']);
  });

  it('去重并保留首次出现顺序', () => {
    expect(extractTags('#摄影 和 #摄影#摄影')).toEqual(['摄影']);
  });

  it('超长话题整体忽略（不入库不搜索）', () => {
    const long = 'x'.repeat(31);
    expect(extractTags(`#${long}#正常`)).toEqual(['正常']);
  });

  it('最多解析 10 个话题', () => {
    const text = Array.from({ length: 15 }, (_, i) => `#tag${i}`).join(' ');
    expect(extractTags(text)).toHaveLength(10);
  });

  it('纯符号不构成话题', () => {
    expect(extractTags('# #! #，##')).toEqual([]);
  });
});

describe('post_tags 同步与搜索', () => {
  it('创建帖子后话题入库，可按 tag 精确搜索', () => {
    createPostWithTags(1, '周末爬山#徒步 #周末');
    createPostWithTags(2, ' another #周末愉快 的帖子');

    const { posts, total } = postRepo.searchPosts('', 1, 20, undefined, '徒步');
    expect(total).toBe(1);
    expect(posts[0].description).toContain('#徒步');
  });

  it('tag 精确匹配：#周末 不命中 #周末愉快', () => {
    const { total } = postRepo.searchPosts('', 1, 20, undefined, '周末');
    expect(total).toBe(1); // 只有 "#周末"，不含 "#周末愉快"
  });

  it('编辑描述后重新同步话题', () => {
    const post = createPostWithTags(1, '#旧话题');
    expect(tagsOf(post.id)).toEqual(['旧话题']);

    postRepo.updatePost({
      postId: post.id,
      userId: 1,
      imageUrl: '["/uploads/test.jpg"]',
      description: '改成了#新话题',
      closeComments: 0,
      pinned: 0,
    });
    postRepo.syncPostTags(post.id, extractTags('改成了#新话题'));

    expect(tagsOf(post.id)).toEqual(['新话题']);
    expect(postRepo.searchPosts('', 1, 20, undefined, '旧话题').total).toBe(0);
    expect(postRepo.searchPosts('', 1, 20, undefined, '新话题').total).toBe(1);
  });

  it('删除帖子级联清理话题记录', () => {
    const post = createPostWithTags(2, '#待删除');
    postRepo.deletePost(post.id);
    expect(tagsOf(post.id)).toEqual([]);
    expect(postRepo.searchPosts('', 1, 20, undefined, '待删除').total).toBe(0);
  });
});
