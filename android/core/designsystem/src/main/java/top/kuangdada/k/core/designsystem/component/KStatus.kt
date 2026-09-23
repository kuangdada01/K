package top.kuangdada.k.core.designsystem.component

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Fill
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.Canvas
import top.kuangdada.k.core.designsystem.theme.KDimens
import top.kuangdada.k.core.designsystem.theme.KMotion
import top.kuangdada.k.core.designsystem.theme.KRadius
import top.kuangdada.k.core.designsystem.theme.KSpacing
import top.kuangdada.k.core.designsystem.theme.KTheme
import top.kuangdada.k.core.designsystem.theme.KType
import top.kuangdada.k.core.designsystem.theme.LocalAnimationsEnabled

/**
 * ============================================================
 * 状态类小件（设计稿「三 · 核心组件」输入 / 状态一行：点赞两态 · 角标）
 * ============================================================
 */

/**
 * 数字角标：15×15，**压住图标右上角约 12px**（不是并排在旁边）。
 *
 * 两个必须遵守的规则：
 *  1. **角标文字用 onAccent，不能用白色** —— 旧 Web 版 `.badge { color: white }` 在深色下
 *     配 `--danger #E0586B` 只有 3.63:1；改用 onAccent 后浅色 5.35 / 深色 5.27，双主题达标。
 *  2. 角标会溢出图标容器边界 → 容器必须留余量或 `clip = false`，
 *     否则会被裁成月牙（设计稿明确记录过这个坑）。
 *
 * @param anchor 被角标压住的图标（角标按 -12px 偏移量贴到它的右上角）
 */
@Composable
fun KBadge(
    count: Int,
    modifier: Modifier = Modifier,
    anchor: (@Composable () -> Unit)? = null,
) {
    if (count <= 0) {
        if (anchor != null) anchor()
        return
    }
    val c = KTheme.colors
    // 角标是纯数字，居中；宽度用 minWidth 撑开（1 位与 2 位数字宽度不同会导致右缘参差，
    // 这是设计稿 §3.2 记录的问题），>99 显示 99+
    val badge: @Composable () -> Unit = {
        Box(
            modifier = Modifier
                .defaultMinSize(minWidth = KDimens.badge, minHeight = KDimens.badge)
                .clip(CircleShape)
                .background(c.danger)
                .padding(horizontal = 4.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = if (count > 99) "99+" else count.toString(),
                color = c.onAccent,
                fontSize = 10.sp,
                fontWeight = FontWeight.SemiBold,
                lineHeight = 10.sp,
                textAlign = TextAlign.Center,
            )
        }
    }

    if (anchor == null) {
        Box(modifier = modifier) { badge() }
        return
    }

    // 角标压住图标右上角：图标在容器内居中，角标按 -12px 偏移量贴右上
    Box(
        modifier = modifier,
        contentAlignment = Alignment.Center,
    ) {
        anchor()
        Box(
            modifier = Modifier
                .align(Alignment.TopEnd)
                .offset(x = KDimens.badgeOverlap, y = (-KDimens.badgeOverlap)),
        ) {
            badge()
        }
    }
}

/**
 * 点赞两态 + 一次"点赞弹跳"（M4）。
 *
 * 旧 Web 版的缺陷（设计稿 §3.1 记录）：`.actionBtn:first-child` 与 `.actionBtn.liked`
 * **颜色完全相同**，未赞与已赞只差 svg 的 `fill` —— 快速滑动时用户分不清自己点没点过。
 * 所以这里三态明确化：
 *   · 未赞：描边图标 + `textSecondary`
 *   · 已赞：实心图标 + `danger`
 *   · 按下：scale(.92) 微反馈（120ms）
 *
 * M4 补的两处：
 *  1. **点赞那一下的弹跳**：`liked` 由 false→true 时心形 scale 冲到 1.28 再回弹
 *     （[KMotion.pressSpec]，阻尼比 0.45 —— 这是"手指施加了力"的反馈，允许明显过冲）。
 *     取消点赞不弹：弹跳代表"给出去"，收回来再弹一次会让人以为又赞了一次。
 *  2. **颜色走过渡**（[KMotion.effects]）：`textSecondary ↔ danger` 直接切会"跳"，
 *     而 `effects` 档阻尼比固定 1.0，不过冲（颜色过冲会显脏）。
 *
 * 计数用 [AnimatedContent] 做**数字滚动**：`+1` 时新数字从下方上来、旧数字向上走，
 * `-1` 时反过来 —— 方向跟"数变大还是变小"一致，用户不用读数字就知道发生了什么。
 * 位数变化（9→10）用 `SizeTransform(clip = false)` 让宽度自己长出来，不要裁字。
 *
 * 降级：系统动画缩放为 0（[LocalAnimationsEnabled] = false）时全部 `snap()` ——
 * 状态依然由**颜色 + 实心/描边 + 数字**表达（动效从来不是唯一信号）。
 */
