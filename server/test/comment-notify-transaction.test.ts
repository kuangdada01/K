/**
 * ============================================================
 * 评论 + 通知同事务测试
 * ============================================================
 * 此前评论 INSERT 成功后通知 INSERT 独立执行：通知失败时评论已提交、
 * 无通知也无 SSE，静默丢失。现在两条 INSERT 包进同一事务（同生共死），
 * SSE 在事务提交后才发。
 *
 * 通知失败用 SQLite 触发器 RAISE(ABORT) 注入（真实外键/IO 失败同型）。
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
let bobToken = '';
let aliceId = 0;
let bobId = 0;
let postIdByBob = 0;

async function post(path: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const commentCount = () => (db.prepare('SELECT COUNT(*) AS n FROM comments').get() as { n: number }).n;
const notificationCount = () =>
  (db.prepare('SELECT COUNT(*) AS n FROM notifications').get() as { n: number }).n;

beforeAll(async () => {
  db = createMemoryDb();
  setDbForTests(db);

  const insertUser = db.prepare(
    "INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, 'x', 'user')"
  );
  aliceId = Number(insertUser.run('alice', 'alice@test.com').lastInsertRowid);
  bobId = Number(insertUser.run('bob', 'bob@test.com').lastInsertRowid);
  aliceToken = generateToken({ id: aliceId, username: 'alice' });
  bobToken = generateToken({ id: bobId, username: 'bob' });

  postIdByBob = Number(
    db
      .prepare(
        "INSERT INTO posts (user_id, image_url, description, created_at) VALUES (?, '[]', 'bob 的帖子', '2026-01-01')"
      )
      .run(bobId).lastInsertRowid
  );

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

describe('评论 + 通知事务化', () => {
  it('正常路径：评论帖子 → 评论与作者通知都落库', async () => {
    const res = await post(`/api/posts/${postIdByBob}/comments`, aliceToken, { content: '好帖' });
    expect(res.status).toBe(201);

    const notification = db
      .prepare('SELECT user_id, type, post_id FROM notifications ORDER BY id DESC LIMIT 1')
      .get() as { user_id: number; type: string; post_id: number };
    expect(notification.user_id).toBe(bobId);
    expect(notification.type).toBe('comment');
    expect(notification.post_id).toBe(postIdByBob);
  });

  it('回复路径：通知发给被回复的评论作者', async () => {
    // alice 的评论（上一用例）
    const parent = db
      .prepare('SELECT id FROM comments WHERE post_id = ? ORDER BY id DESC LIMIT 1')
      .get(postIdByBob) as { id: number };

    const res = await post(`/api/posts/${postIdByBob}/comments`, bobToken, {
      content: '回复 alice',
      parentId: parent.id,
    });
    expect(res.status).toBe(201);

    const notification = db
      .prepare('SELECT user_id, type FROM notifications ORDER BY id DESC LIMIT 1')
      .get() as { user_id: number; type: string };
    expect(notification.user_id).toBe(aliceId);
    expect(notification.type).toBe('reply');
  });

  it('自己评论自己的帖子：不产生通知', async () => {
    const before = notificationCount();
    const res = await post(`/api/posts/${postIdByBob}/comments`, bobToken, { content: '自评' });
    expect(res.status).toBe(201);
    expect(notificationCount()).toBe(before);
  });

  it('通知写入失败 → 评论一并回滚（不出现「有评论无通知」的静默丢失）', async () => {
    db.exec(`
      CREATE TRIGGER fail_notify_insert
      BEFORE INSERT ON notifications
      BEGIN
        SELECT RAISE(ABORT, 'simulated notification failure');
      END;
    `);
    const before = commentCount();

    const res = await post(`/api/posts/${postIdByBob}/comments`, aliceToken, {
      content: '这条应当整体失败',
    });
    expect(res.status).toBe(500);
    expect(commentCount()).toBe(before); // 评论被回滚

    db.exec('DROP TRIGGER fail_notify_insert');
  });

  it('触发器移除后同端点恢复正常（事务不残留失败状态）', async () => {
    const res = await post(`/api/posts/${postIdByBob}/comments`, aliceToken, { content: '恢复' });
    expect(res.status).toBe(201);
  });
});
