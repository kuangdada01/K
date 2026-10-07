/**
 * ============================================================
 * 权限矩阵回归测试（最敏感路径的最小防护网）
 * ============================================================
 * 覆盖:
 * - 管理接口: 未认证 401 / 普通用户 403（列表、删号、发公告）
 * - 写接口: 未认证 401；普通用户 PUT/DELETE 他人帖子 404（不暴露存在性）
 * - 临时视频属主: 他人删除/冒用 403，属主本人正常放行
 * - reset-password 防邮箱枚举: 未注册邮箱与已注册但验证码错误响应完全一致
 *
 * 这些路径此前零覆盖（auth/admin 中间件无任何测试引用），回归只能靠手工。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { createMemoryDb } from './helpers/memdb';
import { setDbForTests, resetDbForTests } from '../src/db/connection';
import { createApp } from '../src/app';
import { generateToken } from '../src/middleware/auth';
import { PATHS } from '../src/config';
import { TEMP_VIDEO_NAME_RE, getChunkOwner } from '../src/lib/chunkUploadRegistry';

let db: InstanceType<typeof Database>;
let server: http.Server;
let base = '';
let adminToken = '';
let userAToken = '';
let userBToken = '';
let postAId = 0;

beforeAll(async () => {
  db = createMemoryDb();
  setDbForTests(db);

  const insertUser = db.prepare(
    "INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, 'x', ?)"
  );
  const userAId = Number(insertUser.run('owner-a', 'usera@test.com', 'user').lastInsertRowid);
  const userBId = Number(insertUser.run('other-b', 'userb@test.com', 'user').lastInsertRowid);
  const adminId = Number(insertUser.run('admin', 'admin@test.com', 'admin').lastInsertRowid);
  adminToken = generateToken({ id: adminId, username: 'admin' });
  userAToken = generateToken({ id: userAId, username: 'owner-a' });
  userBToken = generateToken({ id: userBId, username: 'other-b' });

  const insertPost = db.prepare(
    "INSERT INTO posts (user_id, image_url, title, description) VALUES (?, ?, '', 'post by A')"
  );
  postAId = Number(insertPost.run(userAId, '["/uploads/pm-x-1.jpg"]').lastInsertRowid);

  // 帖子引用的图片文件真实落盘（编辑防数据丢失用例需要验证文件存活）
  fs.mkdirSync(PATHS.uploads, { recursive: true });
  fs.writeFileSync(path.join(PATHS.uploads, 'pm-x-1.jpg'), 'test');

  const app = createApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  resetDbForTests();
  db.close();
});

async function api(method: string, p: string, token?: string, body?: unknown) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    // 条件展开而非 body: undefined —— exactOptionalPropertyTypes 下
    // RequestInit.body 不接受显式的 undefined
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

/** 通过真实接口上传一个 2KB 的假 mp4 到临时目录（会登记属主），返回 { name, url } */
async function uploadTempVideo(token: string) {
  const form = new FormData();
  form.append('video', new Blob([new Uint8Array(2048)], { type: 'video/mp4' }), 'pm-test.mp4');
  const res = await fetch(`${base}/api/posts/video-temp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const data = (await res.json()) as { url?: string };
  expect(res.status).toBe(201);
  const url = data.url as string;
  return { url, name: url.split('/').pop() as string };
}

describe('管理接口权限', () => {
  it('未认证访问 → 401', async () => {
    const res = await api('GET', '/api/admin/users');
    expect(res.status).toBe(401);
  });

  it('普通用户访问各管理接口 → 403', async () => {
    for (const [method, path] of [
      ['GET', '/api/admin/users'],
      ['GET', '/api/admin/posts'],
      ['DELETE', '/api/admin/users/999999'],
      ['POST', '/api/admin/announcements'],
    ] as const) {
      const res = await api(
        method,
        path,
        userBToken,
        method === 'POST' ? { title: 'x', content: 'y' } : undefined
      );
      expect(res.status).toBe(403);
    }
  });

  it('管理员访问 → 200', async () => {
    const res = await api('GET', '/api/admin/users', adminToken);
    expect(res.status).toBe(200);
  });
});

describe('他人资源操作', () => {
  it('未认证发帖 → 401', async () => {
    const res = await api('POST', '/api/posts', undefined, {});
    expect(res.status).toBe(401);
  });

  it('普通用户编辑/删除他人帖子 → 404（不暴露存在性）', async () => {
    const putRes = await api('PUT', `/api/posts/${postAId}`, userBToken, { description: 'hacked' });
    expect(putRes.status).toBe(404);
    const delRes = await api('DELETE', `/api/posts/${postAId}`, userBToken);
    expect(delRes.status).toBe(404);
  });

  it('属主编辑自己的帖子（keepImages 命中）→ 200', async () => {
    const putRes = await api('PUT', `/api/posts/${postAId}`, userAToken, {
      description: 'mine',
      keepImages: ['/uploads/pm-x-1.jpg'],
    });
    expect(putRes.status, `response: ${JSON.stringify(putRes.data)}`).toBe(200);
  });

  it('编辑被 400 拒绝时旧图片文件不被物理删除（防数据丢失回归）', async () => {
    const imgPath = path.join(PATHS.uploads, 'pm-x-1.jpg');
    expect(fs.existsSync(imgPath)).toBe(true);
    // 不带 keepImages 且无新图 → 校验 400；修复前旧图文件此时已被删除
    const putRes = await api('PUT', `/api/posts/${postAId}`, userAToken, { description: 'x' });
    expect(putRes.status).toBe(400);
    expect(fs.existsSync(imgPath)).toBe(true);
  });
});

describe('临时视频属主（防删除/冒用他人草稿）', () => {
  it('他人 DELETE /video-temp 与 POST /video 冒用 → 403，属主本人 → 正常', async () => {
    const { url, name } = await uploadTempVideo(userAToken);

    const delByOther = await api('DELETE', '/api/posts/video-temp', userBToken, { url });
    expect(delByOther.status).toBe(403);

    const useByOther = await fetch(`${base}/api/posts/video`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userBToken}` },
      body: (() => {
        const form = new FormData();
        form.set('video_url', url);
        return form;
      })(),
    });
    expect(useByOther.status).toBe(403);

    // 属主本人放弃发布：正常删除
    const delByOwner = await api('DELETE', '/api/posts/video-temp', userAToken, { url });
    expect(delByOwner.status).toBe(200);
    expect(delByOwner.data).toEqual({ ok: true });
    // 断言「确实删掉了东西」而不只是回了 200：文件形状是服务端生成的临时视频名，
    // 且落盘文件与分片会话都应被回收（此前的 expect(name).toBeTruthy() 近乎空断言）
    expect(name).toMatch(TEMP_VIDEO_NAME_RE);
    expect(fs.existsSync(path.join(PATHS.uploadsTemp, name))).toBe(false);
    expect(getChunkOwner(name)).toBeUndefined();
  });
});

