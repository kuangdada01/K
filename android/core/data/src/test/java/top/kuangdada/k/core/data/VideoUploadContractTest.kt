package top.kuangdada.k.core.data

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import top.kuangdada.k.core.data.api.TempVideoStatus
import top.kuangdada.k.core.data.api.TempVideoResponse
import top.kuangdada.k.core.data.model.Post

/**
 * ============================================================
 * 视频发布的契约测试
 * ============================================================
 * 这一域有两个**失败时无声**的坑，都在这里钉住：
 *
 *  1. **扩展名必须保住**。服务端 video 上传的 fileFilter 是
 *     「扩展名在 `VIDEO_EXTS` 白名单内 **且** mimetype 以 video 斜杠开头或为
 *     octet-stream」（注意：在 KDoc 里直接写「video 斜杠 星号」会提前结束块注释，
 *     Kotlin 的块注释不嵌套），而 Android 的 Photo Picker 给的 `content://`
 *     是**没有文件名**的 —— 拷到 cacheDir 时必须按 MIME 猜一个扩展名出来，
 *     否则上传直接被 400 "仅支持视频格式文件" 拒掉（用户侧只看到"视频传不上去"）。
 *  2. **转码状态未知值要按"没好"处理**。`video-temp/status` 返回 done/encoding/missing，
 *     把未知值当成 done 会让用户在文件还没转码完时发布，播出来是黑屏。
 */
class VideoUploadContractTest {

    private val json = Json { ignoreUnknownKeys = true; isLenient = true; explicitNulls = false }

    @Test
    fun `白名单覆盖服务端 VIDEO_EXTS 的全部扩展名`() {
        // 与 server/src/routes/posts/media.ts 的 VIDEO_EXTS 一一对应
        val serverExts = listOf(".mp4", ".mov", ".avi", ".webm", ".mkv", ".flv", ".wmv")
        serverExts.forEach { ext ->
            assertTrue("$ext 应在白名单内", isAcceptableVideoName("temp-1-2$ext"))
        }
    }

    @Test
    fun `扩展名大小写不敏感`() {
        assertTrue(isAcceptableVideoName("VIDEO.MP4"))
        assertTrue(isAcceptableVideoName("clip.MOV"))
        assertEquals(".mp4", videoExtension("VIDEO.MP4"))
    }

    @Test
    fun `没有扩展名或不在白名单内一律拒绝`() {
        assertFalse(isAcceptableVideoName("video"))
        assertFalse(isAcceptableVideoName("video."))
        assertFalse(isAcceptableVideoName("clip.m4v"))
        assertFalse(isAcceptableVideoName("clip.mp4.exe"))
        assertFalse(isAcceptableVideoName(""))
    }

    // ------------------------------------------------------------------
    // 体积上限（2026-09-29 线上：626MB / 660MB 的视频被 nginx 413 掐掉）
    // ------------------------------------------------------------------

    /**
     * 上限必须与服务端 `MAX_VIDEO_BYTES`（shared/src/constants/upload.ts）一致。
     *
     * 为什么这个数不能"随便大一点"：单次 multipart 的报文还得挤过 nginx 的
     * `client_max_body_size` —— 客户端比服务端宽松时，用户等来的不是
     * 服务端那句可读的「视频超过大小限制」，而是 nginx 的 413（客户端只能显示
     * 「请求失败（413）」）。宁可本地拦严一点。
     */
    @Test
    fun `体积上限与服务端一致（1GB）`() {
        assertEquals(1024L * 1024 * 1024, MAX_VIDEO_BYTES)
        // 且必须小于 nginx 的 client_max_body_size（部署要求 ≥1100M），给 multipart 开销留余量
        assertTrue("上限不能贴到 nginx 的 1100M", MAX_VIDEO_BYTES < 1100L * 1024 * 1024)
    }

    @Test
    fun `刚好在上限内放行、超出一字节就拦下`() {
        assertNull("等于上限应该放行", videoSizeError(MAX_VIDEO_BYTES))
        assertNotNull("超出 1 字节必须拦下", videoSizeError(MAX_VIDEO_BYTES + 1))
    }

