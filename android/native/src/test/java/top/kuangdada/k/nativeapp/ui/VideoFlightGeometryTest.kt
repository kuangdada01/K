package top.kuangdada.k.nativeapp.ui

import androidx.compose.ui.geometry.Rect
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 沉浸视频播放器**进/退场飞行**几何的单测。
 *
 * 这套几何是**照搬图片查看器**的（同一套矩形插值 / 圆角插值 / 遮罩淡入 / 落位算法），
 * 所以这里的断言大多与 `ViewerFlightGeometryTest` 同源 —— 那正是"两处必须一致"的证明。
 *
 * 为什么值得单独钉：这套几何写错的表现全是"真机上一眼可见、读代码看不出来"的观感问题 ——
 *  **画面被拉变形**、起点与详情页那一块错位、落位时跳一下、关了动效还硬播 250ms。
 */
class VideoFlightGeometryTest {

    /** 详情页那一块（16:9，屏宽 1440、高 810）与全屏容器（1440×3168，9:19.5 竖屏） */
    private val source = Rect(left = 56f, top = 566f, right = 1384f, bottom = 1313f)
    private val fullscreen = Rect(left = 0f, top = 0f, right = 1440f, bottom = 3168f)

    // ------------------------------------------------------------------
    // videoFullscreenRect —— ★ 落位矩形必须按宽高比 Fit（不能用容器本身）
    // ------------------------------------------------------------------

    @Test
    fun `横屏视频的落位是屏幕上的一条 16比9 横带`() {
        // ★ 这条是"视频被拉成竖条"那个观感的回归钉。
        //
        // 视频 16:9、屏幕 9:19.5（1440×3168）。落位矩形必须是**按比例 Fit 出来的横带**
        // （1440×810），而不是整个竖屏容器 —— 后者会让飞行块在途中被拉成竖条，
        // 用户看到的是"一块东西被扯变形"，而不是"视频放大到全屏"
        // （真机实测反馈："窗口到全屏位置是固定的啊，你参考一下图片全屏的代码不就好了"）。
        val band = videoFullscreenRect(fullscreen, 16f / 9f)
        assertEquals(1440f, band.width, 0.5f)
        assertEquals(810f, band.height, 0.5f)
        assertEquals(0f, band.left, 0.5f)
        // 垂直居中：这条横带落在屏幕正中间
        assertEquals((3168f - 810f) / 2f, band.top, 0.5f)
    }

    @Test
    fun `竖屏视频的落位是一条居中的竖带`() {
        val tall = videoFullscreenRect(fullscreen, 9f / 16f)
        // 竖屏内容按高度铺满：h = 1440/(9/16) = 2560，垂直居中
        assertEquals(1440f, tall.width, 0.5f)
        assertEquals(2560f, tall.height, 0.5f)
        assertEquals((3168f - 2560f) / 2f, tall.top, 0.5f)
    }

    @Test
    fun `方形视频的落位是居中的正方形`() {
        val sq = videoFullscreenRect(fullscreen, 1f)
        assertEquals(1440f, sq.width, 0.5f)
        assertEquals(1440f, sq.height, 0.5f)
    }

    @Test
    fun `宽高比未知时退回容器本身`() {
        // 与查看器 fitRectIn 的兜底一致：量不到比例就铺满 ——
        // 宁可没有 letterbox，也不能算出一个错的矩形
        assertEquals(fullscreen, videoFullscreenRect(fullscreen, null))
        assertEquals(fullscreen, videoFullscreenRect(fullscreen, 0f))
        assertEquals(fullscreen, videoFullscreenRect(fullscreen, Float.NaN))
    }

    @Test
    fun `落位矩形永远不超出容器`() {
        for (aspect in listOf(0.3f, 0.5625f, 1f, 1.7778f, 3f, 5f)) {
            val r = videoFullscreenRect(fullscreen, aspect)
            assertTrue(
                "aspect=$aspect 越界: $r",
                r.left >= fullscreen.left - 0.5f && r.right <= fullscreen.right + 0.5f &&
                    r.top >= fullscreen.top - 0.5f && r.bottom <= fullscreen.bottom + 0.5f,
            )
        }
    }

    @Test
    fun `容器零大小时不崩`() {
        assertEquals(Rect.Zero, videoFullscreenRect(Rect.Zero, 16f / 9f))
    }

    // ------------------------------------------------------------------
    // videoFlightRect
    // ------------------------------------------------------------------

    @Test
    fun `t 等于 0 时落在来源块上`() {
        val target = videoFullscreenRect(fullscreen, 16f / 9f)
        val r = videoFlightRect(source, target, 0f)!!
        // smoothstep(0) = 0，逐像素等于来源
        assertEquals(source.left, r.left, 0.01f)
        assertEquals(source.top, r.top, 0.01f)
        assertEquals(source.right, r.right, 0.01f)
        assertEquals(source.bottom, r.bottom, 0.01f)
    }

