package top.kuangdada.k.nativeapp.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import top.kuangdada.k.core.designsystem.component.KBreathRing
import top.kuangdada.k.core.designsystem.component.KListSkeleton
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import top.kuangdada.k.core.designsystem.component.KButton
import top.kuangdada.k.core.designsystem.component.KButtonVariant
import top.kuangdada.k.core.designsystem.component.KLikeButton
import top.kuangdada.k.core.designsystem.component.KNavCapsule
import top.kuangdada.k.core.designsystem.component.KNavItem
import top.kuangdada.k.core.designsystem.component.KPlaceholder
import top.kuangdada.k.core.designsystem.component.KPlaceholderKind
import top.kuangdada.k.core.designsystem.component.KTextField
import top.kuangdada.k.core.designsystem.motion.MotionEnterOnce
import top.kuangdada.k.core.designsystem.theme.KDimens
import top.kuangdada.k.core.designsystem.theme.KGrid
import top.kuangdada.k.core.designsystem.theme.KMotion
import top.kuangdada.k.core.designsystem.theme.KMotionOffset
import top.kuangdada.k.core.designsystem.theme.KRadius
import top.kuangdada.k.core.designsystem.theme.KSpacing
import top.kuangdada.k.core.designsystem.theme.KTheme
import top.kuangdada.k.core.designsystem.theme.KType
import top.kuangdada.k.core.designsystem.theme.LocalAnimationsEnabled

/**
 * ============================================================
 * StyleGuide —— M0 的验收物
 * ============================================================
 * 把设计稿「组件规范区」逐项实现，用来验收**双主题令牌正确性**：
 *   · 每个色块 / 组件在切换主题时都要跟着翻转
 *   · 对比度要达到设计稿实测值（§2.1 那张表）
 *
 * 这些不是「示例代码」，是后续 13 屏直接复用的真实组件 —— 所以这里任何一处偷懒，
 * 都会在后续 13 屏里放大 13 倍。
 */
@Composable
fun StyleGuideScreen() {
    val c = KTheme.colors
    var dark by remember { mutableStateOf(false) }
    var navKey by remember { mutableStateOf("home") }
    var liked1 by remember { mutableStateOf(false) }
    var liked2 by remember { mutableStateOf(true) }
    var search by remember { mutableStateOf("") }
    var focusedInput by remember { mutableStateOf("正在输入…") }

    // 外层壳：主题开关放在最上面（切一下就能看全部组件翻转）
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(c.bgPage)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = KSpacing.md)
            .padding(top = KSpacing.xxl, bottom = KDimens.navScrollPadding + KSpacing.xxl),
        verticalArrangement = Arrangement.spacedBy(KSpacing.xl),
    ) {
        Header(dark = dark, onToggle = { dark = !dark })

        Section("一 · 色彩令牌与实测对比度") {
            ColorTokenTable()
        }

        Section("二 · 圆角 / 字号 / 间距尺度") {
            ScaleRulers()
        }

        Section("三 · 核心组件 · 按钮（主 / 按下 / 禁用 / 幽灵 / 危险）") {
            Row(
                horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                KButton("主按钮", onClick = {})
                KButton("按下", onClick = {}, pressed = true)
            }
            Spacer(Modifier.height(KSpacing.xs))
            Row(
                horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                KButton("禁用", onClick = {}, enabled = false)
                KButton("幽灵", onClick = {}, variant = KButtonVariant.Ghost)
                KButton("危险", onClick = {}, variant = KButtonVariant.Danger)
            }
        }

        Section("三 · 核心组件 · 输入 / 状态") {
            KTextField(
                value = search,
                onValueChange = { search = it },
                placeholder = "写点什么…",
                shape = RoundedCornerShape(KRadius.pill),
            )
            Spacer(Modifier.height(KSpacing.xs))
            KTextField(
                value = focusedInput,
                onValueChange = { focusedInput = it },
                placeholder = "聚焦态（2px focusRing 描边）",
                forceFocused = true,
            )
            Spacer(Modifier.height(KSpacing.sm))
            Row(
                horizontalArrangement = Arrangement.spacedBy(KSpacing.lg),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                KLikeButton(liked = liked1, count = 128, onClick = { liked1 = !liked1 })
                KLikeButton(liked = liked2, count = 256, onClick = { liked2 = !liked2 })
                Box(
                    modifier = Modifier
                        .size(KDimens.badge)
                        .clip(CircleShape)
                        .background(c.danger),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("9", color = c.onAccent, style = KType.tiny, textAlign = TextAlign.Center)
                }
            }
        }

        Section("三 · 核心组件 · 状态占位（加载 / 空 / 错）") {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
            ) {
                Box(Modifier.weight(1f)) { KPlaceholder(KPlaceholderKind.Loading) }
                Box(Modifier.weight(1f)) { KPlaceholder(KPlaceholderKind.Empty) }
                Box(Modifier.weight(1f)) { KPlaceholder(KPlaceholderKind.Error) }
            }
        }

        Section("四 · 导航胶囊（悬浮 · 5 项 · 文字标签回归）") {
            Text(
                text = "选中态 = 实心 accent 底 + onAccent 反色；角标压住图标右上角。\n" +
                    "深色下如果图标变成白色就是错的（白字只有 3.6:1）。",
                style = KType.caption,
                color = c.textMuted,
            )
            Spacer(Modifier.height(KSpacing.xs))
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(percent = 50))
                    .background(c.surface)
                    .padding(KSpacing.xs),
            ) {
                KNavCapsule(
                    items = demoNavItems(),
                    selectedKey = navKey,
                    onSelect = { navKey = it },
                )
            }
        }

        Section("五 · 原生层色彩对齐检查") {
            Text(
                text = "以下三处已从旧品牌色改为令牌色（原值见 docs/ui-optimization-plan.md §4.7）：\n" +
                    "· colorAccent #e94560（品红）→ #2F5D50\n" +
                    "· colorPrimary #1a1a2e → #2F5D50\n" +
                    "· 深色窗口底 #0f0f0f → #0D0F14（消除冷启动色闪）",
                style = KType.caption,
                color = c.textSecondary,
            )
        }

        Section("六 · 动效令牌 v2（物理档：空间 / 效果 + 降级开关）") {
            MotionTokensDemo()
        }

        Section("七 · 动效专章 M2–M6（点一遍走完整条动效栈）") {
            MotionShowcase()
        }
    }
}

