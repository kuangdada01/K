package top.kuangdada.k.nativeapp.ui

import android.content.Context
import android.content.SharedPreferences
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.layout
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlin.math.abs
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

/**
 * 面板高的**合理下限**：低于它一律当"没量到"。
 *
 * 2026-10-22 实测：这台机器上 `WindowInsets.ime.getBottom()` 会报出 **1px** 这种残值，
 * 而面板高度就是从它推出来的 —— 面板高被算成 1px，等于"点功能区没反应"。
 * 凡是拿键盘高当面板高之前，都必须先过这道闸。
 */
internal val MinPanelHeightDp: Dp = 160.dp

/** 面板高相对屏高的上限：再高的键盘也不该超过屏幕的七成（防脏数据把面板顶满整屏） */
private const val MAX_PANEL_RATIO = 0.72f

/** 完全量不到键盘时的估算比例（与常见中文输入法量级一致） */
private const val FALLBACK_PANEL_RATIO = 0.40f

/**
 * 键盘「停稳」判定（毫秒）：IME inset 连续这么久没再变化，才算这一次键盘的真实高度。
 *
 * 键盘升起/收起都是逐帧动画，中间会报 300、600、820、700… 这些**半截值**；
 * 拿半截值画面板会抖，写进记忆更糟 —— 收起动画最后一条合规值大约只剩 160dp，
 * 下次打开面板就矮一大截（又变成"两种高度"）。
 */
internal const val ImeSettleMs = 120L

/**
 * 「这个进程里 ADJUST_NOTHING 到底行不行」的记忆。
 *
 * 聊天页会临时把窗口切成 `ADJUST_NOTHING`，好让系统派发**完整**的 IME inset
 * （`adjustResize` 下有些机型会把 inset 吃掉，只剩 1px）。第一次聚焦输入框后仍未量到
 * 真实键盘高，就判定这台机器不支持，此后整个进程都直接用 `ADJUST_RESIZE` ——
 * 免得每次进会话都要经历一次"输入栏被键盘盖住 0.7 秒"。
 */
internal object WindowSoftInputMemory {
    @Volatile
    var nothingUnsupported: Boolean = false
}

/**
 * 最近一次量到的**键盘高度**（dp，跨页、**跨进程**共享）。
 *
 * 面板要和键盘等高才能"原地换位、输入栏不动"，但**还没弹过键盘**时没有这个数。
 * 老实现退回 `导航栏 + 240dp` 的固定值，于是「没弹过键盘 → 点功能区」和
 * 「弹过键盘 → 点功能区」是**两种高度**（用户反馈："功能区有两种高度"）。
 *
 * ## ★ 2026-10-22：从「进程内记忆」改成「落盘记忆」
 *
 * 只记在内存里等于**每次冷启动都忘光**：打开 App → 直接进消息页 → 点表情，
 * 第一次永远是"屏高 40% 估一个"（约 349dp），和真实键盘高（约 300dp）差一大截；
 * 弹过一次键盘后再点，又变成真实键盘高 —— 用户看到的还是「同一个面板两种高度」，
 * 只是从"每次点不同"变成了"每次启动不同"。
 *
 * QQ/微信的做法是**记住这台设备的键盘高**（面板永远等于键盘高），所以这里落一份
 * SharedPreferences（dp 值，与 density 无关）：只要用户在这台设备上弹过一次键盘，
 * 之后**包括重启、包括别的页面**打开面板都直接按真实键盘高画，不再有估算那一档。
 *
 * 仍然是普通变量、不是 State（组合期读它取初值，但不能订阅 —— 否则键盘动画的
 * 每一帧都会把整页拖进重组，见 ChatScreen 的注释）。
 */
internal object KeyboardHeightMemory {

    /**
     * 键盘全高（dp，含导航栏那一条）；`0f` = 这台设备上还从没量到过。
     *
     * 进程启动时由 [install] 从磁盘恢复，量到新值时由 [remember] 写回磁盘。
     */
    @Volatile
    var lastDp: Float = 0f
        private set

    private var prefs: SharedPreferences? = null

    /** 在 `Application.onCreate` 里调一次（必须早于任何页面的组合） */
    fun install(context: Context) {
        if (prefs != null) return
        val p = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs = p
        val saved = p.getFloat(KEY_HEIGHT_DP, 0f)
        // 脏数据（0 / 1px 残值 / 离谱的大值）一律不认，宁可当"没量到"重新估
        if (saved >= MinPanelHeightDp.value && saved <= MAX_PANEL_DP) lastDp = saved
    }

    /**
     * 记录一次量到的键盘高（px 版由调用方换算成 dp 传进来）。
     *
     * 只接受"像键盘"的值：小于 [MinPanelHeightDp] 的是 1px 残值，会把别处也带坏
     * （0.1.57 的现场就是每个进程都从 1px 起步 → 面板永远只有 1px）。
     */
    fun remember(dp: Float) {
        if (dp < MinPanelHeightDp.value || dp > MAX_PANEL_DP) return
        // 变化不到半 dp 不落盘：键盘每帧都在报同一个终值，没必要反复写文件
        if (abs(lastDp - dp) < 0.5f) return
        lastDp = dp
        prefs?.edit()?.putFloat(KEY_HEIGHT_DP, dp)?.apply()
    }

    private const val PREFS = "k_panel"
    private const val KEY_HEIGHT_DP = "keyboard_height_dp"

    /** dp 的绝对上限；真正生效的是 [MAX_PANEL_RATIO]（按屏高算），这条只挡脏数据 */
    private const val MAX_PANEL_DP = 620f
}

/**
 * **面板全高（px）= 键盘高**，聊天页与帖子详情页**共用这一个决策**。
 *
 * 取值顺序（任何"不像键盘"的值都跳过）：
 *  1. [candidates] 里第一个可信的实测值 —— 调用方按可信度传：
 *     ① `WindowInsets.ime` 的全高；② 窗口被压缩的差值 `maxRootHeight - rootHeight`；
 *  2. [KeyboardHeightMemory]（**落盘**的上次键盘高，跨页/跨启动复用）；
 *  3. 屏高 40% 估算（这台设备从没量到过键盘，只能估）。
 *
 * 为什么必须"取真键盘高"而不是固定比例：面板与键盘**等高**才能在
 * 「点输入框 ↔ 点表情」之间原地换位、输入栏不动（QQ/微信的做法）；
 * 比例猜的值每次切换都会矮一截或高一截，看着就是"跳 + 难看"。
 */
internal fun resolvePanelHeightPx(
    density: Density,
    screenHeightPx: Int,
    candidates: IntArray,
): Int {
    val minPx = with(density) { MinPanelHeightDp.toPx() }.roundToInt()
    val maxPx = maxOf(minPx, (screenHeightPx * MAX_PANEL_RATIO).roundToInt())
    for (c in candidates) {
        if (c in minPx..maxPx) return c
    }
    val rememberedPx = with(density) { KeyboardHeightMemory.lastDp.dp.toPx() }.roundToInt()
    if (rememberedPx in minPx..maxPx) return rememberedPx
    return (screenHeightPx * FALLBACK_PANEL_RATIO).roundToInt().coerceIn(minPx, maxPx)
}

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
