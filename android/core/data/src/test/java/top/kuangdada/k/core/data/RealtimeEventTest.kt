package top.kuangdada.k.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ============================================================
 * SSE 事件负载的契约测试（实时刷新）
 * ============================================================
 * 服务端 `server/src/sse.ts` 推的是 `data: {"type":..., ...}\n\n`，字段名由各业务调用点决定：
 *   · `message`      → `{ from, to }`            （message.service.ts:88）
 *   · `notification` → `{ comment_id, post_id }` （posts/comments.ts:127）
 *   · `announcement` → `{ announcement_id }`     （admin/announcements.routes.ts）
 *
 * 为什么值得钉住：**字段名写错不会报错**，只会表现为"事件收到了但什么都没刷新"
 * —— 而这类问题只能靠"对方发一条我这边没反应"来发现，排查成本很高。
 * 这里把三种真实负载原样作为用例输入（JSON 文本照抄服务端）。
 */
class RealtimeEventTest {

    private fun parse(json: String) = KJson.decodeFromString<RealtimeClient.Event>(json)

    @Test
    fun `新私信 带 from 与 to`() {
        val e = parse("""{"type":"message","from":7,"to":42}""")
        assertTrue(e.isMessage)
        assertEquals(7L, e.from)
        assertEquals(42L, e.to)
    }

    @Test
    fun `新通知 带 comment_id 与 post_id`() {
        val e = parse("""{"type":"notification","comment_id":99,"post_id":12}""")
        assertTrue(e.isNotification)
        assertEquals(12L, e.postId)
        assertEquals(99L, e.commentId)
    }

    @Test
    fun `新公告 带 announcement_id`() {
        val e = parse("""{"type":"announcement","announcement_id":5}""")
        assertTrue(e.isAnnouncement)
        assertEquals(5L, e.announcementId)
        assertNull(e.postId)
    }

    @Test
    fun `未知类型不炸且原样保留`() {
        // 将来服务端加新事件类型时，旧客户端应当安静忽略而不是崩掉
        val e = parse("""{"type":"typing","conversation_id":3}""")
        assertEquals("typing", e.type)
        assertTrue(!e.isMessage && !e.isNotification && !e.isAnnouncement)
    }

    @Test
    fun `多出的字段被忽略_不认识的负载不崩`() {
        val e = parse("""{"type":"notification","post_id":12,"future_field":{"a":1}}""")
        assertEquals(12L, e.postId)
    }
}
