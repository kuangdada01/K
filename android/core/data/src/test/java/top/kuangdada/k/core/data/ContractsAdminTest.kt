package top.kuangdada.k.core.data

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import top.kuangdada.k.core.data.model.AdminAnnouncementPage
import top.kuangdada.k.core.data.model.AdminPostPage
import top.kuangdada.k.core.data.model.AdminUserPage
import top.kuangdada.k.core.data.model.AdminUserRow
import top.kuangdada.k.core.data.model.AnnouncementDto

/**
 * ============================================================
 * 管理后台 / 公告 的契约测试（M3 第 14 项）
 * ============================================================
 * 两个最容易错的地方：
 *  1. **封禁是否"现在生效"必须比时间**：服务端只存 `banned_until`，不自己判过期 ——
 *     直接判 `bannedUntil != null` 会把"已到期的封禁"也显示成已禁言（管理界面据此
 *     会给出错误的"解封"按钮，而实际用户早已正常）；
 *  2. 用户/公告列表有**两种响应形状**（带 page 与不带 page）—— 原生侧一律带 page，
 *     但 DTO 必须能解析带 page 的那种（含驼峰 `totalPages` 与蛇形 `has_more` 混排）。
 */
class ContractsAdminTest {

    private val json = Json { ignoreUnknownKeys = true; isLenient = true; explicitNulls = false }

    @Test
    fun `管理端用户列表解析混排字段`() {
        val body = """
            {"users":[{"id":3,"username":"旷达","email":"a@b.c","avatar":null,"bio":"",
             "role":"admin","banned_until":null,"created_at":"2026-01-01T00:00:00.000Z",
             "post_count":12}],
             "total":1,"page":1,"limit":20,"totalPages":1,"has_more":false}
        """.trimIndent()
        val page = json.decodeFromString(AdminUserPage.serializer(), body)
        val u = page.users.single()
        assertEquals(3L, u.id)
        assertEquals(12, u.postCount)
        assertEquals(1, page.totalPages) // 驼峰
        assertFalse(page.hasMore) // 蛇形
        assertTrue(u.isAdmin)
        assertNull(u.bannedUntil)
    }

    @Test
    fun `未封禁用户 isBannedNow 为 false`() {
        val u = AdminUserRow(id = 1, username = "u", bannedUntil = null)
        assertFalse(u.isBannedNow())
    }

    @Test
    fun `封禁未到期的用户 isBannedNow 为 true`() {
        // 用很久以后的固定时间，避免测试随当前时间失效
        val u = AdminUserRow(id = 1, username = "u", bannedUntil = "2099-01-01T00:00:00.000Z")
        assertTrue(u.isBannedNow())
    }

    @Test
    fun `封禁已到期的用户 isBannedNow 必须为 false`() {
        // 这是最关键的用例：服务端只存解封时间、不自己判过期；
        // 客户端若直接判 `bannedUntil != null`，这条会错判成"已禁言"。
        val u = AdminUserRow(id = 1, username = "u", bannedUntil = "2020-01-01T00:00:00.000Z")
        assertFalse(u.isBannedNow())
    }

    @Test
    fun `banned_until 是无法解析的字符串时保守判为封禁中`() {
        // 解析失败时宁可显示"已禁言"（fail-closed）：管理界面给"解封"按钮比
        // 给"封禁"按钮安全 —— 反过来的话管理员可能对已封禁用户重复封禁。
        val u = AdminUserRow(id = 1, username = "u", bannedUntil = "not-a-date")
        assertTrue(u.isBannedNow())
    }

    @Test
    fun `管理端帖子列表形状与信息流一致`() {
        val body = """
            {"posts":[{"id":5,"user_id":2,"image_url":"[]","title":"t","description":"d",
             "close_comments":0,"pinned":1,"share_count":3,"repost_count":1,
             "created_at":"2026-02-01T00:00:00.000Z","username":"某人","avatar":null}],
             "total":1,"page":1,"totalPages":1}
        """.trimIndent()
        val page = json.decodeFromString(AdminPostPage.serializer(), body)
        val p = page.posts.single()
        assertEquals(2L, p.userId)
        assertTrue(p.isPinned)
        assertEquals(3, p.shareCount)
    }

    @Test
    fun `管理端公告列表用驼峰 totalPages 与蛇形 has_more`() {
        val body = """
            {"announcements":[{"id":1,"title":"维护通知","content":"今晚维护",
             "target_user_id":null,"from_user_id":1,"created_at":"2026-03-01T00:00:00.000Z",
             "target_username":null}],
             "total":1,"page":1,"limit":20,"totalPages":1,"has_more":false}
        """.trimIndent()
        val page = json.decodeFromString(AdminAnnouncementPage.serializer(), body)
        val a = page.announcements.single()
        assertNull(a.targetUserId) // null = 全体公告
        assertEquals(1, page.totalPages)
        assertFalse(page.hasMore)
    }

    @Test
    fun `用户侧公告带 is_read 与发布者快照`() {
        val body = """
            {"announcements":[{"id":7,"title":"t","content":"c","target_user_id":9,
             "from_user_id":1,"created_at":"2026-03-01T00:00:00.000Z",
             "from_username":"管理员","from_avatar":null,"is_read":1}]}
        """.trimIndent()
        val a = json.decodeFromString(
            top.kuangdada.k.core.data.model.AnnouncementsResponse.serializer(),
            body,
        ).announcements.single()
        assertEquals(7L, a.id)
        assertTrue(a.read) // is_read 是数字 0/1，不是布尔
        assertEquals("管理员", a.fromUsername)
        assertEquals(9L, a.targetUserId)
    }

    @Test
    fun `封禁响应带 banned_until`() {
        val body = """{"success":true,"banned_until":"2026-04-01T00:00:00.000Z"}"""
        val r = json.decodeFromString<top.kuangdada.k.core.data.model.BanResult>(body)
        assertTrue(r.success)
        assertEquals("2026-04-01T00:00:00.000Z", r.bannedUntil)
    }

    @Test
    fun `解封响应 banned_until 为 null`() {
        val body = """{"success":true,"banned_until":null}"""
        val r = json.decodeFromString<top.kuangdada.k.core.data.model.BanResult>(body)
        assertNull(r.bannedUntil)
    }
}
