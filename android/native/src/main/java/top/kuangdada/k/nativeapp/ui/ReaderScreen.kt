package top.kuangdada.k.nativeapp.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import top.kuangdada.k.core.data.ApiResult
import top.kuangdada.k.core.data.BookRepository
import top.kuangdada.k.core.data.ThemePreference
import top.kuangdada.k.core.data.displayMessage
import top.kuangdada.k.core.data.model.BookChapter
import top.kuangdada.k.core.data.model.BookDetail
import top.kuangdada.k.core.designsystem.component.KButton
import top.kuangdada.k.core.designsystem.component.KPlaceholder
import top.kuangdada.k.core.designsystem.component.KPlaceholderKind
import top.kuangdada.k.core.designsystem.theme.KElevation
import top.kuangdada.k.core.designsystem.theme.KMotion
import top.kuangdada.k.core.designsystem.theme.KDimens
import top.kuangdada.k.core.designsystem.theme.KRadius
import top.kuangdada.k.core.designsystem.theme.KSpacing
import top.kuangdada.k.core.designsystem.theme.KTheme
import top.kuangdada.k.core.designsystem.theme.KType
import top.kuangdada.k.core.designsystem.theme.LocalAnimationsEnabled

/**
 * ============================================================
 * 阅读器（设计稿「阅读器」——**沉浸态，不显示底部导航**）
 * ============================================================
 * 设计稿形态：
 *  · 顶栏：返回圆钮 | **居中章节名** | 目录圆钮 —— 顶栏**不带底色**，与页面同底；
 *  · 正文 15px / 行高 2.0 倍，段间留白，无首行缩进；
 *  · 工具条（同样无底色）：☰ 目录 · AA 字号 · ☀ 主题（accentSoft 圆底高亮）· N / M 章节进度；
 *  · 进度条在**工具条下方**：accent 填充 + surfaceSunken 底槽，数值是本章滚动百分比。
 *
 * 两个刻意行为（都来自既定决策，别"顺手改回去"）：
 *  · **没有上一章/下一章按钮**（设计稿没有；翻章走 ☰ 目录）；
 *  · **主题工具切的是 App 主题**（Q5：阅读器跟随 App 主题，不引入独立阅读主题维度），
 *    ☀ 在浅/深之间一键切换 —— 读长文时最常见的诉求就是"换个底色"。
 *
 * 章节正文是 `text/plain`（不是 HTML），按换行分段渲染 —— 服务端不做任何排版，
 * 所以段落节奏完全由这里决定。
 */
