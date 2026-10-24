/**
 * ============================================================
 * 举报与拉黑（2026-10-24，契约测试）
 * ============================================================
 * 私信文件类型放开后的配套处置通道，覆盖：
 *  1. 拉黑：POST/DELETE /:userId/block、GET /blocks 列表；
 *     拉黑后**双向**发消息 403（文案按方向区分），解除后恢复；
 *  2. 举报：POST /:id/report —— 收件人可举报（文件消息算 sha256 落库），
 *     非收件人 403，重复举报幂等；
 *  3. 管理端：GET /admin/reports（open 过滤 + 用户名上下文）、
 *     POST /:id/resolve —— delete 复用撤回语义（行留痕 + 附件删除 + 双方 SSE）、
 *     dismiss 只标状态；非管理员 403。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { createMemoryDb } from './helpers/memdb';
import { setDbForTests, resetDbForTests } from '../src/db/connection';
import { createApp } from '../src/app';
import { generateToken } from '../src/middleware/auth';
import { PATHS } from '../src/config';

let db: InstanceType<typeof Database>;
let server: http.Server;
let base = '';

const uniq = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
const APK_BYTES = Buffer.from('PK fake apk body for report test');

let adminId = 0;
let userA = 0; // 发送方（被举报人 / 被拉黑人）
let userB = 0; // 接收方（举报人 / 拉黑人）
let userC = 0; // 无关人
let tokenAdmin = '';
let tokenA = '';
let tokenB = '';
let tokenC = '';

/** A → B 发一条文件消息，返回消息 id */
async function sendApkToB(): Promise<number> {
  const form = new FormData();
  form.append('receiverId', String(userB));
  form.append(
    'file',
    new Blob([new Uint8Array(APK_BYTES)], { type: 'application/vnd.android.package-archive' }),
    `evil-${uniq}.apk`
  );
  const res = await fetch(`${base}/api/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenA}` },
    body: form,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: number }).id;
}

