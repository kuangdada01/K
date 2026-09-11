/**
 * ============================================================
 * 临时视频资源护栏测试（每用户字节配额 / 并发槽位 / 失败回收 / 定时清理）
 * ============================================================
 * 覆盖批次 A 的资源类修复：
 * - POST /video-temp 落盘前按 Content-Length 预判配额（413），落盘后复核兜底
 * - 同一用户并发临时上传超过上限返回 429
 * - 转码队列已满（429）时：/video-temp 与 /video 都要当场回收刚落盘的文件，
 *   不能留下只能等 TTL 的孤儿（uploads/ 更没有任何 TTL 覆盖）
 * - POST /video 落库失败时回删已移入 uploads/ 的视频与封面
 * - 分片上传：会话被 POST /video 消费后，迟到分片返回 400 且不重建残片文件
 * - sweepTempVideos 按 TTL 清理并同步回收会话登记
 * - 注册表的每用户字节记账与并发槽位语义
 *
 * 转码队列用 vi.mock 替身：真实队列会起 ffmpeg，且队列满的状态无法稳定构造。
 * ============================================================
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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
import { sweepTempVideos } from '../src/routes/posts/media';
import {
  getChunkOwner,
  getTempBytesUsed,
  getTempQuotaRemaining,
  hasTempUploadSlot,
  MAX_TEMP_BYTES_PER_USER,
  registerChunkUpload,
  releaseChunkUpload,
  setTempUploadBytes,
} from '../src/lib/chunkUploadRegistry';

/**
 * 转码队列替身：queueState.fail 为真时按真实队列抛 429。
 * 无论成功与否都记录 filePath —— 断言「失败回收」时必须精确到本次请求
 * 真正落盘的那个文件：uploads/temp 是跨测试文件共享的真实目录（并行 worker
 * 会同时读写），按目录列表做断言必然是竞态的。
 */
const { enqueued, queueState } = vi.hoisted(() => ({
  enqueued: [] as string[],
  queueState: { fail: false },
}));

vi.mock('../src/lib/video/queue', () => ({
  enqueueVideoTranscode: (filePath: string, _name: string) => {
    enqueued.push(filePath);
    if (queueState.fail) {
      throw Object.assign(new Error('视频处理任务繁忙，请稍后再试'), { status: 429 });
    }
  },
}));

let db: InstanceType<typeof Database>;
let server: http.Server;
let base = '';
let aliceToken = '';
let aliceId = 0;
let bobToken = '';
let bobId = 0;

/** 本轮落盘的临时/正式文件，afterAll 统一清掉 */
const created: string[] = [];

/** 生成一个合法的临时视频表单（>1024 字节，扩展名与 mimetype 同时命中白名单） */
function videoForm(size = 4096, filename = 'clip.mp4'): FormData {
  const form = new FormData();
  form.set('video', new Blob([new Uint8Array(size)], { type: 'video/mp4' }), filename);
  return form;
}

async function postVideoTemp(token: string, form: FormData) {
  const res = await fetch(`${base}/api/posts/video-temp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const data = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
  return { status: res.status, data };
}

function absFromUrl(url: string): string {
  return path.join(PATHS.uploads, '..', url.replace(/^\//, ''));
}

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

beforeEach(() => {
  queueState.fail = false;
  enqueued.length = 0;
});

describe('转码队列已满（429）时的失败回收', () => {
  it('POST /video-temp：临时文件与会话登记当场回收', async () => {
    queueState.fail = true;
    const { status, data } = await postVideoTemp(aliceToken, videoForm());
    expect(status).toBe(429);
    expect(data?.error).toBe('视频处理任务繁忙，请稍后再试');

    // 精确到本次请求落盘的那个文件（目录是跨文件共享的真实目录，不能按列表断言）
    const attempted = enqueued.at(-1);
    expect(attempted).toBeDefined();
    expect(attempted!.startsWith(PATHS.uploadsTemp)).toBe(true);
    expect(fs.existsSync(attempted!)).toBe(false);
    // 会话登记同步释放：否则会一直占着该用户的临时上传并发槽位
    expect(getChunkOwner(path.basename(attempted!))).toBeUndefined();
  });

  it('POST /video：已移入 uploads/ 的视频文件被回删（uploads 无任何 TTL 兜底）', async () => {
    // 先正常上传一个临时视频
    const up = await postVideoTemp(aliceToken, videoForm());
    expect(up.status).toBe(201);
    const url = up.data!.url!;
    const tempAbs = absFromUrl(url);
    created.push(tempAbs);
    expect(fs.existsSync(tempAbs)).toBe(true);

    // 发布时队列已满
    queueState.fail = true;
    const form = new FormData();
    form.set('video_url', url);
    form.set('description', '队列满时应回删视频文件');
    const res = await fetch(`${base}/api/posts/video`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${aliceToken}` },
      body: form,
    });
    expect(res.status).toBe(429);

    const finalAbs = path.join(PATHS.uploads, path.basename(url));
    expect(fs.existsSync(finalAbs)).toBe(false);
    expect(fs.existsSync(tempAbs)).toBe(false);
    // 没有留下帖子
    const posts = db.prepare('SELECT COUNT(*) as c FROM posts').get() as { c: number };
    expect(posts.c).toBe(0);
  });
});

