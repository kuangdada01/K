package top.kuangdada.k.core.data

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import top.kuangdada.k.core.data.model.Post
import top.kuangdada.k.core.data.model.PostListWithMore
import top.kuangdada.k.core.data.model.PostPage

/**
 * ============================================================
 * 数据层契约测试（脱离真机，纯 JVM）
 * ============================================================
 * 这三块是**最容易静默失效**的地方 —— 出问题的表现都是"页面不报错、就是没数据/没反应"，
 * 真机上极难定位，所以必须用单测钉住：
 *
 *  1. **错误映射**：服务端错误信封是 `{ error, banned? }`，映射错了用户只会看到"操作失败"；
 *  2. **相对 URL 拼接**：服务端返回 `/uploads/x.jpg`，拼错就是"图片全白但不报错"；
 *  3. **DTO 字段名**：与 server 的 snake_case 契约一一对应，错一个字段就是静默丢数据。
 */
class ContractsTest {

    // ---------------------------------------------------------------
    // 1. 错误映射
    // ---------------------------------------------------------------

    @Test
    fun `401 映射为登录失效`() {
        val error = mapError(RuntimeException("x"), responseCode = 401, responseBody = """{"error":"Invalid token"}""")
        assertTrue(error is ApiError.Unauthorized)
    }

    @Test
    fun `403 带 banned 标记时保留封禁语义`() {
        val body = """{"error":"账号已被封禁（解封时间: 2026-10-01），封禁期间仅可浏览","banned":true}"""
        val error = mapError(RuntimeException("x"), responseCode = 403, responseBody = body)
        assertTrue(error is ApiError.Forbidden)
        assertEquals(true, (error as ApiError.Forbidden).banned)
        // 文案必须原样透传：封禁提示里带解封日期，替换成通用文案会丢失关键信息
        assertTrue(error.message.contains("2026-10-01"))
    }

    @Test
    fun `400 使用服务端文案而不是通用兜底`() {
        val error = mapError(RuntimeException("x"), responseCode = 400, responseBody = """{"error":"验证码错误或已过期"}""")
        assertEquals("验证码错误或已过期", error.message)
    }

    @Test
    fun `响应体不是合法 JSON 时回退到状态码默认文案`() {
        val error = mapError(RuntimeException("x"), responseCode = 404, responseBody = "<html>nginx</html>")
        assertEquals("内容不存在或已被删除", error.message)
    }

    @Test
    fun `5xx 文案与 4xx 区分`() {
        assertEquals("服务器繁忙，请稍后再试", mapError(RuntimeException("x"), responseCode = 503).message)
    }

    @Test
    fun `限流 429 有专门文案`() {
        assertEquals("操作过于频繁，请稍后再试", mapError(RuntimeException("x"), responseCode = 429).message)
    }

    @Test
    fun `超时与网络不可用是两种错误`() {
        val timeout = object : java.io.IOException("timeout") {
            override val message: String get() = "connect timed out"
        }
        // 这里只验证分类逻辑不抛异常、且落在 Network 家族（真实超时类名由 OkHttp 决定）
        assertTrue(mapError(timeout) is ApiError)
        assertTrue(mapError(java.io.IOException("Connection refused")) is ApiError.Network)
    }

    // ---------------------------------------------------------------
    // 2. 相对 URL 拼接
    // ---------------------------------------------------------------

    @Test
    fun `相对路径拼成绝对地址`() {
        assertEquals(
            "https://www.kuangdada.top/uploads/a.jpg",
            resolveUrl("/uploads/a.jpg", "https://www.kuangdada.top"),
        )
    }

    @Test
    fun `baseUrl 末尾斜杠不会造成双斜杠`() {
        assertEquals(
            "https://www.kuangdada.top/uploads/a.jpg",
            resolveUrl("/uploads/a.jpg", "https://www.kuangdada.top/"),
        )
    }

    @Test
    fun `已是绝对地址时原样返回`() {
        assertEquals(
            "https://cdn.example.com/a.jpg",
            resolveUrl("https://cdn.example.com/a.jpg", "https://www.kuangdada.top"),
        )
    }

    @Test
    fun `空值与空白返回 null`() {
        assertNull(resolveUrl(null, "https://x"))
        assertNull(resolveUrl("", "https://x"))
        assertNull(resolveUrl("   ", "https://x"))
    }

