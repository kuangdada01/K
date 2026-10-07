package top.kuangdada.k.nativeapp.ui

import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.os.Build
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
/**
 * ============================================================
 * 视频首帧 / 抽帧 / 时长（发布页「选封面」用，M6.6）
 * ============================================================
 * 设计稿要求：选完视频后在发布页显示**视频画面**（首帧）+ 时长胶囊 + 「选封面」；
 * 点「选封面」滑出一张面板，里面是**从视频里抽的一排帧**，左右滑动挑一帧当封面。
 *
 * ## 为什么现在才做（之前刻意没做）
 *
 * `ComposerScreen` 里原来写着"为什么不显示视频首帧缩略图：要拿首帧就得解码
 * （MediaMetadataRetriever），对 300MB/4K 文件在低端机上很慢且容易 OOM" —— 那个顾虑是对的，
 * 但**有解**：`getScaledFrameAtTime`（API 27+，本工程 minSdk 就是 27）能**解码到指定宽度**，
 * 不用先解出整张 4K 位图再缩；再加上"整件事放到 IO 线程 + 抽帧数量固定"，
 * 300MB 视频也就是几百毫秒。所以这轮按设计稿做，但要守住三条：
 *
 *  1. **全部在 [Dispatchers.IO]** —— 抽帧是解码，绝不能压在组合/主线程上；
 *  2. **只抽固定几帧**（[STRIP_FRAMES] 帧，等比分布）—— 面板里那排缩略图够用就行，
 *     逐帧抽是"用解码器换滑动"；
 *  3. **尺寸按用途给死**：列表那排小图 [STRIP_WIDTH_PX]、发布页那块大图 [PREVIEW_WIDTH_PX]，
 *     真正上传的封面再单独抽一次 [COVER_WIDTH_PX]（要比缩略图清楚）。
 *
 * 抽出来的帧会**落到 cache 目录的 JPEG 文件**：一来上传要的是文件（multipart 不认 Bitmap），
 * 二来它们天然有文件名与 mime，服务端 `cover` 字段的白名单（图片扩展名 + mime）直接就能过。
 */
object VideoFrames {

    /** 封面面板里那排缩略图的张数（设计稿画了 5 个槽位，左右可以滑更多） */
    const val STRIP_FRAMES = 12

    /** 面板里那排小图的宽度（px，够看清是哪一帧即可） */
    private const val STRIP_WIDTH_PX = 240

    /** 发布页那块大图预览的宽度（px） */
    private const val PREVIEW_WIDTH_PX = 1080

    /** 真正上传的封面宽度（px）：比预览再宽一点，细节够用又不会几 MB */
    private const val COVER_WIDTH_PX = 1440

    /**
     * 读时长（毫秒）。拿不到返回 null —— 界面上就不显示时长胶囊，
     * 不影响其它功能（时长只是信息，不是流程前提）。
     */
    suspend fun durationMs(video: File): Long? = withContext(Dispatchers.IO) {
        withRetriever(video) { r ->
            r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
        }?.takeIf { it > 0L }
    }

    /**
     * 抽**首帧**并落成 cache 里的 JPEG（发布页那块大图）。
     * 拿不到（编码不支持/文件坏了）返回 null —— 界面退回"只有文件名 + 状态"的老样子。
     */
    suspend fun firstFrameFile(video: File, tag: String = "first"): File? =
        frameFile(video, atMs = 0L, widthPx = PREVIEW_WIDTH_PX, tag = tag)

    /**
     * 上传用的封面文件：由**某一帧**抽出来（宽度更大）。
     * 用户在面板里选中第几帧，发布时就上传哪一帧 —— 不是上传缩略图。
     */
    suspend fun coverFrameFile(video: File, atMs: Long): File? =
        frameFile(video, atMs = atMs, widthPx = COVER_WIDTH_PX, tag = "cover")

    /** 面板里那排缩略图（等比分布的 [count] 帧；时长未知时都取第一帧） */
    suspend fun stripFiles(video: File, durationMs: Long?, count: Int = STRIP_FRAMES): List<Pair<Long, File>> =
        withContext(Dispatchers.IO) {
            frameTimesMs(durationMs, count).mapNotNull { at ->
                frameFile(video, atMs = at, widthPx = STRIP_WIDTH_PX, tag = "strip")?.let { at to it }
            }
        }

    /** 抽某一时刻的帧并压成 JPEG 文件（cache 目录；文件名里带时间点，换帧不会读到上一次的） */
    private suspend fun frameFile(video: File, atMs: Long, widthPx: Int, tag: String): File? =
        withContext(Dispatchers.IO) {
            val bitmap = frameBitmap(video, atMs, widthPx) ?: return@withContext null
            runCatching {
                val dir = video.parentFile ?: return@runCatching null
                val out = File(dir, "k-frame-$tag-${video.name.hashCode()}-$atMs.jpg")
                FileOutputStream(out).use { bitmap.compress(Bitmap.CompressFormat.JPEG, 85, it) }
                out
            }.getOrNull().also { bitmap.recycle() }
        }

    private fun frameBitmap(video: File, atMs: Long, widthPx: Int): Bitmap? =
        withRetriever(video) { r ->
            runCatching {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                    // 解码到指定宽度：不经过"整张 4K 位图"，这是低端机上不 OOM 的关键
                    r.getScaledFrameAtTime(
                        atMs * 1000L,
                        MediaMetadataRetriever.OPTION_CLOSEST_SYNC,
                        widthPx,
                        (widthPx * 9 / 16),
                    )
                } else {
                    r.getFrameAtTime(atMs * 1000L, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
                }
            }.getOrNull()
        }

    private inline fun <T> withRetriever(video: File, block: (MediaMetadataRetriever) -> T): T? =
        runCatching {
            val r = MediaMetadataRetriever()
            try {
                r.setDataSource(video.absolutePath)
                block(r)
            } finally {
                runCatching { r.release() }
            }
        }.getOrNull()
}

/**
 * 抽帧的时间点（毫秒，等比分布）。
 *
 * 刻意**从 0 开始、到"末尾前一帧"结束**：最后一帧取 [duration] 本身在很多编码上会拿到空位图
 * （关键帧还没到），所以用 `duration - duration/(count*2)` 收尾；时长未知时退回"全是 0"，
 * 面板里就是同一张首帧（比抽不出来更好）。
 */
internal fun frameTimesMs(durationMs: Long?, count: Int): List<Long> {
    if (count <= 0) return emptyList()
    val d = durationMs ?: return List(count) { 0L }
    if (d <= 0L) return List(count) { 0L }
    if (count == 1) return listOf(0L)
    val end = d - (d / (count * 2L)).coerceAtLeast(1L)
    val step = (end / (count - 1)).coerceAtLeast(1L)
    return List(count) { i -> (step * i).coerceIn(0L, (d - 1).coerceAtLeast(0L)) }
}
