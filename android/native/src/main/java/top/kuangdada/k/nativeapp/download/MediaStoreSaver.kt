package top.kuangdada.k.nativeapp.download

import android.content.ContentValues
import android.content.Context
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import java.io.File
import java.io.FileOutputStream

/**
 * ============================================================
 * 保存**图片 / 视频**到系统相册 —— 原生版
 * ============================================================
 * 从 `:app` 的 `feature/media/MediaStoreSaver.kt` 移植（那个包名属于 WebView 宿主，
 * 随宿主一起下架）。**只保留"写字节"这一层**：WebView 版还要从 URL 抓图，
 * 而原生版的图片来源本来就已经是内存里的字节（Coil/网络层拿到的），
 * 再走一遍 URL 只会多一次请求、多一层错误面。
 *
 * 分档实现（:native 的 minSdk 是 27，两条分支都必须活着）：
 *  · **API 29+**：MediaStore + `RELATIVE_PATH=Pictures/K`，全程**不需要**存储权限；
 *    写入期间 `IS_PENDING=1`，写完置 0 —— 否则相册里会短暂出现半张图。
 *  · **API 27–28**：写公共 `Pictures/K` 目录 + `MediaScannerConnection` 通知相册；
 *    这条路径**需要 `WRITE_EXTERNAL_STORAGE`**（运行时权限）。
 *    ⚠️ `:native` 的 AndroidManifest **目前还没有声明该权限**，要由集成方补
 *    （manifest 不在本次改动范围内）。用 [needsLegacyPermission] 判断要不要申请。
 *
 * 刻意不做权限 UI：这里只返回成功/失败，**由调用方决定**是申请权限还是提示用户。
 */
object MediaStoreSaver {

    private const val TAG = "KSave"
    private const val ALBUM = "K"

    /**
     * 这条系统版本上是否需要 `WRITE_EXTERNAL_STORAGE` 运行时权限。
     * API 29 起走 MediaStore 的 RELATIVE_PATH，**不需要任何存储权限**。
     */
    fun needsLegacyPermission(): Boolean = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q

