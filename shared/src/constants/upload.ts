/**
 * ============================================================
 * 上传体积/分片共享常量（@k/shared）
 * ============================================================
 * 这些数字此前以魔法数散落在 6 处（客户端 5 处 + 服务端 1 处），
 * 其中「5MB 分片」是**前后端协议的一部分**：客户端按它切片、服务端按它换算
 * `MAX_TOTAL_CHUNKS` 做校验，两边不一致会直接表现为「合法视频被 400 拒绝」
 * 或「超出上限的视频被放行」。
 *
 * 因此统一收口到共享包：改一处，两端同时生效。
 */

/** 单张图片上传上限（帖子图片 / 私信图片 / 头像）：10 MB */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** 单个视频上传上限：1 GB */
export const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;

/**
 * 私信语音上限：5 MB。
 *
 * 60 秒 AAC(64kbps) 的 m4a 约 0.5 MB —— 5 MB 是给设备差异留的余量。
 * 服务端按它做二次校验（不信任客户端的录音参数）。
 */
export const MAX_VOICE_BYTES = 5 * 1024 * 1024;

/** 语音最长 60 秒（录音端到点自动停止；服务端按同一常量校验） */
export const MAX_VOICE_MS = 60_000;

/** 语音最短 1 秒（更短的按误触丢弃，不发请求） */
export const MIN_VOICE_MS = 1_000;

/**
 * 「大视频」阈值：150 MB
 * 达到后走分片上传提示（原生端）并跳过封面自动截帧
 * —— 4K/长视频在 WebView 里截帧容易 OOM。
 */
export const LARGE_VIDEO_BYTES = 150 * 1024 * 1024;

/** 分片上传的单片大小：5 MB（前后端协议的一部分，必须一致） */
export const UPLOAD_CHUNK_BYTES = 5 * 1024 * 1024;

/**
 * 私信文件上限：100 MB（2026-10-23）。
 *
 * 私信文件是**单次 multipart**（没有分片），所以这个数必须比 nginx 的
 * `client_max_body_size` 小得多留出余量；同时客户端要在选完文件后**先拦一道**，
 * 否则大文件会先在本机读一遍、白耗流量，最后拿到 nginx 的 413 HTML（见
 * `MessageRepository.kt` 里视频上传的同类事故）。
 */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

/**
 * 单次最多同时发送的文件数：9 个（每个文件一条消息）。
 *
 * 与「一条消息一个附件」的既有约定一致（图片/语音也是），多选只是让一次操作
 * 能连发多条；限制数量的目的是别让用户一次拖 50 个文件把上传队列撑爆。
 */
export const MAX_FILES_PER_SEND = 9;

/** 文件名展示上限（字符数）：超出截断，避免气泡被超长名字撑爆 */
export const MAX_FILE_NAME_CHARS = 120;

/**
 * 允许通过私信发送的扩展名（小写、不含点）。
 *
 * 采用**白名单**而不是黑名单：可执行文件（exe/bat/cmd/msi/scr/apk/jar/sh/ps1…）
 * 一律不在列表里 —— 私信是点对点投递，发过去的可执行文件几乎只会被用来钓鱼。
 * 覆盖面按「用户真的会在聊天里传的东西」来：文档 / 表格 / 演示 / 图片 / 音视频 /
 * 压缩包 / 电子书 / 常见代码与配置。
 */
export const MESSAGE_FILE_EXTENSIONS: readonly string[] = [
  // 文档
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'txt',
  'md',
  'rtf',
  'csv',
  'odt',
  'ods',
  'odp',
  'pages',
  'numbers',
  'key',
  // 电子书
  'epub',
  'mobi',
  'azw3',
  // 图片（svg/heic 只允许下载，不做站内预览）
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'bmp',
  'avif',
  'heic',
  'heif',
  'svg',
  // 音频
  'mp3',
  'wav',
  'm4a',
  'aac',
  'ogg',
  'oga',
  'flac',
  'amr',
  'wma',
  'opus',
  // 视频
  'mp4',
  'mov',
  'm4v',
  'webm',
  'mkv',
  'avi',
  '3gp',
  'flv',
  'wmv',
  // 压缩包
  'zip',
  'rar',
  '7z',
  'tar',
  'gz',
  'tgz',
  'bz2',
  'xz',
  // 代码 / 配置 / 日志
  'json',
  'xml',
  'yaml',
  'yml',
  'html',
  'htm',
  'css',
  'js',
  'ts',
  'tsx',
  'jsx',
  'py',
  'java',
  'kt',
  'c',
  'h',
  'cpp',
  'cs',
  'go',
  'rs',
  'php',
  'rb',
  'sql',
  'log',
  'ini',
  'conf',
  'toml',
  'patch',
  'diff',
];

/** 扩展名（小写、不含点）；没有扩展名时返回空串 */
export function fileExtensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** 文件名是否允许通过私信发送（大小写不敏感；只看扩展名） */
export function isAllowedMessageFile(name: string): boolean {
  return MESSAGE_FILE_EXTENSIONS.includes(fileExtensionOf(name));
}

/**
 * `<input type="file" accept>` 用的字符串：按扩展名列出白名单。
 *
 * 用扩展名而不是 MIME：`.docx` / `.mkv` / `.7z` 这类格式的 MIME 在各平台并不统一，
 * 写 MIME 会把一部分文件在选择器里灰掉。真正的类型判断仍以
 * [isAllowedMessageFile] 为准（服务端同一份白名单再校验一次）。
 */
export const MESSAGE_FILE_ACCEPT = MESSAGE_FILE_EXTENSIONS.map((ext) => `.${ext}`).join(',');

/**
 * 字节 → MB 整数，用于拼提示文案。
 * 存在的意义是避免「常量改了、文案还写着旧数字」这种不一致。
 */
export const toMB = (bytes: number): number => Math.round(bytes / 1024 / 1024);
