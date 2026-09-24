package top.kuangdada.k.nativeapp.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Fill
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import top.kuangdada.k.core.designsystem.theme.KDimens

/**
 * 导航图标（24 网格）。
 *
 * 设计稿要求「**直接复用项目里 lucide-react 的原始图标**，输出 20px，不要手工重绘」——
 * 原因是手绘版线条比例与 lucide 的 24 网格不一致，放大后差异明显。
 *
 * 但 Compose 侧没有 lucide 资产可用（lucide-react 是 React 组件库，不能直接搬到 Compose），
 * 而 `material-icons-extended` 会多引一个 ~3MB 依赖、图标形状也和 lucide 不一致。
 *
 * 现在的做法分两种（**M6.3 起**）：
 *  · **底部导航那 5 个**（House / MessageCircle / BookOpen / AudioLines / User）：
 *    用 [LUCIDE_HOUSE] 等**原始 `d` 字符串** + `PathParser` 渲染（见 [drawLucide]）——
 *    与 Web 端逐点一致，并由 `android/scripts/verify-lucide-paths.mjs` 校验数据没被手改；
 *  · 其余图标仍是按 lucide 24×24 网格几何落成的 Path（描边 1.75/24）。
 */
enum class GlyphKind {
    Home, Chat, Book, Voice, User, Image, Bookmark, Repost, Share, Search, Mail,
    ChevronLeft, Menu, Sun, More, Plus, Close,
    Mic, Volume, Monitor, LogOut, Dot, Sliders, Megaphone,
    Shield, ChevronRight, Maximize,
}

/**
 * lucide 路径数据 → Compose `Path`（24 网格）。
 *
 * 解析一次后缓存：绘制 lambda 每帧都会跑（导航胶囊的指示块是弹簧动画），
 * 每帧重解析 5 个图标是白扔的 CPU。Path 在 24 网格里、与画布尺寸无关，所以可以跨尺寸共用。
 */
private val lucidePathCache = HashMap<String, Path>()

private fun lucidePath(d: String): Path =
    lucidePathCache.getOrPut(d) { androidx.compose.ui.graphics.vector.PathParser().parsePathString(d).toPath() }

/**
 * 按 lucide 的方式描边绘制一组路径：**描边宽度 2（lucide 的默认 `strokeWidth`，同一 24 网格）**、
 * 圆端圆角，并把整个 24 网格缩放到当前画布。
 *
 * `withTransform` 的缩放会把描边一起缩放，所以这里给的 2f 就是"24 网格里的 2" —— 不用自己算 px。
 *
 * 数据里可能有**非 path 元素**（lucide 的 `<circle>` / `<line>`，见 [LUCIDE_USER]）：
 * 它们用一行 `CIRCLE cx cy r` 标记表示，这里认出来画成圆 ——
 * 这样 Kotlin 侧的数据条数与 lucide 的 `__iconNode` 严格一一对应，校验脚本才能逐条比。
 */
private fun DrawScope.drawLucide(paths: List<String>, tint: Color, canvasSize: Float) {
    val k = canvasSize / 24f
    val lucideStroke = Stroke(width = 2f, cap = StrokeCap.Round, join = StrokeJoin.Round)
    withTransform({ scale(k, k, pivot = Offset.Zero) }) {
        paths.forEach { d ->
            when {
                d.startsWith(CIRCLE_MARK) -> {
                    val nums = d.removePrefix(CIRCLE_MARK).trim().split(" ").mapNotNull { it.toFloatOrNull() }
                    if (nums.size == 3) {
                        drawCircle(
                            color = tint,
                            radius = nums[2],
                            center = Offset(nums[0], nums[1]),
                            style = lucideStroke,
                        )
                    }
                }
                d.startsWith(RECT_MARK) -> {
                    // RECT x y w h [r]：lucide 里 `image` 那个外框就是 <rect rx=2 ry=2>
                    val nums = d.removePrefix(RECT_MARK).trim().split(" ").mapNotNull { it.toFloatOrNull() }
                    if (nums.size >= 4) {
                        val r = nums.getOrElse(4) { 0f }
                        drawRoundRect(
                            color = tint,
                            topLeft = Offset(nums[0], nums[1]),
                            size = Size(nums[2], nums[3]),
                            cornerRadius = CornerRadius(r, r),
                            style = lucideStroke,
                        )
                    }
                }
                else -> drawPath(path = lucidePath(d), color = tint, style = lucideStroke)
            }
        }
    }
}