@Composable
fun KLikeButton(
    liked: Boolean,
    count: Int,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = KTheme.colors
    val animationsEnabled = LocalAnimationsEnabled.current
    val haptics = LocalHapticFeedback.current
    val interaction = remember { MutableInteractionSource() }
    val isPressed by interaction.collectIsPressedAsState()

    // 按下缩放 × 点赞弹跳，两个 scale 相乘（否则前者会把后者覆盖掉）
    val pressScale by animateFloatAsState(
        targetValue = if (isPressed) KMotion.pressedScale else 1f,
        animationSpec = tween(KMotion.instant, easing = KMotion.standard),
        label = "KLikeScale",
    )
    val heartScale = remember { Animatable(1f) }
    LaunchedEffect(liked) {
        if (!liked || !animationsEnabled) {
            heartScale.snapTo(1f)
            return@LaunchedEffect
        }
        // 冲过头再弹回来：1.28 是"能看清但不像玩具"的量（比 design 的 .92 按下更深一档）
        heartScale.animateTo(1.28f, KMotion.pressSpec)
        heartScale.animateTo(1f, KMotion.pressSpec)
    }

    val targetTint = if (liked) c.danger else c.textSecondary
    val tint by animateColorAsState(
        targetValue = targetTint,
        animationSpec = if (animationsEnabled) KMotion.effects() else snap(),
        label = "KLikeTint",
    )
    // 空心 → 实心的形变进度（M6）：与颜色同时进行，所以"变色"与"填满"是一个动作
    val fillProgress by animateFloatAsState(
        targetValue = if (liked) 1f else 0f,
        animationSpec = if (animationsEnabled) KMotion.effects() else snap(),
        label = "KLikeFill",
    )

    Row(
        modifier = modifier
            .scale(pressScale)
            .defaultMinSize(minHeight = KDimens.minTouchTarget)
            .clip(RoundedCornerShape(KRadius.chip))
            .clickable(interactionSource = interaction, indication = null) {
                // 触感与动效配对（§6）：点赞是"有结果"的动作，给一次轻微触感
                haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                onClick()
            }
            .padding(horizontal = KSpacing.xs)
            .semantics { contentDescription = if (liked) "取消点赞，当前 $count 赞" else "点赞，当前 $count 赞" },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(KSpacing.xxs),
    ) {
        HeartIcon(
            tint = tint,
            filled = liked,
            modifier = Modifier.scale(heartScale.value),
            size = 18.dp,
            fillProgress = fillProgress,
        )
        CountRoll(count = count, tint = tint, animationsEnabled = animationsEnabled)
    }
}

/**
 * 计数的数字滚动。方向由**数值变化方向**决定：变大 → 新值从下往上进、旧值往上走。
 *
 * 抽出来是为了让 [KLikeButton] 的主干保持"一眼能读完"；它本身不含业务。
 */
@Composable
private fun CountRoll(count: Int, tint: Color, animationsEnabled: Boolean) {
    AnimatedContent(
        targetState = count,
        transitionSpec = {
            if (!animationsEnabled) {
                // 降级：直接换数字（EnterTransition.None + ExitTransition.None）
                EnterTransition.None togetherWith ExitTransition.None
            } else {
                val up = targetState >= initialState
                val enter = slideInVertically(
                    animationSpec = KMotion.spatial(),
                    initialOffsetY = { if (up) it else -it },
                ) + fadeIn(animationSpec = KMotion.effects())
                val exit = slideOutVertically(
                    animationSpec = KMotion.spatial(),
                    targetOffsetY = { if (up) -it else it },
                ) + fadeOut(animationSpec = KMotion.effects())
                // clip = false：9→10 时宽度要能长出来，别把新数字裁掉半个
                (enter togetherWith exit).using(SizeTransform(clip = false))
            }
        },
        label = "KLikeCount",
    ) { value ->
        Text(
            text = value.toString(),
            style = KType.caption,
            color = tint,
        )
    }
}

/**
 * 心形图标（自绘）。
 *
 * 为什么自绘而不是用 `material-icons`：设计稿要求「直接复用项目里 lucide-react 的原始图标」，
 * 手绘版与 lucide 的 24 网格线条比例不一致，放大后差异明显。但 Compose 的 material-icons-core
 * 里没有 Favorite/FavoriteBorder（它们在 material-icons-extended，多一个 ~3MB 依赖），
 * 所以按 lucide 的 24×24 网格比例自绘一个 —— 与设计稿的心形形状、描边宽度（1.6/24）对齐。
 */
