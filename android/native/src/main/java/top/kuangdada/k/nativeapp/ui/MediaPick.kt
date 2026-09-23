package top.kuangdada.k.nativeapp.ui

import android.content.Context
import android.net.Uri
import java.io.File

/**
 * ============================================================
 * 相册选图 → 本地文件（头像等"单选一条"的场景）
 * ============================================================
 * 为什么必须拷到 cacheDir 而不是直接上传 `content://`：
 *  1. multipart 上传需要**真实文件**（`content://` 不能当文件读）；
 *  2. 系统 Photo Picker 授予的读权限是**临时的** —— 拿着 uri 等一会儿再上传
 *     （进程/权限一失效）就再也读不到了。
 *
 * 与发布弹层（`ComposerScreen` 里的多图/视频拷贝）是同一套做法，区别只在这里
 * **必须保住原始扩展名与 MIME**：服务端对上传图片按「扩展名 + mimetype」双校验
 * （server/src/lib/image.ts 的 `imageFileFilter`），而 Photo Picker 给的
 * `content://media/external/images/media/1234` 最后一段是纯数字 id、没有扩展名 ——
 * 不补一个 whitelist 内的扩展名会被直接 400 拒掉。
 */
internal data class PickedImage(
    val file: File,
    /** 与文件内容匹配的 MIME（服务端会一起校验；未知时退回 image/jpeg） */
    val mimeType: String,
)

/** 服务端白名单（server/src/lib/image.ts 的 `IMAGE_MIME_RE`）——不在里面的按 jpeg 处理 */
private val ALLOWED_IMAGE_MIME = setOf(
    "image/jpeg", "image/jpg", "image/png", "image/gif",
    "image/webp", "image/avif", "image/heic", "image/heif",
)

/** mime → 扩展名（服务端 `IMAGE_EXT_RE` 的白名单反过来用） */
private fun extensionFor(mime: String): String = when (mime) {
    "image/png" -> "png"
    "image/webp" -> "webp"
    "image/gif" -> "gif"
    "image/avif" -> "avif"
    "image/heic" -> "heic"
    "image/heif" -> "heif"
    else -> "jpg"
}

/**
 * 把相册返回的 `content://` 整段拷进 `cacheDir/mediapick/`，并带上可被服务端接受的扩展名与 MIME。
 *
 * **必须在工作线程调用**；返回 null 表示读取失败（调用方要给用户一句人话，
 * 而不是静默什么都没发生）。
 */
internal fun copyPickedImageToCache(
    context: Context,
    uri: Uri,
    prefix: String = "pick",
): PickedImage? = runCatching {
    val mime = context.contentResolver.getType(uri)
        ?.lowercase()
        ?.takeIf { it in ALLOWED_IMAGE_MIME }
        ?: "image/jpeg"

    val dir = File(context.cacheDir, "mediapick").apply { mkdirs() }
    val target = File(dir, "${prefix}_${System.currentTimeMillis()}_${(0..9999).random()}.${extensionFor(mime)}")
    val input = context.contentResolver.openInputStream(uri) ?: error("openInputStream 返回 null：$uri")
    input.use { source ->
        target.outputStream().use { output -> source.copyTo(output) }
    }
    PickedImage(file = target, mimeType = mime)
}.getOrNull()