/** 非 path 元素的标记前缀（与 [LUCIDE_USER] 里的写法、`verify-lucide-paths.mjs` 的解析一致） */
private const val CIRCLE_MARK = "CIRCLE "

/** 同上，矩形：`RECT x y w h [rx]`（lucide 的 `<rect>`） */
private const val RECT_MARK = "RECT "

@Composable
fun Glyph(
    tint: Color,
    kind: GlyphKind,
    modifier: Modifier = Modifier,
    size: Dp = KDimens.navIcon,
    /**
     * **已选中状态的实心形态**。
     *
     * 为什么需要它（用户实测反馈：「已收藏变为用实心」）：点赞原来就在做这件事 ——
     * `HeartIcon` 有 `filled` 参数，未赞描边、已赞实心。而收藏/转发的两个图标是
     * 纯 `Glyph` 描边，选中与否**只差一个颜色**，与点赞的"两态明确"不一致
     * （`KLikeButton` 的长注释里记着旧 Web 版的同一个毛病：颜色相同、只差填充，
     * 快速滑动时分不清自己点没点过）。
     *
     * 目前只有 [GlyphKind.Bookmark] 实现了实心（其它图标给 `true` 也不会有变化）——
     * 转发是"两个半环箭头"，填充它没有视觉意义；分享是一次性动作、没有选中态。
     * 需要时再补，不要为了一致而给所有图标硬造一个填充形状。
     */
    filled: Boolean = false,
) {
    Canvas(modifier = modifier.size(size)) {
        val s = this.size.minDimension
        // 24 网格 -> 当前画布
        fun x(v: Float) = v / 24f * s
        fun o(px: Float, py: Float) = Offset(x(px), x(py))
        val stroke = Stroke(
            width = 1.75f / 24f * s,
            cap = StrokeCap.Round,
            join = StrokeJoin.Round,
        )

        when (kind) {
            /**
             * ---- 底部导航那 5 个：直接用 Web 端 lucide 的原始路径（M6.3）----
             *
             * 它们与 Web 端是**并排对照**的，手绘近似在曲率/端点上一定对不齐
             * （消息气泡的尾巴、书本的中缝最明显）。数据与校验脚本见 `LucidePaths.kt`。
             */
            GlyphKind.Home -> drawLucide(LUCIDE_HOUSE, tint, s)
            GlyphKind.Chat -> drawLucide(LUCIDE_MESSAGE_CIRCLE, tint, s)
            GlyphKind.Book -> drawLucide(LUCIDE_BOOK_OPEN, tint, s)
            GlyphKind.Voice -> drawLucide(LUCIDE_AUDIO_LINES, tint, s)
            GlyphKind.User -> drawLucide(LUCIDE_USER, tint, s)
            /** lucide `image`：发布页「从相册选一张图作为封面」那个按钮（M6.6） */
            GlyphKind.Image -> drawLucide(LUCIDE_IMAGE, tint, s)

            // lucide bookmark（书签带缺口）—— 已收藏时走**实心填充**（用户要求）
            GlyphKind.Bookmark -> {
                val p = Path().apply {
                    moveTo(o(6.5f, 3.5f).x, o(6.5f, 3.5f).y)
                    lineTo(o(17.5f, 3.5f).x, o(17.5f, 3.5f).y)
                    lineTo(o(17.5f, 20.5f).x, o(17.5f, 20.5f).y)
                    lineTo(o(12f, 16.2f).x, o(12f, 16.2f).y)
                    lineTo(o(6.5f, 20.5f).x, o(6.5f, 20.5f).y)
                    close()
                }
                // 实心 = 只填不描边。描边留着会让实心书签显得比中心线大一圈
                // （描边是骑在路径上的，填充 + 描边叠加后视觉尺寸会涨一个 strokeWidth）。
                if (filled) drawPath(p, tint, style = Fill) else drawPath(p, tint, style = stroke)
            }

            // lucide repeat（两个半环箭头，表示转发）
            GlyphKind.Repost -> {
                val top = Path().apply {
                    moveTo(o(4f, 9f).x, o(4f, 9f).y)
                    lineTo(o(4f, 7f).x, o(4f, 7f).y)
                    cubicTo(
                        o(4f, 5.6f).x, o(4f, 5.6f).y,
                        o(5.4f, 4.5f).x, o(5.4f, 4.5f).y,
                        o(7f, 4.5f).x, o(7f, 4.5f).y,
                    )
                    lineTo(o(17f, 4.5f).x, o(17f, 4.5f).y)
                }
                drawPath(top, tint, style = stroke)
                drawLine(tint, o(15f, 2f), o(17.5f, 4.5f), stroke.width, StrokeCap.Round)
                drawLine(tint, o(15f, 7f), o(17.5f, 4.5f), stroke.width, StrokeCap.Round)

                val bottom = Path().apply {
                    moveTo(o(20f, 15f).x, o(20f, 15f).y)
                    lineTo(o(20f, 17f).x, o(20f, 17f).y)
                    cubicTo(
                        o(20f, 18.4f).x, o(20f, 18.4f).y,
                        o(18.6f, 19.5f).x, o(18.6f, 19.5f).y,
                        o(17f, 19.5f).x, o(17f, 19.5f).y,
                    )
                    lineTo(o(7f, 19.5f).x, o(7f, 19.5f).y)
                }
                drawPath(bottom, tint, style = stroke)
                drawLine(tint, o(9f, 17f), o(6.5f, 19.5f), stroke.width, StrokeCap.Round)
                drawLine(tint, o(9f, 22f), o(6.5f, 19.5f), stroke.width, StrokeCap.Round)
            }

            // lucide share（向上箭头从方框里出来）
            GlyphKind.Share -> {
                drawLine(tint, o(12f, 3f), o(12f, 14f), stroke.width, StrokeCap.Round)
                drawLine(tint, o(8f, 7f), o(12f, 3f), stroke.width, StrokeCap.Round)
                drawLine(tint, o(16f, 7f), o(12f, 3f), stroke.width, StrokeCap.Round)
                val tray = Path().apply {
                    moveTo(o(6f, 12f).x, o(6f, 12f).y)
                    lineTo(o(5f, 12f).x, o(5f, 12f).y)
                    lineTo(o(5f, 20.5f).x, o(5f, 20.5f).y)
                    lineTo(o(19f, 20.5f).x, o(19f, 20.5f).y)
                    lineTo(o(19f, 12f).x, o(19f, 12f).y)
                    lineTo(o(18f, 12f).x, o(18f, 12f).y)
                }
                drawPath(tray, tint, style = stroke)
            }

            // lucide search（圆 + 右下斜柄；见 lucide-react v0.511.0 search.js）
            GlyphKind.Search -> {
                drawCircle(
                    color = tint,
                    radius = x(8f),
                    center = o(11f, 11f),
                    style = stroke,
                )
                drawLine(tint, o(21f, 21f), o(16.66f, 16.66f), stroke.width, StrokeCap.Round)
            }

            // lucide mail（圆角信封 + 盖上的 V 形折线；见同版本 mail.js：
            //   path "m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7" + rect(2,4,20,16,rx=2)）
            GlyphKind.Mail -> {
                drawRoundRect(
                    color = tint,
                    topLeft = o(2f, 4f),
                    size = Size(x(20f), x(16f)),
                    cornerRadius = CornerRadius(x(2f)),
                    style = stroke,
                )
                val flap = Path().apply {
                    moveTo(o(2f, 7f).x, o(2f, 7f).y)
                    lineTo(o(11f, 12.7f).x, o(11f, 12.7f).y)
                    lineTo(o(13f, 12.7f).x, o(13f, 12.7f).y)
                    lineTo(o(22f, 7f).x, o(22f, 7f).y)
                }
                drawPath(flap, tint, style = stroke)
            }

            // lucide chevron-left（path "m15 18-6-6 6-6"）
            GlyphKind.ChevronLeft -> {
                val p = Path().apply {
                    moveTo(o(14.5f, 17.5f).x, o(14.5f, 17.5f).y)
                    lineTo(o(8.5f, 12f).x, o(8.5f, 12f).y)
                    lineTo(o(14.5f, 6.5f).x, o(14.5f, 6.5f).y)
                }
                drawPath(p, tint, style = stroke)
            }

            // lucide menu（三条等长横线 y=6/12/18，x 4→20）
            GlyphKind.Menu -> {
                listOf(6f, 12f, 18f).forEach { y ->
                    drawLine(tint, o(4f, y), o(20f, y), stroke.width, StrokeCap.Round)
                }
            }

            // lucide sun（圆 r=4 + 八向短线）
            GlyphKind.Sun -> {
                drawCircle(color = tint, radius = x(4f), center = o(12f, 12f), style = stroke)
                val rays = listOf(
                    12f to 2f, 12f to 22f,
                    2f to 12f, 22f to 12f,
                    5.6f to 5.6f, 18.4f to 18.4f,
                    5.6f to 18.4f, 18.4f to 5.6f,
                )
                rays.forEach { (rx, ry) ->
                    val dirX = (rx - 12f) / 10f
                    val dirY = (ry - 12f) / 10f
                    drawLine(
                        color = tint,
                        start = o(12f + dirX * 7f, 12f + dirY * 7f),
                        end = o(12f + dirX * 9.6f, 12f + dirY * 9.6f),
                        strokeWidth = stroke.width,
                        cap = StrokeCap.Round,
                    )
                }
            }

            // lucide ellipsis / more-horizontal（三个实心圆点）
            GlyphKind.More -> {
                listOf(5f, 12f, 19f).forEach { cx ->
                    drawCircle(color = tint, radius = x(1.7f), center = o(cx, 12f))
                }
            }

            // lucide plus（十字）
            GlyphKind.Plus -> {
                drawLine(tint, o(12f, 5f), o(12f, 19f), stroke.width, StrokeCap.Round)
                drawLine(tint, o(5f, 12f), o(19f, 12f), stroke.width, StrokeCap.Round)
            }

            // lucide x（两条对角线）
            GlyphKind.Close -> {
                drawLine(tint, o(6f, 6f), o(18f, 18f), stroke.width, StrokeCap.Round)
                drawLine(tint, o(18f, 6f), o(6f, 18f), stroke.width, StrokeCap.Round)
            }

            // lucide mic（胶囊拾音头 + U 形支架 + 底杆）
            GlyphKind.Mic -> {
                drawRoundRect(
                    color = tint,
                    topLeft = o(9f, 2.5f),
                    size = Size(x(6f), x(10f)),
                    cornerRadius = CornerRadius(x(3f)),
                    style = stroke,
                )
                val u = Path().apply {
                    moveTo(o(19f, 10.5f).x, o(19f, 10.5f).y)
                    lineTo(o(19f, 11.5f).x, o(19f, 11.5f).y)
                    cubicTo(
                        o(19f, 15.6f).x, o(19f, 15.6f).y,
                        o(15.5f, 18.5f).x, o(15.5f, 18.5f).y,
                        o(12f, 18.5f).x, o(12f, 18.5f).y,
                    )
                    cubicTo(
                        o(8.5f, 18.5f).x, o(8.5f, 18.5f).y,
                        o(5f, 15.6f).x, o(5f, 15.6f).y,
                        o(5f, 11.5f).x, o(5f, 11.5f).y,
                    )
                    lineTo(o(5f, 10.5f).x, o(5f, 10.5f).y)
                }
                drawPath(u, tint, style = stroke)
                drawLine(tint, o(12f, 18.5f), o(12f, 21.5f), stroke.width, StrokeCap.Round)
            }

            // lucide volume-2（喇叭 + 一道声波）
            GlyphKind.Volume -> {
                val body = Path().apply {
                    moveTo(o(11f, 4.7f).x, o(11f, 4.7f).y)
                    lineTo(o(7.4f, 8.3f).x, o(7.4f, 8.3f).y)
                    lineTo(o(4f, 8.3f).x, o(4f, 8.3f).y)
                    lineTo(o(4f, 15.7f).x, o(4f, 15.7f).y)
                    lineTo(o(7.4f, 15.7f).x, o(7.4f, 15.7f).y)
                    lineTo(o(11f, 19.3f).x, o(11f, 19.3f).y)
                    close()
                }
                drawPath(body, tint, style = stroke)
                drawArc(
                    color = tint,
                    startAngle = -55f,
                    sweepAngle = 110f,
                    useCenter = false,
                    topLeft = o(12.5f, 7f),
                    size = Size(x(9f), x(10f)),
                    style = stroke,
                )
            }

            // lucide monitor（显示器 + 底座）
            GlyphKind.Monitor -> {
                drawRoundRect(
                    color = tint,
                    topLeft = o(2.5f, 4f),
                    size = Size(x(19f), x(13f)),
                    cornerRadius = CornerRadius(x(2f)),
                    style = stroke,
                )
                drawLine(tint, o(8.5f, 20.5f), o(15.5f, 20.5f), stroke.width, StrokeCap.Round)
                drawLine(tint, o(12f, 17f), o(12f, 20.5f), stroke.width, StrokeCap.Round)
            }

            // lucide log-out（门 + 向外箭头）
            GlyphKind.LogOut -> {
                val door = Path().apply {
                    moveTo(o(9.5f, 21f).x, o(9.5f, 21f).y)
                    lineTo(o(5f, 21f).x, o(5f, 21f).y)
                    lineTo(o(5f, 3f).x, o(5f, 3f).y)
                    lineTo(o(9.5f, 3f).x, o(9.5f, 3f).y)
                }
                drawPath(door, tint, style = stroke)
                drawLine(tint, o(15.5f, 17f), o(20.5f, 12f), stroke.width, StrokeCap.Round)
                drawLine(tint, o(15.5f, 7f), o(20.5f, 12f), stroke.width, StrokeCap.Round)
                drawLine(tint, o(21f, 12f), o(9.5f, 12f), stroke.width, StrokeCap.Round)
            }

            // 录制圆点（实心；红色是"录制中"的通用语义，色由 tint 决定）
            GlyphKind.Dot -> drawCircle(color = tint, radius = x(5f), center = o(12f, 12f))

            // lucide sliders-horizontal（三条横轨 + 三个滑块）
            GlyphKind.Sliders -> {
                listOf(6f, 12f, 18f).forEach { y ->
                    drawLine(tint, o(3f, y), o(21f, y), stroke.width, StrokeCap.Round)
                }
                // 三个滑块（纵向短线），错落在三条轨上
                listOf(14f to 6f, 8f to 12f, 16f to 18f).forEach { (kx, ky) ->
                    drawLine(
                        tint,
                        o(kx, ky - 2.2f),
                        o(kx, ky + 2.2f),
                        stroke.width * 1.4f,
                        StrokeCap.Round,
                    )
                }
            }

            // lucide megaphone（喇叭锥形 + 手柄弧）
            GlyphKind.Megaphone -> {
                val cone = Path().apply {
                    moveTo(o(3f, 11f).x, o(3f, 11f).y)
                    lineTo(o(21f, 6f).x, o(21f, 6f).y)
                    lineTo(o(21f, 18f).x, o(21f, 18f).y)
                    lineTo(o(3f, 13f).x, o(3f, 13f).y)
                    close()
                }
                drawPath(cone, tint, style = stroke)
                val handle = Path().apply {
                    moveTo(o(11.6f, 16.8f).x, o(11.6f, 16.8f).y)
                    cubicTo(
                        o(11.6f, 19f).x, o(11.6f, 19.8f).y,
                        o(9.6f, 20.4f).x, o(8.2f, 19.4f).y,
                        o(8.2f, 19.4f).x, o(8.2f, 19.4f).y,
                    )
                }
                drawPath(handle, tint, style = stroke)
            }
            // lucide chevron-right（path "m9 18 6-6-6-6"，与 ChevronLeft 镜像）
            GlyphKind.ChevronRight -> {
                val p = Path().apply {
                    moveTo(o(9.5f, 17.5f).x, o(9.5f, 17.5f).y)
                    lineTo(o(15.5f, 12f).x, o(15.5f, 12f).y)
                    lineTo(o(9.5f, 6.5f).x, o(9.5f, 6.5f).y)
                }
                drawPath(p, tint, style = stroke)
            }

            // lucide shield（管理后台入口的盾牌）
            // 官方 path: "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6
            //            a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81
            //            17 5 19 5a1 1 0 0 1 1 1z"
            // 这里用"顶边直线 + 两侧下探收成圆角尖底"来近似它的外轮廓：肉眼在 20dp 下与设计稿一致，
            // 且比逐段 cubic 更好读、更不容易写错。
            GlyphKind.Shield -> {
                val shield = Path().apply {
                    moveTo(o(5f, 6f).x, o(5f, 6f).y)
                    lineTo(o(19f, 6f).x, o(19f, 6f).y)
                    lineTo(o(19f, 13f).x, o(19f, 13f).y)
                    cubicTo(
                        o(19f, 17.2f).x, o(19f, 17.2f).y,
                        o(15.6f, 19.6f).x, o(15.6f, 19.6f).y,
                        o(12f, 20.7f).x, o(12f, 20.7f).y,
                    )
                    cubicTo(
                        o(8.4f, 19.6f).x, o(8.4f, 19.6f).y,
                        o(5f, 17.2f).x, o(5f, 17.2f).y,
                        o(5f, 13f).x, o(5f, 13f).y,
                    )
                    close()
                }
                drawPath(shield, tint, style = stroke)
            }
            // lucide maximize-2（四角向外：全屏/展开）
            // 官方是四条折线：M15 3h6v6 / M9 21H3v-6 / M21 3l-7 7 / M3 21l7-7
            GlyphKind.Maximize -> {
                val tl = Path().apply {
                    moveTo(o(15f, 3f).x, o(15f, 3f).y)
                    lineTo(o(21f, 3f).x, o(21f, 3f).y)
                    lineTo(o(21f, 9f).x, o(21f, 9f).y)
                }
                val br = Path().apply {
                    moveTo(o(9f, 21f).x, o(9f, 21f).y)
                    lineTo(o(3f, 21f).x, o(3f, 21f).y)
                    lineTo(o(3f, 15f).x, o(3f, 15f).y)
                }
                drawPath(tl, tint, style = stroke)
                drawPath(br, tint, style = stroke)
                drawLine(tint, o(21f, 3f), o(14f, 10f), stroke.width, StrokeCap.Round)
                drawLine(tint, o(3f, 21f), o(10f, 14f), stroke.width, StrokeCap.Round)
            }
        }
    }
}

/** 供 StyleGuide 的色块直接用十六进制字符串建色（与设计稿文档里的写法一一对应） */
internal fun parseHex(hex: String): Color {
    val v = hex.removePrefix("#")
    val argb = when (v.length) {
        6 -> 0xFF000000L or v.toLong(16)
        8 -> v.toLong(16)
        else -> 0xFF000000L
    }
    return Color(argb)
}
