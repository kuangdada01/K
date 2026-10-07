package top.kuangdada.k.nativeapp.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 渲染器槽位的**纯逻辑**状态机（[ShareRenderHolder.RendererSlot]）。
 *
 * 这是"进出全屏不重建渲染器"这条验收项的**脱机门禁**：
 * 真机日志（`渲染器创建 #<hash>` 整场只出现一次）能证明那一次跑对了，
 * 而这里的断言保证"以后再改也不会把换/不换的判据改坏"。
 *
 * 判据只有一条：**换轨才换渲染器**。
 * 进/退全屏、页面滚动、盒子尺寸变化都不换轨 —— 所以它们都不可能触发重建。
 */
class ShareRendererSlotTest {

    @Test
    fun `首次绑轨需要建渲染器`() {
        assertTrue(ShareRenderHolder.RendererSlot().bind("track-1"))
    }

    /** 同一条轨反复绑（重组、页面滚动、**进/退全屏**都会走到这里）→ 永远不重建 */
    @Test
    fun `同一路轨反复绑不重建`() {
        val slot = ShareRenderHolder.RendererSlot()
        assertTrue(slot.bind("track-1"))
        repeat(50) {
            assertFalse("同一路轨第 $it 次重绑不该重建", slot.bind("track-1"))
        }
        assertEquals("track-1", slot.trackId)
    }

    /** 换人共享 = 换轨：旧渲染器的 sink 绑在旧轨上，必须重建 */
    @Test
    fun `换轨要重建`() {
        val slot = ShareRenderHolder.RendererSlot()
        slot.bind("track-1")
        assertTrue(slot.bind("track-2"))
        assertEquals("track-2", slot.trackId)
        // 再切回来也是一次换轨（不是"回到旧实例"——旧实例已经连同旧 sink 一起丢了）
        assertTrue(slot.bind("track-1"))
    }

    /**
     * 每次共享结束都会 [ShareRenderHolder.RendererSlot.reset]（房间侧重新绑轨时先复位）——
     * 复位之后同一条轨也算"首次"，因为渲染器已经随共享结束销毁了。
     */
    @Test
    fun `复位后同一条轨按首次处理`() {
        val slot = ShareRenderHolder.RendererSlot()
        slot.bind("track-1")
        slot.reset()
        assertEquals(null, slot.trackId)
        assertTrue(slot.bind("track-1"))
    }
}
