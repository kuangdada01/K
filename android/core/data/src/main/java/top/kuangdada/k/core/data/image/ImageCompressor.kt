package top.kuangdada.k.core.data.image

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import android.util.Log
import androidx.exifinterface.media.ExifInterface
import java.io.File
import java.io.FileOutputStream
import kotlin.random.Random

/**
 * ============================================================
 * 选图后的原生压缩（原生版）
 * ============================================================
 * 迁移自 `:app` 的 `feature/media/ImageCompressor`，改造点只有一处：
 *
 * **输出从 `content://`（FileProvider Uri）改为 `File`** —— 原因：
 *  · 包名变了（`top.kuangdada.k.nativeapp`），`:app` 的 FileProvider authority 用不了；
 *  · 更重要的是 **multipart 上传需要真实文件**，中间转一道 Uri 纯属绕路。
 *
 * 保留原实现的三条核心判据（都有单测钉死，见 `ImageCompressorTest`）：
 *  1. **长边 > 2560 或体积 > 1.5MB 才压** —— 小图一律不重编码（重编码只掉画质、省不下体积）；
 *  2. **按长边等比缩到正好 2560**，而不是只靠 `inSampleSize` 的 2 的幂降采样 ——
 *     真机实测过 2700×1519 被"原尺寸重编码"，结果**体积反而变大**（295198B → 342768B）；
 *  3. **压完必须真的更小才采用**，否则丢结果沿用原图（负优化守卫）。
 *
 * 另外两条同样关键：
 *  · **EXIF 方向烘焙进像素**：`BitmapFactory` 不自动旋转，不烘焙就会"预览是正的、上传后躺倒"；
 *  · **GIF 一律跳过**：重编码会毁掉动画。
 *
 * 任何一步失败都**返回 null**，由调用方回退到原图 —— 压缩是优化，绝不能变成"发不了图"。
 */
object ImageCompressor {

    private const val TAG = "KImageCompress"
    private const val MAX_DIMEN = 2560
    private const val JPEG_QUALITY = 88
    private const val SIZE_THRESHOLD_BYTES = 1_500_000L

    /**
     * 压缩判据（**纯函数**）：长边超过 [MAX_DIMEN] 或体积超过 [SIZE_THRESHOLD_BYTES] 才压。
     *
     * 「解不出尺寸且体积未知（0）」时**不压** —— 失败就回退原图，不误伤。
     */
    internal fun needsCompressionFor(width: Int, height: Int, sizeBytes: Long): Boolean =
        width > MAX_DIMEN || height > MAX_DIMEN || sizeBytes > SIZE_THRESHOLD_BYTES

    /**
     * 目标尺寸：长边超过 [max] 时**等比缩到正好 max**（不是 2 的幂次采样）。
     * 极端比例也不会缩成 0（最小 1）。
     */
    internal fun scaledSizeFor(width: Int, height: Int, max: Int = MAX_DIMEN): Pair<Int, Int> {
        val longest = maxOf(width, height)
        if (longest <= 0 || longest <= max) return width to height
        val ratio = max.toDouble() / longest
        return maxOf(1, (width * ratio).toInt()) to maxOf(1, (height * ratio).toInt())
    }

    /** 压完之后要不要采用结果：**必须真的更小**才用（含空文件这种编码失败） */
    internal fun smallerThanOriginal(originalBytes: Long, compressedBytes: Long): Boolean =
        compressedBytes > 0L && compressedBytes < originalBytes

    /**
     * 从相册/拍照返回的 `content://` 取图并压缩，产物写到 cacheDir。
     *
     * **必须在工作线程调用**（解码 + 编码都是重活）。
     *
     * @return 压缩后的文件；不需要压缩、或任何一步失败时返回 **null**（调用方回退原图）
     */
    fun compressToFile(context: Context, source: Uri, purpose: String = "composer"): File? = try {
        val mime = context.contentResolver.getType(source) ?: ""
        if (!mime.startsWith("image/") || mime == "image/gif") {
            null
        } else {
            val bounds = decodeBounds(context, source)
            val (srcWidth, srcHeight) = bounds ?: (0 to 0)
            val size = contentLength(context, source)
            if (!needsCompressionFor(srcWidth, srcHeight, size)) {
                null
            } else {
                val bitmap = decodeSampled(context, source, srcWidth, srcHeight)
                if (bitmap == null) {
                    null
                } else {
                    val rotated = applyExifOrientation(context, source, bitmap)
                    if (rotated !== bitmap) bitmap.recycle()

                    val scaled = scaleToMaxDimension(rotated)
                    if (scaled !== rotated) rotated.recycle()

                    val result = writeJpeg(context, scaled, purpose, srcWidth, srcHeight, size)
                    scaled.recycle()
                    result
                }
            }
        }
    } catch (t: Throwable) {
        Log.w(TAG, "压缩失败，回退原图: $source", t)
        null
    }

