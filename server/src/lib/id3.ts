/**
 * ============================================================
 * 极简 ID3 标签读取（只取标题/艺术家两帧）
 * ============================================================
 * /api/music 的歌曲列表需要标题/艺术家。mp3 的这两项目录扫描拿不到 ——
 * 资源管理器里看到的「标题/参与创作的艺术家」存在文件内部的 ID3 标签里。
 *
 * 为什么手写不引依赖：只需 TIT2/TPE1 两帧，music-metadata 这类通用库
 * 依赖树太重；这里支持实际碰得到的格式——
 *  - ID3v2.2/2.3/2.4（含 UTF-16/UTF-8/latin1 文本编码、整体/帧级反同步）
 *  - ID3v1（128 字节尾块，编码未声明：UTF-8 优先、无效字节按 GBK 兜底）
 * 解析失败一律返回空对象，由调用方退回文件名解析，绝不抛出拦列表。
 */

import fs from 'fs';

export interface Id3Tags {
  title?: string;
  artist?: string;
}

/** v2.4 帧大小/标签大小用 syncsafe 整数：每字节只取低 7 位 */
function readSyncsafe(buf: Buffer, off: number): number {
  return (
    ((buf[off]! & 0x7f) << 21) |
    ((buf[off + 1]! & 0x7f) << 14) |
    ((buf[off + 2]! & 0x7f) << 7) |
    (buf[off + 3]! & 0x7f)
  );
}

function readUint32(buf: Buffer, off: number): number {
  return buf.readUInt32BE(off);
}

/**
 * 文本帧解码。首字节是编码声明：
 * 0=ISO-8859-1，1=UTF-16 带 BOM，2=UTF-16BE，3=UTF-8。
 * 文本以编码对应的 \0 结尾（UTF-16 是 00 00 对齐终止）；v2.4 允许多值，
 * 这里只取第一个值。
 */
function decodeTextFrame(raw: Buffer): string {
  if (raw.length === 0) return '';
  const enc = raw[0]!;
  const body = raw.subarray(1);

  const latin1End = () => {
    const end = body.indexOf(0x00);
    return body.subarray(0, end === -1 ? body.length : end).toString('latin1');
  };
  const utf8End = () => {
    const end = body.indexOf(0x00);
    return body.subarray(0, end === -1 ? body.length : end).toString('utf8');
  };
  /** UTF-16 按 2 字节对齐扫 00 00 终止符；bigEndian 控制字节序，有 BOM 以 BOM 为准 */
  const utf16End = (bigEndianDefault: boolean) => {
    let bigEndian = bigEndianDefault;
    let start = 0;
    if (body.length >= 2) {
      if (body[0] === 0xff && body[1] === 0xfe) {
        bigEndian = false;
        start = 2;
      } else if (body[0] === 0xfe && body[1] === 0xff) {
        bigEndian = true;
        start = 2;
      }
    }
    let end = body.length;
    for (let i = start + ((2 - (start % 2)) % 2); i + 1 < body.length; i += 2) {
      if (body[i] === 0x00 && body[i + 1] === 0x00) {
        end = i;
        break;
      }
    }
    const payload = body.subarray(start, end);
    if (bigEndian) {
      // TextDecoder('utf-16be') 需要完整 ICU；不可用时手工换序走 utf16le
      try {
        return new TextDecoder('utf-16be').decode(payload);
      } catch {
        const swapped = Buffer.from(payload);
        swapped.swap16();
        return swapped.toString('utf16le');
      }
    }
    return payload.toString('utf16le');
  };

  switch (enc) {
    case 0:
      return latin1End();
    case 1:
      return utf16End(false);
    case 2:
      return utf16End(true);
    case 3:
      return utf8End();
    default:
      return '';
  }
}

/**
 * 解析 ID3v2 标签体（buf 从标签头之后开始）。返回的标签不含文件 IO。
 * 版本差异：v2.2 帧头 3+3 字节、帧 ID 是 TT2/TP1；v2.3 帧大小是普通整数，
 * v2.4 是 syncsafe（个别老写入器在 v2.4 里误用普通整数，用高位非零启发式纠正）。
 */
