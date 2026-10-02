package top.kuangdada.k.nativeapp.ui

import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.TargetBasedAnimation
import androidx.compose.animation.core.VectorConverter
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import top.kuangdada.k.core.designsystem.theme.KMotion
import top.kuangdada.k.nativeapp.ui.viewer.coverScaleOf
import kotlin.math.abs

/**
 * 全屏查看器飞行几何的单元测试（M5.2）。
 *
 * 为什么这几条值得测：飞行"没飞起来 / 飞错地方"这类问题**在真机上只能靠慢放逐帧看**，
 * 一旦几何算错（宽高比、插值端点、退场起点的变换），表现就是"图凭空变大一下"或"跳一格"。
 * 这里把三件纯计算的约定钉死：
 *
 *  1. [fitRectIn]：落位矩形必须是**按原图宽高比 Fit** 出来的（这个矩形决定了飞行末帧与
 *     轮播 `ContentScale.Fit` 是否逐像素一致 —— 不一致就会在交接时跳）；
 *  2. [lerpRect]：端点必须严格等于两端（出发帧 = 缩略格，落位帧 = 全屏矩形）；
 *  3. [transformRect]：与 `Modifier.graphicsLayer` 的映射一致
 *     （`screen(q) = pivot + (q - pivot) × scale + translation`），
 *     退场起点靠它做到"与屏幕上看到的一模一样"。
 */
class ViewerFlightGeometryTest {

    private val container = Rect(0f, 0f, 1000f, 2000f)

    /** 竖图（宽高比 0.5）在方形容器里：高度顶满、左右留黑边，且居中 */
    @Test
    fun fit_rect_of_tall_image_is_centered_with_letterbox() {
        val square = Rect(0f, 0f, 1000f, 1000f)
        val r = fitRectIn(square, aspect = 0.5f)
        assertEquals(1000f, r.height, 0.01f)
        assertEquals(500f, r.width, 0.01f)
        assertEquals(250f, r.left, 0.01f)
        assertEquals(0f, r.top, 0.01f)
    }

    /** 横图（宽高比 2.0）在方形容器里：宽度顶满、上下留黑边，且居中 */
    @Test
    fun fit_rect_of_wide_image_is_centered_top_and_bottom() {
        val square = Rect(0f, 0f, 1000f, 1000f)
        val r = fitRectIn(square, aspect = 2f)
        assertEquals(1000f, r.width, 0.01f)
        assertEquals(500f, r.height, 0.01f)
        assertEquals(0f, r.left, 0.01f)
        assertEquals(250f, r.top, 0.01f)
    }

    /** 宽高比与容器**完全一致**时：落位矩形就是整个容器（不产生假的留白） */
    @Test
    fun fit_rect_fills_container_when_aspect_matches() {
        val r = fitRectIn(container, aspect = container.width / container.height)
        assertEquals(container, r)
    }

    /** 落位矩形的宽高比**必须**等于原图宽高比：这是"Crop 填满 == Fit 完整显示"的前提 */
    @Test
    fun fit_rect_keeps_the_image_aspect() {
        val r = fitRectIn(container, aspect = 1.5f)
        assertEquals(1.5f, r.width / r.height, 0.001f)
    }

    /** 宽高比未知（图还没加载出来）：退回整个容器，退化成"铺满"而不是崩掉/留白 */
    @Test
    fun fit_rect_falls_back_to_container_when_aspect_unknown() {
        assertEquals(container, fitRectIn(container, aspect = null))
        assertEquals(container, fitRectIn(container, aspect = 0f))
        assertEquals(container, fitRectIn(container, aspect = Float.NaN))
    }

    /** 插值端点：t=0 就是缩略格，t=1 就是全屏矩形（两端"严丝合缝"靠这条） */
    @Test
    fun lerp_rect_hits_both_ends_exactly() {
        val cell = Rect(100f, 200f, 300f, 400f)
        assertEquals(cell, lerpRect(cell, container, 0f))
        assertEquals(container, lerpRect(cell, container, 1f))
    }

    /** 中点：四个边各自线性插值（防止只插了位置没插尺寸这类错误） */
    @Test
    fun lerp_rect_interpolates_all_four_edges() {
        val mid = lerpRect(Rect(0f, 0f, 100f, 100f), Rect(100f, 200f, 300f, 400f), 0.5f)
        assertEquals(50f, mid.left, 0.01f)
        assertEquals(100f, mid.top, 0.01f)
        assertEquals(200f, mid.right, 0.01f)
        assertEquals(250f, mid.bottom, 0.01f)
    }

