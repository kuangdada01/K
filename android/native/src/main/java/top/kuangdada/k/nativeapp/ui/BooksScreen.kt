package top.kuangdada.k.nativeapp.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import android.os.Build
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import kotlinx.coroutines.launch
import top.kuangdada.k.core.data.ApiResult
import top.kuangdada.k.core.data.BookRepository
import top.kuangdada.k.core.data.displayMessage
import top.kuangdada.k.core.data.model.BookChapter
import top.kuangdada.k.core.data.model.BookDetail
import top.kuangdada.k.core.data.model.BookSummary
import top.kuangdada.k.core.designsystem.component.KButton
import top.kuangdada.k.core.designsystem.component.KButtonVariant
import top.kuangdada.k.core.designsystem.component.KPlaceholder
import top.kuangdada.k.core.designsystem.component.KPlaceholderKind
import top.kuangdada.k.core.designsystem.component.KTextField
import top.kuangdada.k.core.designsystem.component.KTextFieldVariant
import top.kuangdada.k.core.designsystem.theme.KDimens
import top.kuangdada.k.core.designsystem.theme.KMotion
import top.kuangdada.k.core.designsystem.theme.KRadius
import top.kuangdada.k.core.designsystem.theme.KSpacing
import top.kuangdada.k.core.designsystem.theme.KTheme
import top.kuangdada.k.core.designsystem.theme.KType
import top.kuangdada.k.core.designsystem.theme.LocalAnimationsEnabled
import com.kyant.backdrop.backdrops.layerBackdrop
import com.kyant.backdrop.backdrops.rememberLayerBackdrop
// 别名导入：库也导出了一个 `blur(radius: Float)`，直接写会冲突
import androidx.compose.ui.draw.blur as composeBlur

/**
 * 阅读进度（进程内）：bookId → 已读到 [BookDetail.flatChapters] 的下标。
 *
 * 为什么进程内就够：服务端没有阅读进度接口，而「上次读到哪」只要 App 活着就成立。
 * 与 `BookReaderEntries` / VoiceRoomCache 同一套取舍 —— 进程被回收就回到"从第一章开始"，
 * 不算丢数据（章节正文本来就在服务端）。
 * 设计稿图书详情/阅读器都画了进度条，有了它进度条才是真数据而不是装饰。
 */
internal val BookProgress = mutableMapOf<String, Int>()

/**
 * ============================================================
 * 图书列表（设计稿「图书列表」——高亮图书 tab）
 * ============================================================
 * 设计稿要点：分类 chip 选中态用实心 `--accent`；书籍网格 `layout: wrap`，
 * 卡片固定 172px 宽 + hug_contents 高；封面为图片位。
 *
 * 网格用 `GridCells.Fixed(2)` 而不是算像素 —— 设计稿 §4.6 的教训是
 * "定宽格子除不尽可用宽度时，余量会全部堆在右边"。
 */