@Composable
fun ReaderScreen(
    books: BookRepository,
    detail: BookDetail,
    chapter: BookChapter,
    onBack: () -> Unit,
    onOpenChapter: (BookChapter) -> Unit,
    /** 当前 App 主题（供 ☀ 工具判断往哪边切） */
    themeMode: ThemePreference.Mode,
    onThemeChange: (ThemePreference.Mode) -> Unit,
) {
    val c = KTheme.colors
    var current by remember { mutableStateOf(chapter) }
    var text by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var fontSize by remember { mutableIntStateOf(15) }
    var showCatalog by remember { mutableStateOf(false) }
    // 重试计数：作为 LaunchedEffect 的 key 之一，点"重试"时自增即可触发重新拉取
    var reloadTick by remember { mutableIntStateOf(0) }

    val scroll = rememberScrollState()
    val scope = rememberCoroutineScope()

    LaunchedEffect(current, reloadTick) {
        loading = true
        error = null
        text = null
        when (val r = books.chapter(detail.id, current)) {
            is ApiResult.Success -> text = r.data.text
            is ApiResult.Failure -> error = r.error.displayMessage
        }
        loading = false
    }

    // 进度：用滚动位置估算（服务端没有"章节总字数/页数"，所以只能给百分比）
    val progress by remember {
        derivedStateOf {
            val max = scroll.maxValue
            if (max <= 0) 0f else (scroll.value.toFloat() / max).coerceIn(0f, 1f)
        }
    }

    // 滚到本章末尾 → 浮出「下一章」。
    // 设计稿工具条里没有翻章按钮，但连续阅读不能每次都开目录 ——
    // 这是「贴稿 + 不牺牲体验」的折中：平时不出现，读到章末才出现。
    val atChapterEnd by remember {
        derivedStateOf {
            scroll.maxValue > 0 && scroll.value >= scroll.maxValue - 120
        }
    }

    val chapters = detail.flatChapters
    val index = chapters.indexOfFirst { it.file == current.file }
    val chapterNo = if (index >= 0) index + 1 else 0

    // 系统关掉动画时，M4 的进出场一律直接到位
    val animationsEnabled = LocalAnimationsEnabled.current

    /**
     * 换章时正文的不透明度（M4）。
     *
     * 以 `text` 为 key：新章节的正文到货那一刻开始淡入 —— 不是"点了下一章就开始淡"，
     * 否则网络慢的时候会先白一屏。加载中/失败分支各自有自己的表达，不走这里。
     */
    val chapterFade = remember { Animatable(1f) }
    LaunchedEffect(text) {
        if (!animationsEnabled || text == null) {
            chapterFade.snapTo(1f)
            return@LaunchedEffect
        }
        chapterFade.snapTo(0f)
        chapterFade.animateTo(1f, KMotion.effects())
    }

    // 记录阅读进度（进程内）：详情页的「已读 N% · 剩余 M 章」「继续阅读」与进度条都吃这份数据
    LaunchedEffect(detail.id, current.file) {
        if (index >= 0) BookProgress[detail.id] = index
    }

    // 字号三档循环（13 / 15 / 18）：设计稿工具条只有一个 AA 入口，点一下换一档
    fun cycleFontSize() {
        fontSize = when (fontSize) {
            13 -> 15
            15 -> 18
            else -> 13
        }
    }

    Box(modifier = Modifier.fillMaxSize().background(c.bgPage)) {
        Column(modifier = Modifier.fillMaxSize()) {
            // 顶栏：返回 | 居中章节名 | 目录（无底色，与页面同底）
            // 垂直位置走全 App 同一条 kTopBar（见 KWidgets.kTopBar），这里只写左右与下边距
            // （bottom 用 md(16)：正文滚动时与顶栏之间保住一条呼吸感，同聊天页/图书详情）
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .kTopBar()
                    .padding(start = KSpacing.md, end = KSpacing.md, bottom = KSpacing.md),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                KIconButton(icon = GlyphKind.ChevronLeft, onClick = onBack)
                Text(
                    text = current.title.ifBlank { current.file },
                    style = KType.bodyStrong,
                    color = c.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.weight(1f).padding(horizontal = KSpacing.xs),
                )
                KIconButton(icon = GlyphKind.Menu, onClick = { showCatalog = !showCatalog })
            }

            // 正文
            Box(modifier = Modifier.weight(1f)) {
                when {
                    loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(color = c.accent)
                    }

                    error != null -> KPlaceholder(
                        kind = KPlaceholderKind.Error,
                        title = "章节加载失败",
                        description = error,
                        action = {
                            KButton("重试", onClick = { reloadTick += 1 })
                        },
                        modifier = Modifier.align(Alignment.Center),
                    )

                    current.isPdf -> KPlaceholder(
                        kind = KPlaceholderKind.Empty,
                        title = "PDF 章节",
                        description = "服务端以「附件」方式提供 PDF（Content-Disposition: attachment），" +
                            "原生侧需要下载后交给系统查看器或 PdfRenderer 渲染 —— 留给下一阶段。",
                        modifier = Modifier.align(Alignment.Center),
                    )

                    else -> Column(
                        modifier = Modifier
                            .fillMaxSize()
                            .verticalScroll(scroll)
                            .padding(horizontal = KSpacing.lg, vertical = KSpacing.lg)
                            /**
                             * 换章过渡（M4）：新章节正文**淡入 + 轻微上移**。
                             *
                             * 为什么不用 `Crossfade` / `AnimatedContent`：那两者会**同时组合两份内容**，
                             * 而滚动位置由同一个 [scroll] 驱动 —— 两份内容抢一个 `ScrollState`，
                             * 转场期间会互相打架（蹦一下再回位）。这里只对**唯一一份**内容做绘制期动画，
                             * 语义是"这一页自己换掉了" ✓。
                             *
                             * 方向刻意做成**纵向轻微上移**而不是横向滑入：reader 的翻章可能向前也可能
                             * 向后（章节目录里点任意一章），横向滑入必须知道方向才对，否则"往回翻也像往前翻"。
                             */
                            .graphicsLayer {
                                val p = chapterFade.value
                                alpha = p
                                translationY = (1f - p) * 16.dp.toPx()
                            },
                        verticalArrangement = Arrangement.spacedBy(KSpacing.md),
                    ) {
                        // 正文：按空行分段，段间距用 spacing；行高按设计稿取字号的 2.0 倍
                        val bodyStyle = TextStyle(
                            fontSize = fontSize.sp,
                            lineHeight = (fontSize * 2).sp,
                            fontWeight = FontWeight.Normal,
                        )
                        val paragraphs = remember(text) {
                            text.orEmpty().replace("\r\n", "\n").split(Regex("\n\\s*\n"))
                        }
                        paragraphs.forEach { para ->
                            val trimmed = para.trim()
                            if (trimmed.isNotEmpty()) {
                                Text(
                                    text = trimmed,
                                    style = bodyStyle,
                                    color = c.textPrimary,
                                )
                            }
                        }
                        Spacer(Modifier.height(KSpacing.xxl))
                    }
                }
            }

            // 工具条：☰ 目录 · AA 字号 · ☀ 主题 · N / M（无底色，与页面同底）
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .navigationBarsPadding()
                    .padding(horizontal = KSpacing.lg),
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = KSpacing.xs),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    ToolIcon(kind = GlyphKind.Menu, label = "目录") { showCatalog = !showCatalog }
                    // 字号：AA 循环三档（13 → 15 → 18）
                    Box(
                        modifier = Modifier
                            .size(KDimens.minTouchTarget)
                            .clickable(
                                interactionSource = remember { MutableInteractionSource() },
                                indication = null,
                                onClickLabel = "切换字号",
                                onClick = { cycleFontSize() },
                            ),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text("AA", style = KType.bodyStrong, color = c.textPrimary)
                    }
                    // 主题：accentSoft 圆底高亮（设计稿用它提示这是一个可用的切换工具）
                    Box(
                        modifier = Modifier
                            .size(KDimens.iconButton)
                            .clip(CircleShape)
                            .background(c.accentSoft)
                            .clickable(
                                interactionSource = remember { MutableInteractionSource() },
                                indication = null,
                                onClickLabel = "切换主题",
                                onClick = {
                                    onThemeChange(
                                        if (themeMode == ThemePreference.Mode.Dark) {
                                            ThemePreference.Mode.Light
                                        } else {
                                            ThemePreference.Mode.Dark
                                        },
                                    )
                                },
                            ),
                        contentAlignment = Alignment.Center,
                    ) {
                        Glyph(tint = c.textPrimary, kind = GlyphKind.Sun, size = KDimens.navIcon)
                    }
                    // 章节进度（设计稿形态是「12 / 38」这种 N / M）
                    Text(
                        text = if (chapterNo > 0) "$chapterNo / ${chapters.size}" else "",
                        style = KType.footnote,
                        color = c.textMuted,
                    )
                }
                // 进度条在**工具条下方**（设计稿位置）：accent 填充 + surfaceSunken 底槽
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(bottom = KSpacing.xs)
                        .height(3.dp)
                        .clip(RoundedCornerShape(KRadius.pill))
                        .background(c.surfaceSunken),
                ) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth(progress)
                            .height(3.dp)
                            .clip(RoundedCornerShape(KRadius.pill))
                            .background(c.accent),
                    )
                }
            }
        }

        // 章末浮出的「下一章」：悬浮在工具条上方，跳转后回到本章顶部。
        // M4：从下方**滑入 + 淡入**（原来是一出现就在那儿），退出反向 —— 它是"读到章末才出现"的
        // 提示，滑入能明确表达"这是新冒出来的"，而不是一直在那里的固定按钮。
        AnimatedVisibility(
            visible = atChapterEnd && index in 0 until chapters.size - 1,
            enter = if (animationsEnabled) {
                slideInVertically(animationSpec = KMotion.spatial()) { it } + fadeIn(KMotion.effects())
            } else {
                EnterTransition.None
            },
            exit = if (animationsEnabled) {
                slideOutVertically(animationSpec = KMotion.spatial()) { it } + fadeOut(KMotion.effects())
            } else {
                ExitTransition.None
            },
            modifier = Modifier.align(Alignment.BottomCenter),
        ) {
            val next = chapters.getOrNull(index + 1) ?: return@AnimatedVisibility
            Surface(
                modifier = Modifier
                    .navigationBarsPadding()
                    // 76 ≈ 工具条(44+8) + 进度条(3+4) + 呼吸，浮在工具条之上而不是压住它
                    .padding(bottom = 76.dp),
                shape = RoundedCornerShape(KRadius.pill),
                color = c.surfaceRaised,
                shadowElevation = KElevation.raised,
                onClick = {
                    current = next
                    onOpenChapter(next)
                    scope.launch { scroll.scrollTo(0) }
                },
            ) {
                Text(
                    text = "下一章 · ${next.title.ifBlank { next.file }}",
                    style = KType.bodyStrong,
                    color = c.textPrimary,
                    modifier = Modifier.padding(horizontal = KSpacing.lg, vertical = KSpacing.sm),
                )
            }
        }

        // 目录浮层
        if (showCatalog) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(c.scrim)
                    .clickable { showCatalog = false },
            ) {
                Column(
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(topStart = KRadius.sheet, topEnd = KRadius.sheet))
                        .background(c.surfaceRaised)
                        .navigationBarsPadding()
                        .padding(KSpacing.md)
                        .height(360.dp)
                        .verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(KSpacing.xxs),
                ) {
                    Text("目录", style = KType.subtitle, color = c.textPrimary)
                    chapters.forEach { ch ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(KRadius.chip))
                                .clickable {
                                    showCatalog = false
                                    current = ch
                                    onOpenChapter(ch)
                                }
                                .padding(vertical = KSpacing.xs, horizontal = KSpacing.xs),
                        ) {
                            Text(
                                text = ch.title.ifBlank { ch.file },
                                style = KType.caption,
                                color = if (ch.file == current.file) c.accent else c.textSecondary,
                            )
                        }
                    }
                }
            }
        }
    }
}

/** 工具条上的图标工具：44dp 命中区（触控下限），内容居中 */
@Composable
private fun ToolIcon(
    kind: GlyphKind,
    label: String,
    onClick: () -> Unit,
) {
    val c = KTheme.colors
    Box(
        modifier = Modifier
            .size(KDimens.minTouchTarget)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClickLabel = label,
                onClick = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Glyph(tint = c.textPrimary, kind = kind, size = KDimens.navIcon)
    }
}
