package top.kuangdada.k.core.data

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import top.kuangdada.k.core.data.model.BookDetail
import top.kuangdada.k.core.data.model.BookListResponse
import top.kuangdada.k.core.data.model.CreateRoomResponse
import top.kuangdada.k.core.data.model.UserPostsResponse
import top.kuangdada.k.core.data.model.UserProfile
import top.kuangdada.k.core.data.model.VoiceRoomListResponse

/**
 * ============================================================
 * M2 新增 DTO 的契约测试
 * ============================================================
 * 这里的每个用例都对应一个**服务端真实形状**，而且都是"字段名写错就静默失效"的地方
 * （页面不报错、就是没数据/没封面/分页永远只有一页）。
 *
 * 特别值得盯的三处不一致：
 *  1. 图书域用**驼峰** `volumeCount` / `chapterCount`，而帖子域是 snake_case；
 *  2. 语音房间用**驼峰** `participantCount` / `isCreator`，但 `creator_id` / `created_at` 是 snake_case
 *     —— 同一个对象里两种风格混着来，这是最容易写错的；
 *  3. `VoiceRoom.creator_id` 对访客创建的房间是 **0**（占位），归属只能看 `isCreator`。
 */
class ContractsM2Test {

    private val json = Json { ignoreUnknownKeys = true; isLenient = true; explicitNulls = false }

    // ---------------------------------------------------------------
    // 图书
    // ---------------------------------------------------------------

    @Test
    fun `图书列表解析驼峰字段`() {
        val body = """
            {"books":[{"id":"novel","title":"某小说","author":"某人","description":"简介",
            "cover":"/api/books/novel/cover","volumeCount":3,"chapterCount":42}]}
        """.trimIndent()
        val list = json.decodeFromString(BookListResponse.serializer(), body)
        val book = list.books.single()
        assertEquals("novel", book.id)
        // 这两个是驼峰 —— 写成 volume_count 就会静默变成 0
        assertEquals(3, book.volumeCount)
        assertEquals(42, book.chapterCount)
        assertEquals("/api/books/novel/cover", book.cover)
    }

    @Test
    fun `无封面时 cover 为 null 而不是空串`() {
        val body = """{"books":[{"id":"x","title":"t","volumeCount":0,"chapterCount":0}]}"""
        val book = json.decodeFromString(BookListResponse.serializer(), body).books.single()
        assertNull(book.cover)
    }

    @Test
    fun `图书详情解析卷与章节_pdf 与 text 两种类型`() {
        val body = """
            {"id":"b1","title":"书","author":"作者","description":"","cover":null,
             "volumes":[
               {"name":"第一卷","chapters":[
                  {"file":"第一卷/001.txt","type":"text","title":"开端"},
                  {"file":"第一卷/002.pdf","type":"pdf","title":"附录"}]},
               {"name":"","chapters":[{"file":"000.txt","type":"text","title":"序"}]
             }]}
        """.trimIndent()
        val detail = json.decodeFromString(BookDetail.serializer(), body)
        assertEquals(2, detail.volumes.size)
        // 根目录章节的卷名是空串（服务端行为）
        assertEquals("", detail.volumes[1].name)
        // 拍平后必须有全局顺序，否则"下一章"无从实现
        assertEquals(3, detail.flatChapters.size)
        assertEquals("第一卷/001.txt", detail.flatChapters[0].file)
        assertTrue(detail.flatChapters[1].isPdf)
        assertEquals(false, detail.flatChapters[0].isPdf)
        assertEquals(3, detail.chapterCount)
    }

    // ---------------------------------------------------------------
    // 用户资料
    // ---------------------------------------------------------------

    @Test
    fun `用户资料解析统计字段`() {
        val body = """
            {"id":7,"username":"旷达","avatar":"/uploads/a.jpg","bio":"你好","role":"admin",
             "created_at":"2026-01-01T00:00:00.000Z","post_count":12,
             "followers_count":34,"following_count":56}
        """.trimIndent()
        val profile = json.decodeFromString(UserProfile.serializer(), body)
        assertEquals(7L, profile.id)
        assertEquals(12, profile.postCount)
        assertEquals(34, profile.followersCount)
        assertEquals(56, profile.followingCount)
        assertEquals("admin", profile.role)
    }

    @Test
    fun `用户帖子列表用驼峰 totalPages`() {
        val body = """{"posts":[],"total":5,"page":2,"totalPages":3}"""
        val r = json.decodeFromString(UserPostsResponse.serializer(), body)
        assertEquals(5, r.total)
        assertEquals(2, r.page)
        assertEquals(3, r.totalPages)
    }

    // ---------------------------------------------------------------
    // 语音房间
    // ---------------------------------------------------------------

    @Test
    fun `语音房间解析驼峰与蛇形混排字段`() {
        val body = """
            {"rooms":[{"id":3,"name":"深夜电台","description":"随便聊聊","creator_id":0,
             "created_at":"2026-03-01T10:00:00.000Z","creator_username":"未登录-1",
             "creator_avatar":null,"participantCount":4,"isCreator":true}]}
        """.trimIndent()
        val room = json.decodeFromString(VoiceRoomListResponse.serializer(), body).rooms.single()
        assertEquals(3L, room.id)
        // snake_case
        assertEquals(0L, room.creatorId)
        assertEquals("未登录-1", room.creatorUsername)
        // 驼峰（服务端逐查看者计算）
        assertEquals(4, room.participantCount)
        assertTrue(room.isCreator)
    }

    @Test
    fun `访客房间 creator_id 为 0 占位_归属只能看 isCreator`() {
        // 服务端明确说明：creator_id 对访客房间是 0，不要用相等判断归属
        val body = """{"rooms":[{"id":9,"name":"r","creator_id":0,"participantCount":0,"isCreator":false}]}"""
        val room = json.decodeFromString(VoiceRoomListResponse.serializer(), body).rooms.single()
        assertEquals(0L, room.creatorId)
        assertEquals(false, room.isCreator)
    }

    @Test
    fun `建房响应里的 ownerToken 只在创建时下发`() {
        val body = """
            {"room":{"id":11,"name":"新房","description":"","creator_id":0,
             "creator_username":"未登录-2","participantCount":0,"isCreator":true},
             "ownerToken":"tok_abc"}
        """.trimIndent()
        val r = json.decodeFromString(CreateRoomResponse.serializer(), body)
        assertEquals(11L, r.room.id)
        assertEquals("tok_abc", r.ownerToken)
    }

    @Test
    fun `登录用户建房时没有 ownerToken`() {
        val body = """{"room":{"id":12,"name":"n","creator_id":5,"participantCount":0,"isCreator":true}}"""
        val r = json.decodeFromString(CreateRoomResponse.serializer(), body)
        assertNull(r.ownerToken)
        assertEquals(5L, r.room.creatorId)
    }
}
