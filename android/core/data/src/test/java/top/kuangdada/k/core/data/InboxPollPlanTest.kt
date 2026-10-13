package top.kuangdada.k.core.data

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * ============================================================
 * 合并轮询的间隔计算
 * ============================================================
 * 规则只有一条（多消费方取最小间隔、全释放后归零），但错了的表现很隐蔽：
 *  · 算大了：消息页明明开着却按 30s 才刷新（用户只感觉"慢"）；
 *  · 算成常驻：离开消息页后全 App 一直在轮询（只体现在耗电上）；
 *  · 释放时没重算：定时器还在按旧间隔跑，或者干脆停了。
 */
class InboxPollPlanTest {

    @Test
    fun `没有消费方时不轮询`() {
        assertEquals(0, InboxPollPlan().cadence)
    }

    @Test
    fun `单个消费方按它的间隔`() {
        val plan = InboxPollPlan()
        plan.retain(30_000)
        assertEquals(30_000, plan.cadence)
    }

    @Test
    fun `多个消费方取最小间隔`() {
        val plan = InboxPollPlan()
        plan.retain(30_000) // AppShell 的兜底轮询
        plan.retain(10_000) // 消息页开着时更快的那一份
        assertEquals(10_000, plan.cadence)
    }

    @Test
    fun `释放最快的那一份后_回落到次小`() {
        val plan = InboxPollPlan()
        plan.retain(30_000)
        val fast = plan.retain(10_000)
        plan.release(fast)
        assertEquals(30_000, plan.cadence)
    }

    @Test
    fun `全部释放后停表`() {
        val plan = InboxPollPlan()
        val a = plan.retain(30_000)
        val b = plan.retain(90_000)
        plan.release(a)
        plan.release(b)
        assertEquals(0, plan.cadence)
    }

    @Test
    fun `重复释放同一个id不会把别人的计时也关掉`() {
        // 释放函数可能被 onDispose 与显式调用各走一次：多释放必须是无副作用的空操作
        val plan = InboxPollPlan()
        val a = plan.retain(30_000)
        val b = plan.retain(90_000)
        plan.release(a)
        plan.release(a)
        assertEquals(90_000, plan.cadence)
    }

    @Test
    fun `释放不存在的id是无副作用的`() {
        val plan = InboxPollPlan()
        plan.retain(30_000)
        plan.release(999)
        assertEquals(30_000, plan.cadence)
    }
}
