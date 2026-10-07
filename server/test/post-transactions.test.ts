/**
 * ============================================================
 * 业务事务与文件补偿测试（P1-3.5）
 * ============================================================
 * - createPostWithTags / updatePostWithTags：帖子行与话题在同一事务，
 *   话题表写入失败 → 整条回滚（无半完成记录）
 * - recallMessage：**先提交 DB 再删文件** —— DB 失败时文件原样保留
 *   （旧实现反序：DB 失败会留下指向已删文件的死链）
 * ============================================================
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { createMemoryDb } from './helpers/memdb';
import { setDbForTests, resetDbForTests, getDb } from '../src/db/connection';
import { PATHS } from '../src/config';
import * as postRepo from '../src/repositories/post.repo';
import { recallMessage } from '../src/services/message.service';
import { enqueueVideoTranscode } from '../src/lib/video/queue';

let db: InstanceType<typeof Database>;
let aliceId = 0;
let bobId = 0;

/** 破坏话题表（触发 syncPostTags 失败）；finally 里恢复 */
function breakPostTags<T>(block: () => T): T {
  db.exec('ALTER TABLE post_tags RENAME TO post_tags_bak');
  try {
    return block();
  } finally {
    db.exec('ALTER TABLE post_tags_bak RENAME TO post_tags');
  }
}

/** 破坏消息表（触发 deleteMessage 失败）；finally 里恢复 */
function breakMessages<T>(block: () => T): T {
  db.exec('ALTER TABLE messages RENAME TO messages_bak');
  try {
    return block();
  } finally {
    db.exec('ALTER TABLE messages_bak RENAME TO messages');
  }
}

beforeAll(() => {
  db = createMemoryDb();
  setDbForTests(db);
  const insertUser = db.prepare(
    "INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, 'x', 'user')"
  );
  aliceId = Number(insertUser.run('alice', 'alice@test.com').lastInsertRowid);
  bobId = Number(insertUser.run('bob', 'bob@test.com').lastInsertRowid);
});

afterAll(() => {
  resetDbForTests();
  db?.close();
});

describe('帖子与话题的原子事务', () => {
  it('createPostWithTags：话题写入失败 → 帖子行一并回滚（无半完成记录）', () => {
    expect(() =>
      breakPostTags(() =>
        postRepo.createPostWithTags(
          {
            userId: aliceId,
            imageUrl: '[]',
            title: 't',
            description: '正文 #话题',
            location: '',
            closeComments: 0,
            pinned: 0,
          },
          ['话题']
        )
      )
    ).toThrow();

    const posts = getDb().prepare('SELECT COUNT(*) AS c FROM posts').get() as { c: number };
    expect(posts.c).toBe(0); // 帖子行没有留下
  });

  it('createPostWithTags：成功时帖子与话题同生', () => {
    const post = postRepo.createPostWithTags(
      {
        userId: aliceId,
        imageUrl: '[]',
        title: 't',
        description: '你好 #旅行 #夜景',
        location: '',
        closeComments: 0,
        pinned: 0,
      },
      ['旅行', '夜景']
    );
    const tags = getDb().prepare('SELECT tag FROM post_tags WHERE post_id = ? ORDER BY tag').all(post.id) as {
      tag: string;
    }[];
    expect(tags.map((t) => t.tag)).toEqual(['夜景', '旅行']);
  });

  it('updatePostWithTags：话题同步失败 → 正文/图片更新一并回滚', () => {
    const post = postRepo.createPostWithTags(
      {
        userId: aliceId,
        imageUrl: '["/uploads/a.jpg"]',
        title: 't',
        description: '旧正文 #旧话题',
        location: '',
        closeComments: 0,
        pinned: 0,
      },
      ['旧话题']
    );

    expect(() =>
      breakPostTags(() =>
        postRepo.updatePostWithTags(
          {
            postId: post.id,
            userId: aliceId,
            imageUrl: '["/uploads/b.jpg"]',
            description: '新正文',
            location: '',
            closeComments: 0,
            pinned: 0,
          },
          []
        )
      )
    ).toThrow();

    // 回滚：正文与图片仍是旧值
    const row = getDb().prepare('SELECT description, image_url FROM posts WHERE id = ?').get(post.id) as {
      description: string;
      image_url: string;
    };
    expect(row.description).toBe('旧正文 #旧话题');
    expect(row.image_url).toBe('["/uploads/a.jpg"]');
  });

  it('updatePostWithTags：成功时行与话题一起更新', () => {
    const post = postRepo.createPostWithTags(
      {
        userId: aliceId,
        imageUrl: '[]',
        title: 't',
        description: '旧正文',
        location: '',
        closeComments: 0,
        pinned: 0,
      },
      []
    );
    const updated = postRepo.updatePostWithTags(
      {
        postId: post.id,
        userId: aliceId,
        imageUrl: '[]',
        description: '新正文 #新话题',
        location: '',
        closeComments: 0,
        pinned: 0,
      },
      ['新话题']
    );
    expect(updated?.description).toBe('新正文 #新话题');
    const tags = getDb().prepare('SELECT tag FROM post_tags WHERE post_id = ?').all(post.id) as {
      tag: string;
    }[];
    expect(tags.map((t) => t.tag)).toEqual(['新话题']);
  });
});

describe('私信撤回的顺序（先 DB 后文件）', () => {
  const mediaFile = path.join(PATHS.uploadsPrivate ?? PATHS.uploads, `recall-test-${Date.now()}.jpg`);

  function insertMessage(imageUrl: string): number {
    const info = getDb()
      .prepare(
        'INSERT INTO messages (sender_id, receiver_id, content, image_url, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(aliceId, bobId, '带图消息', imageUrl, new Date().toISOString());
    return Number(info.lastInsertRowid);
  }

  beforeAll(() => {
    fs.mkdirSync(path.dirname(mediaFile), { recursive: true });
  });

  afterAll(() => {
    if (fs.existsSync(mediaFile)) fs.unlinkSync(mediaFile);
  });

  it('DB 删除失败时文件不被删除（旧实现会留下指向已删文件的死链）', () => {
    fs.writeFileSync(mediaFile, 'image-bytes');
    const id = insertMessage(`/uploads_private/${path.basename(mediaFile)}`);

    expect(() => breakMessages(() => recallMessage(aliceId, id))).toThrow();

    // 文件原样保留：DB 回滚后消息仍指向有效文件，状态一致
    expect(fs.existsSync(mediaFile)).toBe(true);
  });

  it('DB 删除成功后文件随之回收', () => {
    fs.writeFileSync(mediaFile, 'image-bytes-2');
    const id = insertMessage(`/uploads_private/${path.basename(mediaFile)}`);

    recallMessage(aliceId, id);

    expect(fs.existsSync(mediaFile)).toBe(false);
    const row = getDb().prepare('SELECT 1 FROM messages WHERE id = ?').get(id);
    expect(row).toBeUndefined();
  });

  it('非发送者撤回被拒绝（403），DB 与文件都不动', () => {
    fs.writeFileSync(mediaFile, 'image-bytes-3');
    const id = insertMessage(`/uploads_private/${path.basename(mediaFile)}`);

    expect(() => recallMessage(bobId, id)).toThrow(/只能撤回自己发送的消息/);
    expect(fs.existsSync(mediaFile)).toBe(true);
  });
});

// 引用 enqueueVideoTranscode 仅为确保队列模块被加载（recall 的清理补偿依赖它）
void enqueueVideoTranscode;