/**
 * 动效专章（M7 的验收物）。
 *
 * 为什么必须在 StyleGuide 里能点：动效是**唯一不能靠编译和单测验收**的东西 ——
 * 截图只能证明"某一帧长这样"，而"被打断时连不连续""关掉系统动画后是否真的不动"
 * 只能人点一遍。这一节刻意只演示**真实组件**（点赞按钮、骨架屏、呼吸环都是线上同款），
 * 不写"示例实现" —— 抄一份的示例没有验收价值（这条在 M0 的 StyleGuide 头部就写过）。
 *
 * 页面转场 / 共享元素 / 主题溶解这三项**没法在这里演示**：它们发生在 Shell 那一层。
 * 对应的真机验收入口写在每一行的说明里。
 */
@Composable
private fun MotionShowcase() {
    val c = KTheme.colors
    val enabled = LocalAnimationsEnabled.current

    Text(
        text = "当前系统动画：" + if (enabled) "开启" else "已关闭（全部退化为直接到位）",
        style = KType.footnote,
        color = c.textMuted,
    )
    Text(
        text = "验收时请把「开发者选项 → 动画时长缩放」依次设为 1x / 0.5x / 关闭，各点一遍本节：\n" +
            "· 关闭时应当**完全没有动画**（不是「变快」），且状态依然读得出来（颜色 / 数字 / 文案）；\n" +
            "· 0.5x 时不应该出现「卡在半路」的界面。",
        style = KType.footnote,
        color = c.textMuted,
    )

    Spacer(Modifier.height(KSpacing.xs))
    Text("① 点赞：弹跳（pressSpec 过冲）+ 变色 + 心形空心→实心 + 计数滚动", style = KType.footnote, color = c.textSecondary)
    var liked by remember { mutableStateOf(false) }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(KSpacing.lg)) {
        // 计数跟着点赞走 —— 不然"数字滚动"那条根本看不到
        KLikeButton(liked = liked, count = if (liked) 129 else 128, onClick = { liked = !liked })
        Text(
            text = "点一下：四件事同时发生；再点一下全部反向（取消点赞刻意不弹跳）",
            style = KType.footnote,
            color = c.textMuted,
        )
    }

    Spacer(Modifier.height(KSpacing.sm))
    Text("② 骨架屏 + 微光（信息流 / 搜索 / 通知 / 会话的首屏用的就是它）", style = KType.footnote, color = c.textSecondary)
    KListSkeleton(items = 1)

    Spacer(Modifier.height(KSpacing.sm))
    Text("③ 呼吸环（语音房「在麦」麦位同款；关掉系统动画时连 InfiniteTransition 都不会创建）", style = KType.footnote, color = c.textSecondary)
    Box(modifier = Modifier.size(64.dp), contentAlignment = Alignment.Center) {
        KBreathRing(color = c.success, ringSize = 64.dp)
        Box(
            modifier = Modifier
                .size(44.dp)
                .clip(CircleShape)
                .background(c.success.copy(alpha = 0.25f)),
        )
    }

    Spacer(Modifier.height(KSpacing.sm))
    Text("④ 列表增删：animateItem 的让位（12 处列表同款；这里缩成 4 行演示）", style = KType.footnote, color = c.textSecondary)
    AnimateItemDemo()

    Spacer(Modifier.height(KSpacing.sm))
    Text(
        text = "⑤ 这里演示不了的三项（都发生在 Shell 层，按下面的路径验收）：\n" +
            "· 页面转场 / 预测式返回：任意一级页进二级页、侧滑返回；\n" +
            "· 共享元素：信息流点配图 → 详情页（图从卡片飞入）、点视频封面、点头像进主页、图书封面；\n" +
            "· 主题切换溶解：点本节上方那个「切到深色/浅色主题」按钮。",
        style = KType.footnote,
        color = c.textMuted,
    )
}

