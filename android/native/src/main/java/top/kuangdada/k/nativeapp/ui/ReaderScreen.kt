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
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import kotlin.math.ceil
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
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
 *  · 进度条在**工具条下方**：accent 填充 + surfaceSunken 底槽，数值是**本章页数进度**。
 *
 * 翻页（2026-09-30 重做，对齐番茄小说的「覆盖」翻页，替代旧版
 * "LazyColumn 竖向滚动 + 整体横移"的假翻页 —— 那版拖动时看不到下一页）：
 *  · 正文先**按页排版**（[buildReaderPages]：用 TextMeasurer 把段落切成行、按行装页），
 *    再交给 HorizontalPager 左右滑动 —— **覆盖式（真书方向，2026-10-01 修正）**：
 *    左滑 = 当前页跟手向左滑出，露出原地不动的下一页；右滑 = 上一页从左边滑进来，
 *    盖住原地不动的当前页。动的那页永远在顶层（translationZ），滑动侧（其右缘）
 *    一道渐变阴影投在底页上 —— 只有这一侧有，不带上下；
 *    **没有上下滚动了**；
 *  · 章边界用**虚拟页**过渡：最后一页再往左滑是一页「加载中」，松手落上去即翻下一章；
 *    第一页往右滑同理落到上一章末页 —— 和番茄一样"划着划着就换了章"；
 *  · 点按页面左右 1/3 也能翻页（番茄习惯）；中间 1/3 暂不响应（工具条常驻）。
 *    手势闭包用 Unit key 常驻，回调经 rememberUpdatedState 中转 + 实时读 pager 状态，
 *    闭包捕获旧 pages/bookPage 导致点按失灵的坑别再踩。
 *
 * 两个刻意行为（都来自既定决策，别"顺手改回去"）：
 *  · **没有上一章/下一章按钮**（设计稿没有；翻章 = 页边界继续滑/点，或走 ☰ 目录）；
 *  · **主题工具切的是 App 主题**（Q5：阅读器跟随 App 主题，不引入独立阅读主题维度），
 *    ☀ 在浅/深之间一键切换 —— 读长文时最常见的诉求就是"换个底色"。
 *  · **页面上不画页码**（2026-09-30 需求：去掉了「x / y」页脚 —— 它占掉的底部高度
 *    会让每页下缘永远空一条，观感是"下半页不排字"；进度看工具条的页数进度条）。
 *
 * 章节正文是 `text/plain`（不是 HTML），按空行分段渲染 —— 服务端不做任何排版，
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
    // 字号三档（17 / 20 / 23，默认 20）：2026-09-30 需求 —— 默认 15 太小，调大；
    // AA 点一下循环换档。行高仍是字号的 2.0 倍（readingStyle）
    var fontSize by remember { mutableIntStateOf(20) }
    var showCatalog by remember { mutableStateOf(false) }
    // 重试计数：作为 LaunchedEffect 的 key 之一，点"重试"时自增即可触发重新拉取
    var reloadTick by remember { mutableIntStateOf(0) }
    /**
     * 落页目标：pages（重）算好之后要落到哪一页。所有"到达某页"的路径都先写它，
     * 由 [pages] 的到货 effect 统一消费（scrollToPage，不带动画 —— 是"到达"，不是"翻页"）：
     *  · 翻章（openChapter）→ First / Last；
     *  · 换字号、视口尺寸变化（重排前后页码会漂）→ Position(段, 字符)；
     *  · 首次进入/「继续阅读」→ 章内锚点（BookProgressAnchor）或 First。
     */
    var pendingPage by remember { mutableStateOf<PendingPage?>(null) }
    /**
     * 当前页首行的 (段, 字符) —— settle 时跟着更新（进程内，见下方 snapshotFlow）。
     * 换字号/视口变化会触发重排，重排后"第 N 页"已经是别的字了，
     * 回原位要按它（而不是页码）反查所在页。
     */
    var curPos by remember { mutableStateOf(PendingPage.Position(0, 0)) }

    val scope = rememberCoroutineScope()
    val density = LocalDensity.current
    val animationsEnabled = LocalAnimationsEnabled.current

    val chapters = detail.flatChapters
    val index = chapters.indexOfFirst { it.file == current.file }
    val chapterNo = if (index >= 0) index + 1 else 0
    val hasPrev = index > 0
    val hasNext = index in 0 until chapters.size - 1
    // 章边界虚拟页的数量：有上一章就在头部垫一页、有下一章就在尾部垫一页（见 HorizontalPager）
    val lead = if (hasPrev) 1 else 0

    LaunchedEffect(current, reloadTick) {
        loading = true
        error = null
        text = null
        when (val r = books.chapter(detail.id, current)) {
            is ApiResult.Success -> {
                // 落页目标必须在 text 赋值**之前**定好：text 一到 pages 就会重算并消费
                // pendingPage，同帧生效才不会先闪一帧第一页再跳走。显式导航（openChapter）
                // 已经写过就尊重它；否则章内锚点命中当前章就用锚点（「继续阅读」），再不行回首页。
                if (pendingPage == null) {
                    val anchor = BookProgressAnchor[detail.id]
                    pendingPage = if (anchor != null && anchor.first == index) {
                        PendingPage.Position(anchor.second, anchor.third)
                    } else {
                        PendingPage.First
                    }
                }
                text = r.data.text
            }
            is ApiResult.Failure -> error = r.error.displayMessage
        }
        loading = false
    }

    // 正文按空行分段（段间距用 spacing；行高按设计稿取字号的 2.0 倍）
    val paragraphs = remember(text) {
        text.orEmpty().replace("\r\n", "\n")
            .split(Regex("\n\\s*\n"))
            .map { it.trim() }
            .filter { it.isNotEmpty() }
    }

    // ---- 分页排版（段 → 行 → 页）----
    // 量出 pager 区域后减去页内边距/页脚区，才是"一页正文"的可用宽高；宽高没量到（首帧）
    // 或正文未到货时 pages 为空，pager 分支不渲染，自然是加载态。
    var pagerSize by remember { mutableStateOf(IntSize.Zero) }
    val textMeasurer = rememberTextMeasurer()
    // ★ 排版与渲染必须用同一份 style（下面 [ReaderPageView] 也用它）——
    //   行的切分点由此决定，两边不一致就会"排版说放得下、渲染时溢出"。
    val readingStyle = TextStyle(
        fontSize = fontSize.sp,
        lineHeight = (fontSize * 2).sp,
        fontWeight = FontWeight.Normal,
    )
    val padHpx = with(density) { KSpacing.lg.toPx() }
    val padTopPx = with(density) { KSpacing.lg.toPx() }
    // 底部呼吸：末行距工具条留一条空隙，但不留太大 —— 留大了就是"下半页永不排字"
    val padBottomPx = with(density) { KSpacing.md.toPx() }
    val paraGapPx = with(density) { KSpacing.md.toPx() }
    val lineHeightPx = with(density) { (fontSize * 2).sp.toPx() }
    // 渲染槽高与预算同行高（见 ReaderPageView 的说明）
    val lineHeightDp = with(density) { (fontSize * 2).sp.toDp() }
    val pageWpx = pagerSize.width - 2 * padHpx.toInt()
    val pageHpx = pagerSize.height - padTopPx.toInt() - padBottomPx.toInt()

    val pages = remember(text, fontSize, pageWpx, pageHpx) {
        if (text == null) {
            emptyList()
        } else {
            buildReaderPages(
                paragraphs = paragraphs,
                measurer = textMeasurer,
                style = readingStyle,
                pageWidthPx = pageWpx,
                pageHeightPx = pageHpx,
                lineHeightPx = lineHeightPx,
                paraGapPx = paraGapPx,
            )
        }
    }

    val pagerState = rememberPagerState(initialPage = lead) {
        pages.size + lead + (if (hasNext) 1 else 0)
    }

    // 当前落在真实正文里的第几页（虚拟页期间 coerce 回边界页，进度/浮钮不至于越界）
    val bookPage = if (pages.isEmpty()) 0 else (pagerState.currentPage - lead).coerceIn(0, pages.size - 1)
    val atLastPage = pages.isNotEmpty() && pagerState.currentPage >= lead + pages.size - 1

    // ---- 章内阅读锚点（精确定位续读）----
    // 记 (章节下标, 页首行所在段下标, 段内字符偏移)。保存时机刻意只有两个：
    //  · 离开阅读器（DisposableEffect.onDispose）；
    //  · 换章（[openChapter] 里先存旧章再切）。
    // 不在翻页中连续写：省写放大，也避免新章节首帧把锚点冲掉、和落页互相打架的时序。
    // 恢复条件是锚点章节 == 当前章节 —— 正是"继续阅读"回到退出位置的那条路径。
    fun saveAnchor() {
        if (index < 0 || pages.isEmpty()) return
        val pos = curPos
        // ★ 锚点的页内位置必须取 curPos（本地委托变量，每次访问都读**当下**的值）——
        //   别改回组合期捕获的 bookPage：onDispose 的闭包停在章节到货那一刻，
        //   翻再多页也只会存"第 1 页"，「继续阅读」于是永远回到章首（0.1.17 实测 bug）。
        if (pos is PendingPage.Position) {
            BookProgressAnchor[detail.id] = Triple(index, pos.para, pos.char)
            // 云端记忆（登录后）：退出/换章各写一次，last-write-wins；静默 ——
            // 同步的可见反馈只在图书列表头部（转圈→✓），阅读中不出任何提示
            books.saveCloudProgressAsync(detail.id, index, current.file, pos.para, pos.char)
        }
    }

    /**
     * 翻章统一入口：先存旧章锚点，再写落页目标 + 切章 + 通知宿主。
     * 真正"落到第一页/最后一页"由 pages 到货 effect 完成（见 pendingPage 注释）。
     */
    fun openChapter(ch: BookChapter, toBottom: Boolean = false) {
        if (ch.file == current.file) {
            // 目录里点了当前章：回本章第一页就好，别动加载状态
            scope.launch {
                if (animationsEnabled) pagerState.animateScrollToPage(lead) else pagerState.scrollToPage(lead)
            }
            return
        }
        saveAnchor()
        pendingPage = if (toBottom) PendingPage.Last else PendingPage.First
        current = ch
        onOpenChapter(ch)
    }

    /** 点按翻页：带动画（用户手势的延伸）；系统关动画就直接到位 */
    fun flipTo(target: Int) {
        scope.launch {
            if (animationsEnabled) pagerState.animateScrollToPage(target + lead) else pagerState.scrollToPage(target + lead)
        }
    }

    /**
     * 点按屏幕翻页（番茄习惯）：左 1/3 上一页，右 1/3 下一页；页边界越过去就是翻章。
     * 中间 1/3 不响应 —— 工具条常驻，没有菜单可唤出。
     *
     * ★ 页码必须**实时**从 pagerState 读（不能用手势闭包捕获的 bookPage —— 闭包只在
     *   pointerInput 重启时刷新，用户滑了几页后它还是旧值：左点永远落进"上一章"空分支、
     *   右点倒退回第 2 页 —— "点按不翻页"就是它）。
     */
    fun onTapPage(x: Float, widthPx: Int) {
        if (pages.isEmpty()) return
        val bp = (pagerState.currentPage - lead).coerceIn(0, pages.size - 1)
        when {
            x < widthPx / 3f -> {
                if (bp > 0) flipTo(bp - 1)
                else chapters.getOrNull(index - 1)?.let { openChapter(it, toBottom = true) }
            }
            x > widthPx * 2f / 3f -> {
                if (bp < pages.size - 1) flipTo(bp + 1)
                else chapters.getOrNull(index + 1)?.let { openChapter(it) }
            }
        }
    }

    // 字号三档循环（17 → 20 → 23 → 17）：设计稿工具条只有一个 AA 入口，点一下换一档。
    // 先按当前位置写落页目标（重排后页码漂了也能回到原地），再换字号。
    fun cycleFontSize() {
        if (!loading && text != null) pendingPage = curPos
        fontSize = when (fontSize) {
            17 -> 20
            20 -> 23
            else -> 17
        }
    }

    // 视口尺寸变了（旋转/分屏）：先记住当前位置，重排后回到含它的那页 ——
    // 没有它，旋转后还停在第 N 页上，但那一页已经是别的字了。
    // 声明在 pages 消费 effect **之前**：同一帧里先写 pendingPage 再被消费。
    LaunchedEffect(pageWpx, pageHpx) {
        if (loading || text == null || pages.isEmpty()) return@LaunchedEffect
        pendingPage = curPos
    }

    // pages（重）算好 → 消费落页目标。scrollToPage 不带动画：这是"到达"，不是"翻页"
    LaunchedEffect(pages) {
        if (pages.isEmpty()) return@LaunchedEffect
        val req = pendingPage ?: return@LaunchedEffect
        pendingPage = null
        val target = when (req) {
            PendingPage.First -> 0
            PendingPage.Last -> pages.lastIndex
            is PendingPage.Position ->
                // 找"页首位置在锚点之前（含）"的最后一页 = 锚点所在的那页
                pages.indexOfLast {
                    it.firstPara < req.para || (it.firstPara == req.para && it.firstChar <= req.char)
                }.coerceAtLeast(0)
        }
        pagerState.scrollToPage(target + lead)
    }

    // 边读边同步的去抖句柄：落定后 2.5s 内没有再翻页才真正上传（快速连翻只传最后一页）
    var cloudSyncJob by remember { mutableStateOf<Job?>(null) }

    // curPos 跟随每次落定（手势翻页 / 点按翻页 / scrollToPage 都会走到这里）
    LaunchedEffect(pages, lead) {
        snapshotFlow { pagerState.settledPage }.collect { settled ->
            pages.getOrNull(settled - lead)?.let {
                curPos = PendingPage.Position(it.firstPara, it.firstChar)
                cloudSyncJob?.cancel()
                cloudSyncJob = scope.launch {
                    delay(2500)
                    books.saveCloudProgressAsync(detail.id, index, current.file, it.firstPara, it.firstChar)
                }
            }
        }
    }

    // 章边界虚拟页：松手 settle 上去 = 真翻章（向前落上一章末页，向后进下一章首页）。
    // `first` 跳过 effect（重）启动时的那次"现状"采样 —— 换章瞬间 settledPage 还是
    // 旧章的页码，不能当成手势结果；等真正的手势 settle 再触发。
    LaunchedEffect(pages, lead, index) {
        var first = true
        snapshotFlow { pagerState.settledPage }.collect { settled ->
            if (first) {
                first = false
                return@collect
            }
            if (loading || text == null) return@collect
            when {
                settled < lead -> chapters.getOrNull(index - 1)?.let { openChapter(it, toBottom = true) }
                settled >= lead + pages.size -> chapters.getOrNull(index + 1)?.let { openChapter(it) }
            }
        }
    }

    // 记录阅读进度（进程内）：详情页的「已读 N% · 剩余 M 章」「继续阅读」与进度条都吃这份数据
    LaunchedEffect(detail.id, current.file) {
        if (index >= 0) BookProgress[detail.id] = index
    }

    // 离开阅读器：把退出时刻的位置存进锚点（"继续阅读"因此能回到这一页）。
    // ★ 经 rememberUpdatedState 中转：DisposableEffect(current.file) 的闭包捕获的是
    //   **章节进入组合那一刻**的 saveAnchor —— 那时 pages 还是空列表，
    //   saveAnchor 里 pages.isEmpty() 直接 return，退出时**永远存不上锚点**
    //   （0.1.17 实测「继续阅读」总回章首的根因）。中转后 onDispose 调到的
    //   是最后一次重组的保存函数，pages/bookPage 都是当下的。
    val latestSaveAnchor by rememberUpdatedState { saveAnchor() }
    DisposableEffect(current.file) {
        onDispose { latestSaveAnchor() }
    }

    /**
     * 正文到货的不透明度（M4）。以 `text` 为 key：新章节到货那刻开始淡入 ——
     * 不是"点了下一章就开始淡"，否则网络慢的时候会先白一屏。
     * 换章过渡只剩淡入（平移交给 pager 本身），不再有旧的 chapterFade 上移。
     */
    val contentFade = remember { Animatable(1f) }
    LaunchedEffect(text) {
        if (!animationsEnabled || text == null) {
            contentFade.snapTo(1f)
            return@LaunchedEffect
        }
        contentFade.snapTo(0f)
        contentFade.animateTo(1f, KMotion.effects())
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

            // 正文区：加载/错误/PDF 各有表达；正文就绪后是 **HorizontalPager 平移翻页**。
            // onSizeChanged 量出的是 pager 区域（含页内边距），分页时再减掉。
            Box(
                modifier = Modifier
                    .weight(1f)
                    .onSizeChanged { pagerSize = it },
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

                    else -> Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .graphicsLayer { alpha = contentFade.value },
                    ) {
                        // 点按翻页的回调经 rememberUpdatedState 中转：手势闭包用 Unit key
                        // 常驻（不再因 key 变化重启），每次点按都调到**最新一次重组**的
                        // onTapPage —— 直接把 onTapPage 捕进闭包会拿到旧 pages/旧页码
                        val pageTap by rememberUpdatedState { x: Float, w: Int -> onTapPage(x, w) }
                        HorizontalPager(
                            state = pagerState,
                            modifier = Modifier
                                .fillMaxSize()
                                .pointerInput(Unit) {
                                    detectTapGestures { offset ->
                                        pageTap(offset.x, size.width)
                                    }
                                },
                        ) { pageIdx ->
                            val bi = pageIdx - lead
                            // 覆盖式翻页（番茄，2026-10-01 修正方向 —— 之前动的页放反了）：
                            // 像真书一样，**跟手动的是靠左（下标更小）的那页**：
                            //  · 左滑（下一页）：当前页跟手向左滑出（dist<0，动），下一页钉在
                            //    原地（dist≥0，translationX 抵消 pager 位移）当底页露出来；
                            //  · 右滑（上一页）：上一页从左边跟手滑进来（dist<0，动），盖在
                            //    原地不动的当前页（dist≥0，底页）上。
                            // 动的那页可能是下标更小的页（天然绘制顺序在底页之下）。
                            // 这版 GraphicsLayerScope 没有 translationZ —— 改用**常量 zIndex**：
                            // 覆盖式里要盖在上面的永远是下标更小的页，zIndex = -pageIdx 即可，
                            // 常量值不随拖动重组。
                            Box(
                                modifier = Modifier
                                    .zIndex(-pageIdx.toFloat())
                                    .fillMaxSize()
                                    .graphicsLayer {
                                        val dist = pageIdx -
                                            (pagerState.currentPage + pagerState.currentPageOffsetFraction)
                                        // 页宽 = pager 视口宽(pager 铺满 onSizeChanged 量出的那个 Box);
                                        // 这版 Compose 的 PagerState.pageSize 是 internal,别用
                                        val pageWidth = pagerSize.width.toFloat()
                                        translationX = if (dist < 0f) 0f else -dist * pageWidth
                                    }
                                    // ★ 每页必须**不透明**：覆盖式翻页里页与页是叠着的，
                                    //   透明底会把底页的字透出来（两页文字叠印的 bug 根因）。
                                    //   顺序必须是 graphicsLayer **之后** —— 背景要画进图层里，
                                    //   才会跟着页一起平移；放在前面就钉在原地了
                                    .background(c.bgPage),
                            ) {
                                if (bi in pages.indices) {
                                    ReaderPageView(
                                        page = pages[bi],
                                        style = readingStyle,
                                        lineHeight = lineHeightDp,
                                        paraGap = KSpacing.md,
                                        textColor = c.textPrimary,
                                    )
                                } else {
                                    // 章边界虚拟页：划过去时它是"下一章/上一章加载中"，
                                    // 松手 settle 上去由上面的 settledPage 监听真正切章
                                    Box(
                                        Modifier.fillMaxSize(),
                                        contentAlignment = Alignment.Center,
                                    ) {
                                        CircularProgressIndicator(color = c.accent)
                                    }
                                }
                                // 滑动侧阴影：一道渐变条钉在**动的那页**右缘，投到底页上 ——
                                // 只在这一侧有，不带上下（shadowElevation 四面漏光才弃用的）。
                                // 要的是"有一点阴影的感觉"：峰值透明度压到 0.09，且贴边快速
                                // 衰减（0→0.35 内就散掉大半），不然线性渐变看着像一条断层带。
                                // alpha 在绘制期读 pager 状态：拖动每帧只重画、不重组
                                Box(
                                    modifier = Modifier
                                        .fillMaxHeight()
                                        .width(24.dp)
                                        .align(Alignment.CenterEnd)
                                        .offset(x = 24.dp)
                                        .graphicsLayer {
                                            val dist = pageIdx -
                                                (pagerState.currentPage + pagerState.currentPageOffsetFraction)
                                            alpha = (-dist * 3f).coerceIn(0f, 1f)
                                        }
                                        .background(
                                            Brush.horizontalGradient(
                                                0f to Color.Black.copy(alpha = 0.09f),
                                                0.35f to Color.Black.copy(alpha = 0.03f),
                                                1f to Color.Transparent,
                                            ),
                                        ),
                                )
                            }
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
                // 进度条在**工具条下方**（设计稿位置）：accent 填充 + surfaceSunken 底槽。
                // 数值是**本章页数进度**（旧版是可见段估算的滚动百分比，分页后按页算才真实）
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(bottom = KSpacing.xs)
                        .height(3.dp)
                        .clip(RoundedCornerShape(KRadius.pill))
                        .background(c.surfaceSunken),
                ) {
                    val pageProgress = if (pages.isEmpty()) 0f else (bookPage + 1f) / pages.size
                    Box(
                        modifier = Modifier
                            .fillMaxWidth(pageProgress)
                            .height(3.dp)
                            .clip(RoundedCornerShape(KRadius.pill))
                            .background(c.accent),
                    )
                }
            }
        }

        // 章末浮出的「下一章」：悬浮在工具条上方，跳转后落到新章第一页。
        // M4：从下方**滑入 + 淡入**（原来是一出现就在那儿），退出反向 —— 它是"读到章末才出现"的
        // 提示，滑入能明确表达"这是新冒出来的"，而不是一直在那里的固定按钮。
        AnimatedVisibility(
            visible = atLastPage && text != null && hasNext,
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

/** 一页里的一行：所属段下标 + 行首在段内的字符偏移（锚点定位用）+ 行文本 + 是否段首行 */
private data class ReaderLine(
    val paraIndex: Int,
    val charStart: Int,
    val text: String,
    val isParaStart: Boolean,
)

/** 排版好的一页。firstPara/firstChar 是页首行的位置 —— 阅读锚点记它，换字号/续读按它找页 */
private data class ReaderPage(val lines: List<ReaderLine>) {
    val firstPara: Int get() = lines.first().paraIndex
    val firstChar: Int get() = lines.first().charStart
}

/** 落页目标（见 ReaderScreen.pendingPage） */
private sealed interface PendingPage {
    /** 新章第一页 */
    data object First : PendingPage

    /** 上一章最后一页（向后翻章的落点） */
    data object Last : PendingPage

    /** 回到包含 (段下标, 段内字符偏移) 的那页 —— 换字号/视口变化/锚点恢复用 */
    data class Position(val para: Int, val char: Int) : PendingPage
}

/**
 * 分页排版：把段落列表装进固定大小的页里（番茄式平移翻页的地基）。
 *
 * 做法：每段先用 [measurer] 按 [style] 与页宽测量出真实的换行点（TextLayoutResult），
 * 按行切出来（每行记"段内字符偏移"供锚点定位），再按行高逐行装页 ——
 * 段首行前补一段段间距（页首行不补，与纸质书的段落节奏一致）。
 *
 * 取舍：
 *  · 按行而不是按段装页：段可能在页边界被切开（长段必须能跨页，否则大段会溢出）；
 *  · 预算用 ceil：Text 实际行高按 px 取整，宁可每页少算半像素也别让末行溢出被裁；
 *  · 空页上至少放一行：超大字号 + 迷你屏（一行都放不下）时优先有内容，不死循环。
 */
private fun buildReaderPages(
    paragraphs: List<String>,
    measurer: TextMeasurer,
    style: TextStyle,
    pageWidthPx: Int,
    pageHeightPx: Int,
    lineHeightPx: Float,
    paraGapPx: Float,
): List<ReaderPage> {
    if (pageWidthPx <= 0 || pageHeightPx <= 0) return emptyList()
    val lineCost = ceil(lineHeightPx)
    val gapCost = ceil(paraGapPx)

    val out = mutableListOf<ReaderPage>()
    var cur = mutableListOf<ReaderLine>()
    var used = 0f

    fun flush() {
        if (cur.isNotEmpty()) {
            out += ReaderPage(cur.toList())
            cur = mutableListOf()
            used = 0f
        }
    }

    paragraphs.forEachIndexed { p, para ->
        val layout = measurer.measure(
            para,
            style = style,
            constraints = Constraints(maxWidth = pageWidthPx),
            maxLines = Int.MAX_VALUE,
        )
        for (l in 0 until layout.lineCount) {
            val start = layout.getLineStart(l)
            // 行的终点取下一行起点（含行内的换行符，下面裁掉）—— 不依赖 getLineEnd 的
            // "可见结尾"语义，切分点与测量结果严格一致
            val end = if (l + 1 < layout.lineCount) layout.getLineStart(l + 1) else para.length
            val isParaStart = start == 0
            // 装不下就换页；段间距只在"页中段首行"收（页首行不收，跟书一样）
            val gap = if (isParaStart && cur.isNotEmpty()) gapCost else 0f
            if (cur.isNotEmpty() && used + gap + lineCost > pageHeightPx) flush()
            used += (if (isParaStart && cur.isNotEmpty()) gapCost else 0f) + lineCost
            cur += ReaderLine(p, start, para.substring(start, end).trimEnd('\n'), isParaStart)
        }
    }
    flush()

    // 空章节（正文只有空白）：给一页空白页，别让 pager 无页可显
    if (out.isEmpty()) out += ReaderPage(listOf(ReaderLine(0, 0, "", true)))
    return out
}

/**
 * 一页正文的渲染：行是 [buildReaderPages] 切好的，这里忠实摆出来 ——
 * 每行一个 Text（softWrap 关掉，行宽由排版保证；style 与排版同一份，见 readingStyle），
 * 段首行前补段间距。
 *
 * ★ 每行放进**固定高度 = 排版行高**的槽里（居中）：Text 对 style.lineHeight 的实际
 *   采纳并不总是等于排版预算（实测出现过"字号生效、行高回落到字体自然行高"，
 *   行距从 2.0× 掉到 ~1.5×），槽高强制渲染节奏 == 分页预算，页面才能排满。
 * 不画页码（2026-09-30 需求）—— 页脚占高会让每页下缘永远空一条，观感是"下半页不排字"。
 */
@Composable
private fun ReaderPageView(
    page: ReaderPage,
    style: TextStyle,
    lineHeight: Dp,
    paraGap: Dp,
    textColor: Color,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(start = KSpacing.lg, top = KSpacing.lg, end = KSpacing.lg),
    ) {
        page.lines.forEachIndexed { i, line ->
            if (i > 0 && line.isParaStart) Spacer(Modifier.height(paraGap))
            Box(
                modifier = Modifier.height(lineHeight),
                contentAlignment = Alignment.CenterStart,
            ) {
                Text(
                    text = line.text,
                    style = style,
                    color = textColor,
                    softWrap = false,
                    maxLines = 1,
                )
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
