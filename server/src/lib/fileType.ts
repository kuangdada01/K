/**
 * ============================================================
 * 私信文件类型工具（lib/fileType）
 * ============================================================
 * 只做两件事：
 *  1. 按**扩展名**给出 MIME —— 不相信客户端送来的 `file.mimetype`
 *     （它可以随便写，写 `text/html` 就能在预览里执行脚本）；
 *  2. 判定哪些 MIME 允许**内联预览**（inline），其余一律 `attachment` 下载。
 *
 * 安全边界（与 routes/messages.ts 的媒体端点配合）：
 *  · 响应统一带 `X-Content-Type-Options: nosniff`，浏览器不会把
 *    octet-stream 嗅探成 html；
 *  · `html` / `svg` / `xml` / `js` 这些**能在浏览器里跑起来**的类型不在内联白名单里，
 *    只允许下载到本地 —— 私信内容是用户互传的，不能在我们的源上执行；
 *  · 文件名走 `filename*=UTF-8''…`（RFC 5987），中文名下载不乱码。
 */

import { fileExtensionOf } from '@k/shared';

/** 扩展名 → MIME（值得给正式 MIME 的常见类型；类型已不限，缺省一律 octet-stream 下载） */
const MIME_BY_EXT: Record<string, string> = {
  // 文档
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  rtf: 'application/rtf',
  csv: 'text/plain; charset=utf-8',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  pages: 'application/vnd.apple.pages',
  numbers: 'application/vnd.apple.numbers',
  key: 'application/vnd.apple.keynote',
  // 电子书
  epub: 'application/epub+zip',
  mobi: 'application/x-mobipocket-ebook',
  azw3: 'application/vnd.amazon.ebook',
  // 图片
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  svg: 'image/svg+xml',
  // 音频
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  flac: 'audio/flac',
  amr: 'audio/amr',
  wma: 'audio/x-ms-wma',
  opus: 'audio/opus',
  // 视频
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  '3gp': 'video/3gpp',
  flv: 'video/x-flv',
  wmv: 'video/x-ms-wmv',
  // 安装包（2026-10-24 类型放开后补：apk 给正式 MIME，
  // Chrome 下载完才会出现「打开」按钮拉起系统安装器；不在内联白名单，只下载）
  apk: 'application/vnd.android.package-archive',
  xapk: 'application/vnd.android.package-archive',
  // 压缩包
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  bz2: 'application/x-bzip2',
  xz: 'application/x-xz',
  // 代码 / 配置 / 日志（统一按纯文本下发，便于站内预览）
  json: 'application/json',
  xml: 'application/xml',
  yaml: 'text/plain; charset=utf-8',
  yml: 'text/plain; charset=utf-8',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  ts: 'text/plain; charset=utf-8',
  tsx: 'text/plain; charset=utf-8',
  jsx: 'text/plain; charset=utf-8',
  py: 'text/plain; charset=utf-8',
  java: 'text/plain; charset=utf-8',
  kt: 'text/plain; charset=utf-8',
  c: 'text/plain; charset=utf-8',
  h: 'text/plain; charset=utf-8',
  cpp: 'text/plain; charset=utf-8',
  cs: 'text/plain; charset=utf-8',
  go: 'text/plain; charset=utf-8',
  rs: 'text/plain; charset=utf-8',
  php: 'text/plain; charset=utf-8',
  rb: 'text/plain; charset=utf-8',
  sql: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  ini: 'text/plain; charset=utf-8',
  conf: 'text/plain; charset=utf-8',
  toml: 'text/plain; charset=utf-8',
  patch: 'text/plain; charset=utf-8',
  diff: 'text/plain; charset=utf-8',
};

/**
 * 允许在浏览器里**内联打开**的 MIME 前缀/精确值。
 * 图片里刻意排除 `image/svg+xml`（可带脚本）；文本只放纯文本族，
 * 不含 `text/html` / `text/javascript` / `application/xml`（XML 可挂 XSLT）。
 */
const INLINE_MIME_EXACT = new Set([
  'application/pdf',
  'application/json',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/avif',
  'image/heic',
  'image/heif',
  'audio/mpeg',
  'audio/wav',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'audio/flac',
  'audio/amr',
  'audio/x-ms-wma',
  'audio/opus',
  'video/mp4',
  'video/quicktime',
  'video/x-m4v',
  'video/webm',
  'video/x-matroska',
  'video/x-msvideo',
  'video/3gpp',
  'video/x-flv',
  'video/x-ms-wmv',
]);

/** 按文件名（扩展名）给出 MIME；未知类型按二进制流 */
export function mimeForFileName(name: string): string {
  return MIME_BY_EXT[fileExtensionOf(name)] ?? 'application/octet-stream';
}

/** 该 MIME 能否内联预览（false = 只能下载） */
export function isInlineSafeMime(mime: string): boolean {
  if (INLINE_MIME_EXACT.has(mime)) return true;
  // text/plain; charset=utf-8 这类带参数的先剥参数
  const bare = mime.split(';')[0]!.trim().toLowerCase();
  return bare === 'text/plain';
}

/**
 * 清洗客户端送来的文件名。
 *
 * - 去掉路径（有的浏览器会送 `C:\fakepath\x.pdf` 或 `a/b.pdf`）；
 * - 去掉控制字符与首尾空白；
 * - 截断到 [MAX_FILE_NAME_CHARS]，但**保留扩展名**（否则图标/预览判断失效）。
 *
 * 返回空串表示文件名不可用（调用方按 400 处理）。
 */
export function sanitizeFileName(raw: string | undefined, maxChars: number): string {
  if (!raw) return '';
  // multer/busboy 在部分版本里按 latin1 解 filename，中文会变成 "æ¥å.pdf"；
  // 这里做一次可逆性探测：只有「解出来没有替换符且原串含高位 latin1 字符」才采用
  const decoded = decodeMojibake(raw);
  let name = (decoded.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!name || name === '.' || name === '..') return '';
  if (name.length > maxChars) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot) : '';
    const keep = Math.max(1, maxChars - ext.length);
    name = name.slice(0, keep) + ext;
  }
  return name;
}

/** latin1 误读的 UTF-8 还原（只在高位 latin1 字符存在时尝试，失败则原样返回） */
function decodeMojibake(name: string): string {
  if (!/[\u0080-\u00ff]/.test(name)) return name;
  try {
    const restored = Buffer.from(name, 'latin1').toString('utf8');
    return restored.includes('\ufffd') ? name : restored;
  } catch {
    return name;
  }
}

/** `Content-Disposition` 值：ASCII 兜底名 + RFC 5987 的 UTF-8 名 */
export function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  // 头里不能出现引号/换行；ASCII 兜底只留可打印字符，其余换成 _
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