    /** 越界的 t 会被夹到 [0,1]（弹簧过冲时矩形不会飞出两端之外） */
    @Test
    fun lerp_rect_clamps_t() {
        val a = Rect(0f, 0f, 10f, 10f)
        val b = Rect(10f, 10f, 20f, 20f)
        assertEquals(a, lerpRect(a, b, -1f))
        assertEquals(b, lerpRect(a, b, 2f))
    }

    /**
     * 变换与 `graphicsLayer` 同一映射：`screen(q) = pivot + (q - pivot) × scale + translation`。
     *
     * 退场起点取的就是这个 —— 若与轮播那边的绘制变换不一致，松手飞回去的第一帧就会"跳"。
     */
    @Test
    fun transform_rect_matches_graphics_layer_mapping() {
        val r = Rect(100f, 100f, 300f, 300f)
        val pivot = Offset(200f, 200f)
        val out = transformRect(r, pivot, scale = 2f, translation = Offset(10f, -20f))
        // 左上角：200 + (100-200)*2 + 10 = 10 ；200 + (100-200)*2 - 20 = -20
        assertEquals(10f, out.left, 0.01f)
        assertEquals(-20f, out.top, 0.01f)
        // 右下角：200 + (300-200)*2 + 10 = 410 ；200 + (300-200)*2 - 20 = 380
        assertEquals(410f, out.right, 0.01f)
        assertEquals(380f, out.bottom, 0.01f)
    }

    /** 恒等变换（松手但没位移/缩放）不该改变矩形 —— 退场起点的"无操作"分支 */
    @Test
    fun transform_rect_is_identity_at_rest() {
        val r = Rect(1f, 2f, 3f, 4f)
        assertEquals(r, transformRect(r, Offset(50f, 60f), 1f, Offset.Zero))
    }

    /** 缩放是**绕 pivot** 的：pivot 自己不动（这正是"抓住的那块贴在指头下"的依据） */
    @Test
    fun transform_rect_keeps_pivot_fixed() {
        val pivot = Offset(200f, 300f)
        val atPivot = Rect(pivot.x, pivot.y, pivot.x, pivot.y)
        val out = transformRect(atPivot, pivot, scale = 3f, translation = Offset.Zero)
        assertEquals(pivot.x, out.left, 0.01f)
        assertEquals(pivot.y, out.top, 0.01f)
    }

    /** 来源格在自己的矩形里：飞行出发帧必须**逐像素等于缩略格**，所以矩形要原样传下去 */
    @Test
    fun source_rect_is_used_as_is() {
        val cell = Rect(250f, 560f, 465f, 770f)
        val start = lerpRect(cell, container, 0f)
        assertTrue(start == cell)
    }

    /**
     * 圆角的两端（M5.5）：t=0（停在来源缩略格上）必须是**格子的圆角**，t=1（全屏落位）必须是**直角**。
     *
     * 进场 t: 0→1、退场 t: 1→0 共用这一条，所以两端都得成立 ——
     * 早先飞行图是不裁剪的矩形，结果就是"缩略图的圆角点下去变直角、退回落位时也是直角边"
     * （用户实测反馈）。
     */
    @Test
    fun corner_radius_goes_from_cell_rounding_to_right_angle() {
        val cell = 36f
        assertEquals(cell, lerpCornerRadius(cell, 0f), 0.01f)
        assertEquals(cell / 2f, lerpCornerRadius(cell, 0.5f), 0.01f)
        assertEquals(0f, lerpCornerRadius(cell, 1f), 0.01f)
    }

    /** 弹簧过冲（t 越界）不能造出负半径，也不能比格子本身更圆 */
    @Test
    fun corner_radius_is_clamped_on_overshoot() {
        val cell = 36f
        assertEquals(0f, lerpCornerRadius(cell, 1.2f), 0.01f)
        assertEquals(cell, lerpCornerRadius(cell, -0.2f), 0.01f)
    }

