package top.kuangdada.k.core.designsystem.component

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import top.kuangdada.k.core.designsystem.theme.KDimens
import top.kuangdada.k.core.designsystem.theme.KMotion
import top.kuangdada.k.core.designsystem.theme.KRadius
import top.kuangdada.k.core.designsystem.theme.KSpacing
import top.kuangdada.k.core.designsystem.theme.KTheme
import top.kuangdada.k.core.designsystem.theme.KType

/**
 * ============================================================
 * 按钮五态（设计稿「三 · 核心组件」按钮一行）
 * ============================================================
 * 设计稿画的是：主 / 按下 / 禁用 / 幽灵 / 危险。这里把这五个状态做成**一个组件的变体**，
 * 而不是五个各自硬编码色的按钮 —— 否则「主按钮」和「危险按钮」的按下态迟早会不一致。
 *
 * 关键约束（设计稿 §2.3.2）：accent 的明度在两主题间**反相**（浅色深绿 / 深色浅金），
 * 所以实心按钮的文字必须走 `onAccent`，**不能固定白色** —— 深色下白字只有 3.63:1。
 */
enum class KButtonVariant {
    /** 主按钮：实心 accent 底 + onAccent 字 */
    Primary,

    /**
     * 次级按钮：`surface` 底 + `borderStrong` 描边 + textPrimary 字。
     * 「分享主页」这类与主按钮并排的**白底描边**按钮用它 ——
     * 别拿 [Ghost] 顶：Ghost 是 accentSoft 底 + accent 字，语义是"弱化的强调"，不是"并列的次动作"。
     */
    Secondary,

    /** 幽灵按钮：accentSoft 底 + accentBorder 描边 + accent 字 */
    Ghost,

    /** 危险按钮：dangerSoft 底 + danger 字 */
    Danger,
}

/**
 * 尺度按钮。
 *
 * @param pressed 强制渲染「按下态」（供 StyleGuide 展示五态；正常业务调用不传）
 * @param cornerRadius 圆角。默认全圆（胶囊，导航/行内小按钮用）；
 *   **表单主按钮**（登录/发布这类占满一行的）按设计稿用 [KRadius.control] ——
 *   设计稿登录按钮是「全宽 + 圆角 10」，不是胶囊。
 * @param compact 紧凑尺寸：内边距与最小高度各收一档（设计稿「发布弹层」顶栏的
 *   「发布」实测 58×35，常规尺寸会是 70×44）。**默认 false，不影响既有调用方。**
 */
@Composable
fun KButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    variant: KButtonVariant = KButtonVariant.Primary,
    enabled: Boolean = true,
    pressed: Boolean = false,
    compact: Boolean = false,
    leading: (@Composable RowScope.() -> Unit)? = null,
    cornerRadius: Dp = KRadius.pill,
) {
    val c = KTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val isPressed by interaction.collectIsPressedAsState()
    val active = pressed || (isPressed && enabled)

    val bg: Color
    val fg: Color
    val border: Color?
    if (!enabled) {
        bg = c.disabledSurface
        fg = c.textMuted
        border = null
    } else {
        when (variant) {
            KButtonVariant.Primary -> {
                bg = if (active) c.accentPressed else c.accent
                fg = c.onAccent
                border = null
            }
            KButtonVariant.Secondary -> {
                bg = c.surface
                fg = c.textPrimary
                border = c.borderStrong
            }
            KButtonVariant.Ghost -> {
                bg = c.accentSoft
                fg = c.accent
                border = c.accentBorder
            }
            KButtonVariant.Danger -> {
                bg = c.dangerSoft
                fg = c.danger
                border = null
            }
        }
    }

    // 按下微反馈（120ms）：文字按钮用克制的 .97，
    // scale(.92) 留给图标型按钮，避免整块文字跟着抖
    val scale by animateFloatAsState(
        targetValue = if (active && enabled) 0.97f else 1f,
        animationSpec = tween(KMotion.instant, easing = KMotion.standard),
        label = "KButtonScale",
    )

    val shape = RoundedCornerShape(cornerRadius)
    Row(
        modifier = modifier
            .scale(scale)
            .defaultMinSize(minHeight = if (compact) KDimens.compactControl else KDimens.minTouchTarget)
            .clip(shape)
            .background(bg)
            .then(if (border != null) Modifier.border(BorderStroke(1.dp, border), shape) else Modifier)
            .clickable(
                interactionSource = interaction,
                indication = null,
                enabled = enabled,
                onClick = onClick,
            )
            .padding(
                horizontal = if (compact) KSpacing.sm else KSpacing.lg,
                vertical = if (compact) KSpacing.xs else KSpacing.sm,
            ),
        horizontalArrangement = Arrangement.spacedBy(KSpacing.xs, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        leading?.invoke(this)
        Text(
            text = text,
            style = KType.bodyStrong,
            color = fg,
        )
    }
}