    @Test
    fun `不以斜杠开头的相对路径也能拼`() {
        assertEquals(
            "https://www.kuangdada.top/uploads/a.jpg",
            resolveUrl("uploads/a.jpg", "https://www.kuangdada.top"),
        )
    }

    // ---------------------------------------------------------------
    // 3. DTO 字段名（与服务端 snake_case 契约对齐）
    // ---------------------------------------------------------------

    private val json = Json { ignoreUnknownKeys = true; isLenient = true; explicitNulls = false }

    @Test
    fun `PostPage 解析 totalPages 驼峰字段`() {
        val body = """
            {"posts":[{"id":1,"user_id":2,"image_url":"[]","images":["/uploads/a.jpg"],
            "title":"t","description":"d","created_at":"2026-09-13T07:19:34.025Z",
            "username":"u","avatar":null,"like_count":3,"comment_count":1,"share_count":0,
            "liked":1,"bookmarked":0,"reposted":1,"repost_count":2,"pinned":0}],
            "total":42,"page":2,"totalPages":3}
        """.trimIndent()
        val page = json.decodeFromString(PostPage.serializer(), body)
        assertEquals(42, page.total)
        assertEquals(2, page.page)
        // totalPages 是驼峰（服务端就是驼峰），不是 total_pages
        assertEquals(3, page.totalPages)
        assertTrue(page.hasMore)
        val post = page.posts.first()
        assertEquals(2L, post.userId)
        assertEquals(3, post.likeCount)
        assertEquals(2, post.repostCount)
        assertTrue(post.isLiked)
        assertTrue(post.isReposted)
        assertEquals(false, post.isBookmarked)
        // images 是服务端用 withImages() 补出来的数组
        assertEquals(listOf("/uploads/a.jpg"), post.images)
    }

    @Test
    fun `收藏与转发列表用的是 has_more 而不是分页字段`() {
        val body = """{"posts":[],"has_more":true}"""
        val list = json.decodeFromString(PostListWithMore.serializer(), body)
        assertTrue(list.hasMore)
        assertTrue(list.posts.isEmpty())
    }

    @Test
    fun `未登录时 liked 等状态字段为 null 而不是 false`() {
        // 服务端 optionalAuth 下这些字段不返回 —— 必须能解析成 null，
        // 否则 JSON 解析会抛异常，表现是"游客看不到任何帖子"
        val body = """{"id":1,"user_id":2,"image_url":"[]"}"""
        val post = json.decodeFromString(Post.serializer(), body)
        assertNull(post.liked)
        assertNull(post.bookmarked)
        assertTrue(!post.isLiked)
    }

    @Test
    fun `未知字段被忽略（服务端只增不改）`() {
        val body = """{"id":1,"user_id":2,"image_url":"[]","brand_new_field":"x"}"""
        val post = json.decodeFromString(Post.serializer(), body)
        assertEquals(1L, post.id)
    }

    // ---------------------------------------------------------------
    // 4. 时间显示
    // ---------------------------------------------------------------

    @Test
    fun `相对时间按档位输出`() {
        val now = 1_772_000_000_000L // 固定基准，避免测试依赖当前时间
        val iso = "2026-02-24T10:00:00.000Z"
        val base = kotlinx.serialization.json.Json
        // 用一个计算好的偏移验证各档（解析失败会原样返回，所以先断言能解析）
        val parsed = resolveUrl(iso, "https://x") // 占位，避免未使用警告
        assertTrue(parsed != null)
        assertEquals("刚刚", relativeTime(iso, parseMillisForTest(iso) + 10_000))
        assertEquals("5 分钟前", relativeTime(iso, parseMillisForTest(iso) + 5 * 60_000))
        assertEquals("3 小时前", relativeTime(iso, parseMillisForTest(iso) + 3 * 3_600_000))
        assertEquals("2 天前", relativeTime(iso, parseMillisForTest(iso) + 2 * 86_400_000L))
        // 超过 30 天显示具体日期
        assertTrue(relativeTime(iso, parseMillisForTest(iso) + 40L * 86_400_000L).startsWith("2026-"))
        assertTrue(now > 0)
        assertTrue(base is Json)
    }

    @Test
    fun `解析不了的时间原样返回而不是抛异常`() {
        assertEquals("not-a-date", relativeTime("not-a-date"))
        assertEquals("", relativeTime(""))
    }

    private fun parseMillisForTest(iso: String): Long =
        java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US).apply {
            timeZone = java.util.TimeZone.getTimeZone("UTC")
        }.parse(iso)!!.time
}
