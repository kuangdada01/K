/**
 * ============================================================
 * 清空会话的磁盘图片回收测试
 * ============================================================
 * 覆盖:
 * - DELETE /api/messages/:userId 清空双方消息后，消息引用的 uploads_private
 *   图片文件同步删除（此前只删 DB 行，文件永久累积成孤儿）
 * - 引用消息共享被引用行的物理文件（同一文件名只落一份，删行后统一回收）
 * - 其他会话（A↔C）的消息与文件不受影响
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
let tokenA = '';

/** 唯一文件名前缀，避免与其他测试/真实数据冲突 */
const uniq = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

function makePrivateFile(name: string): string {
  fs.mkdirSync(PATHS.uploadsPrivate, { recursive: true });
  const p = path.join(PATHS.uploadsPrivate, name);
  fs.writeFileSync(p, 'test-image');
  return p;
}

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  setDbForTests(db);

  const insertUser = db.prepare("INSERT INTO users (username, email, password_hash) VALUES (?, ?, 'x')");
  const userA = Number(insertUser.run('gc-a', 'gc-a@test.com').lastInsertRowid);
  const userB = Number(insertUser.run('gc-b', 'gc-b@test.com').lastInsertRowid);
  const userC = Number(insertUser.run('gc-c', 'gc-c@test.com').lastInsertRowid);
  tokenA = generateToken({ id: userA, username: 'gc-a' });

  const insertMsg = db.prepare(
    'INSERT INTO messages (sender_id, receiver_id, content, image_url) VALUES (?, ?, ?, ?)'
  );
  // A↔B：两条 A→B 带图 + 一条 B→A 带图 + 一条纯文字
  insertMsg.run(userA, userB, '看图1', `gc-${uniq}-ab1.jpg`);
  insertMsg.run(userA, userB, '看图2', `gc-${uniq}-ab2.jpg`);
  insertMsg.run(userB, userA, '回图', `gc-${uniq}-ab3.jpg`);
  insertMsg.run(userA, userB, '纯文字', null);
  // A↔C：另一会话的带图消息（清空 A↔B 不得波及）
  insertMsg.run(userA, userC, '其他会话的图', `gc-${uniq}-ac1.jpg`);

  // 文件真实落盘
  for (const name of [
    `gc-${uniq}-ab1.jpg`,
    `gc-${uniq}-ab2.jpg`,
    `gc-${uniq}-ab3.jpg`,
    `gc-${uniq}-ac1.jpg`,
  ]) {
    makePrivateFile(name);
  }

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

describe('清空会话的磁盘图片回收', () => {
  it('清空 A↔B 后消息行与引用的图片文件同步删除，其他会话不受影响', async () => {
    const userA = db.prepare("SELECT id FROM users WHERE username = 'gc-a'").get() as { id: number };
    const userB = db.prepare("SELECT id FROM users WHERE username = 'gc-b'").get() as { id: number };
    const userC = db.prepare("SELECT id FROM users WHERE username = 'gc-c'").get() as { id: number };

    const clearRes = await fetch(`${base}/api/messages/${userB.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(clearRes.status).toBe(200);

    // A↔B 的消息行（双向）全部删除
    const pairRows = db
      .prepare(
        `SELECT COUNT(*) AS c FROM messages
         WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)`
      )
      .get(userA.id, userB.id, userB.id, userA.id) as { c: number };
    expect(pairRows.c).toBe(0);

    // A↔B 的图片文件全部回收
    for (const name of [`gc-${uniq}-ab1.jpg`, `gc-${uniq}-ab2.jpg`, `gc-${uniq}-ab3.jpg`]) {
      expect(fs.existsSync(path.join(PATHS.uploadsPrivate, name))).toBe(false);
    }

    // 其他会话（A↔C）的消息行与文件保持原样
    const acRows = db
      .prepare('SELECT COUNT(*) AS c FROM messages WHERE sender_id = ? AND receiver_id = ?')
      .get(userA.id, userC.id) as { c: number };
    expect(acRows.c).toBe(1);
    expect(fs.existsSync(path.join(PATHS.uploadsPrivate, `gc-${uniq}-ac1.jpg`))).toBe(true);
  });
});
