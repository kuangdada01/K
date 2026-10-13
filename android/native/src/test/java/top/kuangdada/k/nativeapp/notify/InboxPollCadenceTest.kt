package top.kuangdada.k.nativeapp.notify

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * [InboxPollCadence] 真值表：轮询节奏错了的表现是"后台空打请求"（耗电）或
 * "后台彻底收不到提醒"（漏消息），真机上很难定位 —— 用真值表钉死。
 */
class InboxPollCadenceTest {

    @Test
    fun `前台一律按 30s 轮询（与推送绑定无关）`() {
        assertEquals(30_000, InboxPollCadence.shell(foreground = true, pushServerBound = false))
        assertEquals(30_000, InboxPollCadence.shell(foreground = true, pushServerBound = true))
    }

    @Test
    fun `后台已绑定厂商推送 → 停表（后台提醒归系统推送服务）`() {
        assertEquals(0, InboxPollCadence.shell(foreground = false, pushServerBound = true))
    }

    @Test
    fun `后台未绑定推送 → 90s 低频兜底（厂商推送发不出来，轮询是唯一提醒渠道）`() {
        assertEquals(90_000, InboxPollCadence.shell(foreground = false, pushServerBound = false))
    }

    @Test
    fun `页面级消费方仅前台保留间隔，后台停表`() {
        assertEquals(10_000, InboxPollCadence.page(foreground = true, pageMs = 10_000))
        assertEquals(0, InboxPollCadence.page(foreground = false, pageMs = 10_000))
    }
}