describe('reset-password 防邮箱枚举', () => {
  it('未注册邮箱与已注册但验证码错误 → 完全一致的 400 响应', async () => {
    const unregistered = await api('POST', '/api/auth/reset-password', undefined, {
      email: 'never-registered@test.com',
      code: '000000',
      password: 'newpass123',
    });
    const registered = await api('POST', '/api/auth/reset-password', undefined, {
      email: 'userb@test.com',
      code: '000000',
      password: 'newpass123',
    });
    expect(unregistered.status).toBe(400);
    expect(registered.status).toBe(400);
    expect(unregistered.data).toEqual(registered.data);
  });
});

describe('评论点赞对不存在评论的处理', () => {
  it('点赞不存在的评论返回 404 而非 500（外键约束不再泄漏为服务器错误）', async () => {
    const like = await api('POST', '/api/posts/comments/999999/like', userAToken);
    expect(like.status).toBe(404);
    expect(like.data).toEqual({ error: '评论不存在' });

    const unlike = await api('DELETE', '/api/posts/comments/999999/like', userAToken);
    expect(unlike.status).toBe(404);
  });

  it('点赞真实存在的评论仍返回 200 与正确计数', async () => {
    const inserted = db
      .prepare("INSERT INTO comments (post_id, user_id, content) VALUES (?, ?, 'hi')")
      .run(
        postAId,
        Number((db.prepare('SELECT id FROM users WHERE username = ?').get('owner-a') as { id: number }).id)
      );
    const commentId = Number(inserted.lastInsertRowid);

    const like = await api('POST', `/api/posts/comments/${commentId}/like`, userBToken);
    expect(like.status).toBe(200);
    expect(like.data).toEqual({ liked: true, like_count: 1 });

    const unlike = await api('DELETE', `/api/posts/comments/${commentId}/like`, userBToken);
    expect(unlike.status).toBe(200);
    expect(unlike.data).toEqual({ liked: false, like_count: 0 });
  });
});