describe('POST /video 落库失败时回删已落盘的媒体文件', () => {
  it('话题表写入失败 → 事务整体回滚，视频文件被清理', async () => {
    const up = await postVideoTemp(aliceToken, videoForm());
    expect(up.status).toBe(201);
    const url = up.data!.url!;
    const finalAbs = path.join(PATHS.uploads, path.basename(url));
    created.push(finalAbs);

    // 让 createVideoPostWithTags 里的 syncPostTags 失败，触发整个事务回滚
    db.exec('ALTER TABLE post_tags RENAME TO post_tags_bak');
    try {
      const form = new FormData();
      form.set('video_url', url);
      form.set('description', '落库失败应回删媒体文件');
      const res = await fetch(`${base}/api/posts/video`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${aliceToken}` },
        body: form,
      });
      expect(res.status).toBe(500);
    } finally {
      db.exec('ALTER TABLE post_tags_bak RENAME TO post_tags');
    }

    // 事务回滚：没有帖子残留
    const posts = db.prepare('SELECT COUNT(*) as c FROM posts').get() as { c: number };
    expect(posts.c).toBe(0);
    // 媒体文件被回删（原本会永久留在 uploads/ 且无 DB 引用）
    expect(fs.existsSync(finalAbs)).toBe(false);
  });
});

describe('分片上传与会话消费的竞态', () => {
  const chunkId = `temp-${Date.now()}-777.mp4`;
  const CHUNK = Buffer.alloc(2048, 7);

  async function sendChunk(token: string, uploadId: string, chunkIndex: number, totalChunks: number) {
    const form = new FormData();
    form.set('uploadId', uploadId);
    form.set('chunkIndex', String(chunkIndex));
    form.set('totalChunks', String(totalChunks));
    form.set('chunk', new Blob([new Uint8Array(CHUNK)]), 'chunk.bin');
    const res = await fetch(`${base}/api/posts/video-chunk`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    return { status: res.status, data: (await res.json().catch(() => null)) as { size?: number } | null };
  }

  it('会话被 POST /video 消费后，迟到分片返回 400 且不重建残片文件', async () => {
    const tempAbs = path.join(PATHS.uploadsTemp, chunkId);
    const finalAbs = path.join(PATHS.uploads, chunkId);
    created.push(tempAbs, finalAbs);

    expect((await sendChunk(aliceToken, chunkId, 0, 2)).status).toBe(200);
    expect((await sendChunk(aliceToken, chunkId, 1, 2)).status).toBe(200);
    expect(fs.statSync(tempAbs).size).toBe(CHUNK.length * 2);

    // 发布：临时文件移到 uploads/，会话释放
    const form = new FormData();
    form.set('video_url', `/uploads/temp/${chunkId}`);
    form.set('description', '消费中的会话');
    const res = await fetch(`${base}/api/posts/video`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${aliceToken}` },
      body: form,
    });
    expect(res.status).toBe(201);
    expect(fs.existsSync(tempAbs)).toBe(false);
    expect(fs.existsSync(finalAbs)).toBe(true);
    expect(getChunkOwner(chunkId)).toBeUndefined();

    // 迟到分片：会话已消费 → 400，且 'r+' 不会凭空重建 temp 文件
    const late = await sendChunk(aliceToken, chunkId, 1, 2);
    expect(late.status).toBe(400);
    expect(fs.existsSync(tempAbs)).toBe(false);
    // 已发布的文件内容未被追加污染
    expect(fs.statSync(finalAbs).size).toBe(CHUNK.length * 2);
  });
});