    @Test
    fun `体积未知（provider 查不到）不当成超限`() {
        // 少数 content:// 来源给不出 SIZE（OpenableColumns 为空、fd.length 也是 -1）：
        // 不能因为"读不到体积"就拒绝一个正常视频，交给服务端兜底
        assertNull(videoSizeError(-1))
        assertNull(videoSizeError(0))
    }

    @Test
    fun `超限提示带上体积与可照做的动作`() {
        // 线上那次被 nginx 413 掐掉的真实体积：656,344,755 B ≈ 625.9MB —— 上限提到 1GB 后
        // 它已合法放行；超限样本按新上限构造（1GB + 当年那个 626MB 文件）
        val bytes = MAX_VIDEO_BYTES + 656_344_755L
        val msg = videoSizeError(bytes)
        assertNotNull(msg)
        val expectedMb = String.format(java.util.Locale.US, "%.1f", bytes / 1024.0 / 1024.0)
        assertTrue("要写清实际体积（$expectedMb）：$msg", msg!!.contains(expectedMb))
        assertTrue("要写清上限：$msg", msg.contains("1024"))
        assertTrue("要告诉用户怎么办：$msg", msg.contains("裁剪") || msg.contains("压缩"))
    }

    @Test
    fun `临时视频响应解析`() {
        val r = json.decodeFromString(
            TempVideoResponse.serializer(),
            """{"url":"/uploads/temp/temp-1730000000000-123.mp4"}""",
        )
        assertEquals("/uploads/temp/temp-1730000000000-123.mp4", r.url)
    }

    @Test
    fun `转码状态三态与未知值`() {
        fun status(s: String) = json.decodeFromString(TempVideoStatus.serializer(), """{"status":"$s"}""")

        assertTrue(status("done").isDone)
        assertFalse(status("encoding").isDone)
        assertTrue(status("missing").isMissing)
        // 服务端将来加了新状态时，客户端必须**保守地当作还没好**，不能自动放行发布
        assertFalse(status("queued").isDone)
        assertFalse(status("something_new").isDone)
    }

    @Test
    fun `视频帖返回体带 video_url 与 video_cover`() {
        val body = """
            {"id":7,"user_id":1,"image_url":"","images":[],"title":"",
             "description":"随手拍","created_at":"2026-03-01T10:00:00.000Z",
             "username":"我","avatar":null,"like_count":0,"comment_count":0,"share_count":0,
             "repost_count":0,"location":"",
             "video_url":"/uploads/post-1-2.mp4","video_cover":"/uploads/post-1-2.jpg"}
        """.trimIndent()
        val post = json.decodeFromString(Post.serializer(), body)
        assertEquals("/uploads/post-1-2.mp4", post.videoUrl)
        assertEquals("/uploads/post-1-2.jpg", post.videoCover)

        // PostUi 必须把两个相对路径都解析成绝对地址（原生侧拼错的表现是"封面全白但不报错"）
        val ui = post.toUi("https://www.kuangdada.top")
        assertEquals("https://www.kuangdada.top/uploads/post-1-2.mp4", ui.videoUrl)
        assertEquals("https://www.kuangdada.top/uploads/post-1-2.jpg", ui.videoCoverUrl)
        assertTrue(ui.hasVideo)
    }

    @Test
    fun `图文帖没有视频地址`() {
        val body = """
            {"id":8,"user_id":1,"image_url":"[\"/uploads/a.jpg\"]","images":["/uploads/a.jpg"],
             "title":"","description":"图文","created_at":"2026-03-01T10:00:00.000Z",
             "username":"我","location":""}
        """.trimIndent()
        val ui = json.decodeFromString(Post.serializer(), body).toUi("https://www.kuangdada.top")
        assertEquals(null, ui.videoUrl)
        assertEquals(null, ui.videoCoverUrl)
        assertFalse(ui.hasVideo)
    }
}
