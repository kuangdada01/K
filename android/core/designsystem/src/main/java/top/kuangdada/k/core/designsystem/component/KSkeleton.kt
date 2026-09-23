package top.kuangdada.k.core.designsystem.component

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import top.kuangdada.k.core.designsystem.theme.KDimens
import top.kuangdada.k.core.designsystem.theme.KMotion
import top.kuangdada.k.core.designsystem.theme.KRadius
import top.kuangdada.k.core.designsystem.theme.KSpacing
import top.kuangdada.k.core.designsystem.theme.KTheme
import top.kuangdada.k.core.designsystem.theme.LocalAnimationsEnabled

/**
 * ============================================================
 * 骨架屏（M4）
 * ============================================================
 * 为什么要有：转圈（`CircularProgressIndicator`）只表达"在忙"，不表达**"忙完会长什么样"**。
 * 列表页首屏用骨架屏，用户能提前看到版式（几张卡片、每张什么结构），
 * 内容补上时是"同一套版式填上内容"，而不是"转圈突然变成一屏卡片"。
 *
 * 与 [KPlaceholder] 的分工：
 *  · [KPlaceholder]（`Loading` 态）是**状态占位**：居中的一句"加载中…"，用在空页面 / 小区域；
 *  · [KListSkeleton] 是**内容骨架**：按真实版式铺几行，用在列表首屏。
 *
 * 两条硬约束（§6）：
 *  1. **微光必须受 [LocalAnimationsEnabled] 门控** —— 无限循环动画不保证被系统"动画时长缩放"
 *     覆盖，用户关掉动画后还在闪属于可访问性问题，不只是性能问题；
 *  2. **动效不能是唯一信号** —— 骨架整块带 `contentDescription = "加载中"`，
 *     读屏用户拿到的是状态而不是几个空方块。
 */

/**
 * 骨架块：一块 [shape] 形状的底 + 一道横向扫过的微光。
 *
 * 微光用**绘制期读动画值**（`drawBehind` 里读 [androidx.compose.runtime.State]）：
 * 每帧只重画，不重组、不重新布局 —— 与视频封面那处 `graphicsLayer { alpha = … }` 同一手法。
 * 动画关闭时直接退化成静态底色（不再是动画，也就没有"必须门控"的问题）。
 */
@Composable
fun Modifier.kShimmer(shape: Shape = RoundedCornerShape(KRadius.row)): Modifier {
    val c = KTheme.colors
    if (!LocalAnimationsEnabled.current) {
        return this.clip(shape).background(c.surfaceSunken)
    }
    val transition = rememberInfiniteTransition(label = "kShimmer")
    val progress = transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = KMotion.shimmer, easing = LinearEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "kShimmerProgress",
    )
    // 浅色：底色比页底深一档、高光用白；深色：底色比页底浅一档、高光再亮一档。
    // 两套主题的"深浅方向"是反的，所以这里按 isLight 取，而不是写死两个颜色令牌。
    val base = c.surfaceSunken
    val highlight = if (c.isLight) c.surface else c.surfaceRaised
    return clip(shape).drawBehind {
        val p = progress.value
        val band = size.width * 0.45f
        val center = -band + (size.width + band * 2f) * p
        drawRect(
            Brush.linearGradient(
                colors = listOf(base, highlight, base),
                start = Offset(center - band, 0f),
                end = Offset(center + band, 0f),
            ),
        )
    }
}

/**
 * 列表首屏骨架：`items` 张卡片，每张 = 作者行（圆头像 + 两行文字）+（可选）媒体块 + 一行正文。
 *
 * 形状刻意贴信息流卡片：首屏加载完切到真内容时，版式是连续的（这也是骨架屏的意义所在）。
 * 图书那种两列网格不适合它（用 `withMedia = false` 也不像），那里仍用居中转圈。
 */
@Composable
fun KListSkeleton(
    modifier: Modifier = Modifier,
    items: Int = 2,
    withMedia: Boolean = true,
) {
    val c = KTheme.colors
    Column(
        modifier = modifier
            .fillMaxWidth()
            .semantics { contentDescription = "加载中" },
        verticalArrangement = Arrangement.spacedBy(KSpacing.md),
    ) {
        repeat(items) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(KRadius.card))
                    .background(c.surface)
                    .padding(KSpacing.sm),
                verticalArrangement = Arrangement.spacedBy(KSpacing.sm),
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
                ) {
                    Box(Modifier.size(KDimens.avatarCard).kShimmer(CircleShape))
                    Column(verticalArrangement = Arrangement.spacedBy(KSpacing.xxs)) {
                        Box(Modifier.width(96.dp).height(12.dp).kShimmer(RoundedCornerShape(KRadius.pill)))
                        Box(Modifier.width(64.dp).height(10.dp).kShimmer(RoundedCornerShape(KRadius.pill)))
                    }
                }
                if (withMedia) {
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .aspectRatio(16f / 9f)
                            .kShimmer(RoundedCornerShape(KRadius.row)),
                    )
                }
                Box(
                    Modifier
                        .fillMaxWidth(0.7f)
                        .height(12.dp)
                        .kShimmer(RoundedCornerShape(KRadius.pill)),
                )
            }
        }
    }
}
