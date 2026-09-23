package top.kuangdada.k.nativeapp.download

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ============================================================
 * 下载/保存的纯逻辑单测
 * ============================================================
 * 这些辅助函数在真机上出错的代价很高而且**很难查**：
 * 文件名带 `/` 会被 DownloadManager 直接拒绝（用户看到"下载失败"但没有任何原因），
 * 相册落库时带路径分隔符在某些 ROM 上直接抛 IllegalArgumentException。
 * 所以把它们从 Android 依赖里剥出来单独钉住。
 */
class DownloadHelpersTest {

    // ---------------- DownloadController.defaultName ----------------

    @Test
    fun `默认文件名取路径最后一段且去掉 query`() {
        assertEquals(
            "k-app-1.2.3-release.apk",
            DownloadController.defaultName("https://www.kuangdada.top/downloads/k-app-1.2.3-release.apk"),
        )
        assertEquals(
            "k-app.apk",
            DownloadController.defaultName("https://www.kuangdada.top/dl/k-app.apk?token=abc&t=1"),
        )
    }

    @Test
    fun `默认文件名兜底`() {
        assertEquals("download", DownloadController.defaultName(""))
        assertEquals("download", DownloadController.defaultName("https://www.kuangdada.top/"))
        // 形如 https://host（没有路径）时**不能拿域名当文件名**：
        // `:app` 原版就是那么干的，"下载"页里会出现一个叫 host 的文件
        assertEquals("download", DownloadController.defaultName("https://www.kuangdada.top"))
        assertEquals("download", DownloadController.defaultName("https://www.kuangdada.top?x=1"))
        // fragment 也要摘掉，否则文件名会带上 #...
        assertEquals("k-app.apk", DownloadController.defaultName("https://a/b/k-app.apk#frag"))
    }

    // ---------------- DownloadController.sanitize ----------------

    @Test
    fun `净化替换所有非法字符`() {
        assertEquals("a_b_c_d_e_f_g_h_i_j", DownloadController.sanitize("a/b\\c:d*e?f\"g<h>i|j"))
    }

    @Test
    fun `正常文件名不被改动`() {
        assertEquals("k-app-1.2.3-release.apk", DownloadController.sanitize("k-app-1.2.3-release.apk"))
        // 空格与中文是合法的，不要动
        assertEquals("我的 安装包.apk", DownloadController.sanitize("我的 安装包.apk"))
    }

    @Test
    fun `超长文件名被截断到 120`() {
        val long = "a".repeat(300) + ".apk"
        assertEquals(120, DownloadController.sanitize(long).length)
    }

    // ---------------- MediaStoreSaver ----------------

    @Test
    fun `按扩展名推断 mime`() {
        assertEquals("image/jpeg", MediaStoreSaver.mimeTypeOf("a.jpg"))
        assertEquals("image/jpeg", MediaStoreSaver.mimeTypeOf("A.JPEG"))
        assertEquals("image/png", MediaStoreSaver.mimeTypeOf("a.PNG"))
        assertEquals("image/webp", MediaStoreSaver.mimeTypeOf("a.webp"))
        assertEquals("image/gif", MediaStoreSaver.mimeTypeOf("a.gif"))
        // 未知/无扩展名兜底成 jpeg（相册按 mime 分类，兜底比空串安全）
        assertEquals("image/jpeg", MediaStoreSaver.mimeTypeOf("noext"))
    }

    @Test
    fun `展示名带时间戳与合法扩展名`() {
        val name = MediaStoreSaver.timestampedName("K", ".png")
        assertTrue(name.startsWith("K-"))
        assertTrue(name.endsWith(".png"))
        // 扩展名带不带点都要能正确处理
        assertTrue(MediaStoreSaver.timestampedName("K", "webp").endsWith(".webp"))
        // 前缀为空时兜底成 K，扩展名为空时兜底成 jpg
        assertTrue(MediaStoreSaver.timestampedName("", "").startsWith("K-"))
        assertTrue(MediaStoreSaver.timestampedName("", "").endsWith(".jpg"))
    }

    @Test
    fun `minSdk 27 需要走 legacy 权限分支`() {
        // 单测跑在 JVM 上，Build.VERSION.SDK_INT 为 0 → 必须判定"需要权限"。
        // 这条断言真正钉住的是"API<29 的判断方向不能反"：
        // 反了的话，API 27/28 设备上会跳过权限申请直接写盘，然后静默失败。
        assertTrue(MediaStoreSaver.needsLegacyPermission())
    }
}
