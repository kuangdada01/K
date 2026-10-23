/**
 * ============================================================
 * 私信文件消息工具（features/messages/utils）
 * ============================================================
 * 纯函数（可单测）：大小格式化、按扩展名/MIME 归类、判断能否站内预览。
 * 外加一个带鉴权的下载动作（附件在 uploads_private，`<a href>` 直接点会 401）。
 */

import api from '../../../api/http';
import type { Message } from '../../../types';
import { fileExtensionOf } from '@k/shared';

/** 文件归类：决定图标、说明文案与"能不能预览" */
export type FileKind =
  'image' | 'video' | 'audio' | 'pdf' | 'text' | 'doc' | 'sheet' | 'slide' | 'archive' | 'ebook' | 'other';

const KIND_BY_EXT: Record<string, FileKind> = {
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  avif: 'image',
  heic: 'image',
  heif: 'image',
  svg: 'image',
  mp4: 'video',
  mov: 'video',
  m4v: 'video',
  webm: 'video',
  mkv: 'video',
  avi: 'video',
  '3gp': 'video',
  flv: 'video',
  wmv: 'video',
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
  aac: 'audio',
  ogg: 'audio',
  oga: 'audio',
  flac: 'audio',
  amr: 'audio',
  wma: 'audio',
  opus: 'audio',
  pdf: 'pdf',
  txt: 'text',
  md: 'text',
  csv: 'text',
  log: 'text',
  json: 'text',
  xml: 'text',
  yaml: 'text',
  yml: 'text',
  html: 'text',
  htm: 'text',
  css: 'text',
  js: 'text',
  ts: 'text',
  tsx: 'text',
  jsx: 'text',
  py: 'text',
  java: 'text',
  kt: 'text',
  c: 'text',
  h: 'text',
  cpp: 'text',
  cs: 'text',
  go: 'text',
  rs: 'text',
  php: 'text',
  rb: 'text',
  sql: 'text',
  ini: 'text',
  conf: 'text',
  toml: 'text',
  patch: 'text',
  diff: 'text',
  doc: 'doc',
  docx: 'doc',
  rtf: 'doc',
  odt: 'doc',
  pages: 'doc',
  xls: 'sheet',
  xlsx: 'sheet',
  ods: 'sheet',
  numbers: 'sheet',
  ppt: 'slide',
  pptx: 'slide',
  odp: 'slide',
  key: 'slide',
  zip: 'archive',
  rar: 'archive',
  '7z': 'archive',
  tar: 'archive',
  gz: 'archive',
  tgz: 'archive',
  bz2: 'archive',
  xz: 'archive',
  epub: 'ebook',
  mobi: 'ebook',
  azw3: 'ebook',
};

/** 该文件消息属于哪一类（扩展名优先，MIME 兜底） */
export function fileKind(msg: Pick<Message, 'file_name' | 'file_mime'>): FileKind {
  const byExt = KIND_BY_EXT[fileExtensionOf(msg.file_name ?? '')];
  if (byExt) return byExt;
  const mime = (msg.file_mime ?? '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('text/')) return 'text';
  return 'other';
}

/**
 * 文本类里**不做站内预览**的扩展名：服务端对这些按 `text/html` / `text/css` /
 * `text/javascript` / `application/xml` 下发，且不在内联白名单里（会强制下载）。
 */
const TEXT_NOT_PREVIEWABLE = new Set(['html', 'htm', 'css', 'js', 'xml']);

/**
 * 能不能站内预览。
 *
 * 与服务端的 `isInlineSafeMime` 是**同一套口径**（服务端决定 inline/attachment，
 * 这里决定要不要给"预览"入口）：html / svg / xml / css / js 服务端只会以附件下发，
 * 这里也就不提供预览 —— 否则点开只会触发一次下载。
 */
export function isPreviewable(msg: Pick<Message, 'file_name' | 'file_mime'>): boolean {
  const kind = fileKind(msg);
  const ext = fileExtensionOf(msg.file_name ?? '');
  if (kind === 'image') {
    // svg 虽然归到图片，但可携带脚本：服务端强制 attachment，这里不给预览
    return ext !== 'svg';
  }
  if (kind === 'text') return !TEXT_NOT_PREVIEWABLE.has(ext);
  return kind === 'video' || kind === 'audio' || kind === 'pdf';
}

/** 大小 → 人类可读（1.2 MB / 860 KB / 12 B） */
export function formatFileSize(bytes: number | null | undefined): string {
  const n = typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // 小于 10 的保留一位小数（1.4 MB），否则取整（128 MB）
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** 归类 → 副标题文案（气泡里大小后面那一小段） */
export function kindLabel(kind: FileKind): string {
  switch (kind) {
    case 'image':
      return '图片';
    case 'video':
      return '视频';
    case 'audio':
      return '音频';
    case 'pdf':
      return 'PDF';
    case 'text':
      return '文本';
    case 'doc':
      return '文档';
    case 'sheet':
      return '表格';
    case 'slide':
      return '演示';
    case 'archive':
      return '压缩包';
    case 'ebook':
      return '电子书';
    default:
      return '文件';
  }
}

/** 文件消息的气泡副标题：`1.2 MB · PDF` */
export function fileMetaText(msg: Pick<Message, 'file_name' | 'file_mime' | 'file_size'>): string {
  return `${formatFileSize(msg.file_size)} · ${kindLabel(fileKind(msg))}`;
}

/**
 * 下载文件消息（带鉴权）。
 *
 * 附件在 uploads_private 后面，`<a href="/api/messages/1/media">` 拿不到 Authorization，
 * 所以先用 axios 取 blob 再触发本地保存。`timeout: 0` 是必须的 ——
 * 默认 15s 会把几十 MB 的下载直接掐断。
 *
 * 注：整份文件会先进内存（浏览器下载没有流式 saveAs 的标准 API），
 * 100MB 上限下可接受；真嫌重再引入 File System Access API 的流式写入。
 */
export async function downloadMessageFile(msg: Message): Promise<void> {
  const res = await api.get(`/messages/${msg.id}/media`, {
    params: { download: 1 },
    responseType: 'blob',
    timeout: 0,
  });
  const blob = new Blob([res.data as BlobPart], {
    type: msg.file_mime || 'application/octet-stream',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = msg.file_name || '文件';
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // 立刻 revoke 会让部分浏览器（Safari）取消保存，给 1 分钟缓冲
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