/** 增删让位演示：固定高度的 LazyColumn（嵌在可滚动 Column 里必须有确定高度，否则会无限测量） */
@Composable
private fun AnimateItemDemo() {
    val c = KTheme.colors
    var rows by remember { mutableStateOf((1..4).map { "第 $it 条" }) }
    Column(verticalArrangement = Arrangement.spacedBy(KSpacing.xxs)) {
        Row(horizontalArrangement = Arrangement.spacedBy(KSpacing.xs)) {
            KButton(
                text = "加一条",
                variant = KButtonVariant.Ghost,
                onClick = { rows = rows + "第 ${rows.size + 1} 条" },
            )
            KButton(
                text = "删一条",
                variant = KButtonVariant.Ghost,
                onClick = { if (rows.isNotEmpty()) rows = rows.dropLast(1) },
            )
        }
        LazyColumn(
            modifier = Modifier.fillMaxWidth().height(150.dp),
            verticalArrangement = Arrangement.spacedBy(KSpacing.xxs),
        ) {
            items(rows, key = { it }) { row ->
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .animateItem()
                        .clip(RoundedCornerShape(KRadius.chip))
                        .background(c.accentSoft)
                        .padding(KSpacing.xs),
                ) {
                    Text(row, style = KType.footnote, color = c.accent)
                }
            }
        }
    }
}

@Composable
private fun Header(dark: Boolean, onToggle: () -> Unit) {
    val c = KTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(KSpacing.xs)) {
        Text("K App 原生版 · 设计令牌验收", style = KType.title, color = c.textPrimary)
        Text(
            text = if (dark) "当前：深色 · 玄夜鎏金" else "当前：浅色 · 青瓷黛绿",
            style = KType.caption,
            color = c.textSecondary,
        )
        Text(
            text = "BuildConfig.SERVER_URL = " + top.kuangdada.k.nativeapp.BuildConfig.SERVER_URL,
            style = KType.footnote,
            color = c.textMuted,
        )
        Spacer(Modifier.height(KSpacing.xxs))
        // 主题切换：验收双主题用（最终形态应跟随系统 + 用户偏好，落 DataStore）
        KButton(
            text = if (dark) "切到浅色主题" else "切到深色主题",
            onClick = onToggle,
            variant = KButtonVariant.Ghost,
        )
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    val c = KTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(KSpacing.sm)) {
        Text(title, style = KType.subtitle, color = c.textPrimary)
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(KRadius.card))
                .background(c.surface)
                .border(1.dp, c.borderSubtle, RoundedCornerShape(KRadius.card))
                .padding(KSpacing.md),
            verticalArrangement = Arrangement.spacedBy(KSpacing.xxs),
        ) {
            content()
        }
    }
}