@Composable
fun HeartIcon(
    tint: Color,
    filled: Boolean,
    modifier: Modifier = Modifier,
    size: androidx.compose.ui.unit.Dp = 20.dp,
    strokeWidthRatio: Float = 1.6f / 24f,
    /**
     * 描边 → 实心的**形变进度**（M6）：0 = 只有描边，1 = 只有实心，中间 = 两者叠加。
     *
     * 为什么不是 `if (filled) Fill else Stroke` 的硬切：那是"两个图形换了一下"，
     * 而心形从空心变实心本来是**同一个形状在变**。描边淡出的同时填充淡入，
     * 眼睛看到的是"轮廓被填满"，而不是"闪了一下"。
     * 默认 1f 保持既有调用点行为不变（`filled=false` 时按 0 处理）。
     */
    fillProgress: Float = if (filled) 1f else 0f,
) {
    Canvas(modifier = modifier.size(size)) {
        val s = this.size.minDimension
        // lucide heart：中心线在 24 网格上，按比例缩放到当前画布
        fun p(x: Float, y: Float) = androidx.compose.ui.geometry.Offset(x / 24f * s, y / 24f * s)

        val path = Path().apply {
            moveTo(p(12f, 20.5f).x, p(12f, 20.5f).y)
            cubicTo(
                p(2f, 14f).x, p(2f, 14f).y,
                p(2.5f, 4.5f).x, p(2.5f, 4.5f).y,
                p(12f, 9f).x, p(12f, 9f).y,
            )
            cubicTo(
                p(21.5f, 4.5f).x, p(21.5f, 4.5f).y,
                p(22f, 14f).x, p(22f, 14f).y,
                p(12f, 20.5f).x, p(12f, 20.5f).y,
            )
            close()
        }
        val progress = fillProgress.coerceIn(0f, 1f)
        // 两者在中间帧叠加（各 50% 不透明度）：看起来是"轮廓正在被填满"，
        // 而不是"空心图消失、实心图出现"这种两张图交替的观感
        if (progress > 0f) {
            drawPath(path, color = tint.copy(alpha = tint.alpha * progress), style = Fill)
        }
        if (progress < 1f) {
            drawPath(
                path,
                color = tint.copy(alpha = tint.alpha * (1f - progress)),
                style = Stroke(width = strokeWidthRatio * s),
            )
        }
    }
}

/** 加载 / 空 / 错三态的统一占位（设计稿 §1.3：EmptyState 已存在但只有部分页面接入） */
enum class KPlaceholderKind { Loading, Empty, Error }

@Composable
fun KPlaceholder(
    kind: KPlaceholderKind,
    modifier: Modifier = Modifier,
    title: String? = null,
    description: String? = null,
    action: (@Composable () -> Unit)? = null,
) {
    val c = KTheme.colors
    val defaultTitle = when (kind) {
        KPlaceholderKind.Loading -> "加载中…"
        KPlaceholderKind.Empty -> "这里还是空的"
        KPlaceholderKind.Error -> "加载失败"
    }
    Column(
        modifier = modifier.padding(KSpacing.xl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(KSpacing.sm),
    ) {
        Box(
            modifier = Modifier
                .size(48.dp)
                // 加载态用微光（M4）：无限动画由 kShimmer 内部按 LocalAnimationsEnabled 门控；
                // 关掉动画时它就是一块静态底色，状态仍由下面那句"加载中…"表达（§6）
                .then(if (kind == KPlaceholderKind.Loading) Modifier.kShimmer(CircleShape) else Modifier)
                .clip(CircleShape)
                .background(if (kind == KPlaceholderKind.Loading) Color.Transparent else c.accentSoft)
                .border(1.dp, c.borderSubtle, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            if (kind != KPlaceholderKind.Loading) {
                Text(
                    text = when (kind) {
                        KPlaceholderKind.Empty -> "○"
                        KPlaceholderKind.Error -> "!"
                        // 到不了：Loading 已在上面用微光表达，不再画"…"
                        KPlaceholderKind.Loading -> ""
                    },
                    style = KType.subtitle,
                    color = c.accent,
                )
            }
        }
        Text(
            text = title ?: defaultTitle,
            style = KType.body,
            color = c.textSecondary,
        )
        if (description != null) {
            Text(
                text = description,
                style = KType.footnote,
                color = c.textMuted,
                textAlign = TextAlign.Center,
            )
        }
        if (action != null) action()
    }
}
