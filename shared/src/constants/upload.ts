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
 * 私信文件**不限类型**（2026-10-24 起）：此前是扩展名白名单，apk/exe 等可执行文件
 * 一律被拒 —— 结果「传个 APK 给同事」这类最常见的需求反而不行。现在只保留
 * 大小 / 数量 / 文件名三道校验（见 [MAX_FILE_BYTES] / [MAX_FILES_PER_SEND] /
 * 服务端 `sanitizeFileName`）。
 *
 * 安全边界与「能不能发」无关，在**下发侧**单独把守（server/src/lib/fileType.ts）：
 * 按扩展名推导 MIME、未知类型按二进制流强制下载（attachment + nosniff），
 * 能在浏览器里执行脚本的类型（html/svg/xml/js）永远不进内联预览白名单。
 */

/** 扩展名（小写、不含点）；没有扩展名时返回空串 */
export function fileExtensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/**
 * 可执行 / 安装类扩展名（小写、不含点）。
 *
 * 类型放开（2026-10-24）后这些都能发，但它们是「下载后双击就跑」的东西 ——
 * 聊天里传安装包是安卓木马最典型的投递方式，所以两端在**下载/打开前**
 * 要再给用户一次明确警示（`isExecutableFile` 就是那个判断）。
 *
 * 只列「直接可执行」的：安装包（apk/exe/dmg/deb…）与系统脚本（bat/cmd/ps1/vbs…）。
 * sh/js/py 这类开发文件不列 —— 不会被系统顺手执行，列了只会把警示变成噪音。
 */
export const EXECUTABLE_FILE_EXTENSIONS: readonly string[] = [
  // 安卓安装包
  'apk',
  'xapk',
  'apks',
  // Windows
  'exe',
  'msi',
  'msix',
  'scr',
  'com',
  'pif',
  'bat',
  'cmd',
  'ps1',
  'vbs',
  'vbe',
  // macOS / Linux
  'dmg',
  'pkg',
  'deb',
  'rpm',
  'appimage',
  // Java（双击可跑的 jar）
  'jar',
];

/** 是否可执行/安装类文件（决定下载前要不要警示；大小写不敏感） */
export function isExecutableFile(name: string): boolean {
  return EXECUTABLE_FILE_EXTENSIONS.includes(fileExtensionOf(name));
}

/**
 * 字节 → MB 整数，用于拼提示文案。
 * 存在的意义是避免「常量改了、文案还写着旧数字」这种不一致。
 */
export const toMB = (bytes: number): number => Math.round(bytes / 1024 / 1024);
