package top.kuangdada.k.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * ============================================================
 * 「哪条事件该弹通知」的契约测试
 * ============================================================
 * 这段判定原来写在 `AppShell` 的 UI 代码里，只能靠"对方发一条、我这边看有没有反应"来验。
 * 搬成纯函数后把几条**踩过的坑**钉住：
 *  · 收发双方都会收到 `message` 事件（服务端刻意如此），自己发的回声不能提醒；
 *  · 撤回走的是同一个 `message` 类型，只多一个 `recalled`；
 *  · `notice` 里的 post_id 决定点击能不能直达帖子。
 */
class NoticePolicyTest {

    private val me = 42L

    @Test
    fun `发给我的新私信_提醒到那个会话`() {
        val notice = NoticePolicy.decide(
            RealtimeClient.Event(type = "message", from = 7, to = me),
            myUserId = me,
        )
        assertEquals(NoticePolicy.Notice.Message(7L), notice)
    }

    @Test
    fun `自己发出去的回声_不提醒`() {
        // 服务端对收发双方都推 message：不做这一步过滤，"我自己发的消息"会弹成"有人给我发消息"
        assertNull(
            NoticePolicy.decide(
                RealtimeClient.Event(type = "message", from = me, to = 7),
                myUserId = me,
            )
        )
    }

    @Test
    fun `还不知道自己是谁时_私信一律不提醒`() {
        // myUserId = 0（冷启动还没拿到 /auth/me）：无法区分"发给我"和"我发的"，宁可少提醒
        assertNull(
            NoticePolicy.decide(
                RealtimeClient.Event(type = "message", from = 7, to = me),
                myUserId = 0L,
            )
        )
    }

    @Test
    fun `撤回事件不算新消息`() {
        assertNull(
            NoticePolicy.decide(
                RealtimeClient.Event(type = "message", from = 7, to = me, recalled = 88),
                myUserId = me,
            )
        )
    }

    @Test
    fun `缺少发送者id的私信_不提醒`() {
        // 没有 from 就没有 `chat:<id>` 深链目标，点了只会落到消息页 —— 不如不发
        assertNull(
            NoticePolicy.decide(RealtimeClient.Event(type = "message", to = me), myUserId = me)
        )
    }

    @Test
    fun `互动通知_带上帖子的post_id`() {
        val notice = NoticePolicy.decide(
            RealtimeClient.Event(type = "notification", commentId = 99, postId = 12),
            myUserId = me,
        )
        assertEquals(NoticePolicy.Notice.Interaction(12L), notice)
    }

    @Test
    fun `互动通知没有post_id时_仍然提醒_只是退到消息页`() {
        val notice = NoticePolicy.decide(
            RealtimeClient.Event(type = "notification", commentId = 99),
            myUserId = me,
        )
        assertEquals(NoticePolicy.Notice.Interaction(null), notice)
    }

    @Test
    fun `新公告`() {
        val notice = NoticePolicy.decide(
            RealtimeClient.Event(type = "announcement", announcementId = 5),
            myUserId = me,
        )
        assertEquals(NoticePolicy.Notice.Announcement(5L), notice)
    }

    @Test
    fun `未知事件类型_不猜也不提醒`() {
        assertNull(
            NoticePolicy.decide(RealtimeClient.Event(type = "typing"), myUserId = me)
        )
    }

    @Test
    fun `空事件_不提醒`() {
        assertNull(NoticePolicy.decide(RealtimeClient.Event(), myUserId = me))
    }
}
