package top.kuangdada.k.nativeapp

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 全屏宿主「进 / 出小窗」的生命周期状态机（[SharePipFlow]）。
 *
 * 这是"小窗观看能用，且用完能把画面交回房间页"这条链路的**脱机门禁**：
 * 进 PiP 这条路径在真机上无法脚本化回归，而判据写错的表现全是静默的
 * （黑窗 / 房间页槽位永远空 / 小窗关了宿主压在后台），所以四条路径在这里钉死。
 *
 * 回调顺序按 AOSP 的实际行为建模（进 PiP：onPause → onPictureInPictureModeChanged(true)；
 * 展开：onPictureInPictureModeChanged(false) → onResume；关闭：onStop，不去 onResume）。
 */
class SharePipFlowTest {

    /** 普通进全屏 → 双击退出（从未进过小窗）：onPause 必须摘画面，onStop 不收尾 */
    @Test
    fun `普通退场照旧摘画面`() {
        val flow = SharePipFlow()
        flow.onResumed()
        assertTrue("普通退场必须交回画面", flow.shouldDetachOnPause())
        assertFalse("普通退场不该触发收尾", flow.shouldCleanupOnStop())
    }

    /**
     * 「小窗观看」完整路径：请求进入 → onPause（**不能摘画面**，否则黑窗）→
     * 进入确认 → 用户点 X 关闭 → onStop 收尾（交回画面 + 结束宿主）。
     */
    @Test
    fun `进小窗时onPause保留画面_关闭时收尾`() {
        val flow = SharePipFlow()
        flow.onResumed()
        flow.onEnterRequested(entered = true)
        assertFalse("进小窗的 onPause 不许摘画面", flow.shouldDetachOnPause())
        flow.onEnteredPip()
        assertFalse("小窗期间的 onPause（若有）同样不许摘画面", flow.shouldDetachOnPause())
        assertTrue("小窗被关闭（onStop）必须收尾", flow.shouldCleanupOnStop())
        assertFalse("收尾是单向动作，重复 onStop 不再触发", flow.shouldCleanupOnStop())
    }

    /**
     * 从小窗**展开**回全屏：onPictureInPictureModeChanged(false) → onResume。
     * 复位之后，用户再双击退出，必须回到普通交接路径（画面交回房间页）。
     */
    @Test
    fun `小窗展开后回到普通路径`() {
        val flow = SharePipFlow()
        flow.onEnterRequested(entered = true)
        assertTrue("resume 应报告此前处于小窗", flow.onResumed())
        assertTrue("展开后双击退出必须摘画面", flow.shouldDetachOnPause())
        assertFalse("展开后的 onStop（宿主被系统回收等）不该收尾", flow.shouldCleanupOnStop())
    }

    /** 请求进入但系统拒绝（返回 false）：一切保持普通路径，不能把下一次 pause 当"进小窗" */
    @Test
    fun `进小窗被拒不影响后续退场`() {
        val flow = SharePipFlow()
        flow.onResumed()
        flow.onEnterRequested(entered = false)
        assertTrue("请求失败后 onPause 必须照常摘画面", flow.shouldDetachOnPause())
        assertFalse(flow.shouldCleanupOnStop())
    }

    /**
     * 小窗里共享结束（房间侧 requestClose → 宿主 finish）：
     * onPause 不摘（流程中），onStop 收尾（幂等，不会因为 finish 自己而漏 detach）。
     */
    @Test
    fun `小窗中共享结束由onStop完成收尾`() {
        val flow = SharePipFlow()
        flow.onResumed()
        flow.onEnterRequested(entered = true)
        // finish() 触发的 onPause：仍处于小窗流程 → 不摘
        assertFalse(flow.shouldDetachOnPause())
        // 紧接着 onStop：必须收尾（这里完成 detach，画面才交得回去）
        assertTrue(flow.shouldCleanupOnStop())
    }

    /**
     * 时序保险：onPause 早于 onPictureInPictureModeChanged(true) 到达（AOSP 的常见顺序）——
     * 判据必须只靠 [SharePipFlow.onEnterRequested] 的登记，与回调先后无关。
     */
    @Test
    fun `进入确认回调迟到也不影响onPause决策`() {
        val flow = SharePipFlow()
        flow.onResumed()
        flow.onEnterRequested(entered = true)
        // 此刻还没收到 onPictureInPictureModeChanged(true)
        assertFalse(flow.shouldDetachOnPause())
    }

    /** 每次都从干净状态开始：new 出来的实例不在 PiP 流程里 */
    @Test
    fun `初始状态不在小窗流程中`() {
        assertFalse(SharePipFlow().inPipFlow)
    }
}