describe('每用户临时视频配额与并发槽位', () => {
  it('Content-Length 超出剩余配额时在落盘前返回 413', async () => {
    // express-rate-limit 之外没有别的保护：这正是要拦的场景。
    // 直接构造一个声明了 2GB 的原始请求（不真发 body：闸门在 multer 之前就拒绝）
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: (server.address() as AddressInfo).port,
          path: '/api/posts/video-temp',
          method: 'POST',
          headers: {
            Authorization: `Bearer ${aliceToken}`,
            'Content-Type': 'multipart/form-data; boundary=----x',
            'Content-Length': String(2 * 1024 * 1024 * 1024),
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(413);
  });

  it('同一用户并发临时上传超过上限返回 429', async () => {
    // 登记 3 个会话占满槽位。必须同时落盘真实文件：tempUploadGuard 会先做
    // pruneChunkUploads，文件不存在（或超 TTL）的登记会被惰性回收，槽位随即释放。
    const ids = [`temp-${Date.now()}-901.mp4`, `temp-${Date.now()}-902.mp4`, `temp-${Date.now()}-903.mp4`];
    for (const id of ids) {
      const abs = path.join(PATHS.uploadsTemp, id);
      fs.writeFileSync(abs, 'x');
      created.push(abs);
      registerChunkUpload(id, aliceId, 1);
    }
    expect(hasTempUploadSlot(aliceId)).toBe(false);

    const { status } = await postVideoTemp(aliceToken, videoForm());
    expect(status).toBe(429);

    // 槽位是按用户隔离的：alice 占满不影响 bob 正常上传
    const bobUpload = await postVideoTemp(bobToken, videoForm());
    expect(bobUpload.status).toBe(201);
    const bobAbs = absFromUrl(bobUpload.data!.url!);
    created.push(bobAbs);
    // 立即释放：否则这次上传会留在 bob 的配额账上，影响后续用例
    releaseChunkUpload(path.basename(bobAbs));

    for (const id of ids) releaseChunkUpload(id);
    expect(hasTempUploadSlot(bobId)).toBe(true);
  });

  it('字节记账：按用户累计，配额用尽后剩余为 0', () => {
    // 以当前用量为基线做增量断言：同文件内更早的用例可能已给 bob 留下登记，
    // 写死绝对值会让用例之间相互耦合
    const base = getTempBytesUsed(bobId);
    const quotaIds = [`temp-${Date.now()}-911.mp4`, `temp-${Date.now()}-912.mp4`];
    setTempUploadBytes(quotaIds[1]!, 0); // 不存在的会话：静默忽略
    registerChunkUpload(quotaIds[0]!, bobId, 400 * 1024 * 1024);
    registerChunkUpload(quotaIds[1]!, bobId, 700 * 1024 * 1024);

    expect(getTempBytesUsed(bobId)).toBe(base + 1100 * 1024 * 1024);
    expect(getTempQuotaRemaining(bobId)).toBe(0);
    expect(MAX_TEMP_BYTES_PER_USER).toBe(1024 * 1024 * 1024);

    // 更新单个会话的字节数（分片追加后回填）：400 + 1024 = 1424 MiB
    setTempUploadBytes(quotaIds[1]!, 1024 * 1024 * 1024);
    expect(getTempBytesUsed(bobId)).toBe(base + 1424 * 1024 * 1024);
    expect(getTempQuotaRemaining(bobId)).toBe(0);

    releaseChunkUpload(quotaIds[0]!);
    releaseChunkUpload(quotaIds[1]!);
    expect(getTempBytesUsed(bobId)).toBe(base);
    expect(getTempQuotaRemaining(bobId)).toBe(MAX_TEMP_BYTES_PER_USER - base);
  });
});

describe('sweepTempVideos 定时清理', () => {
  it('删除超过 TTL 的文件、保留新文件，并回收对应会话登记', () => {
    const staleId = `temp-${Date.now()}-921.mp4`;
    const freshId = `temp-${Date.now()}-922.mp4`;
    const staleAbs = path.join(PATHS.uploadsTemp, staleId);
    const freshAbs = path.join(PATHS.uploadsTemp, freshId);
    created.push(freshAbs);

    fs.writeFileSync(staleAbs, 'stale');
    fs.writeFileSync(freshAbs, 'fresh');
    // 把 stale 的 mtime 拨回 25 小时前（TTL 24h）
    const past = new Date(Date.now() - 25 * 3600 * 1000);
    fs.utimesSync(staleAbs, past, past);
    registerChunkUpload(staleId, aliceId, 5);
    registerChunkUpload(freshId, aliceId, 5);

    const removed = sweepTempVideos();

    expect(removed).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(staleAbs)).toBe(false);
    expect(fs.existsSync(freshAbs)).toBe(true);
    // 会话登记同步回收（否则配额统计虚高）
    expect(getChunkOwner(staleId)).toBeUndefined();
    expect(getChunkOwner(freshId)).toBeDefined();

    releaseChunkUpload(freshId);
  });
});
