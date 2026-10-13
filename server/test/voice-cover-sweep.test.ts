/**
 * ============================================================
 * 语音封面孤儿清理测试（lib/voiceCoverSweep）
 * ============================================================
 * 封面上传与建房解耦且此前无任何回收路径（删房也不删文件）——
 * 访客可只传封面不建房，单 IP 每天可堆数十 GB 孤儿文件。
 * 修复后：
 *  - sweepOrphanVoiceCovers：未被 voice_rooms.cover_url 引用且超过 TTL 的删除；
 *  - 删房路由顺带 deleteVoiceCoverFile；
 *  - 上传端点独立限流（10 次/10 分钟）。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { createMemoryDb } from './helpers/memdb';
import { setDbForTests, resetDbForTests, getDb } from '../src/db/connection';
import { PATHS } from '../src/config';
import { sweepOrphanVoiceCovers, deleteVoiceCoverFile, VOICE_COVER_TTL_MS } from '../src/lib/voiceCoverSweep';

let db: InstanceType<typeof Database>;
let coversDir: string;

const HOUR = 3600 * 1000;

/** 在 covers 目录造一个文件，并把 mtime 拨到指定时刻（statSync 毫秒级精度不稳，用 utimes 精确控制） */
function makeCover(name: string, mtimeMs: number): string {
  const p = path.join(coversDir, name);
  fs.writeFileSync(p, Buffer.alloc(16, 1));
  fs.utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
  return p;
}

/** 插入一个引用了指定封面的房间 */
function insertRoomWithCover(coverUrl: string | null): number {
  const info = getDb()
    .prepare(
      `INSERT INTO voice_rooms (name, description, cover_url, creator_id, creator_name)
       VALUES ('房间', '', ?, 1, 'alice')`
    )
    .run(coverUrl);
  return Number(info.lastInsertRowid);
}

beforeAll(() => {
  db = createMemoryDb();
  setDbForTests(db);
  // 每个 worker 有独立 UPLOADS_DIR（vitest.config），covers 目录在本 worker 内独占
  coversDir = PATHS.voiceCovers;
  fs.mkdirSync(coversDir, { recursive: true });
});

afterAll(() => {
  resetDbForTests();
  db?.close();
  fs.rmSync(coversDir, { recursive: true, force: true });
});

describe('sweepOrphanVoiceCovers：孤儿封面清扫', () => {
  it('删除「未引用且超 TTL」的文件；被引用的与未超 TTL 的保留', () => {
    const now = Date.now();
    const orphanOld = makeCover('orphan-old.jpg', now - VOICE_COVER_TTL_MS - HOUR);
    const orphanFresh = makeCover('orphan-fresh.jpg', now - HOUR); // 刚传、还没建房
    const referencedOld = makeCover('referenced-old.jpg', now - VOICE_COVER_TTL_MS - HOUR);
    insertRoomWithCover('/uploads/voice-covers/referenced-old.jpg');

    const removed = sweepOrphanVoiceCovers(now);
    expect(removed).toBe(1);
    expect(fs.existsSync(orphanOld)).toBe(false);
    expect(fs.existsSync(orphanFresh)).toBe(true);
    expect(fs.existsSync(referencedOld)).toBe(true);
  });

  it('超 TTL 后仍未被引用的文件在后续清扫中回收（上传后放弃建房的正常路径）', () => {
    const now = Date.now();
    const late = makeCover('late-orphan.jpg', now - HOUR);
    sweepOrphanVoiceCovers(now);
    expect(fs.existsSync(late)).toBe(true);

    // 时间推进超过 TTL：仍未引用 → 回收
    sweepOrphanVoiceCovers(now + VOICE_COVER_TTL_MS + HOUR);
    expect(fs.existsSync(late)).toBe(false);
  });

  it('目录不存在时静默创建并返回 0（全新环境/CI）', () => {
    fs.rmSync(coversDir, { recursive: true, force: true });
    expect(sweepOrphanVoiceCovers()).toBe(0);
    expect(fs.existsSync(coversDir)).toBe(true);
  });
});

describe('deleteVoiceCoverFile：删房补偿路径', () => {
  it('删除封面 URL 对应的文件；null/野路径不抛错', () => {
    const p = makeCover('room-cover.jpg', Date.now());
    expect(() => deleteVoiceCoverFile(null)).not.toThrow();
    expect(() => deleteVoiceCoverFile('not-a-url')).not.toThrow();
    deleteVoiceCoverFile('/uploads/voice-covers/room-cover.jpg');
    expect(fs.existsSync(p)).toBe(false);
  });

  it('文件不存在时幂等（视为成功）', () => {
    expect(() => deleteVoiceCoverFile('/uploads/voice-covers/never-existed.jpg')).not.toThrow();
  });
});

describe('封面回收与房间生命周期的衔接', () => {
  it('房间行删除后，其封面失去引用，超过 TTL 即被清扫回收', () => {
    const now = Date.now();
    const p = makeCover('lifecycle.jpg', now - VOICE_COVER_TTL_MS - HOUR);
    const roomId = insertRoomWithCover('/uploads/voice-covers/lifecycle.jpg');

    // 被引用 → 保留（即使已超 TTL）
    sweepOrphanVoiceCovers(now);
    expect(fs.existsSync(p)).toBe(true);

    // 房间删除（repo 层与路由行为一致）→ 失去引用 → 可回收
    getDb().prepare('DELETE FROM voice_rooms WHERE id = ?').run(roomId);
    sweepOrphanVoiceCovers(now);
    expect(fs.existsSync(p)).toBe(false);
  });
});