    @Test
    fun `t 等于 1 时落在全屏横带上`() {
        val target = videoFullscreenRect(fullscreen, 16f / 9f)
        val r = videoFlightRect(source, target, 1f)!!
        assertEquals(target, r)
    }

    @Test
    fun `中途的矩形夹在两端之间且单调放大`() {
        val target = videoFullscreenRect(fullscreen, 16f / 9f)
        val q1 = videoFlightRect(source, target, 0.25f)!!
        val q2 = videoFlightRect(source, target, 0.5f)!!
        val q3 = videoFlightRect(source, target, 0.75f)!!
        assertTrue(q1.width < q2.width)
        assertTrue(q2.width < q3.width)
        assertTrue(q1.width >= source.width)
        assertTrue(q3.width <= target.width + 0.5f)
    }

    @Test
    fun `飞行途中宽高比保持不变`() {
        // ★ 这是"不做变形"的核心断言：任意中间帧的宽高比都应等于视频自身比例。
        // 之前拿容器当落位矩形时这条必然失败（源 16:9 → 目标 9:19.5，
        // 中途会被插值成一条竖长条）
        val target = videoFullscreenRect(fullscreen, 16f / 9f)
        for (t in listOf(0f, 0.25f, 0.5f, 0.75f, 1f)) {
            val r = videoFlightRect(source, target, t)!!
            // 来源与目标都是 16:9，所以全程比例恒定
            assertEquals("t=$t 时比例被改动", 16f / 9f, r.width / r.height, 0.02f)
        }
    }

    @Test
    fun `缓动是 smoothstep 而不是线性`() {
        val target = videoFullscreenRect(fullscreen, 16f / 9f)
        val quarter = videoFlightRect(source, target, 0.25f)!!
        val linearQuarter = source.width + (target.width - source.width) * 0.25f
        assertTrue(
            "起步应当慢于线性（smoothstep）",
            quarter.width < linearQuarter,
        )
    }

    @Test
    fun `任一端缺失时不给飞行矩形`() {
        assertNull(videoFlightRect(null, fullscreen, 0.5f))
        assertNull(videoFlightRect(source, null, 0.5f))
        assertNull(videoFlightRect(null, null, 0.5f))
    }

    @Test
    fun `超出 0到1 的进度被夹住`() {
        val target = videoFullscreenRect(fullscreen, 16f / 9f)
        val under = videoFlightRect(source, target, -0.5f)!!
        val over = videoFlightRect(source, target, 1.5f)!!
        assertEquals(source.left, under.left, 0.01f)
        assertEquals(target.left, over.left, 0.01f)
    }

    // ------------------------------------------------------------------
    // videoFlightAlpha
    // ------------------------------------------------------------------

    @Test
    fun `进场黑幕从透明到不透明`() {
        assertEquals(0f, videoFlightAlpha(0f, 1f, 0f), 0.001f)
        assertEquals(0.5f, videoFlightAlpha(0f, 1f, 0.5f), 0.001f)
        assertEquals(1f, videoFlightAlpha(0f, 1f, 1f), 0.001f)
    }

    @Test
    fun `退场黑幕反向`() {
        assertEquals(1f, videoFlightAlpha(1f, 0f, 0f), 0.001f)
        assertEquals(0f, videoFlightAlpha(1f, 0f, 1f), 0.001f)
    }

    // ------------------------------------------------------------------
    // videoFlightCorner
    // ------------------------------------------------------------------

    @Test
    fun `圆角从来源块的圆角插值到全屏的直角`() {
        assertEquals(49f, videoFlightCorner(49f, 0f, 0f), 0.01f)
        assertEquals(0f, videoFlightCorner(49f, 0f, 1f), 0.01f)
        val mid = videoFlightCorner(49f, 0f, 0.5f)
        assertTrue(mid > 0f && mid < 49f)
    }

    @Test
    fun `退场方向圆角反向插值`() {
        assertEquals(0f, videoFlightCorner(0f, 49f, 0f), 0.01f)
        assertEquals(49f, videoFlightCorner(0f, 49f, 1f), 0.01f)
    }

    // ------------------------------------------------------------------
    // videoFlightUsable
    // ------------------------------------------------------------------

    @Test
    fun `来源可用时应当播飞行`() {
        assertTrue(videoFlightUsable(source, fullscreen, animationsEnabled = true))
    }

    @Test
    fun `关了动效就不播飞行`() {
        // 系统"移除动画"必须让路：不是性能问题，是可访问性问题
        assertFalse(videoFlightUsable(source, fullscreen, animationsEnabled = false))
    }

    @Test
    fun `没有来源就不播飞行`() {
        assertFalse(videoFlightUsable(null, fullscreen, animationsEnabled = true))
    }