    /**
     * 下拉缩放按**屏幕高的比例**走（参考微信朋友圈那套 `FriendCircleView`：
     * `scale = 1 - |movY| / screenHeight`，且拖到屏高 1/4 就不再缩）。
     *
     * 所以：拖屏高 1/10 只缩 10%，拖到关闭阈值那一点（1/6）是 0.83，1/4 是下限 0.75。
     * 早先这条公式绑在"80dp 的关闭阈值"上（`1 - 0.36 × 比例`）—— 拖 80dp 就缩到 0.64，
     * 真机反馈就是"缩得太小、也太快"。
     *
     * 这条公式**只能有一份**：绘制那边与退场起点（`visualRect`）都用 [dismissScaleOf]，
     * 各写一份的话松手那一刻飞行图的起点会与屏幕上看到的不一致（起飞时跳一下）。
     */
    @Test
    fun dismiss_scale_follows_screen_height_ratio() {
        assertEquals(1f, dismissScaleOf(0f), 0.001f)
        assertEquals(0.9f, dismissScaleOf(0.1f), 0.001f)
        assertEquals(1f - 1f / 6f, dismissScaleOf(1f / 6f), 0.001f)
        assertEquals(MIN_DRAG_SCALE, dismissScaleOf(0.25f), 0.001f)
        // 再往下拉不再缩（只是继续跟着手指走）
        assertEquals(MIN_DRAG_SCALE, dismissScaleOf(3f), 0.001f)
    }

    /** 背景黑度用同一个比例：`1 - 2 × 比例`，拖到屏高 1/4 正好半透，之后不再变透 */
    @Test
    fun drag_alpha_follows_the_same_ratio() {
        assertEquals(1f, dragAlphaOf(0f), 0.001f)
        assertEquals(0.8f, dragAlphaOf(0.1f), 0.001f)
        assertEquals(MIN_DRAG_ALPHA, dragAlphaOf(0.25f), 0.001f)
        assertEquals(MIN_DRAG_ALPHA, dragAlphaOf(3f), 0.001f)
    }

    /**
     * 遮罩在**松手那一刻不能跳**（M5.6，用户反馈"下滑退出会闪屏"）。
     *
     * 拖到任意深度松手时，`flying=false`（拖拽那段）与 `flying=true`（飞行那段）算出来的
     * 透明度必须相等 —— 早先那版在 `flying` 翻过来的瞬间把半透的遮罩跳成了全黑。
     *
     * 注：第三个参数 M5.10 起叫 `maskProgress`（时间线性的遮罩进度），不再是几何的 `progress`；
     * 起飞那一帧它是 1（见 [flightMaskAlphaOf]），所以下面这条等式仍然必须成立。
     */
    @Test
    fun mask_alpha_is_continuous_at_the_handoff() {
        for (drag in listOf(0f, 0.1f, 1f / 6f, 0.25f, 2f)) {
            assertEquals(
                viewerMaskAlpha(flying = false, maskProgress = 1f, dragFraction = drag),
                viewerMaskAlpha(flying = true, maskProgress = 1f, dragFraction = drag),
                0.001f,
            )
        }
        // 没下拉过（点画面退出 / 返回键）：端点与全屏静止状态严丝合缝
        assertEquals(1f, viewerMaskAlpha(flying = true, maskProgress = 1f, dragFraction = 0f), 0.001f)
        assertEquals(0f, viewerMaskAlpha(flying = true, maskProgress = 0f, dragFraction = 0f), 0.001f)
        // 1x 静止时全黑
        assertEquals(1f, viewerMaskAlpha(flying = false, maskProgress = 1f, dragFraction = 0f), 0.001f)
    }

    /**
     * 飞行段遮罩曲线（M5.10，对齐用户第二份微信录屏 Record_2026-10-02-14-53-15 的逐帧实测）：
     * 遮罩**铺满整个飞行**，不是"只在大图占屏的两端"。
     *
     * 实测（进场/退场各自独立测得，τ=0.5 处分别是 0.58 / 0.49）：遮罩在整段飞行上都在变，
     * 所以这里钉的是"每一段都在动"：
     *  · τ=0.25 必须已经**明显不是全亮**（旧曲线在这里是 0，即背景完全没压暗 —— 就是被修掉的观感）；
     *  · τ=0.75 必须**还没全黑**（旧曲线在这里已经 1）；
     *  · 两端严格 0/1，且全程单调（不能中途变亮又变暗）。
     */
    @Test
    fun flight_mask_alpha_spans_the_whole_flight() {
        assertEquals(0f, flightMaskAlphaOf(0f), 0.001f)
        assertEquals(1f, flightMaskAlphaOf(1f), 0.001f)
        // 中点：实测 0.58 / 0.49，曲线给 0.5
        assertEquals(0.5f, flightMaskAlphaOf(0.5f), 0.001f)
        // 整段都在动：四分之一处已压暗一截，四分之三处还没全黑
        assertTrue("τ=0.25 处背景必须已经压暗（实测 0.09~0.20）", flightMaskAlphaOf(0.25f) > 0.05f)
        assertTrue("τ=0.25 处不该已经压黑（实测 0.09~0.20）", flightMaskAlphaOf(0.25f) < 0.35f)
        assertTrue("τ=0.75 处不该已经全黑（实测 0.91~0.95）", flightMaskAlphaOf(0.75f) < 0.95f)
        // 单调递增（进场方向），不许中途回头
        var last = 0f
        var t = 0f
        while (t <= 1f) {
            assertTrue("t=$t 处曲线不单调", flightMaskAlphaOf(t) >= last - 1e-6f)
            last = flightMaskAlphaOf(t)
            t += 0.05f
        }
    }

