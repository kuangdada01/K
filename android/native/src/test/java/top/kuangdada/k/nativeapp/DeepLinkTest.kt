package top.kuangdada.k.nativeapp

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import top.kuangdada.k.nativeapp.ui.AppDestination
import top.kuangdada.k.nativeapp.ui.decodeDest
import top.kuangdada.k.nativeapp.ui.encodeDest

/**
 * ============================================================
 * 深链解析测试（M4 第 17 项）
 * ============================================================
 * 为什么值得专门测：深链解析错了**不会报错**，只会把用户送到错误的页面
 * （往往被当成"缓存问题"或"App 卡了"）。而且 Web 版是 hash 路由
 * （`#/post/1`），分享出去的链接形态不止一种。
 *
 * 覆盖的边界：带/不带 www、查询串、hash 路由、尾斜杠、缺 scheme、
 * 非法 id、未知路径。
 */
class DeepLinkTest {

    private fun path(url: String) = DeepLink.parse(url)

    // ---------------- 基本路由（与 client/src/router/AppRoutes.tsx 对齐） ----------------

    @Test
    fun `首页`() {
        assertEquals(AppDestination.Home, path("https://www.kuangdada.top/"))
        assertEquals(AppDestination.Home, path("https://www.kuangdada.top"))
    }

    @Test
    fun `搜索发现`() {
        assertEquals(AppDestination.Explore(), path("https://www.kuangdada.top/explore"))
    }

    @Test
    fun `图书列表与详情`() {
        assertEquals(AppDestination.Books, path("https://www.kuangdada.top/books"))
        assertEquals(AppDestination.BookDetailDest("abc123"), path("https://www.kuangdada.top/books/abc123"))
    }

    @Test
    fun `阅读器落到图书详情（章节由详情页决定）`() {
        // /books/:id/read 需要章节文件名，而深链里没有，所以先到详情页
        assertEquals(
            AppDestination.BookDetailDest("abc123"),
            path("https://www.kuangdada.top/books/abc123/read"),
        )
    }

    @Test
    fun `语音列表与房内`() {
        assertEquals(AppDestination.Voice, path("https://www.kuangdada.top/voice"))
        assertEquals(AppDestination.VoiceRoomDest(42), path("https://www.kuangdada.top/voice/42"))
    }

    @Test
    fun `私信会话`() {
        assertEquals(AppDestination.Messages, path("https://www.kuangdada.top/messages"))
        val chat = path("https://www.kuangdada.top/messages/7")
        assertEquals(AppDestination.ChatDest(7, null), chat)
    }

    @Test
    fun `个人主页 管理后台 公告`() {
        assertEquals(AppDestination.Profile, path("https://www.kuangdada.top/profile"))
        // `/profile/:id` 是**他人主页**（二级页，顶栏自带返回）。
        // 以前这里被无条件落到自己的主页 —— 别人分享来的 `/profile/9` 会打开
        // "我的主页"，用户看到的是自己的资料（很难被当成 bug 报上来，但确实是错的）。
        assertEquals(
            AppDestination.UserProfileDest(9),
            path("https://www.kuangdada.top/profile/9"),
        )
        assertEquals(AppDestination.Admin, path("https://www.kuangdada.top/admin"))
        assertEquals(AppDestination.Announcements, path("https://www.kuangdada.top/announcements"))
    }

    @Test
    fun `他人主页 id 非法时退回自己的主页`() {
        // `/profile/abc`、`/profile/0`：构造不出用户主页目标（id 必须是正整数），
        // 退回一级 tab 而不是推一个 id 为 0 的死页面
        assertEquals(AppDestination.Profile, path("https://www.kuangdada.top/profile/abc"))
        assertEquals(AppDestination.Profile, path("https://www.kuangdada.top/profile/0"))
    }

    @Test
    fun `他人主页的导航状态可序列化（进程回收后能恢复）`() {
        val raw = encodeDest(AppDestination.UserProfileDest(9))
        assertEquals(AppDestination.UserProfileDest(9), decodeDest(raw))
    }

    @Test
    fun `帖子链接落到首页（详情页尚未实现，刻意降级）`() {
        assertEquals(AppDestination.Home, path("https://www.kuangdada.top/post/123"))
    }

