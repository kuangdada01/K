package top.kuangdada.k.core.designsystem.component

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import top.kuangdada.k.core.designsystem.theme.KDimens
import top.kuangdada.k.core.designsystem.theme.KElevation
import top.kuangdada.k.core.designsystem.theme.KMotion
import top.kuangdada.k.core.designsystem.theme.KSpacing
import top.kuangdada.k.core.designsystem.theme.KTheme
import top.kuangdada.k.core.designsystem.theme.KType

/**
 * ============================================================
 * 底部导航胶囊（设计稿 §3.3 · 本轮重点改造项）
 * ============================================================
 * 改造前的三个问题（设计稿已定稿方案）：
 *  1. `max-width: 420px` 里塞 7–8 项，移动端还 `display:none` 掉所有文字标签 ——
 *     单项可用宽度约 50px，已低于舒适的 44×44 触控目标；**本轮压到 5 项并恢复 11px 文字标签**。
 *  2. 选中态只有 2px 尺寸差 + 颜色变化 —— **改为「实心强调底 + 图标与标签反色」**。
 *  3. 导航是实心栏，把内容切断 —— **改为不占布局空间的悬浮胶囊**，内容从它左右 21px 留白
 *     与上方继续可见。
 *
 * **关于"毛玻璃"**：
 * 背景由**调用方**经 [modifier] 注入：2026-09-22 起为**材质化玻璃**
 * （`KColors.frostedMaterial` = 半透明页底色 + 本组件自带的 1px 描边与浮起阴影）。
 * 本组件自己**不画底色** —— 调用方注入的才是唯一的底；
 * 这里再叠一层会把透明度翻倍，玻璃感直接没了。
 * （真背景模糊在本机走不通，机制见 `docs/android-glass-plan.md` §12。）
 *
 * 注：早年用 haze 毛玻璃时这里有个顺序坑（`clip(胶囊形)` 必须在模糊效果之前，否则四角露出方形玻璃角）；
 *
 * 两个必须遵守的坑（设计稿 §3.3 明确记录）：
 *  · **角标会溢出图标容器** → 容器要么留 2–3px 余量、要么不裁剪，否则角标被裁成月牙。
 *  · **选中态的图标/文字必须跟 `onAccent` 反色**，不能固定白色 —— 深色白字只有 3.6:1。
 *
 * ------------------------------------------------------------
 * M3：选中态从"每项各自变底色"改成**一个滑动的指示块**
 * ------------------------------------------------------------
 * 之前每一项目己画自己的 `accent` 底，切 tab 的表现是"旧项底色瞬间消失、新项瞬间出现"——
 * 颜色能淡入淡出，但**位置是跳变的**。现在改成：
 *  · 一个实心药丸（指示块）画在所有项**下层**，用 [KMotion.spatial] 的弹簧从旧项滑到新项；
 *  · 各项只负责文字/图标的反色（[KMotion.effects]，不滑）；
 *  · 位移用 `graphicsLayer.translationX` 而不是 `Modifier.offset`：前者只重绘、不重新布局。
 * 弹簧而不是定长 tween：用户连续点几个 tab 时，指示块会**带着当前速度**改向，
 * 而不是每次都从头播一条固定曲线（这正是 M1 把动效令牌分成 spatial/effects 的原因）。
 */
data class KNavItem(
    val key: String,
    val label: String,
    val icon: (@Composable (tint: Color, selected: Boolean) -> Unit),
    val badgeCount: Int = 0,
)

