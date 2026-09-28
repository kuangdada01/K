package top.kuangdada.k.core.designsystem.component

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Fill
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import top.kuangdada.k.core.designsystem.theme.KDimens
import top.kuangdada.k.core.designsystem.theme.KRadius
import top.kuangdada.k.core.designsystem.theme.KSpacing
import top.kuangdada.k.core.designsystem.theme.KTheme

/**
 * ============================================================
 * 表情选择器（KEmojiPicker）
 * ============================================================
 * 与 Web 端 `client/src/components/EmojiPicker.tsx` 同一套语义：
 *  · **同一份 71 个常用表情**（[KEmojis]，顺序也与 Web 一致 —— 加表情时两边一起加；
 *    Web 文件头注释写的"64 个"是旧数，实际清单以两边逐条一致为准）；
 *  · 移动端形态 = 底部全宽面板、8 列网格（Web 的 mobilePanel 同款列数）；
 *  · 点一个表情 = 追加到输入框（Web 的 `onSelect` 同语义：往末尾拼，不替换）。
 *
 * 为什么放在 designsystem：私信聊天（`ChatScreen`）先用，语音房聊天、帖子评论
 * 这些"输入条 + 表情"的场景随后都要用 —— 放在这里任何 feature 模块都能直接调，
 * 不需要每处复制一份网格。
 *
 * 用法（状态由调用方持有，面板本身不管开关）：
 * ```
 * var emojiOpen by remember { mutableStateOf(false) }
 * // 输入栏里：
 * KEmojiButton(active = emojiOpen, onClick = { emojiOpen = !emojiOpen })
 * // 输入栏上方（AnimatedVisibility 里）：
 * KEmojiPanel(onPick = { input += it })
 * ```
 */

/**
 * 常用表情清单（**与 Web 端 `EMOJI_LIST` 逐条一致**，71 个）。
 *
 * 两边同源维护的约定：安卓加一个、Web 也要加，否则出现"这边能发出去、那边选不到"。
 * 顺序即展示顺序，不要排序 —— 排序会把最常用的脸打乱到中段去。
 */
object KEmojis {
    val list: List<String> = listOf(
        "😀", "😃", "😄", "😁",
        "😆", "😅", "🤣", "😂",
        "🙂", "😊", "😇", "🥰",
        "😍", "🤩", "😘", "😗",
        "😋", "😛", "😜", "🤪",
        "😝", "🤑", "🤗", "🤭",
        "🤫", "🤔", "🤐", "🤨",
        "😐", "😑", "😶", "😏",
        "😒", "🙄", "😬", "😮",
        "🤥", "😌", "😔", "😪",
        "🤤", "😴", "😷", "🤒",
        "🤕", "🤢", "🤮", "🥵",
        "🥶", "🥴", "😵", "🤯",
        "🤠", "🥳", "😎", "👍",
        "👎", "👏", "🙌", "🤝",
        "❤️", "🔥", "⭐", "💯",
        "🎉", "🎊", "💐", "🌹",
        "✨", "💫", "🎵",
    )
}

/**
 * 表情面板默认高（与 Web 移动端面板的 maxHeight 240 一致）。
 *
 * 导出成令牌而不是藏在默认参数里：调用方要按"输入栏 + 面板"估算底部占位
 * （聊天页的 toast 位置就得躲开它），各写各的 240 迟早对不上。
 */
val KEmojiPanelHeight: Dp = 240.dp

/**
 * 表情开关按钮（输入栏里那个笑脸）。
 *
 * 图标**就地画、不引外部资产**：本模块拿不到 nativeapp 的 `GlyphKind`
 * （依赖方向是 feature → designsystem，反过来就成环了），所以按 lucide `smile`
 * 的 24 网格几何画一个（圆脸 + 两点眼 + 微笑弧）。
 *
 * @param active 面板正开着 —— 用 accent 色点亮，与「朗读开」同一套强调语义。
 * @param boxSize 触控盒边长，默认 [KDimens.minTouchTarget]（44dp）。聊天输入栏
 *   要求两颗钮紧凑成组（2026-09-25 多轮反馈"缩小间距"），传 36dp 之类的小值 ——
 *   图标只有 [iconSize]（20dp），盒子缩小收的主要是图标四周的留白。
 */
