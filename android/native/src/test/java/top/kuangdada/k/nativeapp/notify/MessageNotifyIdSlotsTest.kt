package top.kuangdada.k.nativeapp.notify

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [MessageNotifyIdSlots]：私信通知 id 槽位分配。
 *
 * 取模方案（`基准 + partnerId % 槽数`）的撞号在真机上表现为"A 的通知被 B 覆盖、
 * 点进 A 的会话撤掉 B 的通知"，极难定位 —— 用真值表钉死两条不变量：
 * 同一 partner 恒定、不同 partner 不撞号。
 */
class MessageNotifyIdSlotsTest {

    @Test
    fun `同一 partner 恒定（新消息覆盖旧通知的前提）`() {
        val slots = MessageNotifyIdSlots()
        val first = slots.idFor(42L)
        assertEquals(first, slots.idFor(42L))
        assertEquals(first, slots.idFor(42L))
    }

    @Test
    fun `不同 partner 不撞号（取模方案在 id 相差 10000 时会撞）`() {
        val slots = MessageNotifyIdSlots()
        // 旧取模方案下这一对必然撞号：42 % 10000 == 10042 % 10000
        val a = slots.idFor(42L)
        val b = slots.idFor(10_042L)
        assertTrue(a != b)
        assertTrue(slots.idFor(1L) != slots.idFor(2L))
    }

    @Test
    fun `id 落在私信槽位区间内，不与互动_公告固定 id 段重叠`() {
        val slots = MessageNotifyIdSlots()
        repeat(1_000) { i ->
            val id = slots.idFor(100_000L + i)
            assertTrue("id=$id 越界", id >= SocialNotifier.ID_MESSAGE_BASE)
            assertTrue("id=$id 越界", id < SocialNotifier.ID_INTERACTION)
        }
    }

    @Test
    fun `超过槽位总数才轮转回收（8 万活跃会话前永不复用）`() {
        val slots = MessageNotifyIdSlots()
        val firstId = slots.idFor(1L)
        // 分配远少于槽位总数的活跃会话：id 两两不同
        val ids = (2L..5_000L).map { slots.idFor(it) }.toSet()
        assertEquals(4_999, ids.size)
        assertEquals(firstId, slots.idFor(1L)) // partner 1 的槽位仍稳定
    }

    @Test
    fun `槽位耗尽后轮转回收最老分配的槽位（计数推进）`() {
        val slots = MessageNotifyIdSlots(next = MessageNotifyIdSlots.MESSAGE_ID_SLOTS - 1)
        val lastFresh = slots.idFor(7L) // 拿到最后一个空闲槽位
        assertEquals(
            MessageNotifyIdSlots.MESSAGE_ID_BASE + MessageNotifyIdSlots.MESSAGE_ID_SLOTS - 1,
            lastFresh,
        )
        // 计数推进到槽位总数 → 回卷：新 partner 复用 0 号槽位
        val wrapped = slots.idFor(8L)
        assertEquals(MessageNotifyIdSlots.MESSAGE_ID_BASE, wrapped)
    }

    @Test
    fun `落盘条目格式往返一致（含负数 partnerId）`() {
        val entries = listOf(1L, -42L, Long.MAX_VALUE).map { partner ->
            SocialNotifier.formatMessageIdEntry(partner, 7)
        }
        assertEquals(
            listOf(1L to 7, -42L to 7, Long.MAX_VALUE to 7),
            entries.mapNotNull { SocialNotifier.parseMessageIdEntry(it) },
        )
    }

    @Test
    fun `坏条目解析返回 null 而不是抛错（落盘数据损坏时自愈）`() {
        assertEquals(null, SocialNotifier.parseMessageIdEntry("not-a-pair"))
        assertEquals(null, SocialNotifier.parseMessageIdEntry(":5"))
        assertEquals(null, SocialNotifier.parseMessageIdEntry("abc:xyz"))
    }
}
