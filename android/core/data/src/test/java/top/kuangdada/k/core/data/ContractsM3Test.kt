package top.kuangdada.k.core.data

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import top.kuangdada.k.core.data.model.ConversationsResponse
import top.kuangdada.k.core.data.model.IceConfigResponse
import top.kuangdada.k.core.data.model.MessageDto
import top.kuangdada.k.core.data.model.MessageHistoryResponse
import top.kuangdada.k.core.data.model.Post

/**
 * ============================================================
 * 私信 / 发帖 的契约测试（M3）
 * ============================================================
 * 这一域有三处**极易写错且失败时无声**的地方：
 *  1. 消息历史是**游标分页**（`has_more` = 还有更早的消息），不是页码分页；
 *  2. 会话列表是 `{ conversations: [...] }`，而 `GET /:userId` 是 `{ messages, has_more }`
 *     —— 两个端点的外层字段名不同；
 *  3. 引用消息可能**只有图片没有文字**（quoted_content 为空、quoted_image_url 有值），
 *     UI 只判 content 的话会显示成一个空的引用条。
 */
class ContractsM3Test {

    private val json = Json { ignoreUnknownKeys = true; isLenient = true; explicitNulls = false }

    @Test
    fun `会话列表外层字段是 conversations`() {
        val body = """
            {"conversations":[{"partner_id":9,"username":"林深","avatar":"/uploads/a.jpg",
             "last_message":"深色那边我刚看过，确实好多了","last_message_at":"2026-03-01T10:00:00.000Z",
             "unread_count":2}]}
        """.trimIndent()
        val r = json.decodeFromString(ConversationsResponse.serializer(), body)
        val conv = r.conversations.single()
        assertEquals(9L, conv.partnerId)
        assertEquals(2, conv.unreadCount)
        // 注意是 partner_id（不是 user_id）
        assertEquals("林深", conv.username)
    }

    @Test
    fun `消息历史是游标分页_外层字段是 messages 与 has_more`() {
        val body = """
            {"messages":[{"id":31,"sender_id":1,"receiver_id":2,"content":"在吗","read":1,
             "created_at":"2026-03-01T09:00:00.000Z","sender_username":"我"}],
             "has_more":true}
        """.trimIndent()
        val r = json.decodeFromString(MessageHistoryResponse.serializer(), body)
        assertTrue(r.hasMore)
        assertEquals(31L, r.messages.single().id)
        assertTrue(r.messages.single().isRead)
    }

    @Test
    fun `纯图片消息的 content 为空但 image_url 有值`() {
        val body = """{"id":1,"sender_id":1,"receiver_id":2,"content":"","image_url":"abc.jpg","read":0,"sender_username":"我"}"""
        val m = json.decodeFromString(MessageDto.serializer(), body)
        assertTrue(m.hasImage)
        assertEquals("", m.content)
    }

    @Test
    fun `引用消息的四个字段可全部为 null`() {
        val body = """{"id":2,"sender_id":1,"receiver_id":2,"content":"hi","read":0,"sender_username":"我"}"""
        val m = json.decodeFromString(MessageDto.serializer(), body)
        assertNull(m.quotedMessageId)
        assertEquals("", m.quotedPreview)
    }

    @Test
    fun `引用纯图片消息时 quotedPreview 回退为图片占位`() {
        // 服务端可能给"引用的是一条图片消息"：quoted_content 为空、quoted_image_url 有值。
        // UI 只判 content 的话，引用条会是一片空白。
        val body = """
            {"id":3,"sender_id":1,"receiver_id":2,"content":"这张不错","read":0,
             "sender_username":"我","quoted_message_id":1,"quoted_content":null,
             "quoted_image_url":"abc.jpg","quoted_sender_username":"对方"}
        """.trimIndent()
        val m = json.decodeFromString(MessageDto.serializer(), body)
        assertEquals(1L, m.quotedMessageId)
        assertEquals("[图片]", m.quotedPreview)
        assertEquals("对方", m.quotedSenderUsername)
    }