@Composable
fun KEmojiButton(
    active: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    iconSize: Dp = KDimens.navIcon,
    boxSize: Dp = KDimens.minTouchTarget,
) {
    val c = KTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    // 面板开着或被按下都点亮：后者是即时触感，前者是"当前状态"
    val fg = if (active || pressed) c.accent else c.textSecondary
    Box(
        modifier = modifier
            // 默认 44dp 触控目标（KDimens.minTouchTarget）：视觉 20dp 的图标钮，
            // 手指实际能点到的范围必须达标，否则输入栏这一排等于"半个按钮"；
            // 紧凑场景可经 [boxSize] 调小（代价是触控目标跟着变小）
            .size(boxSize)
            .clip(RoundedCornerShape(KRadius.pill))
            .background(if (active || pressed) c.accentSoft else Color.Transparent)
            .clickable(
                interactionSource = interaction,
                indication = null,
                onClick = onClick,
            )
            .semantics { contentDescription = if (active) "收起表情" else "表情" },
        contentAlignment = Alignment.Center,
    ) {
        Canvas(modifier = Modifier.size(iconSize)) {
            val s = this.size.minDimension
            // 24 网格 -> 当前画布（与 nativeapp 的 Glyph 同一套换算）
            fun x(v: Float) = v / 24f * s
            fun o(px: Float, py: Float) = Offset(x(px), x(py))
            val stroke = Stroke(
                width = 1.75f / 24f * s,
                cap = StrokeCap.Round,
                join = StrokeJoin.Round,
            )
            // lucide smile：脸（圆 r=10）
            drawCircle(color = fg, radius = x(10f), center = o(12f, 12f), style = stroke)
            // 眼睛：两个实心点（lucide 用两条极短线表示，20dp 下画点更清楚）
            drawCircle(color = fg, radius = x(1.15f), center = o(9f, 9f), style = Fill)
            drawCircle(color = fg, radius = x(1.15f), center = o(15f, 9f), style = Fill)
            // 微笑弧：脸圆内切的一段下弧（20° → 160°，经过正下方 90°）
            drawArc(
                color = fg,
                startAngle = 20f,
                sweepAngle = 140f,
                useCenter = false,
                topLeft = o(6.4f, 6.4f),
                size = Size(x(11.2f), x(11.2f)),
                style = stroke,
            )
        }
    }
}

/**
 * 表情面板（8 列网格，贴在输入栏上方）。
 *
 * 与 Web 移动端面板同参数：8 列、最大高 240、内部可滚。
 * 表情字号 22sp（Web 的 mobilePanel 是 22px）。
 *
 * @param columns 列数。8 = 私信聊天用的档；别的场景（更宽的面板）可以传 7（Web 桌面档）。
 * @param height 面板高。固定高而不是 wrapContent：71 个表情全展开有 9 行、
 *   会把输入栏挤出屏幕；固定高 + 内部滚动才装得下（样式指南那种外层可滚的页面里，
 *   wrapContent 还会触发"无限高约束"崩溃，固定高同时避开这个）。
 */
@Composable
fun KEmojiPanel(
    onPick: (String) -> Unit,
    modifier: Modifier = Modifier,
    columns: Int = 8,
    height: Dp = KEmojiPanelHeight,
) {
    val c = KTheme.colors
    LazyVerticalGrid(
        columns = GridCells.Fixed(columns),
        modifier = modifier
            .fillMaxWidth()
            .height(height)
            .background(c.surface)
            .padding(horizontal = KSpacing.sm, vertical = KSpacing.xs),
        horizontalArrangement = Arrangement.spacedBy(KSpacing.xxs),
        verticalArrangement = Arrangement.spacedBy(KSpacing.xxs),
    ) {
        items(KEmojis.list, key = { it }) { emoji ->
            KEmojiCell(emoji = emoji, onPick = onPick)
        }
    }
}

/** 一格表情：正方形格子 + 按下时 accentSoft 底（与 [KButton] 同一套按压反馈） */
@Composable
private fun KEmojiCell(
    emoji: String,
    onPick: (String) -> Unit,
) {
    val c = KTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    Box(
        modifier = Modifier
            .aspectRatio(1f)
            .clip(RoundedCornerShape(KRadius.control))
            .background(if (pressed) c.accentSoft else Color.Transparent)
            .clickable(
                interactionSource = interaction,
                indication = null,
                onClick = { onPick(emoji) },
            )
            .semantics { contentDescription = "表情 $emoji" },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = emoji,
            fontSize = 22.sp,
            textAlign = TextAlign.Center,
        )
    }
}