@Composable
fun KNavCapsule(
    items: List<KNavItem>,
    selectedKey: String,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = KTheme.colors
    val shape = RoundedCornerShape(percent = 50)
    val haptics = LocalHapticFeedback.current

    // 空列表直接不画：下面要按 items.size 均分宽度，除零会得到 Infinity 宽度（整条胶囊画崩）
    if (items.isEmpty()) return

    val selectedIndex = items.indexOfFirst { it.key == selectedKey }.coerceAtLeast(0)

    BoxWithConstraints(
        modifier = Modifier
            .fillMaxWidth()
            .height(KDimens.navCapsuleHeight)
            /**
             * 阴影必须画在**底与描边之前**：Compose 的 `Modifier.shadow` 把阴影画进
             * 元素自己的图层，后画的 background 正好盖在它上面 —— 顺序写反的话，
             * 阴影会盖住胶囊自己的底色（浅色主题下表现为"胶囊发灰"）。
             *
             * 颜色不用默认的黑：浅色主题下纯黑阴影在暖白页底上会发脏，
             * 这里用一点绿味的深色（与 scrim 同一色系），两套主题都能用同一个值 ——
             * 深色主题下它会被压到几乎看不见，但深色底上本来也不需要重阴影。
             */
            .shadow(
                elevation = KElevation.card,
                shape = shape,
                clip = false,
                ambientColor = KNavShadow,
                spotColor = KNavShadow,
            )
            .clip(shape)
            // 调用方的背景（纯色）画的是节点矩形，必须在 clip 之内才不会露出方角，
            // 之后的 clip 裁不到它 —— 链上反着写，胶囊四角会露出方形玻璃角（见类注释）
            .then(modifier)
            .border(1.dp, c.borderSubtle, shape)
            .padding(horizontal = KSpacing.xxs),
        contentAlignment = Alignment.Center,
    ) {
        // 每一项等宽（下面 Row 里每项 weight(1f)），所以指示块的位置可以直接算出来 ——
        // 不需要为了拿子项坐标去上 SubcomposeLayout / 自定义 Layout
        val itemWidth = maxWidth / items.size

        // 刻意不写 `by`：State 留到 graphicsLayer 里读，滑动期间只重绘、不重组
        val indicatorX = animateDpAsState(
            targetValue = itemWidth * selectedIndex,
            animationSpec = KMotion.spatial(),
            label = "navIndicator",
        )

        // ① 选中指示块（下层）
        //
        // 2026-09-22 曾按参考图改成"浅灰圆角块 + 绿色图标"，用户试用后要求回退 ——
        // 定稿仍是原来的「**实心 accent 药丸 + onAccent 反色**」。
        Box(
            modifier = Modifier
                .align(Alignment.CenterStart)
                .graphicsLayer { translationX = indicatorX.value.toPx() }
                .width(itemWidth)
                .height(KDimens.navItemHeight)
                .clip(RoundedCornerShape(percent = 50))
                .background(c.accent),
        )

        // ② 各项（上层，画在指示块之上）
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            items.forEach { item ->
                val selected = item.key == selectedKey
                KNavCapsuleItem(
                    item = item,
                    selected = selected,
                    onClick = {
                        // 触感与动效配对：切 tab 是这个 App 最频繁的"层级变动"，
                        // 一次轻微触感比再加一层动画更"实"。重复点当前 tab 不给（没有变化就别震）
                        if (!selected) {
                            haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                        }
                        onSelect(item.key)
                    },
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

/** 胶囊阴影色：与 `scrim` 同一色系（rgba(20,31,26,·)），比纯黑更贴合青瓷黛绿底 */
private val KNavShadow = Color(0x2E141F1A)

/**
 * 单项。选中态用「实心 accent 块 + onAccent 反色」（浅色墨绿块近白字 / 深色鎏金块近黑字）；
 * **未选中用 textPrimary（近黑）**——用户要求未选中的图标与标签是黑的，不是灰的（2026-09-22）。
 *
 * M3 起**底色不再由每一项自己画**（那是位置跳变的根源），改由外层的滑动指示块承担；
 * 这里只留文字/图标的配色与一点点图标放大。
 */
@Composable
private fun KNavCapsuleItem(
    item: KNavItem,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = KTheme.colors
    // 颜色走效果档（阻尼比 1.0、不过冲）：颜色"弹一下"会先冲过目标色再回来，观感是脏的
    val fg by animateColorAsState(
        // 未选中用 textPrimary（#1F2B26 近黑）：不用 textSecondary（灰）——
        // 胶囊是浅色玻璃面，近黑的可读性更好，也是用户指定的观感
        targetValue = if (selected) c.onAccent else c.textPrimary,
        animationSpec = KMotion.effects(),
        label = "navItemFg",
    )
    // 选中时图标轻微放大：指示块在滑、颜色在变，图标"跟上一点"才不显得木。
    // 幅度刻意很小（6%）—— 设计稿的选中态是"实心块 + 反色"，放大只是补一点生气，不是主角。
    val iconScale = animateFloatAsState(
        targetValue = if (selected) 1.06f else 1f,
        animationSpec = KMotion.spatial(KMotion.Preset.Fast),
        label = "navIconScale",
    )

    Box(
        modifier = modifier
            .height(KDimens.navItemHeight)
            .clip(RoundedCornerShape(percent = 50))
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                role = Role.Tab,
                onClick = onClick,
            )
            .semantics { this.selected = selected },
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            // 图标容器比图标大：SVG 描边中心线画在边界上时外半侧会溢出，
            // 24px 图标放进 24px 容器会被裁掉一圈（表现为「图标被遮住」）
            Box(
                modifier = Modifier
                    .size(
                        width = KDimens.navIconBox.first,
                        height = KDimens.navIconBox.second,
                    )
                    .graphicsLayer {
                        scaleX = iconScale.value
                        scaleY = iconScale.value
                    },
                contentAlignment = Alignment.Center,
            ) {
                item.icon(fg, selected)
                if (item.badgeCount > 0) {
                    // 角标压住图标右上角约 12px；这里不做裁剪，避免被裁成月牙
                    Box(
                        modifier = Modifier
                            .align(Alignment.TopEnd)
                            .offset(x = KDimens.badgeOverlap / 2, y = -KDimens.badgeOverlap / 2),
                    ) {
                        KBadgeCount(item.badgeCount)
                    }
                }
            }
            Text(
                text = item.label,
                style = KType.tiny,
                color = fg,
                textAlign = TextAlign.Center,
            )
        }
    }
}

/** 导航角标（与 KBadge 同规则：底色 danger、文字 onAccent） */
@Composable
private fun KBadgeCount(count: Int) {
    val c = KTheme.colors
    Box(
        modifier = Modifier
            .size(KDimens.badge)
            .clip(CircleShape)
            .background(c.danger),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = if (count > 9) "9+" else count.toString(),
            color = c.onAccent,
            style = KType.tiny,
            textAlign = TextAlign.Center,
        )
    }
}