    /**
     * 飞行的进度动画**必须不过冲**（用户反馈："退出全屏会闪一下，图片顿一下再回位"）。
     *
     * 为什么这条值得钉住：几何是**每帧手算**的 —— `lerpRect(a, b, progress)`，而 `progress`
     * 一旦超过 1（弹簧过冲），`lerpRect` 会把它夹回 1（见 `lerp_rect_clamps_t`）。
     * 于是动画的**后段整段都在画同一个矩形**：视觉上不是"弹一下"，而是
     * "飞到目标位、**顿一下**、再回到目标位" —— 白顿一顿，还多耗掉一百多毫秒。
     *
     * 所以飞行用的档（[top.kuangdada.k.core.designsystem.theme.KMotion.spatialBounded]）
     * 阻尼比必须是 1.0。这里按"给定弹簧在超调时间内是否越过 1"直接验：
     * 取 60fps 采样整段动画，值不得大于 1（留 1e-4 容差给浮点）。
     */
    @Test
    fun viewer_flight_progress_never_overshoots() {
        assertNeverOvershoots(
            spec = KMotion.spatialBounded(KMotion.Preset.Default),
            from = 0f,
            to = 1f,
            below = "1（会顿一下再回位）",
        )
    }

    /**
     * 反向（退场 1 → 0）同样不能过冲 —— 否则缩回格子的末帧会"越过"格子，再弹回来一次。
     */
    @Test
    fun viewer_leave_progress_never_undershoots() {
        assertNeverOvershoots(
            spec = KMotion.spatialBounded(KMotion.Preset.Default),
            from = 1f,
            to = 0f,
            below = "0（会越出缩略格再弹回）",
        )
    }

    /**
     * M5.7 的飞行绘制变换：`cropOverScaleOf(落位矩形, 中间矩形)` 必须**等价于 ContentScale.Crop**
     * —— 飞行图按落位矩形只布局一次，每帧用这个系数缩放。
     *
     * 系数取小了：缩放后的内容盖不住裁剪框，框里露黑边（真机上就是飞行图"缺一角"）。
     * 所以这条不变量必须钉死：**缩放后的基准矩形在两轴上都 ≥ 中间矩形**（覆盖），且至少
     * 一轴**恰好相等**（贴边，Crop 的"裁着填满"）。
     */
    @Test
    fun crop_over_scale_always_covers_and_touches_both_ends() {
        val fullscreen = Rect(0f, 0f, 1080f, 2400f) // 竖屏全屏（落位矩形）
        val cells = listOf(
            Rect(90f, 900f, 990f, 1800f),   // 九宫格的方格（1:1）
            Rect(56f, 773f, 1383f, 2542f),  // 详情单图（真机量到过的矩形）
            Rect(0f, 0f, 1080f, 2400f),     // 落位矩形自己（恒等）
        )
        for (cell in cells) {
            val s = cropOverScaleOf(fullscreen, cell)
            assertTrue("s 必须为正", s > 0f)
            val scaledW = fullscreen.width * s
            val scaledH = fullscreen.height * s
            assertTrue("宽度方向必须盖住格子", scaledW >= cell.width - 0.01f)
            assertTrue("高度方向必须盖住格子", scaledH >= cell.height - 0.01f)
            assertTrue(
                "至少一轴恰好贴边（Crop 的取景），否则取景和 Crop 不一致",
                abs(scaledW - cell.width) < 0.01f || abs(scaledH - cell.height) < 0.01f,
            )
        }
    }

    /** 恒等情形：rect == base 时系数必须是 1（落位帧与全屏 Fit 逐像素一致的前提） */
    @Test
    fun crop_over_scale_is_identity_at_the_target() {
        val r = Rect(10f, 20f, 110f, 320f)
        assertEquals(1f, cropOverScaleOf(r, r), 0.001f)
    }

