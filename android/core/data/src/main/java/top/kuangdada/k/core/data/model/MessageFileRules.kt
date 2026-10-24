package top.kuangdada.k.core.data.model

import java.util.Locale

/**
 * ============================================================
 * 私信文件规则（2026-10-23；2026-10-24 取消类型白名单）
 * ============================================================
 * **类型不限**（apk/exe 等都能发），本地只拦大小/数量 —— 不拦的话，选完一个
 * 300MB 的压缩包要先把文件读进 cache、再白传几分钟，最后才收到 400
 * （这正是视频上传踩过的坑，见 MessageRepository.MAX_VIDEO_BYTES 的注释）。
 * 下发侧的安全（未知类型按二进制流强制下载、html/svg 绝不内联）由服务端
 * `lib/fileType.ts` 把守，与「能不能发」无关。
 */

/** 单个文件上限：100 MB */
const val MAX_MESSAGE_FILE_BYTES: Long = 100L * 1024 * 1024

/** 单次最多发几个（一个文件一条消息） */
const val MAX_MESSAGE_FILES = 9

/** 扩展名（小写、不含点）；没有扩展名返回空串 */
fun messageFileExtension(name: String): String {
    val base = name.substringAfterLast('/').substringAfterLast('\\')
    val dot = base.lastIndexOf('.')
    return if (dot > 0) base.substring(dot + 1).lowercase(Locale.US) else ""
}

/**
 * 可执行 / 安装类扩展名（与 shared 的 `EXECUTABLE_FILE_EXTENSIONS` 手工镜像）。
 *
 * 类型放开（2026-10-24）后这些都能发，但它们「下载完双击就跑」——
 * 聊天传安装包是安卓木马最典型的投递方式，下载/打开前要过一次警示确认
 * （[isExecutableMessageFile] 就是那个判断；漏改两端会表现为「一边弹窗一边不弹」）。
 */
val EXECUTABLE_MESSAGE_EXTENSIONS: Set<String> = setOf(
    // 安卓安装包
    "apk", "xapk", "apks",
    // Windows
    "exe", "msi", "msix", "scr", "com", "pif", "bat", "cmd", "ps1", "vbs", "vbe",
    // macOS / Linux
    "dmg", "pkg", "deb", "rpm", "appimage",
    // Java
    "jar",
)

/** 是否可执行/安装类文件（决定下载前要不要警示） */
fun isExecutableMessageFile(name: String): Boolean =
    messageFileExtension(name) in EXECUTABLE_MESSAGE_EXTENSIONS

/**
 * 文件大小校验：返回 null 表示通过，否则是给用户看的错误文案。
 * 文案与 Web 端一致（"超过 100MB"），避免两端说法不同。
 */
fun messageFileSizeError(bytes: Long): String? {
    if (bytes <= 0L) return "文件是空的"
    if (bytes > MAX_MESSAGE_FILE_BYTES) {
        val mb = MAX_MESSAGE_FILE_BYTES / (1024 * 1024)
        return "文件不能超过 ${mb}MB"
    }
    return null
}

/** 文件归类：决定气泡图标（与 Web 的 fileKind 同一套映射） */
enum class MessageFileKind { Image, Video, Audio, Pdf, Text, Doc, Sheet, Slide, Archive, Ebook, App, Other }

