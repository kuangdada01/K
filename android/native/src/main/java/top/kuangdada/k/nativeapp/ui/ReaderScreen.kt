package top.kuangdada.k.nativeapp.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.abs
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

    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()

    // ---- 横滑翻页（跟手）----
    // 视口高度（"一页" = 一个正文区高度）；翻页 = 一次滚动一个视口
    var viewportPx by remember { mutableIntStateOf(0) }
    /** 跟手/翻页的横向位移（px），graphicsLayer 绘制期读取 —— 拖动每帧不重组 */
    val dragX = remember { mutableFloatStateOf(0f) }
    /** 翻页动画执行中：期间的新的横滑手势一律忽略（避免两套位移互相打架） */
    var flipping by remember { mutableStateOf(false) }
    /** 往回翻到上一章时，新章节到货后要滚到**末尾**（阅读连续性） */
    var pendingScrollBottom by remember { mutableStateOf(false) }
    /** 翻章后新正文到货要先回顶部：**不能立刻滚**——见 openChapter 里的时序说明 */
    var pendingScrollTop by remember { mutableStateOf(false) }

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

    // 正文按空行分段（段间距用 spacing；行高按设计稿取字号的 2.0 倍）。
    // 提到屏幕作用域：翻章回滚/锚点恢复的 LaunchedEffect 也要知道段数。
    val paragraphs = remember(text) {
        text.orEmpty().replace("\r\n", "\n")
            .split(Regex("\n\\s*\n"))
            .map { it.trim() }
            .filter { it.isNotEmpty() }
    }

    // 进度：用可见段估算（服务端没有"章节总字数/页数"，只能给百分比）
    val progress by remember {
        derivedStateOf {
            val total = listState.layoutInfo.totalItemsCount
            if (total <= 0) 0f
            else {
                val last = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
                ((last + 1).toFloat() / total).coerceIn(0f, 1f)
            }
        }
    }

    // 滚到本章末尾 → 浮出「下一章」。
    // ★ `!canScrollForward` 同时覆盖两种"到底"：真的滚到末尾，以及**本章内容不满一屏**
    //   （后者老实现用 scroll.maxValue 判断，maxValue==0 时按钮永远不出现 —— 就是
    //   "短章节不触发下一章"那个 bug 的根因）。
    val atChapterEnd by remember {
        derivedStateOf { !listState.canScrollForward }
    }

    val chapters = detail.flatChapters
    val index = chapters.indexOfFirst { it.file == current.file }
    val chapterNo = if (index >= 0) index + 1 else 0

    // ---- 章内阅读锚点（精确定位续读）----
    // 记 (章节下标, 首个可见段, 段内像素偏移)。保存时机刻意只有两个：
    //  · 离开阅读器（DisposableEffect.onDispose）；
    //  · 换章（[openChapter] 里先存旧章再切）。
    // 不在滚动中连续写：既省写放大，也避免"新章节首帧 firstVisible=0 把锚点冲掉"
    // 与恢复滚动互相打架的时序。恢复条件是锚点章节 == 当前章节 —— 正是"继续阅读"
    // 回到退出位置（而不是章节开头）的那条路径。
    fun saveAnchor() {
        if (index >= 0) {
            BookProgressAnchor[detail.id] = Triple(
                index,
                listState.firstVisibleItemIndex,
                listState.firstVisibleItemScrollOffset,
            )
        }
    }

    /**
     * 翻章统一入口：先存旧章锚点，再切章 + 通知宿主。
     *
     * ★ 时序（别"顺手优化"掉）：这里**不能立刻 scrollToItem(0)** —— 切章会触发
     * DisposableEffect(current.file) 换 key，旧 effect 的 onDispose 会再存一次锚点；
     * 若此刻滚动已被清零，存下来的就是 (旧章, 0, 0)，把真实位置冲掉。复位改由
     * 下面的到货 effect 在新正文渲染前完成（pendingScrollTop / pendingScrollBottom）。
     */
    fun openChapter(ch: BookChapter, toBottom: Boolean = false) {
        saveAnchor()
        current = ch
        onOpenChapter(ch)
        pendingScrollTop = !toBottom
        pendingScrollBottom = toBottom
    }

    // 离开阅读器：把退出时刻的位置存进锚点（"继续阅读"因此能回到这一段）
    DisposableEffect(current.file) {
        onDispose { saveAnchor() }
    }

    // 新章节正文到货后的滚动目标（优先级：回末尾 > 锚点恢复 > 回到顶部）。
    // 滚动发生在内容首帧渲染之前（effect 先于下一帧），不会看到跳位。
    LaunchedEffect(current, text) {
        if (text == null) return@LaunchedEffect
        val anchor = BookProgressAnchor[detail.id]
        when {
            pendingScrollBottom -> {
                pendingScrollBottom = false
                pendingScrollTop = false
                listState.scrollToItem(paragraphs.lastIndex.coerceAtLeast(0))
            }
            !pendingScrollTop && anchor != null && anchor.first == index && index >= 0 -> {
                listState.scrollToItem(anchor.second, anchor.third)
            }
            else -> {
                pendingScrollTop = false
                // 懒列表跨章复用（同一个 listState），旧章的可见位置必须清掉
                listState.scrollToItem(0, 0)
            }
        }
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

            // 正文。这里同时是**横滑翻页**的 gesture 宿主：
            //  · onSizeChanged 量出"一页"高度（翻页 = 滚一个视口）；
            //  · detectHorizontalDragGestures 只认横向往复，竖滑仍由 LazyColumn 自己滚动，
            //    两套手势互不抢（各自等各自方向的 touch slop）。
            // 拖动中 dragX 逐帧累加（graphicsLayer 跟手）；松手后按位移决定：
            // 翻一页 / 到章边界翻一章 / 弹回 —— 见 decideFlip。
            val pageable = !loading && error == null && text != null && !current.isPdf
            Box(
                modifier = Modifier
                    .weight(1f)
                    .onSizeChanged { viewportPx = it.height }
                    .then(
                        if (pageable) {
                            Modifier.pointerInput(current.file, fontSize) {
                                var gestureActive = false
                                detectHorizontalDragGestures(
                                    onDragStart = { if (!flipping) gestureActive = true },
                                    onHorizontalDrag = { change, amount ->
                                        if (gestureActive && !flipping) {
                                            change.consume()
                                            dragX.floatValue += amount
                                        }
                                    },
                                    onDragEnd = {
                                        if (!gestureActive || flipping) return@detectHorizontalDragGestures
                                        gestureActive = false
                                        val startX = dragX.floatValue
                                        val w = viewportPx.toFloat()
                                        if (w <= 0f || abs(startX) < 1f) {
                                            dragX.floatValue = 0f
                                            return@detectHorizontalDragGestures
                                        }
                                        val forward = startX < 0
                                        val far = abs(startX) > w * 0.25f
                                        flipping = true
                                        scope.launch {
                                            try {
                                                suspend fun slide(from: Float, to: Float, ms: Int) = animate(
                                                    from, to,
                                                    animationSpec = tween(ms),
                                                ) { v, _ -> dragX.floatValue = v }
                                                when {
                                                    // 位移不够一页：弹回
                                                    !far -> slide(startX, 0f, 180)
                                                    forward && listState.canScrollForward -> {
                                                        slide(startX, -w, 200)      // 本页滑出左侧
                                                        listState.scroll { scrollBy(w) } // 滚到下一页
                                                        dragX.floatValue = w        // 新页从右侧进
                                                        slide(w, 0f, 200)
                                                    }
                                                    !forward && listState.canScrollBackward -> {
                                                        slide(startX, w, 200)       // 本页滑出右侧
                                                        listState.scroll { scrollBy(-w) } // 滚到上一页
                                                        dragX.floatValue = -w       // 新页从左侧进
                                                        slide(-w, 0f, 200)
                                                    }
                                                    // 章边界：横滑越过去就是翻章（向后翻落到上一章末尾）
                                                    forward -> {
                                                        val next = chapters.getOrNull(index + 1)
                                                        if (next != null) {
                                                            slide(startX, -w, 200)
                                                            openChapter(next)
                                                        }
                                                        dragX.floatValue = 0f
                                                    }
                                                    else -> {
                                                        val prev = chapters.getOrNull(index - 1)
                                                        if (prev != null) {
                                                            slide(startX, w, 200)
                                                            openChapter(prev, toBottom = true)
                                                        }
                                                        dragX.floatValue = 0f
                                                    }
                                                }
                                            } finally {
                                                flipping = false
                                            }
                                        }
                                    },
                                    onDragCancel = {
                                        gestureActive = false
                                        scope.launch {
                                            animate(dragX.floatValue, 0f, animationSpec = tween(180)) { v, _ ->
                                                dragX.floatValue = v
                                            }
                                        }
                                    },
                                )
                            }
                        } else {
                            Modifier
                        },
                ),
            ) {
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

                    else -> LazyColumn(
                        state = listState,
                        // 底部多让一档 xxl：老实现的尾部 Spacer（章末与屏幕底缘的呼吸感）
                        contentPadding = PaddingValues(
                            start = KSpacing.lg,
                            top = KSpacing.lg,
                            end = KSpacing.lg,
                            bottom = KSpacing.lg + KSpacing.xxl,
                        ),
                        modifier = Modifier
                            .fillMaxSize()
                            /**
                             * 换章过渡（M4）+ 横滑翻页位移（2026-09-29）共用一个 graphicsLayer：
                             *  · chapterFade：新章节正文**淡入 + 轻微上移**（原实现保留——
                             *    不用 Crossfade/AnimatedContent 是因为两份内容会抢同一份滚动）；
                             *  · translationX：横滑跟手与翻页动画的位移，绘制期读 [dragX]，
                             *    拖动/动画期间每帧只重画不重组。
                             */
                            .graphicsLayer {
                                val p = chapterFade.value
                                alpha = p
                                translationY = (1f - p) * 16.dp.toPx()
                                translationX = dragX.floatValue
                            },
                        verticalArrangement = Arrangement.spacedBy(KSpacing.md),
                    ) {
                        // 正文：段落即 item。key 用段下标（同章内稳定），锚点恢复/走秒都按它定位
                        itemsIndexed(paragraphs) { _, para ->
                            Text(
                                text = para,
                                style = TextStyle(
                                    fontSize = fontSize.sp,
                                    lineHeight = (fontSize * 2).sp,
                                    fontWeight = FontWeight.Normal,
                                ),
                                color = c.textPrimary,
                            )
                        }
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
            visible = atChapterEnd && text != null && index in 0 until chapters.size - 1,
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
                    openChapter(next)
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
                                    openChapter(ch)
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