    // ---------------- URL 形态边界 ----------------

    @Test
    fun `带 www 与不带 www 都要认`() {
        assertEquals(AppDestination.Explore(), path("https://kuangdada.top/explore"))
        assertEquals(AppDestination.Explore(), path("https://www.kuangdada.top/explore"))
    }

    @Test
    fun `尾斜杠不影响解析`() {
        assertEquals(AppDestination.VoiceRoomDest(42), path("https://www.kuangdada.top/voice/42/"))
    }

    @Test
    fun `查询串被忽略`() {
        assertEquals(
            AppDestination.BookDetailDest("b1"),
            path("https://www.kuangdada.top/books/b1?from=share&x=1"),
        )
    }

    @Test
    fun `hash 路由形态（Web 版就是 hash 路由）`() {
        assertEquals(AppDestination.Explore(), path("https://www.kuangdada.top/#/explore"))
        assertEquals(AppDestination.VoiceRoomDest(5), path("https://www.kuangdada.top/#/voice/5"))
        // hash 后面为空时退回前半段
        assertEquals(AppDestination.Home, path("https://www.kuangdada.top/#"))
    }

    @Test
    fun `缺 scheme 的写法也要认`() {
        assertEquals(AppDestination.Explore(), path("kuangdada.top/explore"))
        assertEquals(AppDestination.Explore(), path("/explore"))
        assertEquals(AppDestination.Explore(), path("explore"))
    }

    // ---------------- 非法输入 ----------------

    @Test
    fun `非法 id 退回父级列表页而不是构造出 id 为 0 的目标`() {
        // 关键判据：**绝不能**构造出 id=0 的目标（那会去请求一个不存在的房间/用户）。
        // 退回列表页是安全的降级 —— 用户看到的是"房间列表"，而不是一个空房间。
        assertEquals(AppDestination.Voice, path("https://www.kuangdada.top/voice/abc"))
        assertEquals(AppDestination.Messages, path("https://www.kuangdada.top/messages/xyz"))
        assertEquals(AppDestination.Voice, path("https://www.kuangdada.top/voice/0"))
        assertEquals(AppDestination.Messages, path("https://www.kuangdada.top/messages/-3"))
    }

    @Test
    fun `未知路径返回 null（调用方保持默认首页）`() {
        assertNull(path("https://www.kuangdada.top/not-a-real-page"))
        assertNull(path("https://example.com/explore")) // 非本站：路径长得像也不认
        assertNull(path(""))
        assertNull(path("   "))
        // 裸主机名 = 站点根，按首页处理（与 Web 版 `<Navigate to="/" replace />` 的语义一致）
        assertEquals(AppDestination.Home, path("https://www.kuangdada.top"))
    }

    @Test
    fun `帖子 id 非法时退回首页`() {
        // 帖子详情页尚未实现（见 DeepLink 类注释的"刻意降级"），
        // 所以合法 id 也先落首页；非法 id 同样落首页，不做额外区分。
        assertEquals(AppDestination.Home, path("https://www.kuangdada.top/post/abc"))
        assertEquals(AppDestination.Home, path("https://www.kuangdada.top/post/0"))
    }

    // ---------------- 应用内编码形态（通知点击用） ----------------

    @Test
    fun `通知里的 voice 编码形态要能解析`() {
        // VoiceForegroundService 的通知 PendingIntent 带的就是这种
        assertEquals(AppDestination.VoiceRoomDest(42), path("voice:42"))
        assertEquals(AppDestination.VoiceRoomDest(7), path("voice:7"))
    }

    @Test
    fun `通知里的 book 与 chat 编码形态`() {
        assertEquals(AppDestination.BookDetailDest("abc"), path("book:abc"))
        assertEquals(AppDestination.ChatDest(7, null), path("chat:7"))
        assertEquals(AppDestination.ChatDest(7, "小明"), path("chat:7:小明"))
    }

    @Test
    fun `编码形态非法值返回 null（不能误判成路由）`() {
        assertNull(path("voice:abc"))
        assertNull(path("voice:0"))
        assertNull(path("book:"))
        assertNull(path("随便一段文本"))
        assertNull(path("hello"))
    }
}