function authPost(token: string, p: string, body?: unknown) {
  return fetch(`${base}${p}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    // exactOptionalPropertyTypes：body 为空时不能显式传 undefined
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function storedFileOf(messageId: number): string {
  const row = db.prepare('SELECT file_url FROM messages WHERE id = ?').get(messageId) as {
    file_url: string | null;
  };
  return row.file_url ?? '';
}

beforeAll(async () => {
  db = createMemoryDb();
  setDbForTests(db);

  const insert = db.prepare("INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, 'x', ?)");
  adminId = Number(insert.run(`boss-${uniq}`, `boss-${uniq}@test.com`, 'admin').lastInsertRowid);
  userA = Number(insert.run(`a-${uniq}`, `a-${uniq}@test.com`, 'user').lastInsertRowid);
  userB = Number(insert.run(`b-${uniq}`, `b-${uniq}@test.com`, 'user').lastInsertRowid);
  userC = Number(insert.run(`c-${uniq}`, `c-${uniq}@test.com`, 'user').lastInsertRowid);

  tokenAdmin = generateToken({ id: adminId, username: `boss-${uniq}` });
  tokenA = generateToken({ id: userA, username: `a-${uniq}` });
  tokenB = generateToken({ id: userB, username: `b-${uniq}` });
  tokenC = generateToken({ id: userC, username: `c-${uniq}` });

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

describe('拉黑', () => {
  it('拉黑自己 → 400；拉黑不存在的人 → 404', async () => {
    const self = await authPost(tokenB, `/api/messages/${userB}/block`);
    expect(self.status).toBe(400);
    const ghost = await authPost(tokenB, '/api/messages/999999/block');
    expect(ghost.status).toBe(404);
  });

  it('B 拉黑 A 后：A 发不出去（对方暂不接受），B 也发不出去（你已拉黑）', async () => {
    const block = await authPost(tokenB, `/api/messages/${userA}/block`);
    expect(block.status).toBe(200);

    const fromA = await fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ receiverId: userB, content: '还发吗' }),
    });
    expect(fromA.status).toBe(403);
    expect(((await fromA.json()) as { error: string }).error).toContain('对方暂不接受');

    const fromB = await fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ receiverId: userA, content: '我也发不了' }),
    });
    expect(fromB.status).toBe(403);
    expect(((await fromB.json()) as { error: string }).error).toContain('你已拉黑');
  });

  it('GET /blocks 返回我的拉黑列表；解除后双向恢复', async () => {
    const list = await fetch(`${base}/api/messages/blocks`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(((await list.json()) as { blocked_ids: number[] }).blocked_ids).toContain(userA);

    const unblock = await fetch(`${base}/api/messages/${userA}/block`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(unblock.status).toBe(200);

    const again = await fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ receiverId: userB, content: '和好了' }),
    });
    expect(again.status).toBe(201);
  });
});

describe('举报', () => {
  it('收件人举报文件消息 → 201，sha256 与磁盘内容一致；重复举报幂等', async () => {
    const messageId = await sendApkToB();

    const report = await authPost(tokenB, `/api/messages/${messageId}/report`, {
      reason: '恶意文件或诈骗',
    });
    expect(report.status).toBe(201);

    const rows = db.prepare('SELECT * FROM message_reports WHERE message_id = ?').all(messageId) as {
      reporter_id: number;
      sender_id: number;
      reason: string;
      file_sha256: string | null;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reporter_id).toBe(userB);
    expect(rows[0]!.sender_id).toBe(userA);
    expect(rows[0]!.reason).toBe('恶意文件或诈骗');
    const expected = crypto.createHash('sha256').update(APK_BYTES).digest('hex');
    expect(rows[0]!.file_sha256).toBe(expected);

    // 重复举报：仍然成功，但不新增行（防刷从表结构开始）
    const dup = await authPost(tokenB, `/api/messages/${messageId}/report`, { reason: '再报一次' });
    expect(dup.status).toBe(201);
    const count = (
      db.prepare('SELECT COUNT(*) as n FROM message_reports WHERE message_id = ?').get(messageId) as {
        n: number;
      }
    ).n;
    expect(count).toBe(1);
  });

  it('非收件人举报 → 403（无关的人根本看不到这条消息）', async () => {
    const messageId = await sendApkToB();
    const res = await authPost(tokenC, `/api/messages/${messageId}/report`, { reason: 'x' });
    expect(res.status).toBe(403);
  });
});

describe('管理端处置', () => {
  it('非管理员访问 → 403', async () => {
    const list = await fetch(`${base}/api/admin/reports`, {
      headers: { Authorization: `Bearer ${tokenC}` },
    });
    expect(list.status).toBe(403);
  });

  it('列表带用户名与消息上下文（open 过滤）', async () => {
    const res = await fetch(`${base}/api/admin/reports?status=open`, {
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      reports: {
        reporter_name: string;
        sender_name: string;
        message_file_name: string | null;
        status: string;
      }[];
      total: number;
    };
    expect(json.total).toBeGreaterThan(0);
    const row = json.reports[0]!;
    expect(row.reporter_name).toBe(`b-${uniq}`);
    expect(row.sender_name).toBe(`a-${uniq}`);
    expect(row.message_file_name).toContain('.apk');
    expect(row.status).toBe('open');
  });

  it('delete：消息按撤回语义处理（留痕 + 附件删除），举报变 resolved', async () => {
    const messageId = await sendApkToB();
    await authPost(tokenB, `/api/messages/${messageId}/report`, { reason: '恶意文件' });

    const stored = storedFileOf(messageId);
    expect(stored).not.toBe('');
    expect(fs.existsSync(path.join(PATHS.uploadsPrivate, stored))).toBe(true);

    const reportId = (
      db.prepare('SELECT id FROM message_reports WHERE message_id = ?').get(messageId) as { id: number }
    ).id;

    const res = await authPost(tokenAdmin, `/api/admin/reports/${reportId}/resolve`, {
      action: 'delete',
    });
    expect(res.status).toBe(200);

    // 消息：行保留、字段清空、recalled_at 落地（与用户撤回同款）
    const msg = db
      .prepare('SELECT content, file_url, file_name, recalled_at FROM messages WHERE id = ?')
      .get(messageId) as {
      content: string;
      file_url: string | null;
      file_name: string | null;
      recalled_at: string | null;
    };
    expect(msg.recalled_at).toBeTruthy();
    expect(msg.file_url).toBeNull();
    expect(msg.file_name).toBeNull();
    // 磁盘附件已删
    expect(fs.existsSync(path.join(PATHS.uploadsPrivate, stored))).toBe(false);
    // 举报已 resolved
    const report = db
      .prepare('SELECT status, resolved_by FROM message_reports WHERE id = ?')
      .get(reportId) as { status: string; resolved_by: number };
    expect(report.status).toBe('resolved');
    expect(report.resolved_by).toBe(adminId);
  });

  it('dismiss：只标状态，消息原样保留；已处理的在 open 列表消失', async () => {
    const messageId = await sendApkToB();
    await authPost(tokenB, `/api/messages/${messageId}/report`, { reason: '误报一下' });
    const reportId = (
      db.prepare('SELECT id FROM message_reports WHERE message_id = ?').get(messageId) as { id: number }
    ).id;

    const res = await authPost(tokenAdmin, `/api/admin/reports/${reportId}/resolve`, {
      action: 'dismiss',
    });
    expect(res.status).toBe(200);
    const msg = db.prepare('SELECT file_url, recalled_at FROM messages WHERE id = ?').get(messageId) as {
      file_url: string | null;
      recalled_at: string | null;
    };
    expect(msg.recalled_at).toBeNull();
    expect(msg.file_url).not.toBeNull();

    const open = await fetch(`${base}/api/admin/reports?status=open`, {
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    const json = (await open.json()) as { reports: { id: number }[] };
    expect(json.reports.find((r) => r.id === reportId)).toBeUndefined();
  });

  it('非法 action → 400；不存在的举报 → 404', async () => {
    const bad = await authPost(tokenAdmin, '/api/admin/reports/1/resolve', { action: 'nuke' });
    expect(bad.status).toBe(400);
    const ghost = await authPost(tokenAdmin, '/api/admin/reports/999999/resolve', {
      action: 'dismiss',
    });
    expect(ghost.status).toBe(404);
  });
});