private val KIND_BY_EXT: Map<String, MessageFileKind> = buildMap {
    listOf("jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "heic", "heif", "svg")
        .forEach { put(it, MessageFileKind.Image) }
    listOf("mp4", "mov", "m4v", "webm", "mkv", "avi", "3gp", "flv", "wmv")
        .forEach { put(it, MessageFileKind.Video) }
    listOf("mp3", "wav", "m4a", "aac", "ogg", "oga", "flac", "amr", "wma", "opus")
        .forEach { put(it, MessageFileKind.Audio) }
    put("pdf", MessageFileKind.Pdf)
    listOf(
        "txt", "md", "csv", "log", "json", "xml", "yaml", "yml", "html", "htm", "css", "js",
        "ts", "tsx", "jsx", "py", "java", "kt", "c", "h", "cpp", "cs", "go", "rs", "php", "rb",
        "sql", "ini", "conf", "toml", "patch", "diff",
    ).forEach { put(it, MessageFileKind.Text) }
    listOf("doc", "docx", "rtf", "odt", "pages").forEach { put(it, MessageFileKind.Doc) }
    listOf("xls", "xlsx", "ods", "numbers").forEach { put(it, MessageFileKind.Sheet) }
    listOf("ppt", "pptx", "odp", "key").forEach { put(it, MessageFileKind.Slide) }
    listOf("zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz").forEach { put(it, MessageFileKind.Archive) }
    listOf("epub", "mobi", "azw3").forEach { put(it, MessageFileKind.Ebook) }
    // 安装包/可执行（2026-10-24）：与 [EXECUTABLE_MESSAGE_EXTENSIONS] 同一族
    EXECUTABLE_MESSAGE_EXTENSIONS.forEach { put(it, MessageFileKind.App) }
}

/** 归类：扩展名优先，MIME 兜底 */
fun messageFileKind(name: String?, mime: String?): MessageFileKind {
    KIND_BY_EXT[messageFileExtension(name ?: "")]?.let { return it }
    val m = (mime ?: "").lowercase(Locale.US)
    return when {
        m.startsWith("image/") -> MessageFileKind.Image
        m.startsWith("video/") -> MessageFileKind.Video
        m.startsWith("audio/") -> MessageFileKind.Audio
        m == "application/pdf" -> MessageFileKind.Pdf
        m.startsWith("text/") -> MessageFileKind.Text
        else -> MessageFileKind.Other
    }
}

/** 归类 → 中文说明（气泡副标题里那一段） */
fun messageFileKindLabel(kind: MessageFileKind): String = when (kind) {
    MessageFileKind.Image -> "图片"
    MessageFileKind.Video -> "视频"
    MessageFileKind.Audio -> "音频"
    MessageFileKind.Pdf -> "PDF"
    MessageFileKind.Text -> "文本"
    MessageFileKind.Doc -> "文档"
    MessageFileKind.Sheet -> "表格"
    MessageFileKind.Slide -> "演示"
    MessageFileKind.Archive -> "压缩包"
    MessageFileKind.Ebook -> "电子书"
    MessageFileKind.App -> "安装包"
    MessageFileKind.Other -> "文件"
}

/**
 * 字节 → 人类可读（与 Web `formatFileSize` 同口径：小于 10 保留一位小数）。
 * 大小未知（0）返回空串，让调用方决定要不要省略这一段。
 */
fun formatFileBytes(bytes: Long): String {
    if (bytes <= 0L) return ""
    if (bytes < 1024) return "$bytes B"
    val units = listOf("KB", "MB", "GB", "TB")
    var value = bytes / 1024.0
    var unit = 0
    while (value >= 1024 && unit < units.size - 1) {
        value /= 1024
        unit += 1
    }
    val text = if (value < 10) String.format(Locale.US, "%.1f", value) else value.toLong().toString()
    return "$text ${units[unit]}"
}

/**
 * 打开文件用的 MIME（系统 Intent 需要）。
 * 只用扩展名推导，覆盖常见类型即可 —— 推不出来给通配类型（`star slash star`），
 * 让系统自己挑应用。
 */
fun messageFileMime(name: String?, mime: String?): String {
    if (!mime.isNullOrBlank() && mime != "application/octet-stream") return mime
    return when (messageFileExtension(name ?: "")) {
        "pdf" -> "application/pdf"
        "doc" -> "application/msword"
        "docx" -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        "xls" -> "application/vnd.ms-excel"
        "xlsx" -> "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        "ppt" -> "application/vnd.ms-powerpoint"
        "pptx" -> "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        "txt", "md", "csv", "log" -> "text/plain"
        "jpg", "jpeg" -> "image/jpeg"
        "png" -> "image/png"
        "gif" -> "image/gif"
        "webp" -> "image/webp"
        "mp4" -> "video/mp4"
        "mov" -> "video/quicktime"
        "mp3" -> "audio/mpeg"
        "m4a", "aac" -> "audio/mp4"
        "wav" -> "audio/wav"
        "zip" -> "application/zip"
        "rar" -> "application/vnd.rar"
        "7z" -> "application/x-7z-compressed"
        "epub" -> "application/epub+zip"
        // 安装包：给正式 MIME，点开才会拉起系统安装器
        "apk", "xapk" -> "application/vnd.android.package-archive"
        else -> "*/*"
    }
}