/** 色彩令牌表：每行左=浅色、右=深色两个色块 + 名称与实测对比度 */
@Composable
private fun ColorTokenTable() {
    val rows = listOf(
        Triple("bgPage 页面底", "#EEF2EE", "#0D0F14"),
        Triple("surface 卡片表面", "#FFFFFF", "#1E232D"),
        Triple("surfaceRaised 浮层", "#FFFFFF", "#262B36"),
        Triple("textPrimary", "#1F2B26", "#E8E6E1"),
        Triple("textSecondary", "#55645D", "#A8ABAF"),
        Triple("textMuted 弱化（2.83→4.88 / 3.91→5.97）", "#5A6D63", "#8B9098"),
        Triple("accent 强调", "#2F5D50", "#C9A962"),
        Triple("onAccent 强调底文字（关键·反相）", "#F5FAF6", "#0D0F14"),
        Triple("accentSoft 选中底", "#D1DBD6", "#2E2B21"),
        Triple("accentBorder 幽灵描边", "#A8BFB5", "#6B5C38"),
        Triple("danger（4.29→4.99）", "#A84A40", "#E0586B"),
        Triple("dangerSoft 危险底", "#E8DEDB", "#2E1A21"),
        Triple("success（4.35→5.05）", "#347252", "#7FBF8F"),
        Triple("borderSubtle 分隔线", "#DEE8DE", "#1F242E"),
        Triple("borderStrong 输入框描边", "#BAC9BA", "#454F5E"),
    )
    rows.forEach { (name, light, dark) ->
        Row(
            modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
        ) {
            Swatch(parseHex(light), KTheme.colors.isLight)
            Swatch(parseHex(dark), KTheme.colors.isLight)
            Text(
                text = name,
                style = KType.footnote,
                color = KTheme.colors.textSecondary,
                modifier = Modifier.weight(1f),
            )
        }
    }
}

@Composable
private fun Swatch(color: Color, lightTheme: Boolean) {
    // 色块本身必须带描边：浅色主题下 #FFFFFF 的块在白底上看不见
    Box(
        modifier = Modifier
            .size(28.dp)
            .clip(RoundedCornerShape(KRadius.chip))
            .background(color)
            .border(1.dp, KTheme.colors.borderSubtle, RoundedCornerShape(KRadius.chip)),
    )
}

/** 圆角 / 字号 / 间距标尺 */
@Composable
private fun ScaleRulers() {
    val c = KTheme.colors
    val radii = listOf("chip 6" to KRadius.chip, "control 10" to KRadius.control, "row 14" to KRadius.row, "card 18" to KRadius.card, "sheet 24" to KRadius.sheet)
    Row(
        horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        radii.forEach { (_, r) ->
            Box(
                modifier = Modifier
                    .size(34.dp)
                    .clip(RoundedCornerShape(r))
                    .background(c.accentSoft)
                    .border(1.dp, c.accentBorder, RoundedCornerShape(r)),
            )
        }
        Text("圆角 6 / 10 / 14 / 18 / 24", style = KType.footnote, color = c.textSecondary)
    }
    Spacer(Modifier.height(KSpacing.xs))
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text("24 标题 Title", style = KType.title, color = c.textPrimary)
        Text("17 小标题 Subtitle", style = KType.subtitle, color = c.textPrimary)
        Text("15 正文 Body —— 正文只有这一档（旧版 14/15 撞车已收敛）", style = KType.body, color = c.textPrimary)
        Text("13 辅助 Caption", style = KType.caption, color = c.textSecondary)
        Text("12 说明 Footnote", style = KType.footnote, color = c.textMuted)
        Text("11 极小 Tiny（导航标签）", style = KType.tiny, color = c.textMuted)
    }
    Spacer(Modifier.height(KSpacing.xs))
    Row(
        horizontalArrangement = Arrangement.spacedBy(2.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        listOf(4, 8, 12, 16, 20, 24, 32).forEach { v ->
            Box(
                modifier = Modifier
                    .width(v.dp)
                    .height(20.dp)
                    .clip(RoundedCornerShape(2.dp))
                    .background(c.accent),
            )
        }
    }
    Text(
        text = "间距 4 / 8 / 12 / 16 / 20 / 24 / 32    ·    动效 ${KMotion.instant}/${KMotion.quick}/${KMotion.medium}ms " +
            "· v2 物理档 spatial/effects × Fast/Default/Slow",
        style = KType.footnote,
        color = c.textSecondary,
    )
    Text(
        text = "网格：可用宽 = 390 - 16×2 = ${KGrid.available.value.toInt()}；3 列 3×114+2×8 ✓（用 GridCells.Fixed，不手算像素）",
        style = KType.footnote,
        color = c.textMuted,
    )
}

