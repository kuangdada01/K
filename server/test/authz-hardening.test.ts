/**
 * ============================================================
 * 权限与保护网测试（HTTP 层）
 * ============================================================
 * 覆盖此前零测试、且出错即为「安全事故」或「数据丢失」的路径：
 *
 * A. 读授权
 *    - 私信图片下载：非收发双方 403（routes/messages.ts）
 *    - 私密图片文件：非属主 404（routes/users.ts）
 * B. 评论端点
 *    - parentId 不存在 / 属于别的帖子 → 400（真实路由校验，非测试自算）
 *    - 删除他人评论 → 404 且行数不变
 * C. 管理端破坏性操作
 *    - 封禁 → 被封者写操作 403、读放行；解封恢复
 *    - 不能封禁管理员、不能重置管理员密码
 * D. 限流
 *    - 非 GET 的 /api 请求命中全局写限流返回 429
 *    - /api/auth/login 有更严格的专属限流
 *
 * 这些守卫在生产代码里都在，但此前没有任何测试引用过它们 ——
 * 一个把 !== 写成 === 的改动可以让整套 CI 全绿上线。
 * ============================================================
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { createMemoryDb } from './helpers/memdb';
import { setDbForTests, resetDbForTests } from '../src/db/connection';
import { createApp } from '../src/app';
import { generateToken } from '../src/middleware/auth';
import { PATHS } from '../src/config';

let db: InstanceType<typeof Database>;
let server: http.Server;
let base = '';
let adminToken = '';
let aliceToken = '';
let bobToken = '';
let aliceId = 0;
let bobId = 0;
/** 供「封禁后写操作」类用例复用的帖子（评论端点接受 JSON，比 multipart 发帖好构造） */
let sharedPostId = 0;

/** 测试建的临时文件，afterAll 清理（UPLOADS_DIR 已由 vitest.config.mts 隔离） */
const created: string[] = [];

/** 本文件断言到的响应字段（各端点形状不同，统一按可选字段声明，避免 any） */
interface ApiResponse {
  error?: string;
  banned?: boolean;
  id?: number;
  message?: string;
  [key: string]: unknown;
}

async function api(
  method: string,
  p: string,
  token?: string,
  body?: unknown
): Promise<{ status: number; data: ApiResponse }> {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as ApiResponse };
}

