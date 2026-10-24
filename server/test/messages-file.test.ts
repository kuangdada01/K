/**
 * ============================================================
 * 私信文件消息（2026-10-23）
 * ============================================================
 * 覆盖服务端对外契约：
 *  1. multipart `file` → 201，返回鉴权媒体地址、原始名、大小与 MIME，content 为空；
 *  2. 空文件 / 图片超限 → 400，且已落盘文件被清理；
 *  3. 下发：可内联的类型 `inline`，`?download=1` 与 html/svg 一律 `attachment`
 *     （带 nosniff，绝不在站点源上执行）；
 *  4. 只有收发双方能取（否则 403 / 未登录 401）；
 *  5. 会话列表预览 `[文件] 名字`；引用条带 quoted_file_name；
 *  6. 撤回 / 清空会话都会删除磁盘文件并清空字段；
 *  7. 文件名清洗（路径、控制字符、超长截断）与 MIME 判定的纯函数行为。
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
import { contentDisposition, isInlineSafeMime, mimeForFileName, sanitizeFileName } from '../src/lib/fileType';

let db: InstanceType<typeof Database>;
let server: http.Server;
let base = '';
let userA = 0;
let userB = 0;
let userC = 0;
let tokenA = '';
let tokenB = '';
let tokenC = '';

const uniq = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

const PDF_BYTES = Buffer.from('%PDF-1.4 fake pdf body for contract test');
const HTML_BYTES = Buffer.from('<script>alert(1)</script>');

/** 发送一条文件消息（默认 pdf） */
async function sendFile(opts: {
  token: string;
  receiverId: number;
  filename?: string;
  bytes?: Buffer;
  mime?: string;
  quotedMessageId?: number;
  extraImage?: boolean;
}): Promise<Response> {
  const form = new FormData();
  form.append('receiverId', String(opts.receiverId));
  if (opts.quotedMessageId) form.append('quotedMessageId', String(opts.quotedMessageId));
  form.append(
    'file',
    // 复制进一个普通的 Uint8Array：Buffer 的底层可能是 SharedArrayBuffer，
    // 不满足 BlobPart 的类型（TS 6 的 ArrayBufferLike 收紧）
    new Blob([new Uint8Array(opts.bytes ?? PDF_BYTES)], { type: opts.mime ?? 'application/pdf' }),
    opts.filename ?? `报告-${uniq}.pdf`
  );
  if (opts.extraImage) {
    form.append(
      'image',
      new Blob([Buffer.from('fake-image')], { type: 'image/jpeg' }),
      `file-extra-${uniq}.jpg`
    );
  }
  return fetch(`${base}/api/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.token}` },
    body: form,
  });
}

/** 库里存的物理文件名（断言磁盘清理用） */
function storedName(messageId: number): string {
  const row = db.prepare('SELECT file_url FROM messages WHERE id = ?').get(messageId) as {
    file_url: string | null;
  };
  return row.file_url ?? '';
}

function physicalExists(name: string): boolean {
  return !!name && fs.existsSync(path.join(PATHS.uploadsPrivate, name));
}

