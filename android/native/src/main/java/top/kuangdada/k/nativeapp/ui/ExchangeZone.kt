package top.kuangdada.k.nativeapp.ui

import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.layout
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import kotlin.math.roundToInt

/**
 * ============================================================
 * 键盘/表情「交换区」高度的**布局期**计算（聊天页 + 帖子详情页共用）
 * ============================================================
 * 高度口径与两页的老实现逐字一致：max(IME 高, 导航栏高, 面板全高 × 展开比例)。
 *
 * ★ 为什么值必须在 layout 阶段读：IME 弹起/收起与面板展开/收起都是逐帧动画
 * （120Hz 下一次约 36 帧），这些输入**每帧都变**。老实现在屏幕根作用域的组合期读
 * `WindowInsets.ime.getBottom()` / `panelFraction.value`，每一帧都让整页 body
 * （含 LazyColumn 与全部 item DSL）重组一遍 —— 弹/收键盘、开关表情面板就是一次
 * 全屏重组风暴，长评论/多图页面最伤。改成 layout 期读取后，每帧只重走这一个
 * modifier 的 measure/layout，**不进 composition**。
 *
 * 调用方约定（两个调用点一致）：
 *  1. 组合期只**捕获** insets 对象 —— `WindowInsets.ime` 是 @Composable getter，
 *     必须在组合里调（顺便注册监听），但捕获本身不订阅高度变化；
 *  2. 真正的读值发生在下面两个 modifier 的 layout 块里：insets 与 [panelFractionValue]
 *     的快照写入只会**重布局**这一个节点。展开比例传 **lambda**（`{ panelFraction.value }`）
 *     而不是 Animatable 本体 —— 动画库的 `Animatable` 不实现 `State`，lambda 读值
 *     发生在 layout 块里，快照语义相同；
 *  3. [panelHeightPx]（面板全高，只随"键盘出现新全高"而变，低频）照常组合期传入；
 *  4. [density] 从组合期捕获传入，字体缩放/折叠屏变化时组合会重跑、modifier 随之重建。
 *
 * 两条与老实现的对位关系：
 *  · [exchangeZoneHeight] ≙ `.height(exchangeZoneDp)`：把子内容钉到交换区高
 *    （面板按比例长出时靠外层 clipToBounds 裁掉超出部分，与老实现一致）；
 *  · [exchangeZoneBottomInset] ≙ `.padding(bottom = exchangeZoneDp + [extra])`：
 *    内容照常测量，但整体占位多出底部让位高度 —— toast 跟着键盘/面板"躲让"用。
 */

/** 交换区高度（px）：max(IME 高, 导航栏高, 面板全高 × 展开比例) */
private fun exchangeZoneHeightPx(
    density: Density,
    ime: WindowInsets,
    nav: WindowInsets,
    panelHeightPx: Int,
    panelFractionValue: () -> Float,
): Int = maxOf(
    ime.getBottom(density),
    nav.getBottom(density),
    (panelHeightPx * panelFractionValue()).roundToInt(),
)

/** 交换区 Box 的高度（`.height(exchangeZoneDp)` 的布局期等价） */
internal fun Modifier.exchangeZoneHeight(
    density: Density,
    ime: WindowInsets,
    nav: WindowInsets,
    panelHeightPx: Int,
    panelFractionValue: () -> Float,
): Modifier = layout { measurable, constraints ->
    val h = exchangeZoneHeightPx(density, ime, nav, panelHeightPx, panelFractionValue).coerceAtLeast(0)
    val placeable = measurable.measure(
        constraints.copy(minHeight = h, maxHeight = h),
    )
    layout(placeable.width, h) { placeable.place(0, 0) }
}

/** 「整体底部多出让位高度」（`.padding(bottom = exchangeZoneDp + [extra])` 的布局期等价） */
internal fun Modifier.exchangeZoneBottomInset(
    density: Density,
    ime: WindowInsets,
    nav: WindowInsets,
    panelHeightPx: Int,
    panelFractionValue: () -> Float,
    extra: Dp,
): Modifier = layout { measurable, constraints ->
    val h = exchangeZoneHeightPx(density, ime, nav, panelHeightPx, panelFractionValue)
        .coerceAtLeast(0) + with(density) { extra.toPx() }.roundToInt()
    val placeable = measurable.measure(
        constraints.copy(maxHeight = (constraints.maxHeight - h).coerceAtLeast(0)),
    )
    // 报告的高度 = 内容 + 底部让位：父级按底边对齐摆这个块时，
    // 内容正好悬在"交换区 + extra"之上（与 padding 的视觉一致）
    layout(placeable.width, placeable.height + h) { placeable.place(0, 0) }
}