    /**
     * 飞行时长（M5.10）：几何弹簧的 `durationNanos` 就是遮罩补间的时长（见 `flightDurationMs`），
     * 所以它同时决定"图片飞多久"和"背景压黑多久"。
     *
     * 为什么钉一个区间：用户录屏逐帧量到的微信飞行是 **约 245~250ms**
     * （进场 1.3607→1.610、退场 2.9305→3.180）。这条动画也顺带保证
     * `durationNanos` 不会返回一个离谱的值 —— 遮罩时长是照抄它的，
     * 一旦它变成几百毫秒，`flying` 会被白白拖长（期间不能翻页、点击也不响应）。
     */
    @Test
    fun flight_duration_stays_in_the_measured_band() {
        val ms = TargetBasedAnimation(
            animationSpec = KMotion.spatialBounded<Float>(KMotion.Preset.Default),
            typeConverter = Float.VectorConverter,
            initialValue = 0f,
            targetValue = 1f,
        ).durationNanos / 1_000_000
        println("[flight] 几何弹簧时长 = $ms ms（微信实测约 245~250ms）")
        assertTrue("飞行时长 $ms ms 偏离微信实测太多", ms in 150..400)
    }

    /**
     * 双击目标倍率（M5.9，用户实测微信的行为）：**刚好铺满全屏**的 cover 倍率 ——
     * 放大后只有溢出的那个方向需要滑（通常是左右滑），不再"上下左右全得拖"。
     */
    @Test
    fun double_tap_cover_scale_fills_the_screen_exactly() {
        // 3:4 竖图在 ~9:19.5 屏：图比屏"相对更宽" → 按高铺满，左右滑
        assertEquals(0.75f / 0.46f, coverScaleOf(0.75f, 460f, 1000f)!!, 0.01f)
        // 16:9 宽图：同样按高铺满，横向溢出更多
        assertEquals(1.78f / 0.46f, coverScaleOf(1.78f, 460f, 1000f)!!, 0.01f)
        // 极窄长图（比屏幕相对更窄）→ 按宽铺满，上下滑
        assertEquals(0.46f / 0.4f, coverScaleOf(0.4f, 460f, 1000f)!!, 0.01f)
        // 与屏幕同比例：cover = 1，双击不缩放（本就全屏）
        assertEquals(1f, coverScaleOf(0.46f, 460f, 1000f)!!, 0.01f)
        // 比例/容器不可用 → null（调用方退回固定倍率）
        assertEquals(null, coverScaleOf(0f, 460f, 1000f))
        assertEquals(null, coverScaleOf(0.75f, 0f, 1000f))
    }

    /**
     * 可反悔退场的弹簧档已随"单击即刻关闭"试验一起移除（真机否掉了双击的回弹观感），
     * 退场回到 [KMotion.spatialBounded] —— 上面两条不过冲测试已覆盖它。
     */

    /**
     * 逐帧跑完一整段动画，断言值**始终落在 [from, to] 之间**，并且真的走到了终点。
     *
     * 用 [TargetBasedAnimation] 而不是直接问 spec：`FiniteAnimationSpec` 只有
     * `vectorize` / `getDurationNanos` 这类可见 API，把"某一时刻的值"暴露出来的是
     * `TargetBasedAnimation#getValueFromNanos` —— 它正好也是 Compose 真正跑动画时用的那条路径，
     * 所以这里验的就是运行时行为，不是另写一套数学。
     */
    private fun assertNeverOvershoots(
        spec: FiniteAnimationSpec<Float>,
        from: Float,
        to: Float,
        below: String,
    ) {
        val lo = minOf(from, to)
        val hi = maxOf(from, to)
        val anim = TargetBasedAnimation(
            animationSpec = spec,
            typeConverter = Float.VectorConverter,
            initialValue = from,
            targetValue = to,
        )
        val duration = anim.durationNanos
        var last = from
        var t = 0L
        // 按 60fps 采样整段 + 一点点尾巴（弹簧的收尾比 durationNanos 稍长）
        val until = duration + 200_000_000L
        while (t <= until) {
            val v = anim.getValueFromNanos(t)
            assertTrue("t=$t v=$v 越出 [$lo, $hi] 的 $below", v in lo - 1e-4f..hi + 1e-4f)
            last = v
            t += 16_000_000L
        }
        // 收尾必须真的到位（不能停在 0.99，否则交接给轮播时会有一次微跳）
        assertEquals(to, last, 1e-3f)
    }
}
