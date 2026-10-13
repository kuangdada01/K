/**
 * ============================================================
 * 公开列表缓存测试（/api/music 与 /api/books 的 mtime 校验缓存）
 * ============================================================
 * 两个公开端点此前每请求同步扫盘（音乐还逐文件读 ID3，单文件最多 2MB），
 * 同步 IO 占住事件循环。缓存必须「无陈旧窗口」：目录/文件任一变化
 * （增、删、改名、内容替换）都通过 mtime/size 变化即时反映。
 *
 * books/music 路径不可经环境变量覆盖，故缓存核心以目录参数导出，
 * 测试用临时目录验证；路由层行为另做冒烟断言。
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import type { AddressInfo } from 'net';
import Database from 'better-sqlite3';
import { createMemoryDb } from './helpers/memdb';
import { setDbForTests, resetDbForTests } from '../src/db/connection';
import { createApp } from '../src/app';
// vi.mock 会提升到所有 import 之前：这里静态导入拿到的就是下方 mock 后的模块
import { getBookEntry } from '../src/routes/books';
import { createMusicListReader } from '../src/routes/music';

const { id3Calls } = vi.hoisted(() => ({ id3Calls: { n: 0 } }));

vi.mock('../src/lib/id3', () => ({
  readId3Tags: (p: string) => {
    id3Calls.n++;
    // 模拟 ID3：文件名形如 "T<title>.mp3" 时返回 title
    const base = path.basename(p, path.extname(p));
    return base.startsWith('T') ? { title: base.slice(1), artist: null } : {};
  },
}));

let db: InstanceType<typeof Database>;
let server: http.Server;
let base = '';

/** 把路径 mtime 强制拨到未来（statSync 毫秒级精度下保证缓存判定为失效） */
function bumpMtime(p: string): void {
  const t = new Date(Date.now() + 60_000);
  fs.utimesSync(p, t, t);
}

beforeAll(async () => {
  db = createMemoryDb();
  setDbForTests(db);
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

describe('music 列表缓存（createMusicListReader）', () => {
  it('命中缓存不重新解析 ID3；文件变化即时反映', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-music-'));
    try {
      const read = createMusicListReader(dir);
      fs.writeFileSync(path.join(dir, 'TSunny.mp3'), 'x');

      expect(read()).toEqual([{ title: 'Sunny', artist: '未知艺术家', src: '/music/TSunny.mp3' }]);
      const afterFirst = id3Calls.n;

      read();
      read();
      expect(id3Calls.n).toBe(afterFirst); // 无变化 → 纯缓存命中，不再读 ID3

      // 新增文件 → 目录 mtime 变化 → 重建（含新文件）
      fs.writeFileSync(path.join(dir, 'plain.mp3'), 'x');
      bumpMtime(dir);
      const two = read();
      expect(two).toHaveLength(2);
      expect(two.map((s) => s.src)).toContain('/music/plain.mp3');

      // 删除文件 → 即时反映
      fs.unlinkSync(path.join(dir, 'plain.mp3'));
      bumpMtime(dir);
      expect(read()).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('目录不存在 → 空列表（与旧行为一致），出现后恢复', () => {
    const dir = path.join(os.tmpdir(), `k-music-missing-${Date.now()}`);
    const read = createMusicListReader(dir);
    expect(read()).toEqual([]);

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.mp3'), 'x');
    expect(read()).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('路由冒烟：GET /api/music 返回数组', async () => {
    const res = await fetch(`${base}/api/music`);
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});

describe('books 每本缓存（getBookEntry）', () => {
  it('缓存命中返回同一结果；book.json 变化即时反映', () => {
    const booksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-books-'));
    try {
      const bookDir = path.join(booksDir, 'b1');
      fs.mkdirSync(bookDir);
      fs.writeFileSync(path.join(bookDir, 'book.json'), JSON.stringify({ title: '第一版' }));
      fs.writeFileSync(path.join(bookDir, '01-开始.txt'), '内容');

      const first = getBookEntry(booksDir, 'b1');
      expect(first?.meta.title).toBe('第一版');
      expect(first?.volumes).toHaveLength(1); // 根目录 txt 归为默认卷

      const second = getBookEntry(booksDir, 'b1');
      expect(second).toBe(first); // 同一对象：纯缓存命中

      // 元数据变更 → mtime 变化 → 重建
      fs.writeFileSync(path.join(bookDir, 'book.json'), JSON.stringify({ title: '第二版' }));
      bumpMtime(path.join(bookDir, 'book.json'));
      const third = getBookEntry(booksDir, 'b1');
      expect(third).not.toBe(first);
      expect(third?.meta.title).toBe('第二版');
    } finally {
      fs.rmSync(booksDir, { recursive: true, force: true });
    }
  });

  it('卷目录内章节增删（卷目录 mtime 变化）即时反映', () => {
    const booksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-books-'));
    try {
      const bookDir = path.join(booksDir, 'b2');
      const vol = path.join(bookDir, '第一卷');
      fs.mkdirSync(vol, { recursive: true });
      fs.writeFileSync(path.join(vol, '01-a.txt'), 'a');

      expect(getBookEntry(booksDir, 'b2')?.volumes[0]?.chapters).toEqual(['01-a.txt']);

      fs.writeFileSync(path.join(vol, '02-b.txt'), 'b');
      bumpMtime(vol);
      const entry = getBookEntry(booksDir, 'b2');
      expect(entry?.volumes[0]?.chapters).toEqual(['01-a.txt', '02-b.txt']);
    } finally {
      fs.rmSync(booksDir, { recursive: true, force: true });
    }
  });

  it('书目录不存在 → null；删除已缓存的书 → null（不残留陈旧条目）', () => {
    const booksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-books-'));
    try {
      expect(getBookEntry(booksDir, 'ghost')).toBeNull();

      const bookDir = path.join(booksDir, 'b3');
      fs.mkdirSync(bookDir);
      fs.writeFileSync(path.join(bookDir, '01.txt'), 'x');
      expect(getBookEntry(booksDir, 'b3')).not.toBeNull();

      fs.rmSync(bookDir, { recursive: true, force: true });
      expect(getBookEntry(booksDir, 'b3')).toBeNull();
    } finally {
      fs.rmSync(booksDir, { recursive: true, force: true });
    }
  });

  it('路由冒烟：GET /api/books 与 GET /api/books/:id 形状稳定', async () => {
    const listRes = await fetch(`${base}/api/books`);
    expect(listRes.status).toBe(200);
    const { books } = (await listRes.json()) as { books: { id: string }[] };
    expect(Array.isArray(books)).toBe(true);

    if (books.length > 0) {
      const detailRes = await fetch(`${base}/api/books/${encodeURIComponent(books[0]!.id)}`);
      expect(detailRes.status).toBe(200);
      const detail = (await detailRes.json()) as { volumes: unknown[] };
      expect(Array.isArray(detail.volumes)).toBe(true);
    }
  });
});