export function parseId3v2(header: Buffer, body: Buffer): Id3Tags {
  if (header.length < 10 || header.subarray(0, 3).toString('latin1') !== 'ID3') return {};
  const major = header[3]!;
  if (major < 2 || major > 4) return {};
  const flags = header[5]!;
  const tagSize = readSyncsafe(header, 6);
  if (tagSize <= 0) return {};

  const raw = body.subarray(0, Math.min(tagSize, body.length));

  // 扩展头（标志 0x40）：v2.3 大小不含自身且为普通整数，v2.4 含自身且为 syncsafe
  let offset = 0;
  if (flags & 0x40 && raw.length >= 4) {
    if (major === 3) {
      offset = 4 + readUint32(raw, 0);
    } else if (major === 4) {
      offset = readSyncsafe(raw, 0);
    }
    if (offset < 0 || offset >= raw.length) return {};
  }

  const idLen = major === 2 ? 3 : 4;
  const sizeLen = idLen;
  const flagsLen = major === 2 ? 0 : 2;
  const headerLen = idLen + sizeLen + flagsLen;
  const tags: Id3Tags = {};
  // 反同步的范围跟着标志走：v2.3 是全标签标志（0x80），v2.4 是帧级标志（0x02）。
  // 帧头/帧大小都读自原始流（反同步保证流里 FF 后必跟 00，不会截坏帧头），
  // 只有帧内容在取出后才需要还原，否则还原让流变短、按存储大小找边界会越界。
  const tagUnsync = major === 3 && (flags & 0x80) !== 0;

  while (offset + headerLen <= raw.length) {
    const id = raw.subarray(offset, offset + idLen).toString('latin1');
    let size: number;
    if (major === 2) {
      size = (raw[offset + 3]! << 16) | (raw[offset + 4]! << 8) | raw[offset + 5]!;
    } else if (major === 3) {
      size = readUint32(raw, offset + 4);
    } else {
      const syncsafe = readSyncsafe(raw, offset + 4);
      const plain = readUint32(raw, offset + 4);
      // syncsafe 整数四个字节的最高位必为 0；出现 1 说明是误用普通整数的写入器
      size = (plain & 0x80808080) !== 0 ? plain : syncsafe;
    }
    if (size <= 0) break; // 0 大小 = 填充区，到头了
    const frameFlags = major >= 3 ? raw.readUInt16BE(offset + idLen + sizeLen) : 0;
    const contentStart = offset + headerLen;
    if (contentStart + size > raw.length) break;

    const isTitle = id === 'TIT2' || id === 'TT2';
    const isArtist = id === 'TPE1' || id === 'TP1';
    if ((isTitle || isArtist) && !(isTitle ? tags.title : tags.artist)) {
      let content = raw.subarray(contentStart, contentStart + size);
      if (tagUnsync || (major === 4 && frameFlags & 0x0002)) {
        const out = Buffer.allocUnsafe(content.length);
        let n = 0;
        for (let i = 0; i < content.length; i++) {
          out[n++] = content[i]!;
          if (content[i] === 0xff && content[i + 1] === 0x00) i++;
        }
        content = out.subarray(0, n);
      }
      const text = decodeTextFrame(content)
        .replace(/\u0000+$/g, '')
        .trim();
      if (text) {
        if (isTitle) tags.title = text;
        else tags.artist = text;
      }
    }
    if (tags.title && tags.artist) break; // 两帧到手，剩下的（可能是封面大图）不扫了
    offset = contentStart + size;
  }

  return tags;
}

/**
 * 解析 ID3v1 尾块（buf 为文件最后 128 字节）。
 * v1 不声明编码：中文老标签实际是 GBK，新的是 UTF-8——先按 UTF-8 解，
 * 出现替换字符（U+FFFD，非法 UTF-8 序列的产物）再按 GBK 重解。
 */
export function parseId3v1(tail: Buffer): Id3Tags {
  if (tail.length < 128 || tail.subarray(0, 3).toString('latin1') !== 'TAG') return {};
  const field = (start: number, len: number) => {
    const raw = tail.subarray(start, start + len);
    const end = raw.indexOf(0x00);
    const bytes = raw.subarray(0, end === -1 ? raw.length : end);
    const utf8 = bytes.toString('utf8');
    if (!utf8.includes('\uFFFD')) return utf8.trim();
    try {
      return new TextDecoder('gbk').decode(bytes).trim();
    } catch {
      return utf8.trim();
    }
  };
  const tags: Id3Tags = {};
  const title = field(3, 30);
  const artist = field(33, 30);
  if (title) tags.title = title;
  if (artist) tags.artist = artist;
  return tags;
}

/**
 * 读单个音频文件的 ID3 标签（v2 优先，缺失字段用 v1 兜底）。任何异常都归为空对象。
 * 标签体可能带着几 MB 的封面图：先只读前 2MB，两帧没找齐且标签确实更大时才整读一次。
 */
const V2_HEAD_LIMIT = 2 * 1024 * 1024;

export function readId3Tags(filePath: string): Id3Tags {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 10) return {};

    const fd = fs.openSync(filePath, 'r');
    try {
      const header = Buffer.alloc(10);
      if (fs.readSync(fd, header, 0, 10, 0) < 10) return {};

      let tags: Id3Tags = {};
      if (header.subarray(0, 3).toString('latin1') === 'ID3') {
        const tagSize = readSyncsafe(header, 6);
        if (tagSize > 0) {
          const firstRead = Math.min(tagSize, V2_HEAD_LIMIT);
          const body = Buffer.alloc(firstRead);
          const got = fs.readSync(fd, body, 0, firstRead, 10);
          tags = parseId3v2(header, body.subarray(0, got));
          if (!(tags.title && tags.artist) && tagSize > firstRead) {
            const full = Buffer.alloc(tagSize);
            const gotFull = fs.readSync(fd, full, 0, tagSize, 10);
            tags = parseId3v2(header, full.subarray(0, gotFull));
          }
        }
      }

      // v1 兜底：只在 v2 缺字段时读尾块
      if (!(tags.title && tags.artist) && stat.size >= 128) {
        const tail = Buffer.alloc(128);
        if (fs.readSync(fd, tail, 0, 128, stat.size - 128) === 128) {
          const v1 = parseId3v1(tail);
          if (!tags.title && v1.title) tags.title = v1.title;
          if (!tags.artist && v1.artist) tags.artist = v1.artist;
        }
      }
      return tags;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return {};
  }
}
