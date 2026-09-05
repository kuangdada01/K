/**
 * ============================================================
 * 管理端删除的磁盘文件清理测试
 * ============================================================
 * 覆盖:
 * - DELETE /api/admin/posts/:id 删帖后图片/视频/封面文件同步删除
 * - DELETE /api/admin/users/:id 删号后头像/帖子媒体/私密图片/私信图片
 *   与验证码记录同步删除（修复：原实现只删库行，磁盘文件永久残留）
 * - 帖子不存在返回 404 且不动文件
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { createSchema } from '../src/db/schema';
import { setDbForTests, resetDbForTests } from '../src/db/connection';
import { createApp } from '../src/app';
import { generateToken } from '../src/middleware/auth';
import { PATHS } from '../src/config';

let db: InstanceType<typeof Database>;
let server: http.Server;
let base = '';
let adminToken = '';
let adminId = 0;
let userId = 0;
/** 唯一文件名前缀，避免与其他测试/真实数据冲突（uploads 目录已 gitignore） */
const uniq = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

function makeFile(dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, 'test');
  return p;
}

beforeAll(async () => {
  db = new Database(':memory:');
  // 与生产一致：foreign_keys = ON（级联删除依赖外键）
  db.pragma('foreign_keys = ON');
  createSchema(db);
  setDbForTests(db);

  const insertUser = db.prepare(
    "INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, 'x', ?)"
  );
  userId = Number(insertUser.run('victim', 'victim@test.com', 'user').lastInsertRowid);
  adminId = Number(insertUser.run('admin', 'admin@test.com', 'admin').lastInsertRowid);
  adminToken = generateToken({ id: adminId, username: 'admin' });

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

async function api(method: string, p: string, token?: string) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

describe('管理员删帖的文件清理', () => {
  it('删帖后图片/视频/封面文件同步删除', async () => {
    const img1 = makeFile(PATHS.uploads, `ac-${uniq}-1.jpg`);
    const img2 = makeFile(PATHS.uploads, `ac-${uniq}-2.jpg`);
    const video = makeFile(PATHS.uploads, `ac-${uniq}.mp4`);
    const cover = makeFile(PATHS.uploads, `ac-${uniq}-cover.jpg`);
    const postId = Number(
      db
        .prepare('INSERT INTO posts (user_id, image_url, video_url, video_cover) VALUES (?, ?, ?, ?)')
        .run(
          userId,
          JSON.stringify([`/uploads/${path.basename(img1)}`, `/uploads/${path.basename(img2)}`]),
          `/uploads/${path.basename(video)}`,
          `/uploads/${path.basename(cover)}`
        ).lastInsertRowid
    );

    const { status } = await api('DELETE', `/api/admin/posts/${postId}`, adminToken);
    expect(status).toBe(200);
    for (const p of [img1, img2, video, cover]) {
      expect(fs.existsSync(p)).toBe(false);
    }
  });

  it('删不存在的帖子返回 404', async () => {
    const { status } = await api('DELETE', '/api/admin/posts/999999', adminToken);
    expect(status).toBe(404);
  });
});

describe('管理员删号的文件清理', () => {
  it('删号后头像/帖子媒体/私密图片/私信图片与验证码记录同步删除', async () => {
    const avatar = makeFile(PATHS.avatars, `ac-${uniq}-avatar.jpg`);
    const postImg = makeFile(PATHS.uploads, `ac-${uniq}-post.jpg`);
    const postVideo = makeFile(PATHS.uploads, `ac-${uniq}-post.mp4`);
    const privateImg = makeFile(PATHS.uploadsPrivate, `ac-${uniq}-private.jpg`);
    const msgImg = makeFile(PATHS.uploadsPrivate, `ac-${uniq}-msg.jpg`);

    db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(
      `/uploads/avatars/${path.basename(avatar)}`,
      userId
    );
    db.prepare('INSERT INTO posts (user_id, image_url, video_url) VALUES (?, ?, ?)').run(
      userId,
      JSON.stringify([`/uploads/${path.basename(postImg)}`]),
      `/uploads/${path.basename(postVideo)}`
    );
    db.prepare('INSERT INTO private_images (user_id, image_url) VALUES (?, ?)').run(
      userId,
      path.basename(privateImg)
    );
    db.prepare('INSERT INTO messages (sender_id, receiver_id, content, image_url) VALUES (?, ?, ?, ?)').run(
      userId,
      adminId,
      'hi',
      path.basename(msgImg)
    );
    db.prepare('INSERT INTO verification_codes (email, code, expires) VALUES (?, ?, ?)').run(
      'victim@test.com',
      '123456',
      new Date(Date.now() + 3600_000).toISOString()
    );

    const { status } = await api('DELETE', `/api/admin/users/${userId}`, adminToken);
    expect(status).toBe(200);

    for (const p of [avatar, postImg, postVideo, privateImg, msgImg]) {
      expect(fs.existsSync(p)).toBe(false);
    }
    expect(db.prepare('SELECT COUNT(*) as c FROM users WHERE id = ?').get(userId)).toEqual({ c: 0 });
    expect(
      db.prepare('SELECT COUNT(*) as c FROM verification_codes WHERE email = ?').get('victim@test.com')
    ).toEqual({ c: 0 });
  });
});
