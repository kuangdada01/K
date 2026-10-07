package top.kuangdada.k.nativeapp.download

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * ============================================================
 * 「把这条图片/视频存进手机相册」—— 下载 + 落盘的一层
 * ============================================================
 * [MediaStoreSaver] 只管"把字节写进相册"，而用户点的是**一条 URL**，
 * 中间那次下载（以及私密图片要带的 JWT 头）收在这里，界面只调一个 suspend 函数。
 *
 * 两个刻意的取舍：
 *  · **用 HttpURLConnection 而不是 OkHttp 的私有 client**：[KApi](../../../../../../../../core/data/src/main/java/top/kuangdada/k/core/data/KApi.kt)
 *    的 client 是私有的（只对外给 Retrofit 服务接口），为了下载去把它开个口子，
 *    等于让"保存到相册"这条弱依赖长进网络层；这里要的只是"一次带头的 GET"。
 *    跟帖子/聊天的图片是**两份独立实现**：媒体 URL 的场景只有读，没有重试/续期这些要求。
 *  · **图片进内存、视频走流式**：封面图几十到几百 KB，直接 ByteArray 最省事；
 *    视频动辄几十上百 MB，攒内存会 OOM —— 所以视频是"边下边写进相册输出流"。
 *
 * 超时给得比 JSON 接口宽：媒体文件大、弱网下慢但在动，20s 的读超时会把"正常的慢"判成失败。
 * 这里的读超时是**单次读**的上限（连上了但一个字节都不来），不是整个下载的上限。
 */
object MediaSaver {

    private const val TAG = "KSave"

    /** 连接 15s / 单次读 30s —— 与 [KApi] 的 15/20 同量级，略放宽给媒体 */
    private const val CONNECT_TIMEOUT_MS = 15_000
    private const val READ_TIMEOUT_MS = 30_000

    /** 一次媒体下载的结果（界面据此提示；不抛异常，失败也要有话说） */
    sealed interface Result {
        /** 已存进系统相册 */
        data object Saved : Result

        /** 失败；[reason] 是给用户看的一句话（"网络断了" / "保存失败"） */
        data class Failed(val reason: String) : Result
    }

    /** 保存一张图片：整张读进内存再写相册（图片体量小，缓存友好、失败面小） */
    suspend fun saveImage(
        context: Context,
        url: String,
        namePrefix: String,
        headers: Map<String, String> = emptyMap(),
    ): Result = withContext(Dispatchers.IO) {
        try {
            // HttpURLConnection **不是 Closeable**（只有流是），所以这里不能 .use {}
            val conn = openConnection(url, headers)
            val code = conn.responseCode
            if (code !in 200..299) return@withContext Result.Failed("服务器返回 $code")
            val bytes = conn.inputStream.use { it.readBytes() }
            if (bytes.isEmpty()) return@withContext Result.Failed("图片是空的")
            val ext = MediaStoreSaver.extensionOf(url, "jpg")
            val name = MediaStoreSaver.timestampedName(namePrefix, ext)
            val ok = MediaStoreSaver.saveImage(
                context = context,
                bytes = bytes,
                fileName = name,
                mimeType = MediaStoreSaver.mimeTypeOf(name),
            )
            if (ok) Result.Saved else Result.Failed("保存失败（相册不可写）")
        } catch (e: Exception) {
            Log.w(TAG, "保存图片失败: $url", e)
            Result.Failed("网络异常，没保存成功")
        }
    }

    /**
     * 保存一个视频：**流式**边下边写（不整段进内存）。
     *
     * [onProgress] 给 0f..1f（总长度未知时一直是 0f）—— 视频要下几秒到几十秒，
     * 界面得能显示"在转"，否则用户会以为点不动而反复点。
     */
    suspend fun saveVideo(
        context: Context,
        url: String,
        namePrefix: String,
        headers: Map<String, String> = emptyMap(),
        onProgress: (Float) -> Unit = {},
    ): Result = withContext(Dispatchers.IO) {
        try {
            val conn = openConnection(url, headers)
            val code = conn.responseCode
            if (code !in 200..299) return@withContext Result.Failed("服务器返回 $code")
            val total = conn.contentLengthLong
            val ext = MediaStoreSaver.extensionOf(url, "mp4")
            val name = MediaStoreSaver.timestampedName(namePrefix, ext)
            val mime = MediaStoreSaver.videoMimeTypeOf(name)
            val ok = conn.inputStream.use { input ->
                MediaStoreSaver.saveVideo(context, name, mime) { out ->
                    copyStream(input, out, total, onProgress)
                }
            }
            if (ok) Result.Saved else Result.Failed("保存失败（相册不可写）")
        } catch (e: Exception) {
            Log.w(TAG, "保存视频失败: $url", e)
            Result.Failed("网络异常，没保存成功")
        }
    }

    /** 带可选鉴权头的 GET（私信图片必须带 Bearer，否则 403；公开媒体传空表即可） */
    private fun openConnection(url: String, headers: Map<String, String>): HttpURLConnection {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = READ_TIMEOUT_MS
            // 跟着 CDN/反代的跳转走（媒体地址经常是 302 到对象存储）
            instanceFollowRedirects = true
        }
        headers.forEach { (k, v) -> conn.setRequestProperty(k, v) }
        return conn
    }

    /** 流式拷贝；返回是否完整写完（写一半断网要返回 false，让相册那条记录被清掉） */
    private fun copyStream(
        input: InputStream,
        out: java.io.OutputStream,
        total: Long,
        onProgress: (Float) -> Unit,
    ): Boolean {
        val buf = ByteArray(64 * 1024)
        var copied = 0L
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            out.write(buf, 0, n)
            copied += n
            if (total > 0) onProgress((copied.toFloat() / total).coerceIn(0f, 1f))
        }
        out.flush()
        // 长度已知时必须对得上：短了就是连接被掐断（半截视频）
        return total <= 0 || copied >= total
    }
}