@Composable
fun BooksScreen(
    books: BookRepository,
    onOpenDetail: (String) -> Unit,
) {
    val c = KTheme.colors
    val scope = rememberCoroutineScope()

    // 先用仓库缓存直接渲染（切走再回来不空白、不转圈），再静默刷新
    var all by remember { mutableStateOf(books.cachedList) }
    var loading by remember { mutableStateOf(all.isEmpty()) }
    var error by remember { mutableStateOf<String?>(null) }
    var categoryIndex by remember { mutableStateOf(0) }

    /**
     * 图书自己的搜索：**搜书名与作者**，就地在这一页过滤（输入即出结果）。
     *
     * 为什么不复用首页那个"搜索发现"（旧实现就是点这里 push 它）：那个搜的是**帖子** ——
     * 拿它搜书名一条也搜不到，用户要的是"找一本书"，不是"找一条帖"（用户要求）。
     *
     * 为什么不新开一个页面/接口：书目是**全量**在手（`all`，服务端 `/api/books` 一次给全），
     * 本地过滤又快又不用联网 —— 单独开一页反而多一次转圈、还多一层返回。
     */
    var searchOpen by remember { mutableStateOf(false) }
    var query by remember { mutableStateOf("") }
    val searchFocus = remember { FocusRequester() }
    val animationsEnabled = LocalAnimationsEnabled.current
    /**
     * 退出搜索必须**同时**做两件事，缺一件输入法就会"赖着不走"：
     *
     *  ① `clearFocus(force = true)`：焦点还在输入框上时，IME 是"有主"的 ——
     *     `keyboard.hide()` 只是请求它收起，下一帧系统会因为仍有焦点而把它弹回来；
     *  ② `keyboard.hide()`：兜一次，让 IME 在焦点刚清掉的那一帧就收到收起请求。
     *
     * ★ 顺序反了或只做 ① 的后果（旧代码就是**两件都没做**）：搜索框走
     *   `AnimatedVisibility` 的 `shrinkVertically`，**动画播完之前节点一直留在组合里**，
     *   输入框在被摘掉之前始终握着焦点 → 系统只能等节点真正 dispose
     *   （≈ 一整段收起动画的时间，KMotion.spatial 那档）才被动收键盘。
     *   观感就是用户报的"**取消搜索的时候输入法取消的很慢，不是立马缩回去**"。
     *
     * 所以退出搜索统一走 [closeSearch]：先清焦点收键盘，再收 UI（这两步在同一帧里发出去，
     * 输入法立刻开始下行，收起动画同时开始播，两者并行、互不等待）。
     */
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val closeSearch: () -> Unit = {
        focusManager.clearFocus(force = true)
        keyboard?.hide()
        query = ""
        searchOpen = false
    }
    /**
     * 头部里两处"就地展开/收起"（搜索框、分类 chip）**必须共用同一对进出场**。
     *
     * 因为它们在同一个点位上互相顶替（搜索时 chip 收起、退出搜索时 chip 回来），
     * 同参数才会同时开始、同时结束 —— 两段动画一旦错开，看起来就是"跳了两下"。
     */
    val collapseEnter = if (animationsEnabled) {
        expandVertically(animationSpec = KMotion.spatial()) + fadeIn(animationSpec = KMotion.effects())
    } else {
        EnterTransition.None
    }
    val collapseExit = if (animationsEnabled) {
        shrinkVertically(animationSpec = KMotion.spatial()) + fadeOut(animationSpec = KMotion.effects())
    } else {
        ExitTransition.None
    }

    suspend fun load(silent: Boolean = false) {
        if (!silent) loading = true
        error = null
        when (val r = books.list()) {
            is ApiResult.Success -> all = r.data
            is ApiResult.Failure -> error = r.error.displayMessage
        }
        loading = false
    }

    LaunchedEffect(Unit) { load(silent = all.isNotEmpty()) }
    // 展开搜索框后把焦点交给它（键盘随之弹起；`runCatching` 兜极端时序下节点未附着）
    LaunchedEffect(searchOpen) {
        if (searchOpen) runCatching { searchFocus.requestFocus() }
    }
    /**
     * 兜底：搜索**以任何方式**关闭时都确保键盘不会"挂"在屏幕上。
     *
     * 正常退出走 [closeSearch]（已经先清了焦点），这里管的是别的路径 ——
     * 退出搜索后立刻切 tab、进详情、被返回手势压栈等。那些路径下焦点可能还留在
     * 已被摘掉的节点上，系统便没人去通知 IME 收起。
     * 第二次 `clearFocus` 是无害的幂等操作（没有焦点时什么都不做）。
     */
    DisposableEffect(searchOpen) {
        onDispose { if (!searchOpen) focusManager.clearFocus(force = true) }
    }

    // 分类：服务端目前没有分类字段，所以用"全部 / 有封面 / 无封面"这类**可判定**的切分，
    // 而不是编造分类。真正的分类要等服务端提供（已记入 §11 待补）。
    val categories = listOf("全部", "有封面", "待补封面")
    val byCategory = when (categoryIndex) {
        1 -> all.filter { it.cover != null }
        2 -> all.filter { it.cover == null }
        else -> all
    }
    val keyword = query.trim()
    /**
     * 搜索词生效时**忽略分类**：搜索是"我要找那本书"，不是"在这个分类里找" ——
     * 叠加分类会让"待补封面"这种分类下搜不到明明存在的书。
     * 大小写不敏感（书名/作者都可能中英混排）。
     */
    val visible = if (keyword.isEmpty()) {
        byCategory
    } else {
        all.filter {
            it.title.contains(keyword, ignoreCase = true) || it.author.contains(keyword, ignoreCase = true)
        }
    }

    Box(modifier = Modifier.fillMaxSize().background(c.bgPage)) {
        when {
            loading && all.isEmpty() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = c.accent)
            }

            error != null && all.isEmpty() -> KPlaceholder(
                kind = KPlaceholderKind.Error,
                title = "图书列表加载失败",
                description = error,
                action = { KButton("重试", onClick = { scope.launch { load() } }) },
                modifier = Modifier.align(Alignment.Center),
            )

            all.isEmpty() -> KPlaceholder(
                kind = KPlaceholderKind.Empty,
                title = "书架还是空的",
                description = "服务端 server/books 目录下还没有图书",
                modifier = Modifier.align(Alignment.Center),
            )

            else -> LazyVerticalGrid(
                columns = GridCells.Fixed(2),
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(
                    start = KSpacing.md,
                    end = KSpacing.md,
                    // 这里**不能**有 top：页头那一项自己挂 kTopBar（见 KWidgets.kTopBar）。
                    // 原来这档 16dp 叠在页头的 statusBarsPadding 上，本页顶栏被压到状态栏下 24dp。
                    bottom = KDimens.navScrollPadding + KSpacing.lg,
                ),
                horizontalArrangement = Arrangement.spacedBy(KSpacing.sm),
                verticalArrangement = Arrangement.spacedBy(KSpacing.sm),
            ) {
                item(span = { androidx.compose.foundation.lazy.grid.GridItemSpan(2) }) {
                    Column(
                        // 顶栏垂直位置的唯一来源（状态栏安全区 + KSpacing.xs）。
                        //
                        // 间距**刻意不用 `Arrangement.spacedBy`**：它按"子项个数"算间距，
                        // 会给退出中的零高度子项也留一份 —— 病根与取舍见下面搜索框那一处。
                        modifier = Modifier.kTopBar(),
                    ) {
                        // 页头：标题 + 右上角搜索圆钮（与首页页头同款：surface 底 + 描边）
                        KPageHeader(
                            title = "图书",
                            trailing = {
                                KIconButton(
                                    icon = GlyphKind.Search,
                                    // 圆钮就是开关：再点一次收起（并清掉关键词，不留"看起来还在搜"的状态）。
                                    // 收起走 [closeSearch]：**先清焦点收键盘**再收 UI，否则输入法要等
                                    // 收起动画播完、节点被摘掉才被动收起（用户报的"取消很慢"）。
                                    onClick = {
                                        if (searchOpen) closeSearch() else searchOpen = true
                                    },
                                )
                            },
                        )
                        /**
                         * 图书搜索框：**就地展开**（不是跳到另一个页面）。
                         *
                         * 出现/消失走展开 + 淡入/收起 + 淡出 —— 它会把下面的分类与网格整体推移，
                         * 硬跳最容易被看成卡顿。进出场与分类 chip 共用（见 [collapseEnter]/[collapseExit]）。
                         *
                         * ------------------------------------------------------------
                         * 它的间距**必须写在展开容器里面**（`padding(top = KSpacing.sm)`），
                         * 不能留给外层 Column 的 `Arrangement.spacedBy` —— 否则关闭搜索会"跳两下"。
                         *
                         * 真机病根：`spacedBy` 是按**子项个数**分配间距的（每个子项后面加一份，
                         * 零高度的子项照样加，见 foundation `SpacedAligned.arrange`）。
                         * 而退场里的搜索框在动画**播完之前一直留在组合里**（这是 AnimatedVisibility
                         * 的语义，height 收到 0 才摘掉），于是那一刻的布局是
                         * 「页头 + 12 + 搜索框(0) + 12 + 分类」，两处 12 都还在。
                         * 动画一结束、节点被摘掉，**其中一份 12 会瞬间消失** ——
                         * 观感就是"收起动画走完，下面又硬生生往上蹦了一下"（用户报的"跳2次"）。
                         *
                         * 把间距放进容器里之后：展开态的高度 = 12 + 输入框高，收起时一起被
                         * 动画收成 0，摘节点那一刻高度**本来就是 0**，于是全程只有一段连续位移。
                         */
                        AnimatedVisibility(
                            visible = searchOpen,
                            enter = collapseEnter,
                            exit = collapseExit,
                        ) {
                            KTextField(
                                value = query,
                                onValueChange = { query = it },
                                placeholder = "搜索书名、作者",
                                // 间距在这一层（详见上面那段）：跟着展开容器一起收放
                                modifier = Modifier.padding(top = KSpacing.sm),
                                shape = RoundedCornerShape(KRadius.control),
                                variant = KTextFieldVariant.Inset,
                                focusRequester = searchFocus,
                                leading = {
                                    Glyph(tint = c.textMuted, kind = GlyphKind.Search, size = KDimens.navIcon)
                                },
                                trailing = {
                                    // 一键退出搜索：**先收键盘**（见 closeSearch 的注释），再清词 + 收起
                                    Box(
                                        modifier = Modifier
                                            .clip(CircleShape)
                                            .clickable(onClickLabel = "退出搜索") { closeSearch() }
                                            .padding(KSpacing.xxs),
                                    ) {
                                        Glyph(tint = c.textMuted, kind = GlyphKind.Close, size = KDimens.navIcon)
                                    }
                                },
                            )
                        }
                        // 有搜索词时**收起分类 chip**：那一刻分类不参与过滤（见 visible 的注释），
                        // 继续摆在屏幕上会让人以为"还在按分类筛"。
                        //
                        // 和搜索框一样走动画而不是 `if` 硬切：这条的显隐与搜索框的收放**由同一次点击
                        // 触发**（退出搜索 = 清词 + 收起）—— 硬切的那一份会在同一帧里把下面顶出去、
                        // 动画那一份再顶回来，合起来就是"跳2次"。同参数同时播还有一个好处：
                        // chip 长出来的高度正好抵掉搜索框收掉的高度，下面的统计与网格几乎不动。
                        //
                        // 间距同样在容器里（理由见上面搜索框那段）。
                        AnimatedVisibility(
                            visible = keyword.isEmpty(),
                            enter = collapseEnter,
                            exit = collapseExit,
                        ) {
                            Row(
                                modifier = Modifier.padding(top = KSpacing.sm),
                                horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
                            ) {
                                categories.forEachIndexed { index, label ->
                                    CategoryChip(
                                        label = label,
                                        selected = index == categoryIndex,
                                        onClick = { categoryIndex = index },
                                    )
                                }
                            }
                        }
                        // 统计（设计稿「全部图书 · 12 本」）：搜索时改成「搜索「xx」· N 本」
                        Text(
                            text = if (keyword.isEmpty()) {
                                "${if (categories[categoryIndex] == "全部") "全部图书" else categories[categoryIndex]} · ${visible.size} 本"
                            } else {
                                "搜索「$keyword」· ${visible.size} 本"
                            },
                            style = KType.footnote,
                            color = c.textMuted,
                            // 自己的间距自己带（同上，不再靠 Column 的 spacedBy）
                            modifier = Modifier.padding(top = KSpacing.sm),
                        )
                    }
                }
                // 搜索无结果时给一句话（否则屏幕只剩页头，看着像坏了）
                if (visible.isEmpty() && keyword.isNotEmpty()) {
                    item(span = { androidx.compose.foundation.lazy.grid.GridItemSpan(2) }) {
                        KPlaceholder(
                            kind = KPlaceholderKind.Empty,
                            title = "没有找到这本书",
                            description = "换个书名或作者再试试",
                            modifier = Modifier.padding(top = KSpacing.lg),
                        )
                    }
                }
                items(visible, key = { it.id }) { book ->
                    BookCard(
                        book = book,
                        coverUrl = books.coverUrl(book),
                        onClick = { onOpenDetail(book.id) },
                        // 切分类（有封面 / 待补封面）时，网格重排走弹簧而不是瞬移（M4）
                        modifier = Modifier.animateItem(),
                    )
                }
            }
        }
    }
}