/**
 * ============================================================
 * 动效令牌演示（M1 的验收物）
 * ============================================================
 * 三档物理强度 × 两个类别（空间 / 效果），加上按下回弹与一次性入场。全部可点、双主题可对照。
 *
 * 这里同时是**写法示范**：位移/缩放这类能交给绘制期的属性一律走 `graphicsLayer`，
 * 并且把 `animate*AsState` 返回的 State **留到绘制期再读**（不写 `by`）—— 每帧只重绘、不重组。
 * 颜色做不到（它要参与组合重建 Modifier），所以 `animateColorAsState` 仍然用 `by`。
 * 页面里照抄这段写法，不要抄"`by` + `Modifier.offset()`"那种每帧重新测量的版本。
 */
@Composable
private fun MotionTokensDemo() {
    val c = KTheme.colors

    Text(
        text = "系统动画：" + if (LocalAnimationsEnabled.current) "开启" else "已关闭（降级为直接到位）",
        style = KType.footnote,
        color = c.textMuted,
    )
    Text(
        text = "空间档（spatial）动位置 / 尺寸 / 缩放，允许轻微过冲；" +
            "效果档（effects）动颜色 / 透明度，阻尼比 1.0 不过冲。\n" +
            "导航胶囊的滑动指示块用 KMotion.boundsTransform（LookaheadScope + animateBounds）。",
        style = KType.footnote,
        color = c.textMuted,
    )
    Spacer(Modifier.height(KSpacing.xs))

    var onFast by remember { mutableStateOf(false) }
    var onDefault by remember { mutableStateOf(false) }
    var onSlow by remember { mutableStateOf(false) }
    MotionTrackRow("spatial Fast", KMotion.Preset.Fast, onFast) { onFast = !onFast }
    MotionTrackRow("spatial Default", KMotion.Preset.Default, onDefault) { onDefault = !onDefault }
    MotionTrackRow("spatial Slow", KMotion.Preset.Slow, onSlow) { onSlow = !onSlow }

    Spacer(Modifier.height(KSpacing.xs))
    EffectsTrackRow()

    Spacer(Modifier.height(KSpacing.xs))
    PressSpecRow()

    Spacer(Modifier.height(KSpacing.xs))
    EnterOnceDemo()
}

/** 一行「空间档」：点一下让圆点滑到另一端，手感由 [preset] 决定 */
@Composable
private fun MotionTrackRow(
    label: String,
    preset: KMotion.Preset,
    on: Boolean,
    onToggle: () -> Unit,
) {
    val c = KTheme.colors
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
    ) {
        Text(label, style = KType.footnote, color = c.textSecondary, modifier = Modifier.width(112.dp))
        BoxWithConstraints(
            modifier = Modifier
                .weight(1f)
                .height(28.dp)
                .clip(RoundedCornerShape(KRadius.control))
                .background(c.accentSoft)
                .clickable { onToggle() },
            contentAlignment = Alignment.CenterStart,
        ) {
            // 行程按**实际可用宽**算，不写死像素 —— 360dp 窄屏上写死会直接滑出边界
            val travel = maxWidth - 22.dp - KSpacing.xxs * 2
            // 刻意不写 `by`：State 留到 graphicsLayer 里读，动画期间只重绘不重组
            val x = animateDpAsState(
                targetValue = if (on) travel else 0.dp,
                animationSpec = KMotion.spatial(preset),
                label = "motionSpatial",
            )
            Box(
                modifier = Modifier
                    .padding(start = KSpacing.xxs)
                    .size(22.dp)
                    .graphicsLayer { translationX = x.value.toPx() }
                    .clip(CircleShape)
                    .background(c.accent),
            )
        }
    }
}