    /**
     * 保存图片字节到系统相册。
     *
     * 为什么必须传 [Context]：写入要 `ContentResolver`，而 API < 29 的
     * `MediaScannerConnection.scanFile` 也要 Context —— 没有 Context 这两条路径
     * 一条都走不通，硬凑一个"无 Context 版"只会得到一个必然失败的 API。
     *
     * @param fileName 展示名；相册按扩展名分类，**必须带后缀**，否则会被存成无类型文件
     * @return 是否写入成功。失败只记日志、不抛异常 —— 调用方拿 false 去提示用户
     */
    fun saveImage(context: Context, bytes: ByteArray, fileName: String, mimeType: String): Boolean {
        if (bytes.isEmpty()) {
            Log.w(TAG, "拒绝保存空数据: $fileName")
            return false
        }
        val name = sanitize(fileName)
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                saveViaMediaStore(context, bytes, name, mimeType)
            } else {
                saveViaPublicDir(context, bytes, name, mimeType)
            }
        } catch (e: Exception) {
            Log.w(TAG, "保存到相册失败: $name", e)
            false
        }
    }

    /**
     * 保存**视频**到系统相册（`Movies/K`）。
     *
     * 与 [saveImage] 的两点不同，都不是随手写的：
     *  1. **流式写入**（`write` 回调往里倒数据），不是先攒一个 ByteArray ——
     *     一个 300MB 的视频在内存里攒一遍，低端机直接 OOM，而视频恰恰是这个体量；
     *  2. 汇入 `MediaStore.Video`（相册才会把它当视频收进"视频"分类，塞进 Images 表是看不见的）。
     *
     * @param write 往输出流里写数据；**返回 false 视为失败**（网络断了），此时记录会被清掉 ——
     *   留一条半截视频比什么都没有更糟（用户点开是坏的，还以为是我们保存坏了）。
     */
    fun saveVideo(
        context: Context,
        fileName: String,
        mimeType: String,
        write: (java.io.OutputStream) -> Boolean,
    ): Boolean {
        val name = sanitize(fileName)
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                saveVideoViaMediaStore(context, name, mimeType, write)
            } else {
                saveVideoViaPublicDir(context, name, mimeType, write)
            }
        } catch (e: Exception) {
            Log.w(TAG, "保存视频失败: $name", e)
            false
        }
    }

    /** 按扩展名推 mime（调用方只有文件名时用） */
    fun mimeTypeOf(fileName: String): String = when (fileName.substringAfterLast('.', "").lowercase()) {
        "png" -> "image/png"
        "gif" -> "image/gif"
        "webp" -> "image/webp"
        "avif" -> "image/avif"
        "heic", "heif" -> "image/heic"
        "bmp" -> "image/bmp"
        else -> "image/jpeg"
    }

    /** 按扩展名推视频 mime（服务端转码产物是 mp4，其余格式兜底也用 video/mp4） */
    fun videoMimeTypeOf(fileName: String): String = when (fileName.substringAfterLast('.', "").lowercase()) {
        "webm" -> "video/webm"
        "mkv" -> "video/x-matroska"
        "mov" -> "video/quicktime"
        "avi" -> "video/x-msvideo"
        else -> "video/mp4"
    }

    /** 扩展名（小写、不带点）；取不到时用 [fallback] */
    fun extensionOf(pathOrUrl: String, fallback: String): String {
        val clean = pathOrUrl.substringBefore('?').substringBefore('#')
        val ext = clean.substringAfterLast('.', "").lowercase()
        // 只认"像扩展名"的那一档（长度 2..5、全字母数字），否则 URL 里的点号会被当成后缀
        return if (ext.length in 2..5 && ext.all { it.isLetterOrDigit() }) ext else fallback
    }

    /** 相册里的展示名（带时间戳，避免重名被相册自动加 (1)(2) 后缀） */
    fun timestampedName(prefix: String, extension: String): String {
        val ext = extension.trimStart('.').lowercase().ifBlank { "jpg" }
        return "${prefix.ifBlank { "K" }}-${System.currentTimeMillis()}.$ext"
    }

    private fun saveViaMediaStore(
        context: Context,
        bytes: ByteArray,
        displayName: String,
        mimeType: String,
    ): Boolean {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, displayName)
            put(MediaStore.Images.Media.MIME_TYPE, mimeType)
            put(MediaStore.Images.Media.RELATIVE_PATH, "${Environment.DIRECTORY_PICTURES}/$ALBUM")
            // IS_PENDING 期间别的 App 看不到这条记录 —— 不置 1 的话相册会先显示一张 0 字节的图
            put(MediaStore.Images.Media.IS_PENDING, 1)
        }
        val uri: Uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
            ?: return false
        try {
            val out = resolver.openOutputStream(uri)
            if (out == null) {
                // 留一条 0 字节的空记录比什么都没有更糟（用户会在相册里看到破图）
                Log.w(TAG, "打开输出流失败: $displayName")
                runCatching { resolver.delete(uri, null, null) }
                return false
            }
            out.use { it.write(bytes) }
        } catch (e: Exception) {
            // 写入中途失败同样必须清理，否则相册里留下永远 pending 的僵尸记录
            runCatching { resolver.delete(uri, null, null) }
            throw e
        }
        values.clear()
        values.put(MediaStore.Images.Media.IS_PENDING, 0)
        resolver.update(uri, values, null, null)
        Log.d(TAG, "已保存到相册: $displayName (${bytes.size} bytes)")
        return true
    }

    private fun saveViaPublicDir(
        context: Context,
        bytes: ByteArray,
        displayName: String,
        mimeType: String,
    ): Boolean {
        @Suppress("DEPRECATION")
        val pictures = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES)
        val dir = File(pictures, ALBUM)
        if (!dir.exists() && !dir.mkdirs()) {
            Log.w(TAG, "创建相册目录失败: ${dir.absolutePath}")
            return false
        }
        val file = File(dir, displayName)
        FileOutputStream(file).use { out -> out.write(bytes) }
        // 只写文件不通知 MediaScanner 的话用户在相册里**看不到**这张图（要等系统下次全盘扫描）
        MediaScannerConnection.scanFile(context, arrayOf(file.absolutePath), arrayOf(mimeType), null)
        Log.d(TAG, "已保存到相册(legacy): ${file.absolutePath}")
        return true
    }

    private fun saveVideoViaMediaStore(
        context: Context,
        displayName: String,
        mimeType: String,
        write: (java.io.OutputStream) -> Boolean,
    ): Boolean {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Video.Media.DISPLAY_NAME, displayName)
            put(MediaStore.Video.Media.MIME_TYPE, mimeType)
            put(MediaStore.Video.Media.RELATIVE_PATH, "${Environment.DIRECTORY_MOVIES}/$ALBUM")
            put(MediaStore.Video.Media.IS_PENDING, 1)
        }
        val uri: Uri = resolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values)
            ?: return false
        try {
            val out = resolver.openOutputStream(uri)
            if (out == null) {
                runCatching { resolver.delete(uri, null, null) }
                return false
            }
            val ok = out.use { write(it) }
            if (!ok) {
                // 下载中断：清掉半截记录（同上，坏的视频比没有更糟）
                Log.w(TAG, "视频数据没写完: $displayName")
                runCatching { resolver.delete(uri, null, null) }
                return false
            }
        } catch (e: Exception) {
            runCatching { resolver.delete(uri, null, null) }
            throw e
        }
        values.clear()
        values.put(MediaStore.Video.Media.IS_PENDING, 0)
        resolver.update(uri, values, null, null)
        Log.d(TAG, "视频已保存到相册: $displayName")
        return true
    }

    private fun saveVideoViaPublicDir(
        context: Context,
        displayName: String,
        mimeType: String,
        write: (java.io.OutputStream) -> Boolean,
    ): Boolean {
        @Suppress("DEPRECATION")
        val movies = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MOVIES)
        val dir = File(movies, ALBUM)
        if (!dir.exists() && !dir.mkdirs()) {
            Log.w(TAG, "创建视频目录失败: ${dir.absolutePath}")
            return false
        }
        val file = File(dir, displayName)
        val ok = FileOutputStream(file).use { out -> write(out) }
        if (!ok) {
            // 半截文件要删掉：相册扫描到它会显示一个打不开的视频
            runCatching { file.delete() }
            return false
        }
        MediaScannerConnection.scanFile(context, arrayOf(file.absolutePath), arrayOf(mimeType), null)
        Log.d(TAG, "视频已保存到相册(legacy): ${file.absolutePath}")
        return true
    }

    /**
     * 文件名净化：必须剥掉路径分隔符（否则会写到 Pictures/K 之外；
     * API 29 的 MediaStore 遇到带 '/' 的 DISPLAY_NAME 还可能直接抛 IllegalArgumentException）。
     */
    private fun sanitize(name: String): String {
        val base = name.substringAfterLast('/').substringAfterLast('\\')
        return base.replace(Regex("[\\\\/:*?\"<>|]"), "_").take(120).ifBlank { "K.jpg" }
    }
}