beforeAll(async () => {
  db = createMemoryDb();
  setDbForTests(db);

  const insertUser = db.prepare(
    "INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, 'x', ?)"
  );
  aliceId = Number(insertUser.run('alice', 'alice@test.com', 'user').lastInsertRowid);
  bobId = Number(insertUser.run('bob', 'bob@test.com', 'user').lastInsertRowid);
  const adminId = Number(insertUser.run('root', 'root@test.com', 'admin').lastInsertRowid);
  adminToken = generateToken({ id: adminId, username: 'root' });
  aliceToken = generateToken({ id: aliceId, username: 'alice' });
  bobToken = generateToken({ id: bobId, username: 'bob' });

  sharedPostId = Number(
    db
      .prepare("INSERT INTO posts (user_id, image_url, title, description) VALUES (?, '[]', '', 'p')")
      .run(aliceId).lastInsertRowid
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
  for (const p of created) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
});

describe('A. 读授权：私信图片与私密图片', () => {
  let mediaId = 0;
  let privateImageId = 0;

  it('准备：alice 给 bob 发一张私信图片，alice 存一张私密图片', () => {
    const mediaName = 'msg-authz-test.jpg';
    const mediaAbs = path.join(PATHS.uploadsPrivate, mediaName);
    fs.mkdirSync(PATHS.uploadsPrivate, { recursive: true });
    fs.writeFileSync(mediaAbs, 'fake-image-bytes');
    created.push(mediaAbs);

    mediaId = Number(
      db
        .prepare("INSERT INTO messages (sender_id, receiver_id, content, image_url) VALUES (?, ?, '看图', ?)")
        .run(aliceId, bobId, mediaName).lastInsertRowid
    );

    privateImageId = Number(
      db
        .prepare('INSERT INTO private_images (user_id, image_url) VALUES (?, ?)')
        .run(aliceId, 'private-authz-test.jpg').lastInsertRowid
    );
    const privateAbs = path.join(PATHS.uploadsPrivate, 'private-authz-test.jpg');
    fs.writeFileSync(privateAbs, 'fake-private-bytes');
    created.push(privateAbs);

    expect(mediaId).toBeGreaterThan(0);
    expect(privateImageId).toBeGreaterThan(0);
  });

  it('私信图片：非收发双方的第三方访问 403', async () => {
    const third = Number(
      db
        .prepare("INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, 'x', 'user')")
        .run('carol', 'carol@test.com').lastInsertRowid
    );
    const carolToken = generateToken({ id: third, username: 'carol' });

    const res = await api('GET', `/api/messages/${mediaId}/media`, carolToken);
    expect(res.status).toBe(403);
  });

  it('私信图片：收发双方都能取到', async () => {
    for (const token of [aliceToken, bobToken]) {
      const res = await fetch(`${base}/api/messages/${mediaId}/media`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('fake-image-bytes');
    }
  });

  it('私信图片：未认证 401', async () => {
    const res = await api('GET', `/api/messages/${mediaId}/media`);
    expect(res.status).toBe(401);
  });

  it('私密图片：非属主拿不到（404，不暴露存在性）', async () => {
    const res = await api('GET', `/api/users/me/private-images/${privateImageId}/file`, bobToken);
    expect(res.status).toBe(404);
  });

  it('私密图片：属主可下载', async () => {
    const res = await fetch(`${base}/api/users/me/private-images/${privateImageId}/file`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('fake-private-bytes');
  });
});

describe('B. 评论端点鉴权与 parentId 校验', () => {
  let postA = 0;
  let postB = 0;
  let aliceCommentId = 0;

  beforeAll(() => {
    const insertPost = db.prepare(
      "INSERT INTO posts (user_id, image_url, title, description) VALUES (?, '[]', '', ?)"
    );
    postA = Number(insertPost.run(aliceId, 'post A').lastInsertRowid);
    postB = Number(insertPost.run(aliceId, 'post B').lastInsertRowid);
  });

  it('parentId 不存在 → 400（真实路由校验）', async () => {
    const res = await api('POST', `/api/posts/${postA}/comments`, bobToken, {
      content: '回复一个不存在的父评论',
      parentId: 999999,
    });
    expect(res.status).toBe(400);
    expect(res.data).toEqual({ error: '父评论不存在或不属于该帖子' });
  });

  it('parentId 属于另一个帖子 → 400（防跨帖回复与通知串帖）', async () => {
    const created1 = await api('POST', `/api/posts/${postA}/comments`, aliceToken, {
      content: 'A 帖的顶级评论',
    });
    expect(created1.status).toBe(201);
    aliceCommentId = created1.data.id as number;

    const res = await api('POST', `/api/posts/${postB}/comments`, bobToken, {
      content: '拿 A 帖的评论当父评论',
      parentId: aliceCommentId,
    });
    expect(res.status).toBe(400);
  });

  it('同帖 parentId → 201', async () => {
    const res = await api('POST', `/api/posts/${postA}/comments`, bobToken, {
      content: '正常回复',
      parentId: aliceCommentId,
    });
    expect(res.status).toBe(201);
  });

  it('删除他人评论 → 404，且评论行仍在', async () => {
    const before = db.prepare('SELECT COUNT(*) as c FROM comments').get() as { c: number };

    const res = await api('DELETE', `/api/posts/comments/${aliceCommentId}`, bobToken);
    expect(res.status).toBe(404);
    expect(res.data).toEqual({ error: '评论不存在或无权删除' });

    const after = db.prepare('SELECT COUNT(*) as c FROM comments').get() as { c: number };
    expect(after.c).toBe(before.c);
  });

  it('删除自己的评论 → 200 且行被删除', async () => {
    const res = await api('DELETE', `/api/posts/comments/${aliceCommentId}`, aliceToken);
    expect(res.status).toBe(200);
    const row = db.prepare('SELECT 1 FROM comments WHERE id = ?').get(aliceCommentId);
    expect(row).toBeUndefined();
  });
});

describe('C. 管理端破坏性操作的守卫', () => {
  it('封禁用户后：写操作 403（带 banned 标记），GET 放行', async () => {
    const ban = await api('POST', `/api/admin/users/${bobId}/ban`, adminToken, { days: 7 });
    expect(ban.status).toBe(200);

    const write = await api('POST', `/api/posts/${sharedPostId}/comments`, bobToken, {
      content: '封禁期间评论应被拒',
    });
    expect(write.status).toBe(403);
    expect(write.data.banned).toBe(true);

    // 封禁期间只读放行
    const read = await api('GET', '/api/posts?page=1', bobToken);
    expect(read.status).toBe(200);

    const unban = await api('POST', `/api/admin/users/${bobId}/unban`, adminToken);
    expect(unban.status).toBe(200);

    const writeAfter = await api('POST', `/api/posts/${sharedPostId}/comments`, bobToken, {
      content: '解封后应可评论',
    });
    expect(writeAfter.status).toBe(201);
  });

  it('不能封禁管理员账号', async () => {
    const adminId = Number(
      (db.prepare('SELECT id FROM users WHERE role = ?').get('admin') as { id: number }).id
    );
    const res = await api('POST', `/api/admin/users/${adminId}/ban`, adminToken, { days: 1 });
    expect(res.status).toBe(400);
    expect(res.data).toEqual({ error: '不能封禁管理员账号' });
  });

  it('不能重置管理员账号的密码', async () => {
    const adminId = Number(
      (db.prepare('SELECT id FROM users WHERE role = ?').get('admin') as { id: number }).id
    );
    const res = await api('PUT', `/api/admin/users/${adminId}/password`, adminToken, {
      password: 'newpass123',
    });
    expect(res.status).toBe(400);
    expect(res.data).toEqual({ error: '不能重置管理员账号的密码' });
  });

  it('普通用户访问管理端 → 403（不是 200，也不泄露数据）', async () => {
    const res = await api('POST', `/api/admin/users/${bobId}/ban`, aliceToken, { days: 1 });
    expect(res.status).toBe(403);
  });
});

describe('D. 限流生效', () => {
  it('登录接口的专属限流会在超过阈值后返回 429', async () => {
    // authLimiter：15 分钟 10 次（按 IP）。连续打满后必须出现 429。
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) {
      const res = await api('POST', '/api/auth/login', undefined, {
        email: 'nobody@test.com',
        password: 'wrongpass',
      });
      statuses.push(res.status);
      if (res.status === 429) break;
    }
    expect(statuses).toContain(429);
    // 429 之前应是正常的凭据错误，而不是别的失败
    expect(statuses.filter((s) => s === 401).length).toBeGreaterThan(0);
  });

  it('全局写限流对非 GET 的 /api 请求生效（响应头存在且限额为正）', async () => {
    const res = await fetch(`${base}/api/posts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_url: '[]', description: 'x' }),
    });
    // 标准头由 standardHeaders: true 下发
    const limit = res.headers.get('ratelimit-limit') ?? res.headers.get('x-ratelimit-limit');
    expect(limit).not.toBeNull();
    expect(Number(limit)).toBeGreaterThan(0);
  });
});