/** 效果档：一个 spec 驱动颜色（颜色过冲会「脏」，所以这一档阻尼比是 1.0） */
@Composable
private fun EffectsTrackRow() {
    val c = KTheme.colors
    var on by remember { mutableStateOf(false) }
    val tint by animateColorAsState(
        targetValue = if (on) c.accent else c.textSecondary,
        animationSpec = KMotion.effects(),
        label = "motionEffects",
    )
    Row(
        modifier = Modifier.fillMaxWidth().clickable { on = !on },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
    ) {
        Text("effects", style = KType.footnote, color = c.textSecondary, modifier = Modifier.width(112.dp))
        Box(
            modifier = Modifier
                .weight(1f)
                .height(28.dp)
                .clip(RoundedCornerShape(KRadius.control))
                .background(tint)
                .border(1.dp, c.borderSubtle, RoundedCornerShape(KRadius.control)),
        )
        Text(if (on) "accent" else "textSecondary", style = KType.footnote, color = c.textMuted)
    }
}

/** 按下回弹：过冲比空间档明显（这是"手指施加了力"的反馈，不是界面移动） */
@Composable
private fun PressSpecRow() {
    val c = KTheme.colors
    var pressed by remember { mutableStateOf(false) }
    val scale = animateFloatAsState(
        targetValue = if (pressed) KMotion.pressedScale else 1f,
        animationSpec = KMotion.pressSpec,
        label = "motionPress",
    )
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
    ) {
        Text("pressSpec", style = KType.footnote, color = c.textSecondary, modifier = Modifier.width(112.dp))
        Box(
            modifier = Modifier
                .size(40.dp)
                .graphicsLayer {
                    scaleX = scale.value
                    scaleY = scale.value
                }
                .clip(CircleShape)
                .background(c.accent)
                .clickable { pressed = !pressed },
            contentAlignment = Alignment.Center,
        ) {
            Text("点", style = KType.tiny, color = c.onAccent)
        }
        Text(
            text = "点一下：${KMotion.pressedScale} ↔ 1.0（spring 0.45 / 1400）",
            style = KType.footnote,
            color = c.textMuted,
        )
    }
}

/** 一次性入场：改 key 让它重新入场（重页面用的就是这个包装） */
@Composable
private fun EnterOnceDemo() {
    val c = KTheme.colors
    var enterKey by remember { mutableIntStateOf(0) }
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
    ) {
        Text("MotionEnterOnce", style = KType.footnote, color = c.textSecondary, modifier = Modifier.width(112.dp))
        KButton("重播入场", onClick = { enterKey += 1 }, variant = KButtonVariant.Ghost)
    }
    key(enterKey) {
        MotionEnterOnce(offsetY = KMotionOffset.enterSlide) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(44.dp)
                    .clip(RoundedCornerShape(KRadius.control))
                    .background(c.accentSoft),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = "滑入 + 淡入，且刻意没有出场动画（重页面：语音房 / 视频 / 聊天 / 阅读器）",
                    style = KType.footnote,
                    color = c.accent,
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
}

/**
 * 5 项导航（设计稿定稿：首页 / 消息 / 图书 / 语音 / 主页；
 * 分享改为首页 FAB，公告与管理收进二级入口）。
 *
 * 注意这里全部用具名参数：`icon` 是最后一个参数、`badgeCount` 有默认值，
 * 用尾随 lambda 写法会被当成 `badgeCount`（Int）而编译失败。
 */
private fun demoNavItems(): List<KNavItem> = listOf(
    KNavItem(key = "home", label = "首页", icon = { tint, _ -> Glyph(tint, GlyphKind.Home) }),
    KNavItem(
        key = "messages",
        label = "消息",
        icon = { tint, _ -> Glyph(tint, GlyphKind.Chat) },
        badgeCount = 3,
    ),
    KNavItem(key = "books", label = "图书", icon = { tint, _ -> Glyph(tint, GlyphKind.Book) }),
    KNavItem(key = "voice", label = "语音", icon = { tint, _ -> Glyph(tint, GlyphKind.Voice) }),
    KNavItem(key = "profile", label = "主页", icon = { tint, _ -> Glyph(tint, GlyphKind.User) }),
)