    /**
     * 从**本地文件**压缩（发布弹层已经先把 uri 拷进 cache 了，这里给它再压一道）。
     * 与 [compressToFile] 同一套判据，只是入口不同。
     */
    fun compressFile(context: Context, source: File, purpose: String = "composer"): File? = try {
        if (!source.exists() || source.length() <= 0) {
            null
        } else {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(source.absolutePath, bounds)
            val (srcWidth, srcHeight) = bounds.outWidth to bounds.outHeight
            if (!needsCompressionFor(srcWidth, srcHeight, source.length())) {
                null
            } else {
                val options = BitmapFactory.Options().apply {
                    inSampleSize = sampleSizeFor(srcWidth, srcHeight)
                    inPreferredConfig = Bitmap.Config.ARGB_8888
                }
                val bitmap = BitmapFactory.decodeFile(source.absolutePath, options)
                if (bitmap == null) {
                    null
                } else {
                    val rotated = applyExifOrientationFromFile(source, bitmap)
                    if (rotated !== bitmap) bitmap.recycle()
                    val scaled = scaleToMaxDimension(rotated)
                    if (scaled !== rotated) rotated.recycle()
                    val result = writeJpeg(context, scaled, purpose, srcWidth, srcHeight, source.length())
                    scaled.recycle()
                    result
                }
            }
        }
    } catch (t: Throwable) {
        Log.w(TAG, "压缩本地文件失败，回退原图: $source", t)
        null
    }

    // ------------------------------------------------------------------

    private fun writeJpeg(
        context: Context,
        bitmap: Bitmap,
        purpose: String,
        srcWidth: Int,
        srcHeight: Int,
        srcBytes: Long,
    ): File? {
        val dir = File(context.cacheDir, "compressed_$purpose")
        if (!dir.exists() && !dir.mkdirs()) return null
        val out = File(dir, "IMG-${System.currentTimeMillis()}-${Random.nextInt(1000)}.jpg")
        FileOutputStream(out).use { stream ->
            bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, stream)
        }
        Log.d(TAG, "压缩 ${srcWidth}x$srcHeight/${srcBytes}B → ${bitmap.width}x${bitmap.height}/${out.length()}B")
        // 负优化守卫：重编码后没有更小就丢结果（真机实测过 295KB → 342KB）
        if (!smallerThanOriginal(srcBytes, out.length())) {
            Log.d(TAG, "压缩结果没有更小（${srcBytes}B → ${out.length()}B），沿用原图")
            out.delete()
            return null
        }
        return out
    }

    private fun decodeBounds(context: Context, uri: Uri): Pair<Int, Int>? = try {
        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) }
        if (options.outWidth > 0 && options.outHeight > 0) options.outWidth to options.outHeight else null
    } catch (t: Throwable) {
        null
    }

    private fun sampleSizeFor(width: Int, height: Int): Int {
        var sample = 1
        while (width / (sample * 2) >= MAX_DIMEN || height / (sample * 2) >= MAX_DIMEN) {
            sample *= 2
        }
        return sample
    }

    private fun decodeSampled(context: Context, uri: Uri, width: Int, height: Int): Bitmap? = try {
        val options = BitmapFactory.Options().apply {
            inSampleSize = sampleSizeFor(width, height)
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) }
    } catch (t: Throwable) {
        Log.w(TAG, "解码失败: $uri", t)
        null
    }

    /** 长边超过 [MAX_DIMEN] 时精确等比缩放（返回新 Bitmap；已在阈值内则原样返回） */
    private fun scaleToMaxDimension(bitmap: Bitmap): Bitmap {
        val (width, height) = scaledSizeFor(bitmap.width, bitmap.height)
        if (width == bitmap.width && height == bitmap.height) return bitmap
        return try {
            Bitmap.createScaledBitmap(bitmap, width, height, true)
        } catch (t: Throwable) {
            Log.w(TAG, "缩放失败，沿用解码结果", t)
            bitmap
        }
    }

    /**
     * 把 EXIF 方向烘焙进像素。
     * 为什么必须做：`BitmapFactory` **不**自动旋转，而相册预览会按 EXIF 旋转 ——
     * 不处理就会"预览是正的、上传后躺倒"。
     */
    private fun applyExifOrientation(context: Context, uri: Uri, bitmap: Bitmap): Bitmap {
        val orientation = try {
            context.contentResolver.openInputStream(uri)?.use { stream ->
                ExifInterface(stream).getAttributeInt(
                    ExifInterface.TAG_ORIENTATION,
                    ExifInterface.ORIENTATION_NORMAL,
                )
            } ?: ExifInterface.ORIENTATION_NORMAL
        } catch (t: Throwable) {
            ExifInterface.ORIENTATION_NORMAL
        }
        return rotateBy(bitmap, orientation)
    }

    private fun applyExifOrientationFromFile(file: File, bitmap: Bitmap): Bitmap {
        val orientation = try {
            ExifInterface(file.absolutePath).getAttributeInt(
                ExifInterface.TAG_ORIENTATION,
                ExifInterface.ORIENTATION_NORMAL,
            )
        } catch (t: Throwable) {
            ExifInterface.ORIENTATION_NORMAL
        }
        return rotateBy(bitmap, orientation)
    }

    private fun rotateBy(bitmap: Bitmap, orientation: Int): Bitmap {
        val matrix = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> matrix.postRotate(90f)
            ExifInterface.ORIENTATION_ROTATE_180 -> matrix.postRotate(180f)
            ExifInterface.ORIENTATION_ROTATE_270 -> matrix.postRotate(270f)
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.postScale(-1f, 1f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.postScale(1f, -1f)
            ExifInterface.ORIENTATION_TRANSPOSE -> {
                matrix.postRotate(90f)
                matrix.postScale(-1f, 1f)
            }
            ExifInterface.ORIENTATION_TRANSVERSE -> {
                matrix.postRotate(270f)
                matrix.postScale(-1f, 1f)
            }
            else -> return bitmap
        }
        return try {
            Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
        } catch (t: Throwable) {
            Log.w(TAG, "旋转失败，沿用未旋转位图", t)
            bitmap
        }
    }

    private fun contentLength(context: Context, uri: Uri): Long = try {
        context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { it.length } ?: -1L
    } catch (t: Throwable) {
        -1L
    }
}
