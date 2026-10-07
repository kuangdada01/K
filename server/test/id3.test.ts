/**
 * ID3 标签解析测试
 * 合成字节流测各版本/编码的解析（不依赖真实音频文件），
 * readId3Tags 用临时文件走一遍真实 IO。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseId3v1, parseId3v2, readId3Tags } from '../src/lib/id3';

/** syncsafe 整数：每字节低 7 位 */
function ss(n: number): Buffer {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
}

function frame23or4(id: string, content: Buffer, sizeBuf: Buffer): Buffer {
  return Buffer.concat([Buffer.from(id, 'latin1'), sizeBuf, Buffer.from([0, 0]), content]);
}

function frame22(id: string, content: Buffer): Buffer {
  const size = Buffer.from([(content.length >> 16) & 0xff, (content.length >> 8) & 0xff, content.length & 0xff]);
  return Buffer.concat([Buffer.from(id, 'latin1'), size, content]);
}

/** 拼一个完整 ID3v2 标签（header + frames，无填充） */
function tag(major: number, frames: Buffer, flags = 0): { header: Buffer; body: Buffer } {
  const header = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([major, 0, flags]), ss(frames.length)]);
  return { header, body: frames };
}

/** 文本帧内容：编码声明 + 带编码的文本（含终止符） */
function text(enc: number, bytes: Buffer, terminate = true): Buffer {
  const term = enc === 1 || enc === 2 ? Buffer.from([0, 0]) : Buffer.from([0]);
  return Buffer.concat([Buffer.from([enc]), bytes, ...(terminate ? [term] : [])]);
}

const utf16le = (s: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);

describe('parseId3v2', () => {
  it('v2.3 + UTF-16 带 BOM（真实场景最常见，中文艺术家）', () => {
    const t1 = text(1, utf16le('Deadman'));
    const t2 = text(1, utf16le('蔡徐坤'));
    const { header, body } = tag(3, Buffer.concat([frame23or4('TIT2', t1, ss(t1.length)), frame23or4('TPE1', t2, ss(t2.length))]));
    expect(parseId3v2(header, body)).toEqual({ title: 'Deadman', artist: '蔡徐坤' });
  });

  it('v2.4 + UTF-8，syncsafe 帧大小', () => {
    const t1 = text(3, Buffer.from('晴天', 'utf8'));
    const t2 = text(3, Buffer.from('周杰伦', 'utf8'));
    const { header, body } = tag(4, Buffer.concat([frame23or4('TIT2', t1, ss(t1.length)), frame23or4('TPE1', t2, ss(t2.length))]));
    expect(parseId3v2(header, body)).toEqual({ title: '晴天', artist: '周杰伦' });
  });

  it('v2.4 误用普通整数帧大小的老写入器（高位非零启发式）', () => {
    // 帧内容 160 字节：0xA0 的 syncsafe 解读会爆，启发式应回退普通整数
    const content = Buffer.concat([Buffer.from([3]), Buffer.alloc(159, 0x61)]);
    const plain = Buffer.from([0, 0, 0, content.length]);
    const { header, body } = tag(4, frame23or4('TPE1', content, plain));
    expect(parseId3v2(header, body)).toEqual({ artist: 'a'.repeat(159) });
  });

  it('v2.2 短帧头（TT2/TP1）', () => {
    const t1 = text(0, Buffer.from('Bohemian', 'latin1'));
    const t2 = text(0, Buffer.from('Queen', 'latin1'));
    const { header, body } = tag(2, Buffer.concat([frame22('TT2', t1), frame22('TP1', t2)]));
    expect(parseId3v2(header, body)).toEqual({ title: 'Bohemian', artist: 'Queen' });
  });

  it('v2.3 整体反同步：内容里的 FF 被转义为 FF 00', () => {
    // latin1 文本 "aÿ"（0xFF），传输流里写成 FF 00
    const escaped = Buffer.concat([Buffer.from([0]), Buffer.from('a', 'latin1'), Buffer.from([0xff, 0x00]), Buffer.from([0])]);
    const { header, body } = tag(3, frame23or4('TPE1', escaped, ss(escaped.length)), 0x80);
    expect(parseId3v2(header, body)).toEqual({ artist: 'a\u00ff' });
  });

  it('非 ID3 头 / 坏版本号 / 空体 → 空对象', () => {
    const notId3 = Buffer.from('XID3xxxxx');
    expect(parseId3v2(notId3, Buffer.alloc(0))).toEqual({});
    const badVersion = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([9, 0, 0]), ss(10)]);
    expect(parseId3v2(badVersion, Buffer.alloc(10))).toEqual({});
  });
});

describe('parseId3v1', () => {
  it('标准 128 字节尾块（UTF-8 中文）', () => {
    const tail = Buffer.alloc(128);
    tail.write('TAG', 0, 'latin1');
    tail.write('东风破', 3, 'utf8');
    tail.write('周杰伦', 33, 'utf8');
    expect(parseId3v1(tail)).toEqual({ title: '东风破', artist: '周杰伦' });
  });

  it('无 TAG 魔数 → 空对象', () => {
    expect(parseId3v1(Buffer.alloc(128))).toEqual({});
  });
});

describe('readId3Tags（真实文件 IO）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'id3-test-'));

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('v2.3 标签的 mp3 读出标题/艺术家', () => {
    const t1 = text(1, utf16le('七里香'));
    const t2 = text(1, utf16le('周杰伦'));
    const { header, body } = tag(3, Buffer.concat([frame23or4('TIT2', t1, ss(t1.length)), frame23or4('TPE1', t2, ss(t2.length))]));
    const file = join(dir, 'song.mp3');
    writeFileSync(file, Buffer.concat([header, body, Buffer.alloc(2048, 0xff)])); // 后面垫"音频数据"
    expect(readId3Tags(file)).toEqual({ title: '七里香', artist: '周杰伦' });
  });

  it('无标签的文件 → 空对象（路由退回文件名解析）', () => {
    const file = join(dir, 'plain.mp3');
    writeFileSync(file, Buffer.alloc(4096, 0xff));
    expect(readId3Tags(file)).toEqual({});
  });

  it('ID3v1 兜底：只有 v1 标签也能读出', () => {
    const tail = Buffer.alloc(128);
    tail.write('TAG', 0, 'latin1');
    tail.write('V1 Song', 3, 'latin1');
    tail.write('V1 Artist', 33, 'latin1');
    const file = join(dir, 'v1.mp3');
    writeFileSync(file, Buffer.concat([Buffer.alloc(1024, 0xff), tail]));
    expect(readId3Tags(file)).toEqual({ title: 'V1 Song', artist: 'V1 Artist' });
  });
});
