package top.kuangdada.k.nativeapp.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 共享画面**框的几何**（[shareContentSize] / [shareFullscreenBox]）。
 *
 * 为什么值得单测：这两条规则错了**不会报错**，只会以"画面被拉伸/裁切"或"黑边忽多忽少"的形式
 * 出现在真机上（正是用户反复报的那类问题）。而它们是纯函数 —— 不必上真机就能钉死：
 *  1. 框的比例**永远等于**画面比例（否则 `SurfaceViewRenderer` 按 View 尺寸推出来的比例就是错的）；
 *  2. 两个宿主（房间内联槽位 / 全屏 Activity）用的是**同一个函数**，
 *     所以"进/退全屏比例不一致"从结构上不可能发生。
 */
class ShareFrameGeometryTest {

    private val frame16x9 = 16f / 9f

    /** 可用空间比画面更"高"（竖屏手机看横屏共享）→ 以宽为准，上下留纯黑边 */
    @Test
    fun `横屏画面在竖屏可用空间里以宽为准`() {
        val (w, h) = shareContentSize(1080f, 2400f, frame16x9)
        assertEquals(1080f, w, 1e-3f)
        assertEquals(1080f / frame16x9, h, 1e-3f)
    }

    /** 可用空间比画面更"宽" → 以高为准，左右留纯黑边 */
    @Test
    fun `横屏画面在更宽的可用空间里以高为准`() {
        val (w, h) = shareContentSize(2400f, 1080f, frame16x9)
        assertEquals(1080f * frame16x9, w, 1e-3f)
        assertEquals(1080f, h, 1e-3f)
    }

    /** 16:10 的采集源（本机屏幕就是）在 16:9 的全屏里应当略窄一点 —— 这正是"黑边"的来源 */
    @Test
    fun `十六比十的画面框比十六比九窄`() {
        val (w169, _) = shareContentSize(1080f, 2400f, frame16x9)
        val (w1610, _) = shareContentSize(1080f, 2400f, 1.6f)
        // 宽度受可用宽度限制时两者同宽、高度不同；这里比较"同高下的宽度"才有意义
        val (wide, _) = shareContentSize(2400f, 1080f, frame16x9)
        val (narrow, _) = shareContentSize(2400f, 1080f, 1.6f)
        assertTrue("16:10 的框应当比 16:9 窄（实际 $narrow vs $wide）", narrow < wide)
        assertEquals(w169, w1610, 1e-3f)
    }

    /** 退化比例（0 / 负数 / NaN）必须回落到 16:9，绝不能让框塌成 0 高 */
    @Test
    fun `退化比例回落到兜底`() {
        for (bad in listOf(0f, -1f, Float.NaN, 0.01f)) {
            val (w, h) = shareContentSize(1080f, 2400f, bad)
            assertEquals("比例 $bad 时框的宽应为可用宽", 1080f, w, 1e-3f)
            assertEquals(1080f / frame16x9, h, 1e-3f)
        }
    }

    /**
     * 与"全屏"走的是同一条公式：把内联槽位的宽度当成"可用空间"时，
     * 算出来的高度必须与内联那个 `aspectRatio` 修饰符一致（同一个比例 ⇒ 同一条黑边）。
     */
    @Test
    fun `全屏框与内联槽位同源`() {
        val aspect = 1.6f
        val inlineWidth = 358
        val (inlineW, inlineH) = shareContentSize(inlineWidth.toFloat(), 10_000f, aspect)
        val box = shareFullscreenBox(
            availableWidthPx = inlineWidth,
            availableHeightPx = 10_000,
            aspect = aspect,
        )
        assertEquals(inlineW.toInt(), box.widthPx)
        assertEquals(inlineH.toInt(), box.heightPx)
        assertEquals(aspect, box.aspect, 1e-6f)
    }

    /** 全屏框绝不会超过可用空间（否则画面会被窗口裁掉） */
    @Test
    fun `全屏框不超出可用空间`() {
        for (aspect in listOf(0.45f, 1f, 1.6f, frame16x9, 2.4f)) {
            val box = shareFullscreenBox(1080, 2400, aspect)
            assertTrue("$aspect：宽 ${box.widthPx} 超出 1080", box.widthPx <= 1080)
            assertTrue("$aspect：高 ${box.heightPx} 超出 2400", box.heightPx <= 2400)
            // 至少有一条边贴满：letterbox 就是"最大化后留边"，两边都小就是白留了黑边
            assertTrue(
                "$aspect：两边都没贴满（${box.widthPx}x${box.heightPx}）",
                box.widthPx == 1080 || box.heightPx == 2400,
            )
        }
    }
}