beforeAll(async () => {
  db = createMemoryDb();
  setDbForTests(db);

  const insertUser = db.prepare("INSERT INTO users (username, email, password_hash) VALUES (?, ?, 'x')");
  userA = Number(insertUser.run(`file-a-${uniq}`, `file-a-${uniq}@test.com`).lastInsertRowid);
  userB = Number(insertUser.run(`file-b-${uniq}`, `file-b-${uniq}@test.com`).lastInsertRowid);
  userC = Number(insertUser.run(`file-c-${uniq}`, `file-c-${uniq}@test.com`).lastInsertRowid);

  tokenA = generateToken({ id: userA, username: `file-a-${uniq}` });
  tokenB = generateToken({ id: userB, username: `file-b-${uniq}` });
  tokenC = generateToken({ id: userC, username: `file-c-${uniq}` });

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

describe('私信文件消息', () => {
  it('发送成功：返回鉴权地址、原始名、大小与 MIME，content 为空', async () => {
    const res = await sendFile({ token: tokenA, receiverId: userB });
    expect(res.status).toBe(201);

    const json = (await res.json()) as {
      id: number;
      content: string;
      file_url: string | null;
      file_name: string | null;
      file_size: number;
      file_mime: string | null;
      image_url: string | null;
      audio_url: string | null;
    };
    expect(json.content).toBe('');
    expect(json.image_url).toBeNull();
    expect(json.audio_url).toBeNull();
    expect(json.file_url).toBe(`/api/messages/${json.id}/media`);
    // 中文名原样保留（不能被 latin1 解成乱码）
    expect(json.file_name).toBe(`报告-${uniq}.pdf`);
    expect(json.file_size).toBe(PDF_BYTES.length);
    expect(json.file_mime).toBe('application/pdf');
  });

  it('类型不限：exe/apk/无扩展名也能发，下发一律 attachment', async () => {
    // exe：不在 MIME 表里 → 二进制流，强制下载
    const exe = (await (
      await sendFile({
        token: tokenA,
        receiverId: userB,
        filename: `tool-${uniq}.exe`,
        bytes: Buffer.from('MZ fake'),
        mime: 'application/octet-stream',
      })
    ).json()) as { file_url: string; file_mime: string | null };
    expect(exe.file_mime).toBe('application/octet-stream');
    const exeRes = await fetch(`${base}${exe.file_url}`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(exeRes.status).toBe(200);
    expect(exeRes.headers.get('content-type')).toBe('application/octet-stream');
    expect(exeRes.headers.get('content-disposition')).toContain('attachment');
    expect(exeRes.headers.get('x-content-type-options')).toBe('nosniff');

    // apk：有正式 MIME（安卓下载完出现「打开」拉起安装器），同样只下载不内联
    const apk = (await (
      await sendFile({
        token: tokenA,
        receiverId: userB,
        filename: `app-${uniq}.apk`,
        bytes: Buffer.from('PK fake apk'),
        mime: 'application/vnd.android.package-archive',
      })
    ).json()) as { file_mime: string | null };
    expect(apk.file_mime).toBe('application/vnd.android.package-archive');

    // 无扩展名（云盘 provider 常见）：照发，按二进制流下载
    const noExt = await sendFile({
      token: tokenA,
      receiverId: userB,
      filename: `Makefile-${uniq}`,
      bytes: Buffer.from('all:'),
      mime: 'application/octet-stream',
    });
    expect(noExt.status).toBe(201);
  });

  it('空文件 → 400', async () => {
    const res = await sendFile({
      token: tokenA,
      receiverId: userB,
      filename: `empty-${uniq}.txt`,
      bytes: Buffer.alloc(0),
      mime: 'text/plain',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('文件是空的');
  });

  it('文件与图片同时上传 → 400（一条消息只带一个附件）', async () => {
    const res = await sendFile({ token: tokenA, receiverId: userB, extraImage: true });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('只能带一个附件');
  });

  it('图片超过 10MB → 400（上传器上限已抬到文件上限，服务端要补这道校验）', async () => {
    const form = new FormData();
    form.append('receiverId', String(userB));
    form.append(
      'image',
      new Blob([Buffer.alloc(11 * 1024 * 1024)], { type: 'image/jpeg' }),
      `huge-${uniq}.jpg`
    );
    const res = await fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: form,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('图片不能超过');
  });

  it('媒体下发：可内联类型 inline，?download=1 强制 attachment', async () => {
    const sent = (await (await sendFile({ token: tokenA, receiverId: userB })).json()) as {
      id: number;
      file_url: string;
    };

    // 接收方可以取（附带 RFC 5987 的中文名）
    const inline = await fetch(`${base}${sent.file_url}`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(inline.status).toBe(200);
    expect(inline.headers.get('content-type')).toContain('application/pdf');
    expect(inline.headers.get('content-disposition')).toContain('inline');
    expect(inline.headers.get('content-disposition')).toContain(encodeURIComponent(`报告-${uniq}.pdf`));
    expect(inline.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await inline.arrayBuffer()).toString()).toBe(PDF_BYTES.toString());

    const download = await fetch(`${base}${sent.file_url}?download=1`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('application/octet-stream');
    expect(download.headers.get('content-disposition')).toContain('attachment');
  });

  it('html 不内联（防在本站源上执行脚本）', async () => {
    const sent = (await (
      await sendFile({
        token: tokenA,
        receiverId: userB,
        filename: `page-${uniq}.html`,
        bytes: HTML_BYTES,
        mime: 'text/html',
      })
    ).json()) as { id: number; file_url: string };

    const res = await fetch(`${base}${sent.file_url}`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toContain('attachment');
  });

  it('非参与者 403，未登录 401', async () => {
    const sent = (await (await sendFile({ token: tokenA, receiverId: userB })).json()) as {
      id: number;
      file_url: string;
    };
    const forbidden = await fetch(`${base}${sent.file_url}`, {
      headers: { Authorization: `Bearer ${tokenC}` },
    });
    expect(forbidden.status).toBe(403);

    const anonymous = await fetch(`${base}${sent.file_url}`);
    expect(anonymous.status).toBe(401);
  });

  it('会话列表预览显示 [文件] 原始名', async () => {
    // 上面已有多次 A→B 的文件消息；列表里 B 看到的最后一条应是 [文件] xxx
    const res = await fetch(`${base}/api/messages/conversations`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    const json = (await res.json()) as { conversations: { last_message: string }[] };
    const conv = json.conversations.find((c) => c.last_message.startsWith('[文件]'));
    expect(conv).toBeTruthy();
    expect(conv!.last_message).toContain('.');
  });

  it('引用文件消息：quoted_file_name 带出原始名', async () => {
    const first = (await (await sendFile({ token: tokenA, receiverId: userB })).json()) as {
      id: number;
      file_name: string;
    };
    const quoted = await sendFile({
      token: tokenB,
      receiverId: userA,
      filename: `回复-${uniq}.txt`,
      bytes: Buffer.from('reply body'),
      mime: 'text/plain',
      quotedMessageId: first.id,
    });
    expect(quoted.status).toBe(201);
    const json = (await quoted.json()) as {
      quoted_message_id: number;
      quoted_file_name: string | null;
      quoted_content: string;
    };
    expect(json.quoted_message_id).toBe(first.id);
    expect(json.quoted_file_name).toBe(first.file_name);
  });

  it('撤回：文件从磁盘删除、字段清空，媒体接口 404', async () => {
    const sent = (await (await sendFile({ token: tokenA, receiverId: userB })).json()) as {
      id: number;
      file_url: string;
    };
    const stored = storedName(sent.id);
    expect(physicalExists(stored)).toBe(true);

    const recall = await fetch(`${base}/api/messages/single/${sent.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(recall.status).toBe(200);
    expect(physicalExists(stored)).toBe(false);

    const media = await fetch(`${base}${sent.file_url}`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(media.status).toBe(404);

    const row = db
      .prepare('SELECT file_url, file_name, file_size, content, recalled_at FROM messages WHERE id = ?')
      .get(sent.id) as {
      file_url: string | null;
      file_name: string | null;
      file_size: number;
      content: string;
      recalled_at: string | null;
    };
    expect(row.recalled_at).toBeTruthy();
    expect(row.file_url).toBeNull();
    expect(row.file_name).toBeNull();
    expect(row.file_size).toBe(0);
    expect(row.content).toBe('');
  });

  it('清空会话：文件全部从磁盘删除', async () => {
    const sent = (await (await sendFile({ token: tokenA, receiverId: userB })).json()) as {
      id: number;
    };
    const stored = storedName(sent.id);
    expect(physicalExists(stored)).toBe(true);

    const res = await fetch(`${base}/api/messages/${userA}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(res.status).toBe(200);
    expect(physicalExists(stored)).toBe(false);
  });
});

describe('文件类型工具（纯函数）', () => {
  it('MIME 按扩展名判定，未知类型退化成二进制流', () => {
    expect(mimeForFileName('a.PDF')).toBe('application/pdf');
    expect(mimeForFileName('a.docx')).toContain('wordprocessingml');
    expect(mimeForFileName('app.apk')).toBe('application/vnd.android.package-archive');
    expect(mimeForFileName('a.unknown')).toBe('application/octet-stream');
    expect(mimeForFileName('无扩展名')).toBe('application/octet-stream');
  });

  it('只有安全的类型允许内联（html/svg/xml 不行）', () => {
    expect(isInlineSafeMime('application/pdf')).toBe(true);
    expect(isInlineSafeMime('image/png')).toBe(true);
    expect(isInlineSafeMime('text/plain; charset=utf-8')).toBe(true);
    expect(isInlineSafeMime('text/html')).toBe(false);
    expect(isInlineSafeMime('image/svg+xml')).toBe(false);
    expect(isInlineSafeMime('application/zip')).toBe(false);
  });

  it('文件名清洗：去路径、去控制字符、超长截断但保留扩展名', () => {
    expect(sanitizeFileName('C:\\fakepath\\报告.pdf', 120)).toBe('报告.pdf');
    expect(sanitizeFileName('a/b/c.txt', 120)).toBe('c.txt');
    expect(sanitizeFileName('bad\u0000name.txt', 120)).toBe('badname.txt');
    expect(sanitizeFileName('   ', 120)).toBe('');
    const long = sanitizeFileName(`${'x'.repeat(300)}.pdf`, 20);
    expect(long.length).toBeLessThanOrEqual(20);
    expect(long.endsWith('.pdf')).toBe(true);
  });

  it('Content-Disposition：ASCII 兜底 + RFC 5987 中文名', () => {
    const value = contentDisposition('attachment', '报告 "final".pdf');
    expect(value.startsWith('attachment; filename="')).toBe(true);
    expect(value).toContain(`filename*=UTF-8''${encodeURIComponent('报告 "final".pdf')}`);
    // 头里不能出现裸引号/换行
    expect(value.split('filename*=')[0]!.split('"')[1]).not.toContain('"');
  });
});