/** 分类 chip：选中态用**实心 accent**（设计稿 §3.3.1 明确要求，不用 accentSoft） */
@Composable
private fun CategoryChip(label: String, selected: Boolean, onClick: () -> Unit) {
    val c = KTheme.colors
    val shape = RoundedCornerShape(KRadius.pill)
    Box(
        modifier = Modifier
            .clip(shape)
            .background(if (selected) c.accent else c.surface)
            .then(if (selected) Modifier else Modifier.border(1.dp, c.borderStrong, shape))
            .clickable(onClick = onClick)
            .padding(horizontal = KSpacing.md, vertical = KSpacing.xs),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            style = KType.caption,
            // 选中态文字必须跟 onAccent 反色：深色主题下 accent 是浅金，白字只有 3.6:1
            color = if (selected) c.onAccent else c.textSecondary,
        )
    }
}

/**
 * ============================================================
 * 图书详情（设计稿「图书详情」——**沉浸态，不显示底部导航**）
 * ============================================================
 * 设计稿要点：顶栏返回/更多按钮用「surface 底 + border 描边」的 36px 圆钮；
 * 进度条用 accent 填充、surface 底槽（本轮先不做进度，因为没有阅读进度接口）；
 * 底部 CTA 常驻不滚动。
 */
@Composable
fun BookDetailScreen(
    books: BookRepository,
    bookId: String,
    onBack: () -> Unit,
    onRead: (BookDetail, BookChapter) -> Unit,
) {
    val c = KTheme.colors
    var detail by remember { mutableStateOf<BookDetail?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    /**
     * 首帧的骨架数据：**列表页已经拉到过这一条书目**（进程内缓存，见 `BookRepository.cachedList`）。
     *
     * 为什么必须有它 —— 封面共享元素（M3）的**目标端必须在转场的第一帧就存在**。
     * 原来这里是 `loading -> 居中转圈`：封面元素根本没组合出来，共享元素匹配不上，
     * 等接口回来封面才在原地"啪"地出现，真机表现就是"**第一次点图书会闪一下封面**"；
     * 第二次之所以自然，是因为接口与图片都已经进了缓存、数据几乎在同一帧内就到了。
     *
     * 所以这里改成"**骨架与真内容同一套布局**"（同顶栏 / 同封面尺寸 / 同位置 / 同间距），
     * 封面用列表缓存先画出来 —— 数据补上时只有右边的文字在变，封面位置不变，
     * 因此也不会有"跳一下"。顺带去掉了首帧那个"整页转圈"。
     */
    val summary = remember(bookId) { books.cachedList.firstOrNull { it.id == bookId } }
    val coverUrl = detail?.let { books.coverUrl(it) } ?: summary?.let { books.coverUrl(it) }
    val title = detail?.title ?: summary?.title
    val author = detail?.author ?: summary?.author

    LaunchedEffect(bookId) {
        error = null
        when (val r = books.detail(bookId)) {
            is ApiResult.Success -> detail = r.data
            is ApiResult.Failure -> error = r.error.displayMessage
        }
    }

    Box(modifier = Modifier.fillMaxSize().background(c.bgPage)) {
        if (error != null && detail == null) {
            // 拉不到详情、也没骨架可画 → 整页错误；只是"加载中"不打断骨架（见上）
            KPlaceholder(
                kind = KPlaceholderKind.Error,
                title = "图书详情加载失败",
                description = error,
                action = { KButton("返回", onClick = onBack) },
                modifier = Modifier.align(Alignment.Center),
            )
        } else {
            val d = detail
            // 系统分享（「更多」圆钮）要从 Activity context 发起
            val appContext = LocalContext.current
            // 阅读进度（有才显示；进程内，见文件顶部 BookProgress 的说明）
            val lastIndex = d?.let { BookProgress[it.id]?.takeIf { i -> i in it.flatChapters.indices } }
            val progressFraction =
                if (d != null && lastIndex != null) {
                    (lastIndex + 1).toFloat() / d.flatChapters.size
                } else {
                    null
                }
        // 顶栏真毛玻璃：Kyant0 的 backdrop 库（Compose 版液态玻璃）。
        //  · 内容列挂 layerBackdrop（把它的绘制捕获进 backdrop）；
        //  · 顶栏挂 drawPlainBackdrop + effects { blur() }；
        //  · backdrop 的绘制块里**先铺页底色**再 drawContent()：官方教程强调，
        //    否则"源之外"的像素是透明的，玻璃上会出现空洞；
        //  · ⚠️ **不要加 vibrancy() / 任何 colorFilter**：本机实测它会打断效果链 ——
        //    表现是"捕获正常、但 blur 不生效"，玻璃退化成半透明色膜（真机截图确认）。
        //    官方文档说效果顺序是"颜色滤镜 ⇒ 模糊 ⇒ 透镜"，但在这台机器上带滤镜就不糊。
        //  · 低版本（<API 31 无 RenderEffect）退回不透明纯色，避免"半透明不模糊"。
        val canBlur = Build.VERSION.SDK_INT >= 31
        val pageBg = KTheme.colors.bgPage
        // 色膜厚度：决定"透出多少背后的颜色"。
        //  · 0.92 = 背后几乎全盖住（最稳，但颜色也看不出来）；
        //  · 0.85 = 当前值 —— 背后贡献 15%，能透出图片的色调，而**形状早就被 32dp 模糊糊没了**，
        //    所以透出来的是颜色、不是字。沸腾在重度模糊的色场上表现为缓慢的色彩漂移，不是"沸腾"。
        //  · 再往下调会更透，但残留细节会重新变得可辨、沸腾也会回来。
        val frostedTint = KTheme.colors.frosted.copy(alpha = 0.85f)
        // 玻璃源：**本页自己录**（内容列上挂 layerBackdrop）。顶栏在 shell 那层的内容里，
        // 采样 shell 那层会自引用（无限递归 → 原生崩溃），所以这里只用页面级的源；
        // 细节与理由见 rememberTopBarGlass 的注释。
        val backdrop = rememberLayerBackdrop(onDraw = rememberBackdropOnDraw(pageBg))
        // 顶栏高度：首帧先用估算值起步，实测值到达后覆盖。
        // 若从 0 起步，封面/正文会先顶到最上面、测量回来后才弹到顶栏之下 ——
        // 真机表现就是"刚进页面时顶栏高矮跳一下"（见 kTopBarHeightEstimatePx）。
        val estimatedTopBarPx = kTopBarHeightEstimatePx(bottomPadding = KSpacing.md)
        var measuredTopBarPx by remember { mutableIntStateOf(0) }
        val topBarPx = if (measuredTopBarPx > 0) measuredTopBarPx else estimatedTopBarPx
        val topInset = with(LocalDensity.current) { topBarPx.toDp() }
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    // 玻璃源：把这棵子树的绘制捕获进 backdrop（栏是它的兄弟节点、画在它之后）
                    .then(if (canBlur) Modifier.layerBackdrop(backdrop) else Modifier),
            ) {

                // 内容区可滚动
                Column(
                    modifier = Modifier
                        .weight(1f)
                        .verticalScroll(rememberScrollState())
                        .padding(top = topInset + KSpacing.sm)
                        .padding(horizontal = KSpacing.md),
                    verticalArrangement = Arrangement.spacedBy(KSpacing.lg),
                ) {
                    // 封面 + 信息列（书名 / 作者 / 已读与剩余 / 进度条）。
                    // **加载中的骨架走的也是这一行**（见文件下方 BookCoverRow 的注释）：
                    // 封面从第一帧就在最终位置上，共享元素才匹配得上。
                    BookCoverRow(
                        bookId = bookId,
                        coverUrl = coverUrl,
                        title = title,
                        author = author,
                        progressFraction = progressFraction,
                        remaining = if (d != null && lastIndex != null) {
                            d.flatChapters.size - (lastIndex + 1)
                        } else {
                            null
                        },
                    )

                    if (d == null) {
                        // 详情还在路上：转圈放在封面下面（封面已经落位，不动）
                        Box(
                            modifier = Modifier.fillMaxWidth().padding(top = KSpacing.xl),
                            contentAlignment = Alignment.Center,
                        ) {
                            CircularProgressIndicator(color = c.accent)
                        }
                        return@Column
                    }

                    // 简介（独立小节，完整展示，不再截 4 行塞在封面旁边）
                    if (d.description.isNotBlank()) {
                        Column(verticalArrangement = Arrangement.spacedBy(KSpacing.xxs)) {
                            Text("简介", style = KType.footnote, color = c.textMuted)
                            Text(d.description, style = KType.body, color = c.textSecondary)
                        }
                    }

                    // 目录（小节标题带总数；卷名仍在，作为分组头）
                    Column(verticalArrangement = Arrangement.spacedBy(KSpacing.xxs)) {
                        Text("目录 · 共 ${d.chapterCount} 章", style = KType.footnote, color = c.textMuted)
                        d.volumes.forEach { volume ->
                            Column(
                                modifier = Modifier.padding(top = KSpacing.xs),
                                verticalArrangement = Arrangement.spacedBy(KSpacing.xxs),
                            ) {
                                if (volume.name.isNotBlank()) {
                                    Text(volume.name, style = KType.bodyStrong, color = c.textPrimary)
                                }
                                volume.chapters.forEach { chapter ->
                                    Row(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .clip(RoundedCornerShape(KRadius.chip))
                                            .clickable { onRead(d, chapter) }
                                            .padding(vertical = KSpacing.sm, horizontal = KSpacing.xs),
                                        verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
                                    ) {
                                        Text(
                                            text = chapter.title.ifBlank { chapter.file },
                                            style = KType.body,
                                            color = c.textSecondary,
                                            modifier = Modifier.weight(1f),
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                        )
                                        if (chapter.isPdf) {
                                            Text("PDF", style = KType.tiny, color = c.accent)
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Spacer(Modifier.height(KSpacing.xl))
                }

                // 底部 CTA 常驻（不随目录滚动）——设计稿明确要求；有进度时直接落到上次读的位置。
                // 详情没到手时**整条不画**：这一块在内容区之外，画了会把滚动区高度改掉。
                if (d != null) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = KSpacing.md, vertical = KSpacing.sm),
                    ) {
                        val first = d.flatChapters.firstOrNull()
                        val resume = lastIndex?.let { d.flatChapters[it] }
                        val target = resume ?: first
                        KButton(
                            text = when {
                                first == null -> "暂无可读章节"
                                resume != null -> "继续阅读 · 第 ${lastIndex + 1} 章"
                                else -> "开始阅读"
                            },
                            onClick = { if (target != null) onRead(d, target) },
                            enabled = first != null,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            }

            // 顶栏浮层（毛玻璃）：返回 | 「…」。封面/正文从它底下穿过。
            val barContent: @Composable (Modifier) -> Unit = { extra ->
                Row(
                    modifier = extra
                        .fillMaxWidth()
                        // 玻璃挂在 kTopBar（状态栏避让）之前 + 按整条量高：与聊天页同款，
                        // 玻璃矩形才含状态栏那一条（顺序铁律）
                        .onSizeChanged { measuredTopBarPx = it.height }
                        .kTopBar()
                        .padding(start = KSpacing.md, end = KSpacing.md, bottom = KSpacing.md),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    KIconButton(icon = GlyphKind.ChevronLeft, onClick = onBack)
                    Spacer(Modifier.weight(1f))
                    // 详情还没到手时按钮照画（布局不跳 → 封面位置不跳），只是点了不做事
                    KIconButton(
                        icon = GlyphKind.More,
                        onClick = {
                            val book = detail ?: return@KIconButton
                            shareText(appContext, "${book.title} · ${book.author}", "分享图书")
                        },
                    )
                }
            }
            // 顶栏毛玻璃（统一写法，见 rememberTopBarGlass）。
            // 必须挂在 kTopBar（状态栏避让）的**左侧**：玻璃矩形才含状态栏那一条
            // （顺序铁律见下方 barContent 的注释）。
            barContent(
                rememberTopBarGlass(
                    canBlur = canBlur,
                    backdrop = backdrop,
                    blurRadius = KGlassBlurRadius,
                    tint = frostedTint,
                    solid = KTheme.colors.frostedSolid,
                )
            )
        }
    }
}

/**
 * 图书详情的「封面 + 信息列」（书名 / 作者 / 已读与剩余 / 进度条）。
 *
 * 抽成独立组件的理由是**功能性的，不是整理代码**：加载中的骨架与真内容必须共用它 ——
 * 只有布局逐像素一致，数据回来时封面才不会"跳一下"，共享元素也才落得准
 * （详见 [BookDetailScreen] 里 `summary` 那段注释）。
 *
 * [title] / [author] 允许为 null（首帧只有列表缓存里的书名，深链进来甚至没有）；
 * [progressFraction] / [remaining] 为 null = 还不知道阅读进度，这一行先不画。
 */
@Composable
private fun BookCoverRow(
    bookId: String,
    coverUrl: String?,
    title: String?,
    author: String?,
    progressFraction: Float?,
    remaining: Int?,
) {
    val c = KTheme.colors
    /**
     * 阅读进度条的填充比例走弹簧（M4）。
     *
     * 这里**该**动画：进度是"读完一章"跳一档的离散值，直接改会"啪"地跳一格；
     * 注意与阅读器里那根进度条的区别 —— 那根跟手指滚动 1:1，加弹簧反而会拖后腿（那边刻意不加）。
     * 关掉系统动画时 `snap()`，条子仍然是准确值。
     */
    val animatedFraction by animateFloatAsState(
        targetValue = progressFraction ?: 0f,
        animationSpec = if (LocalAnimationsEnabled.current) KMotion.spatial() else snap(),
        label = "bookReadProgress",
    )
    Row(horizontalArrangement = Arrangement.spacedBy(KSpacing.md)) {
        Box(
            modifier = Modifier
                // 共享元素（M3）：与图书列表卡片的封面共用 key
                .sharedBoundsIfAvailable(bookCoverKey(bookId))
                .width(104.dp)
                .height(140.dp)
                .clip(RoundedCornerShape(KRadius.row))
                .background(c.surfaceSunken),
            contentAlignment = Alignment.Center,
        ) {
            val cover = rememberSharedCoverRequest(coverUrl)
            if (cover != null) {
                AsyncImage(
                    // 与列表卡片同一个请求模型 —— 内存缓存键一致，飞行途中封面才有内容
                    model = cover,
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.width(104.dp).height(140.dp),
                )
            } else {
                Text(title.orEmpty().take(1), style = KType.title, color = c.accent)
            }
        }
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(KSpacing.xxs),
        ) {
            Text(title.orEmpty(), style = KType.overlayTitle, color = c.textPrimary)
            if (!author.isNullOrBlank()) {
                Text(author, style = KType.caption, color = c.textSecondary)
            }
            if (progressFraction != null && remaining != null) {
                Text(
                    "已读 ${(progressFraction * 100).toInt()}% · 剩余 $remaining 章",
                    style = KType.footnote,
                    color = c.textMuted,
                )
                // 进度条（设计稿：accent 填充 + surfaceSunken 底槽）
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = KSpacing.xxs)
                        .height(6.dp)
                        .clip(RoundedCornerShape(KRadius.pill))
                        .background(c.surfaceSunken),
                ) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth(animatedFraction)
                            .height(6.dp)
                            .clip(RoundedCornerShape(KRadius.pill))
                            .background(c.accent),
                    )
                }
            }
        }
    }
}

/**
 * 36px 圆形图标钮（surface 底 + border 描边）—— 设计稿对二级页顶栏的要求。
 * [icon] 与 [label] 二选一，优先画图标（lucide 几何，见 [Glyph]）；没有才回落到文字。
 */
@Composable
fun KIconButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    label: String? = null,
    icon: GlyphKind? = null,
) {
    val c = KTheme.colors
    Box(
        modifier = modifier
            .height(KDimens.iconButton)
            .width(KDimens.iconButton)
            .clip(RoundedCornerShape(percent = 50))
            .background(c.surface)
            .border(1.dp, c.borderStrong, RoundedCornerShape(percent = 50))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        if (icon != null) {
            Glyph(tint = c.textPrimary, kind = icon, size = KDimens.navIcon)
        } else {
            Text(label.orEmpty(), style = KType.bodyStrong, color = c.textPrimary)
        }
    }
}
