    @Test
    fun `尺寸退化的来源不播飞行`() {
        assertFalse(
            videoFlightUsable(Rect(0f, 0f, 0f, 0f), fullscreen, animationsEnabled = true),
        )
    }

    @Test
    fun `容器零大小时不播飞行`() {
        // 首帧容器还没测量出来（Rect.Zero）—— 这时判"能飞"会拿到一个错位的矩形
        assertFalse(videoFlightUsable(source, Rect.Zero, animationsEnabled = true))
    }

    @Test
    fun `来源与目标同样大时不播飞行`() {
        assertFalse(videoFlightUsable(fullscreen, fullscreen, animationsEnabled = true))
    }

    @Test
    fun `非有限数值的来源被拒`() {
        assertFalse(
            videoFlightUsable(Rect(Float.NaN, 0f, 100f, 100f), fullscreen, animationsEnabled = true),
        )
    }

    // ------------------------------------------------------------------
    // 封面取景
    // ------------------------------------------------------------------

    @Test
    fun `封面取景系数与查看器同一条规则`() {
        // 飞行块按 Fit 布局、封面要 Crop 填满它 —— 复用查看器的 cropOverScaleOf，
        // 保证两条路径的"裁着填满"逐像素一致（各写一遍迟早会偏）
        val base = Rect(0f, 0f, 1440f, 810f)
        assertEquals(2000f / 1440f, videoCoverCropScale(base, Rect(0f, 0f, 2000f, 810f)), 0.001f)
        assertEquals(1620f / 810f, videoCoverCropScale(base, Rect(0f, 0f, 1440f, 1620f)), 0.001f)
    }

    // ------------------------------------------------------------------
    // videoFlightTransform —— ★ "退出没有动画"的回归钉
    // ------------------------------------------------------------------

    @Test
    fun `当前帧等于终态时是恒等变换`() {
        // ★ 最关键的一条：落地那一刻必须 scale=1、位移=0。
        // 不满足的话"动画结束"与"正常播放"之间会跳一下。
        val xf = videoFlightTransform(fullscreen, fullscreen)
        assertEquals(1f, xf.scale, 0.0001f)
        assertEquals(0f, xf.dx, 0.0001f)
        assertEquals(0f, xf.dy, 0.0001f)
    }

    @Test
    fun `从来源块起步时按比例缩小`() {
        val target = videoFullscreenRect(fullscreen, 16f / 9f) // 1440 x 810
        // 来源块 1328 x 747（详情页那一块的实测尺寸）
        val source = Rect(56f, 566f, 1384f, 1313f)
        val xf = videoFlightTransform(source, target)
        // 等比取小的一维：min(1328/1440, 747/810) = min(0.922, 0.922) ≈ 0.922
        assertEquals(0.922f, xf.scale, 0.01f)
        // 位移 = 两个中心之差（来源中心在屏幕上方，所以 dy 为负）
        assertTrue("应当向上位移（来源在上方）", xf.dy < 0f)
        assertEquals(source.center.x - target.center.x, xf.dx, 0.01f)
        assertEquals(source.center.y - target.center.y, xf.dy, 0.01f)
    }

    @Test
    fun `缩放是等比的不做拉伸`() {
        // 任意中间帧都必须是**等比**缩放 —— 非等比会把画面拉变形
        val target = videoFullscreenRect(fullscreen, 16f / 9f)
        for (t in listOf(0.2f, 0.5f, 0.8f)) {
            val current = videoFlightRect(source, target, t)!!
            val xf = videoFlightTransform(current, target)
            // 用一个非等比的目标再验证一次"取小的一维"这条规则本身
            assertTrue("scale 必须落在 (0,1]", xf.scale > 0f && xf.scale <= 1f)
        }
    }

    @Test
    fun `缩放比取小的那一维`() {
        // current 比 target 更"扁"时，受高度约束；更"瘦"时受宽度约束。
        // 取小的那一维才能保证内容完整落在 current 里（大的一维会溢出）
        val target = Rect(0f, 0f, 1000f, 1000f)
        assertEquals(0.5f, videoFlightTransform(Rect(0f, 0f, 2000f, 500f), target).scale, 0.001f)
        assertEquals(0.5f, videoFlightTransform(Rect(0f, 0f, 500f, 2000f), target).scale, 0.001f)
    }

    @Test
    fun `终态尺寸为零时不崩`() {
        val xf = videoFlightTransform(Rect(0f, 0f, 100f, 100f), Rect.Zero)
        assertTrue(xf.scale.isFinite() && xf.scale > 0f)
    }

    @Test
    fun `当前帧缺失时退回恒等变换`() {
        // 量不到飞行矩形（没来源）时不能把画面缩成 0
        val xf = videoFlightTransform(null, fullscreen)
        assertEquals(1f, xf.scale, 0.0001f)
        assertEquals(0f, xf.dx, 0.0001f)
    }
}