    @Test
    fun `引用文字消息时 quotedPreview 用文字`() {
        val body = """
            {"id":4,"sender_id":1,"receiver_id":2,"content":"收到","read":0,"sender_username":"我",
             "quoted_message_id":1,"quoted_content":"原消息","quoted_sender_username":"对方"}
        """.trimIndent()
        val m = json.decodeFromString(MessageDto.serializer(), body)
        assertEquals("原消息", m.quotedPreview)
    }

    @Test
    fun `发送消息的响应是单条 message 对象而不是包在数组里`() {
        // POST /api/messages 直接返回 message 对象（不是 { messages: [...] }）
        val body = """{"id":9,"sender_id":1,"receiver_id":2,"content":"新消息","read":0,"created_at":"2026-03-02T00:00:00.000Z","sender_username":"我"}"""
        val m = json.decodeFromString(MessageDto.serializer(), body)
        assertEquals(9L, m.id)
        assertEquals("新消息", m.content)
    }

    @Test
    fun `发帖响应复用 Post 形状且带 images 数组`() {
        val body = """
            {"id":77,"user_id":1,"image_url":"[\"/uploads/x.jpg\"]","images":["/uploads/x.jpg"],
             "title":"标题","description":"正文","created_at":"2026-03-02T00:00:00.000Z",
             "username":"我","avatar":null,"like_count":0,"comment_count":0,"share_count":0,
             "close_comments":1}
        """.trimIndent()
        val p = json.decodeFromString(Post.serializer(), body)
        assertEquals(77L, p.id)
        assertEquals(listOf("/uploads/x.jpg"), p.images)
        // close_comments 是数字 1（服务端 SQLite 返回数字），不是布尔
        assertTrue(p.commentsClosed)
    }

    // ---------------------------------------------------------------
    // 语音 ICE 配置（线上真实响应，两种 urls 形态混用）
    // ---------------------------------------------------------------

    @Test
    fun `ICE 配置解析真实响应_stun 是数组而 turn 是单个字符串`() {
        // 这条样例是**直接从线上抓的**（2026-09 实测），不是拼出来的：
        // 服务端对 STUN 给数组、对带鉴权的 TURN 给单字符串，符合 WebRTC 的
        // RTCIceServer.urls: string | string[] 规范。
        //
        // 之前只按 List<String> 解，会在第二条上抛 SerializationException ——
        // 真机表现是"房间提示：获取配置失败：服务端返回的数据格式异常"，
        // 而信令/鉴权/其他接口全正常，很容易被误判成网络问题。
        val body = """
            {"iceServers":[
              {"urls":["stun:stun.miwifi.com:3478","stun:stun.l.google.com:19302"]},
              {"urls":"turn:120.25.100.193:3478","username":"kvoice","credential":"81488226880808ae9f55e25b71326de2"}
            ]}
        """.trimIndent()

        val config = json.decodeFromString(IceConfigResponse.serializer(), body)
        assertEquals(2, config.iceServers.size)

        val stun = config.iceServers[0]
        assertEquals(2, stun.urls.size)
        assertEquals("stun:stun.miwifi.com:3478", stun.urls.first())
        assertNull(stun.username)

        val turn = config.iceServers[1]
        // 关键：单字符串被归一化成长度为 1 的数组，而不是解析失败
        assertEquals(listOf("turn:120.25.100.193:3478"), turn.urls)
        assertEquals("kvoice", turn.username)
        assertEquals("81488226880808ae9f55e25b71326de2", turn.credential)
    }

    @Test
    fun `urls 为单个字符串时也能解`() {
        val body = """{"iceServers":[{"urls":"stun:example.com:3478"}]}"""
        val config = json.decodeFromString(IceConfigResponse.serializer(), body)
        assertEquals(listOf("stun:example.com:3478"), config.iceServers.single().urls)
    }

    @Test
    fun `urls 为空数组时解出空列表`() {
        val body = """{"iceServers":[{"urls":[]}]}"""
        val config = json.decodeFromString(IceConfigResponse.serializer(), body)
        assertTrue(config.iceServers.single().urls.isEmpty())
    }

    @Test
    fun `完全没有 iceServers 字段时解出空配置而不是崩`() {
        val config = json.decodeFromString(IceConfigResponse.serializer(), "{}")
        assertTrue(config.iceServers.isEmpty())
    }
}
