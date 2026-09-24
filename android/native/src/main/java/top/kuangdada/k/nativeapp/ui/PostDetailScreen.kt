package top.kuangdada.k.nativeapp.ui

import androidx.compose.animation.SharedTransitionScope
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import android.os.Build
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.fadeOut
import top.kuangdada.k.core.designsystem.theme.LocalAnimationsEnabled
import androidx.compose.animation.core.Animatable
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.isSpecified
import androidx.compose.ui.zIndex
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import android.content.ClipData
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import top.kuangdada.k.core.data.ApiResult
import top.kuangdada.k.core.data.CommentRepository
import top.kuangdada.k.core.data.PostRepository
import top.kuangdada.k.core.data.PostUi
import top.kuangdada.k.core.data.RealtimeClient
import top.kuangdada.k.core.data.SessionRepository
import top.kuangdada.k.core.data.displayMessage
import top.kuangdada.k.core.data.isNotFound
import top.kuangdada.k.core.designsystem.component.KButton
import top.kuangdada.k.core.designsystem.component.KButtonVariant
import top.kuangdada.k.core.designsystem.component.KPlaceholder
import top.kuangdada.k.core.designsystem.component.KPlaceholderKind
import top.kuangdada.k.core.designsystem.component.KTextField
import top.kuangdada.k.core.designsystem.component.KTextFieldVariant
import top.kuangdada.k.core.designsystem.theme.KElevation
import top.kuangdada.k.core.designsystem.theme.KDimens
import top.kuangdada.k.core.designsystem.theme.KMotion
import top.kuangdada.k.core.designsystem.theme.KRadius
import top.kuangdada.k.core.designsystem.theme.KSpacing
import top.kuangdada.k.core.designsystem.theme.KTheme
import com.kyant.backdrop.backdrops.layerBackdrop
import com.kyant.backdrop.backdrops.rememberLayerBackdrop
import top.kuangdada.k.core.designsystem.theme.KType
import top.kuangdada.k.nativeapp.ui.viewer.rememberImageViewerSimple

/**
 * ============================================================
 * 帖子详情（首页帖子的二级页）
 * ============================================================
 * 设计稿：「帖子」顶栏（返回 / 标题 / …）→ 作者行 → 正文 → 配图（两列方块）→ 互动栏
 * → 分隔线 → 「评论 · N」→ 评论列表 → 底部输入条。
 *
 * 几个刻意的选择：
 *  · **帖子对象优先取列表缓存**（`posts.cached`），首帧就画得出内容；缓存没有
 *    （深链进来 / 进程回收）才拉 `GET /api/posts/:id`。评论一律单独拉
 *    （详情接口内嵌的那份没有点赞状态，且没有分页参数时走的是"完整树"老契约）。
 *  · 评论**只做一层树**（顶级 + 其回复，回复缩进显示）。服务端返回的是扁平数组，
 *    再深的层级会被压到顶层祖先下 —— 压缩比丢评论好。
 *  · 发评论后既刷新评论列表，也回调 `onCommentCountChanged` 让列表卡片上的评论数跟上。
 */
@Composable
fun PostDetailScreen(
    postId: Long,
    posts: PostRepository,
    comments: CommentRepository,
    session: SessionRepository,
    myUserId: Long,
    /** SSE 事件流：有人评论这条帖子时，评论列表与计数**自己刷新** */
    realtime: RealtimeClient? = null,
    onBack: () -> Unit,
    onRequireLogin: () -> Unit,
    onEdit: (PostUi) -> Unit,
    onCommentCountChanged: (delta: Int) -> Unit,
    /**
     * 正文里的视频要点全屏 → 打开沉浸播放器（AppShell 推 `VideoDest`）。
     *
     * 视频地址由 Shell 从仓库缓存里取（导航状态只带 postId，见 `VideoDest` 的注释）。
     */
    onOpenVideo: () -> Unit = {},
    /**
     * 这条帖子**已经不存在了**（详情接口 404）。
     *
     * 为什么会走到这里：删帖后返回栈里可能还压着一个指向该帖的详情页 ——
     * 例如"详情页 →「…」→ 编辑 → 删除"，删完 pop 回来的正是那个详情页。
     * 那种情况下**不该把用户留在一个死页面**上（之前显示的是「帖子加载失败 HTTP 404」），
     * 而是交回调用方退到主页。
     *
     * 传 postId 而不是无参：调用方可以用它顺手清掉进程内缓存/列表里的这一条。
     * 默认值退回 [onBack]（只退一层）—— 那是"这条帖子本来就不该打开"时的合理兜底。
     */
    onPostGone: (postId: Long) -> Unit = { onBack() },
    /** 点正文里的 #话题 → 搜该话题的相关帖子（由 AppShell 打开搜索页） */
    onTagClick: ((String) -> Unit)? = null,
    /**
     * 点作者行（头像 / 昵称）→ 进这个人的主页（由 AppShell 推他人主页 / 切自己的主页 tab）。
     *
     * 为什么详情页必须有这个入口：这是唯一"看着一条帖子、想看看作者是谁"的地方，
     * 而卡片上点头像进详情之后就没有别的路径了（用户实测反馈：详情页点作者没反应）。
     */
    onOpenUser: ((userId: Long) -> Unit)? = null,
) {
    val c = KTheme.colors
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()
    val keyboard = LocalSoftwareKeyboardController.current
    /**
     * 焦点管理器：打开图片查看器前**必须清掉输入框焦点**（见 [openViewerFromContent]）。
     */
    val focusManager = LocalFocusManager.current
    /**
     * 评论输入框的焦点句柄：点「回复」时把焦点交给它 —— 输入法随即弹起，
     * 用户可以直接打字（见下面 `onReply`）。
     */
    val inputFocusRequester = remember { androidx.compose.ui.focus.FocusRequester() }
    /**
     * 顶栏底边（窗口像素）。
     *
     * 给**进出全屏的那一段飞行**避让用（见 [ImageViewerRequest.topInsetPx]）：飞行那一张
     * 画在查看器覆盖层里、而覆盖层永远压在页面之上 —— 不避让的话，进场时图片会直接
     * "长"到顶栏上、退出时它会**盖住顶栏**再跳回后面（用户实测反馈的就是这个）。
     *
     * 用 ref 而不是值：顶栏高度是测量出来的（组合之后），而 [openViewer] 的 lambda
     * 要读"点下去那一刻"的真实高度。
     */
    val topBarBottomPx = remember { mutableFloatStateOf(0f) }
    /**
     * 配图/视频封面这条飞行的**顶栏裁剪**（见 [topBarOverlayClip] 的长注释）。
     *
     * 为什么需要它（用户实测反馈）：**从首页点配图进详情页后立刻快速上滑**，配图会整条
     * 压住顶栏、滚停才"重新显示"。飞行那一份画在覆盖层里，而覆盖层永远在页面（含顶栏）之上。
     *
     * 用 `remember` 固定实例：`SharedElementEntry.overlayClip` 是可变状态，每次重组换个实例
     * 都会让库更新一遍（与 `rememberTopBarGlass` / 胶囊玻璃同一个坑）。
     * 读的是 ref（`topBarBottomPx`）而不是值：裁剪发生在绘制期，要拿"那一刻"的真实高度。
     */
    val imageFlightClip = remember { topBarOverlayClip { topBarBottomPx.floatValue } }
    // 原生图片查看器（点配图 → 全屏可缩放/翻页），与首页同一套
    val openViewer = rememberImageViewerSimple(topInsetPx = { topBarBottomPx.floatValue })

    /**
     * 点配图 → **先收起键盘** → 再打开全屏查看器。
     *
     * 为什么不能省（用户实测反馈："点输入框、再点图片，输入框不缩回去"）：
     * 查看器是 Shell 上的**覆盖层**，它不改变焦点 —— 输入框还握着焦点，
     * 系统 IME 就会一直顶在上面，把全屏看图压成半截。
     *
     * 而且 `keyboard?.hide()` **不够**：它只是请求 IME 收起，输入框仍聚焦，
     * 下一帧 IME 会自己弹回来。所以要先 `clearFocus(force = true)`，
     * 再 call `hide()` 兜一次（焦点清掉后 IME 才真的会走）。
     *
     * 这也是详情页里"点别处收键盘"那条规则的一部分（LazyColumn 上那个
     * `detectTapGestures { keyboard?.hide() }` 只管空白处，配图是可点元素、自己消费事件）。
     */
    val openViewerFromContent: (List<String>, Int, Long?) -> Unit = { images, index, pid ->
        focusManager.clearFocus(force = true)
        keyboard?.hide()
        openViewer(images, index, pid)
    }

    /**
     * 帖子状态 —— **订阅仓库的单帖状态流，而不是自己存一份快照**。
     *
     * ★ 这是「详情页与首页共用同一份、联动」的落点（用户实测反馈：
     * 「五个元素只在首页生效在详情页不生效啊，2 套动效？用首页的就行了，一套共用联动的」）。
     *
     * 改之前是 `var post by remember(postId) { mutableStateOf(posts.cached(postId)) }` ——
     * 一份**只属于这一页**的快照，完全在仓库的 `lists` 之外。于是：
     *  · `posts.toggleLike/toggleBookmark/toggleRepost` 走 `applyToAll`，只改 `lists` 里的副本；
     *  · 详情页读自己的 `post` → **纹丝不动**，连 `KLikeButton` 的弹跳都触发不了
     *    （它的 `liked` 参数压根没变）；
     *  · 唯一能更新它的路径是 `refreshDetail`（从服务端拉）→ 所以只有"别人评论"这种
     *    服务端事件才让详情页变，**自己点的赞/收藏/转发永远不生效**；
     *  · 更糟的是单向联动：`refreshDetail` 会写回列表，所以**详情页能影响首页、首页影响不了详情页**。
     *
     * 现在两页读同一个 `StateFlow`，`applyToAll` 一改两边同时变 —— 真正一套。
     */
    val postFlow = remember(postId) { posts.detailFlow(postId) }

    /**
     * 首帧种子：把列表缓存里那条**塞进单帖状态流**，让详情页进来就有内容。
     *
     * 为什么需要（而不是干等 `refreshDetail`）：深链/冷启动进来时流还是 null，
     * 页面会先显示"帖子加载失败"再跳成真内容。仓库的 `seedDetail` 只在**当前为空**时写，
     * 不会覆盖已经在流里的更新鲜的状态。
     */
    LaunchedEffect(postId) {
        posts.cached(postId)?.let { posts.seedDetail(postId, it) }
    }

    val post by postFlow.collectAsState()
    var postError by remember(postId) { mutableStateOf<String?>(null) }
    var loadingPost by remember(postId) { mutableStateOf(post == null) }

    var commentList by remember(postId) { mutableStateOf<List<CommentRepository.CommentUi>>(emptyList()) }
    var commentTotal by remember(postId) { mutableStateOf(post?.commentCount ?: 0) }
    var commentHasMore by remember(postId) { mutableStateOf(false) }
    var loadingComments by remember(postId) { mutableStateOf(true) }
    var loadingMore by remember(postId) { mutableStateOf(false) }
    var commentError by remember(postId) { mutableStateOf<String?>(null) }

    /**
     * **正在播删除动画**的评论 / 回复 id（删成功后先标记，动画播完才从列表摘掉）。
     *
     * 为什么需要它：回复是嵌在父评论的 `replies` 里的，数据一改它就当场从组合里消失 ——
     * 既没有动画，下面的行还会立刻跳上来（用户实测："删除回复不会有动画消失"）。
     * `CommentBlock` 里那一行据此先收缩 + 淡出，等动画结束再真正移除。
     */
    val deletingCommentIds = remember { mutableStateListOf<Long>() }

    /**
     * 等着二次确认的那条评论 / 回复 id（null = 没有待确认的删除）。
     *
     * 「删除」是先弹确认、确认后才真的发请求（用户要求）—— 这是个破坏性动作，
     * 而它的入口小得可怜（评论行里一个"删除"小字），误触代价却是内容没了。
     */
    var confirmDeleteCommentId by remember { mutableStateOf<Long?>(null) }

    /**
     * 页内提示文案（null = 不显示）。
     *
     * 声明位置**必须在 [performDeleteComment] 之前**：那个局部函数会写它，
     * 而 Kotlin 的局部变量/函数作用域是从声明处往后的（放到后面就是"未定义引用"）。
     */
    var toast by remember { mutableStateOf<String?>(null) }

    /**
     * 真正执行删除（**已经过二次确认**）。
     *
     * 抽成局部函数而不是写在弹层的 `onClick` 里：删除按钮只是一个入口，
     * 真正改数据的那段（两级摘除 + 动画 + 计数）要能一眼读完整。
     */
    fun performDeleteComment(id: Long) {
        scope.launch {
            when (val r = comments.delete(id)) {
                is ApiResult.Success -> {
                    /**
                     * 只有**回复**需要"先播动画、再摘数据"。
                     *
                     * 顶级评论直接摘：它自己那一行有 LazyColumn 的 `animateItem()` 淡出，
                     * 等这 220ms 反而会变成"点了没反应、过半秒才消失"。
                     * 回复嵌在父评论里、没有那一层，才得自己等。
                     */
                    val isReply = commentList.any { item ->
                        item.id != id && item.replies.any { it.id == id }
                    }
                    if (isReply) {
                        deletingCommentIds += id
                        delay(DELETED_ROW_ANIM_MS)
                    }
                    commentList = commentList.mapNotNull { item ->
                        when {
                            // 顶级评论：整条移除（它下面的回复跟着一起走）
                            item.id == id -> null
                            // ★ 回复：只摘掉这一条 ——
                            //   旧代码只过滤顶级评论，回复根本没被摘掉，
                            //   于是"删了还在、再点提示已删除"（用户实测）
                            item.replies.any { it.id == id } ->
                                item.copy(replies = item.replies.filterNot { it.id == id })
                            else -> item
                        }
                    }
                    deletingCommentIds -= id
                    commentTotal = (commentTotal - 1).coerceAtLeast(0)
                    onCommentCountChanged(-1)
                    toast = "已删除"
                }
                is ApiResult.Failure -> toast = r.error.displayMessage
            }
        }
    }

    var input by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var replyTo by remember { mutableStateOf<CommentRepository.CommentUi?>(null) }
    var menuOpen by remember { mutableStateOf(false) }
    val clipboard = LocalClipboard.current
    val context = LocalContext.current

    val isLoggedIn = session.isLoggedIn

    suspend fun loadComments(silent: Boolean = false) {
        if (!silent) loadingComments = true
        commentError = null
        when (val r = comments.list(postId)) {
            is ApiResult.Success -> {
                commentList = r.data.first
                commentHasMore = r.data.second
            }
            is ApiResult.Failure -> commentError = r.error.displayMessage
        }
        loadingComments = false
    }

    LaunchedEffect(postId) {
        // 评论列表
        loadComments()
        // 帖子详情（拿最新的点赞/收藏/评论总数）
        // 拉到之后由 `PostRepository.refreshDetail` 自己推给单帖状态流，这里**不要再赋值** ——
        // 详情页的状态只有"仓库那一个来源"（见 `postFlow` 的注释）
        when (val r = posts.refreshDetail(postId)) {
            is ApiResult.Success -> {
                if (r.data.commentCount > 0) commentTotal = r.data.commentCount
            }
            is ApiResult.Failure -> {
                if (post == null) postError = r.error.displayMessage
                /**
                 * 404 = 这条帖子**不存在了**（被别人删了，或者就是自己刚删的）。
                 * 不再把用户留在一个写着「帖子加载失败 HTTP 404」的死页面上，直接交回调用方。
                 *
                 * 只认 404：网络超时/500 不能当成"帖子没了" —— 那些情况用户重试一下就好了，
                 * 页面被自动踢走反而更莫名其妙。
                 */
                if (r.error.isNotFound) onPostGone(postId)
            }
        }
        loadingPost = false
    }

    /**
     * SSE：有人评论/回复了**这条**帖子（服务端通知事件带 `post_id`）→ 静默刷新评论与计数。
     * 其它帖子的通知不属于本页，直接忽略。
     */
    LaunchedEffect(realtime, postId) {
        if (realtime == null) return@LaunchedEffect
        realtime.events.collect { event ->
            if (event.isNotification && event.postId == postId) {
                loadComments(silent = true)
                when (val r = posts.refreshDetail(postId)) {
                    is ApiResult.Success -> {
                        // 同样：状态由仓库推流，这里只同步评论数
                        commentTotal = r.data.commentCount
                    }
                    is ApiResult.Failure -> Unit
                }
            }
        }
    }

    Box(modifier = Modifier.fillMaxSize().background(c.bgPage)) {
        // 顶栏真毛玻璃：Kyant0 的 backdrop 库。用法与注意事项见 BooksScreen 同段注释
        // （要点：backdrop 里先铺页底色；**不要加 vibrancy/colorFilter**，本机实测会打断效果链）。
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
        // 若从 0 起步，内容会先顶到最上面、测量回来后才弹到顶栏之下 ——
        // 真机表现就是"刚进页面时顶栏高矮跳一下"（见 kTopBarHeightEstimatePx）。
        val estimatedTopBarPx = kTopBarHeightEstimatePx(bottomPadding = KSpacing.xs)
        var measuredTopBarPx by remember { mutableIntStateOf(0) }
        val topBarPx = if (measuredTopBarPx > 0) measuredTopBarPx else estimatedTopBarPx
        val topInset = with(LocalDensity.current) { topBarPx.toDp() }
        Column(
            modifier = Modifier
                .fillMaxSize()
                // 玻璃源：栏的兄弟节点，且在栏之前绘制
                .then(if (canBlur) Modifier.layerBackdrop(backdrop) else Modifier),
        ) {

            val current = post
            when {
                current == null && loadingPost -> Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = c.accent)
                }

                current == null -> KPlaceholder(
                    kind = KPlaceholderKind.Error,
                    title = "帖子加载失败",
                    description = postError,
                    action = { KButton("返回", onClick = onBack) },
                    modifier = Modifier.weight(1f),
                )

                else -> LazyColumn(
                    state = listState,
                    // 点正文/评论区的空白处收起键盘（输入框聚焦时挡内容）
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxWidth()
                        .pointerInput(Unit) { detectTapGestures { keyboard?.hide() } },
                    contentPadding = PaddingValues(
                        start = KSpacing.md,
                        end = KSpacing.md,
                        top = topInset + KSpacing.sm,
                        bottom = KSpacing.lg,
                    ),
                    verticalArrangement = Arrangement.spacedBy(KSpacing.sm),
                ) {
                    item(key = "post") {
                        PostDetailBody(
                            post = current,
                            onLike = {
                                scope.launch {
                                    when (val r = posts.toggleLike(postId)) {
                                        is ApiResult.Failure -> toast = r.error.displayMessage
                                        else -> Unit
                                    }
                                }
                            },
                            onBookmark = {
                                scope.launch {
                                    when (val r = posts.toggleBookmark(postId)) {
                                        is ApiResult.Success -> toast = if (r.data) "已收藏" else "已取消收藏"
                                        is ApiResult.Failure -> toast = r.error.displayMessage
                                    }
                                }
                            },
                            onComment = { toast = "在下面写评论" },
                            /**
                             * 转发 —— 与首页卡片 [PostActions] 里那一颗完全同源。
                             *
                             * 之前详情页**根本没有这个入口**（用户反馈："详情页只显示 4 个"），
                             * 于是"看完整条帖子觉得值得转"时只能退出去、在卡片上再点一次。
                             */
                            onRepost = {
                                scope.launch {
                                    when (val r = posts.toggleRepost(postId)) {
                                        is ApiResult.Success -> toast = if (r.data) "已转发" else "已取消转发"
                                        is ApiResult.Failure -> toast = r.error.displayMessage
                                    }
                                }
                            },
                            /**
                             * 分享 —— 走右上角「…」菜单里同一个系统分享（同一段链接、同一个标题）。
                             *
                             * `markShared` 是**服务端只做计数**（每用户每帖计一次），
                             * 它失败不影响系统分享本身，所以不等它、也不为它报错。
                             */
                            onShare = {
                                scope.launch { posts.markShared(postId) }
                                shareText(context, "$PROFILE_SHARE_BASE/post/$postId", "分享帖子")
                            },
                            // 打开查看器前先收键盘（见 openViewerFromContent）
                            onImageClick = openViewerFromContent,
                            // 正文视频的**全屏入口**：内联播放器右下角那个按钮。
                            // 之前这里是空的 `{}` —— 于是"想放大看"根本没有入口，
                            // 点画面只能暂停（用户实测反馈）。
                            onVideoClick = onOpenVideo,
                            // 正文里的 #话题可点（**之前这里漏传了**：参数在 PostDetailScreen
                            // 上有、却没往 PostDetailBody 传，表现为"详情页的话题点了没反应"）
                            onTagClick = onTagClick,
                            // 作者行 → 这个人的主页
                            onOpenUser = onOpenUser,
                            // 配图/视频封面飞行的顶栏裁剪（见 imageFlightClip 的定义处）
                            imageFlightClip = imageFlightClip,
                        )
                    }

                    item(key = "divider") {
                        HorizontalDivider(
                            modifier = Modifier.padding(vertical = KSpacing.xs),
                            color = c.borderSubtle,
                        )
                    }

                    item(key = "comments-header") {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(KSpacing.xxs),
                        ) {
                            Text("评论", style = KType.bodyStrong, color = c.textPrimary)
                            Text("· ${commentTotal}", style = KType.caption, color = c.textMuted)
                        }
                    }

                    when {
                        loadingComments && commentList.isEmpty() -> item(key = "loading") {
                            Box(Modifier.fillMaxWidth().padding(KSpacing.xl), contentAlignment = Alignment.Center) {
                                CircularProgressIndicator(color = c.accent)
                            }
                        }

                        commentError != null && commentList.isEmpty() -> item(key = "error") {
                            KPlaceholder(
                                kind = KPlaceholderKind.Error,
                                title = "评论加载失败",
                                description = commentError,
                                action = { KButton("重试", onClick = { scope.launch { loadComments() } }) },
                            )
                        }

                        // 无评论时**不再渲染空态提示**（用户要求去掉「还没有评论 / 来说两句吧」）：
                        // 落到下面的 else 分支自然就是"什么都没有"，只留上方的「评论 · 0」计数。
                        else -> {
                            items(commentList, key = { it.id }) { comment ->
                                CommentBlock(
                                    comment = comment,
                                    onReply = { target ->
                                        if (!isLoggedIn) {
                                            onRequireLogin()
                                        } else {
                                            replyTo = target
                                            /**
                                             * 点「回复」**直接能打字**（用户要求"点回复自动弹出输入法"）。
                                             *
                                             * 输入框是固定底栏、一定在组合里，所以这里同步请求焦点是安全的；
                                             * `runCatching` 只兜"极端时序下节点还没附着"（那时让用户手动点一下，
                                             * 比抛 IllegalStateException 崩掉好）。`keyboard?.show()` 是保险：
                                             * 少数机型拿到焦点也不自动起 IME（尤其刚被手动收过键盘）。
                                             */
                                            runCatching { inputFocusRequester.requestFocus() }
                                            keyboard?.show()
                                        }
                                    },
                                    // 「删除」只是**开口**：先弹二次确认，确认后才真删（见 performDeleteComment）
                                    onDelete = { id -> confirmDeleteCommentId = id },
                                    isLoggedIn = isLoggedIn,
                                    // 正在播删除动画的那几条（回复行走 AnimatedVisibility）
                                    deletingIds = deletingCommentIds.toSet(),
                                    /**
                                     * 顶级评论的删除动画 = **淡化消失 + 其余评论让位**。
                                     *
                                     * 两个 spec 都显式钉住：回复那一行（嵌在父评论里、用不上
                                     * `animateItem`）是手写的 `fadeOut(KMotion.effects())` +
                                     * 父容器 `animateContentSize(KMotion.spatial())` ——
                                     * **两处必须是同一套**，否则"删评论"和"删回复"一眼看得出是两种动画。
                                     */
                                    modifier = Modifier.animateItem(
                                        fadeOutSpec = KMotion.effects(),
                                        placementSpec = KMotion.spatial(),
                                    ),
                                )
                            }
                            if (commentHasMore) {
                                item(key = "more") {
                                    Box(Modifier.fillMaxWidth().animateItem(), contentAlignment = Alignment.Center) {
                                        KButton(
                                            text = if (loadingMore) "加载中…" else "加载更多评论",
                                            variant = KButtonVariant.Ghost,
                                            enabled = !loadingMore,
                                            onClick = {
                                                scope.launch {
                                                    loadingMore = true
                                                    val cursor = commentList.lastOrNull()?.id
                                                    when (val r = comments.list(postId, afterId = cursor)) {
                                                        is ApiResult.Success -> {
                                                            val seen = commentList.mapTo(HashSet()) { it.id }
                                                            commentList = commentList + r.data.first.filterNot { it.id in seen }
                                                            commentHasMore = r.data.second
                                                        }
                                                        is ApiResult.Failure -> toast = r.error.displayMessage
                                                    }
                                                    loadingMore = false
                                                }
                                            },
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }

            /**
             * 回复目标的显示位置：**不再单独占一行**，而是写进输入框里
             * （灰色前缀 `回复<名字>：` + 尾部「取消」，见下面 KTextField 的 leading / trailing）。
             *
             * 原来这里是独立的一条「回复 @xxx / 取消」：它会把下面整条输入栏顶下去、多占一层高度，
             * 而且回复状态一变就是整条进出（用户要求："改成写进输入框、变灰"）。
             * 现在前缀跟着输入框走 —— 输入的文字接在前缀后面，回复谁一眼可见。
             */

            // 输入条与正文之间用一条分隔线隔开（与聊天页同款交互）
            HorizontalDivider(color = c.borderSubtle)
            // 输入条（与聊天页同款：白/深卡片条 + 凹陷底药丸 + 药丸发送按钮）
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(c.surface)
                    .navigationBarsPadding()
                    .imePadding()
                    .padding(horizontal = KSpacing.md, vertical = KSpacing.sm),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(KSpacing.sm),
            ) {
                Box(modifier = Modifier.weight(1f)) {
                    KTextField(
                        value = input,
                        onValueChange = { if (isLoggedIn) input = it else onRequireLogin() },
                        placeholder = if (isLoggedIn) "说点什么…" else "登录后才能评论",
                        shape = RoundedCornerShape(KRadius.control),
                        variant = KTextFieldVariant.Inset,
                        // 点「回复」时把焦点交给它（见 onReply），IME 随之弹起
                        focusRequester = inputFocusRequester,
                        /**
                         * 回复谁：**写在输入框里**（灰字前缀），而不是单独占一行。
                         *
                         * `textMuted` 就是"灰"——它与正文字色（`textPrimary`）分得开，
                         * 一眼能看出这段不是自己敲的。输入文字排在它后面，
                         * 于是"回复谁 + 说什么"在同一条里读完整。
                         */
                        leading = if (replyTo != null) {
                            {
                                Text(
                                    text = "回复${replyTo?.raw?.username.orEmpty()}：",
                                    style = KType.body,
                                    color = c.textMuted,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        } else {
                            null
                        },
                        /**
                         * 「取消」跟着挪进来：回复态原来那条独立行删了，
                         * 取消入口不能跟着消失（否则点错了回复只能靠发出去才能退出）。
                         */
                        trailing = if (replyTo != null) {
                            {
                                Text(
                                    "取消",
                                    style = KType.footnote,
                                    color = c.accent,
                                    modifier = Modifier.clickable { replyTo = null },
                                )
                            }
                        } else {
                            null
                        },
                    )
                }
                KButton(
                    text = if (sending) "…" else "发送",
                    enabled = !sending,
                    // 圆角与输入框一致（小圆角），不再是胶囊
                    cornerRadius = KRadius.control,
                    onClick = {
                        if (!isLoggedIn) {
                            onRequireLogin()
                            return@KButton
                        }
                        if (input.isBlank()) {
                            toast = "评论不能为空"
                            return@KButton
                        }
                        scope.launch {
                            sending = true
                            val parent = replyTo
                            when (val r = comments.create(postId, input, parent?.id)) {
                                is ApiResult.Success -> {
                                    // 顶级评论追加到末尾；回复挂到父评论下
                                    commentList = if (parent == null) {
                                        commentList + r.data
                                    } else {
                                        commentList.map { if (it.id == parent.id) it.copy(replies = it.replies + r.data) else it }
                                    }
                                    commentTotal += 1
                                    onCommentCountChanged(1)
                                    input = ""
                                    replyTo = null
                                    toast = "已发布"
                                    /**
                                     * 发完就**收键盘 + 清焦点** —— 发送是这一轮输入的终点。
                                     * （原来回复场景不收，输入法一直挂着；用户实测反馈：
                                     * "回复完评论应该是收回输入法"。）
                                     */
                                    focusManager.clearFocus(force = true)
                                    keyboard?.hide()
                                    /**
                                     * **只有"发新评论"才滚到列表末尾**（去找"我刚发的那条在哪"）。
                                     *
                                     * 回复**不滚**：回复挂在父评论下面，而这里的滚动目标是**列表末尾**
                                     * —— 两者根本不在一个位置，一律滚过去就是"回复完被甩到最下面"
                                     * （用户实测反馈："不是跳过去"）。
                                     *
                                     * ★ 滚动要等**输入法收完**再做：收起 IME 会让 LazyColumn 的可用高度
                                     * 从"键盘上方那一段"变回整屏，此刻按旧高度算出来的滚动目标落位后会再
                                     * 修正一次 —— 观感就是"评论完跳一下"（用户实测反馈）。
                                     * 等布局稳定（见 [KEYBOARD_SETTLE_MS]）再滚，动画就是一条平滑的线。
                                     */
                                    if (parent == null) {
                                        delay(KEYBOARD_SETTLE_MS)
                                        listState.animateScrollToItem(2 + commentList.size)
                                    }
                                }
                                is ApiResult.Failure -> toast = r.error.displayMessage
                            }
                            sending = false
                        }
                    },
                )
            }
        }

        // 顶栏浮层（毛玻璃）：返回 | 帖子 | 「…」。正文/评论从它底下穿过。
        // 与图书详情同一个病根：放进内容 Column 会被当成最后一个子项排到输入栏下面
        //（真机表现："帖子详情的 top 栏跑到底下去了"）；必须是它的兄弟节点、挂在根 Box 里 ——
        // 后画 = 盖在内容之上，这才是浮层。
        Row(
            modifier = Modifier
                .fillMaxWidth()
                // 顶栏毛玻璃（统一写法，见 rememberTopBarGlass）。
                // 必须挂在 kTopBar（状态栏避让）的**左侧**：玻璃矩形才含状态栏那一条（顺序铁律）
                //
                // ★ 2026-09-24：**转场期间降级成纯色**（canBlur 临时给 false）。
                // 为什么：配图飞行那一端改回 `renderInOverlayDuringTransition = true`（见
                // SingleDetailImage 的注释）后，**飞行期间页面里那一格不留内容**（内容在覆盖层里飞）
                // —— 若顶栏此刻还在做真模糊，它采样到的就是一块空白 → "玻璃变纯色"（09-23 的老症状）。
                // 与其为了玻璃而牺牲飞行的观感，不如让**顶栏在转场这 200ms 里就用纯色**
                // （`frostedSolid` 本来就是它低版本/无模糊时的降级形态，观感统一），
                // 转场结束再恢复模糊 —— 用户看不到"玻璃突变"，因为它从头到尾都是同一块浅色。
                .then(
                    rememberTopBarGlass(
                        canBlur = canBlur && !isPageTransitioning(),
                        backdrop = backdrop,
                        blurRadius = KGlassBlurRadius,
                        tint = frostedTint,
                        solid = KTheme.colors.frostedSolid,
                    )
                )
                .onSizeChanged {
                    measuredTopBarPx = it.height
                    // 同一份高度也给查看器：退出全屏飞行时要避开这一条（见 topBarBottomPx）
                    topBarBottomPx.floatValue = it.height.toFloat()
                }
                .kTopBar()
                .padding(start = KSpacing.md, end = KSpacing.md, bottom = KSpacing.xs),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(KSpacing.md),
        ) {
            KIconButton(icon = GlyphKind.ChevronLeft, onClick = onBack)
            Text(
                text = "帖子",
                style = KType.subtitle,
                color = c.textPrimary,
                modifier = Modifier.weight(1f),
            )
            Box {
                KIconButton(icon = GlyphKind.More, onClick = { menuOpen = true })
                DropdownMenu(
                    expanded = menuOpen,
                    onDismissRequest = { menuOpen = false },
                    shape = RoundedCornerShape(KRadius.control),
                    containerColor = c.surfaceRaised,
                    tonalElevation = 0.dp,
                    shadowElevation = KElevation.raised,
                    border = BorderStroke(1.dp, c.borderSubtle),
                ) {
                    ChatMenuItem("分享", c.textPrimary) {
                        menuOpen = false
                        shareText(context, "$PROFILE_SHARE_BASE/post/$postId", "分享帖子")
                    }
                    ChatMenuItem("复制链接", c.textPrimary) {
                        menuOpen = false
                        /**
                         * M3 之后的写法：`LocalClipboard` 的 `setClipEntry` 是**挂起函数**
                         * （旧的 `LocalClipboardManager.setText` 已废弃 —— 它在 Android 13+
                         * 的剪贴板确认机制下无法正确处理"写入被系统拒绝"）。
                         * 剪贴板写入本身很短，直接用组合的 scope 起一个协程即可。
                         */
                        scope.launch {
                            clipboard.setClipEntry(
                                ClipEntry(
                                    ClipData.newPlainText(
                                        "帖子链接",
                                        "$PROFILE_SHARE_BASE/post/$postId",
                                    ),
                                ),
                            )
                        }
                        toast = "已复制链接"
                    }
                    if (post?.post?.userId == myUserId && myUserId > 0) {
                        ChatMenuItem("编辑", c.textPrimary) {
                            menuOpen = false
                            post?.let(onEdit)
                        }
                    }
                }
            }
        }

        /**
         * 删除评论 / 回复的二次确认。
         *
         * 与消息页「清空聊天记录」、语音房「删除房间」**同一套写法**（Material3 AlertDialog +
         * `containerColor = c.surface`）：破坏性动作不该一次点击就生效（用户要求）。
         *
         * 文案分两种——删一条回复和删一整条评论（连带它下面的回复）不是同一件事，
         * 让人在确认框里就能看出自己正要删掉多少东西。
         */
        val pendingDeleteId = confirmDeleteCommentId
        if (pendingDeleteId != null) {
            val isReplyTarget = commentList.any { item ->
                item.id != pendingDeleteId && item.replies.any { it.id == pendingDeleteId }
            }
            AlertDialog(
                onDismissRequest = { confirmDeleteCommentId = null },
                title = { Text("删除评论", style = KType.subtitle, color = c.textPrimary) },
                text = {
                    Text(
                        if (isReplyTarget) {
                            "这条回复会被删除，且不可恢复。"
                        } else {
                            "这条评论及其下的回复都会被删除，且不可恢复。"
                        },
                        style = KType.body,
                        color = c.textSecondary,
                    )
                },
                confirmButton = {
                    Text(
                        "删除",
                        style = KType.bodyStrong,
                        color = c.danger,
                        modifier = Modifier
                            .clip(RoundedCornerShape(KRadius.control))
                            .clickable {
                                confirmDeleteCommentId = null
                                performDeleteComment(pendingDeleteId)
                            }
                            .padding(horizontal = KSpacing.sm, vertical = KSpacing.xs),
                    )
                },
                dismissButton = {
                    Text(
                        "取消",
                        style = KType.body,
                        color = c.textMuted,
                        modifier = Modifier
                            .clip(RoundedCornerShape(KRadius.control))
                            .clickable { confirmDeleteCommentId = null }
                            .padding(horizontal = KSpacing.sm, vertical = KSpacing.xs),
                    )
                },
                containerColor = c.surface,
            )
        }

        if (toast != null) {
            PostToast(text = toast!!, onDismiss = { toast = null }, modifier = Modifier.align(Alignment.BottomCenter))
        }
    }
}

/**
 * 帖子正文块（作者行 → 标题 → 正文 → 配图 → 互动栏）。
 *
 * 视频在这里**自动播放且带声音**（用户要求："点进详情页自动播放视频带声音"）：
 * 进入组合即 `playWhenReady = true` 且不静音 —— 与信息流的静音自动播放相反，
 * 因为进详情页是用户的明确意图（点进来的），出声是预期行为。
 *
 * 进度条画在视频**容器底部**（不是屏幕底部）：形态沿用阅读器的细进度条，
 * 右侧给「剩余 mm:ss」让用户随时知道还剩多少。
 */
@Composable
private fun PostDetailBody(
    post: PostUi,
    onLike: () -> Unit,
    onBookmark: () -> Unit,
    onComment: () -> Unit,
    onRepost: () -> Unit,
    onShare: () -> Unit,
    onImageClick: (List<String>, Int, Long?) -> Unit,
    onVideoClick: () -> Unit,
    /** 点正文里的 #话题 → 搜该话题的相关帖子 */
    onTagClick: ((String) -> Unit)? = null,
    /** 点作者行（头像 / 昵称）→ 这个人的主页；null = 不可点 */
    onOpenUser: ((userId: Long) -> Unit)? = null,
    /**
     * 配图 / 视频封面这条飞行的**顶栏裁剪**（见 [topBarOverlayClip]）。
     *
     * 从 `PostDetailScreen` 一路传下来而不是用 CompositionLocal：与 `SingleDetailImage` 的
     * `sharedKey` 同一个理由 —— 它只对这一族共享元素有意义，显式传更好读。
     */
    imageFlightClip: SharedTransitionScope.OverlayClip = NoOverlayClip,
) {
    val c = KTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(KSpacing.sm)) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
        ) {
            // 头像 + 昵称/时间 整块可点 → 作者主页（与信息流卡片同一套交互，
            // 也在同一个位置上，用户点第二次时不会"这次有反应、那次没有"）
            val flyer = rememberAvatarFlyer()
            Row(
                modifier = Modifier
                    .weight(1f)
                    .then(
                        if (onOpenUser != null) {
                            Modifier.clickable(
                                onClickLabel = "查看 ${post.username} 的主页",
                                onClick = { onOpenUser(post.post.userId) },
                            )
                        } else {
                            Modifier
                        }
                    ),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
            ) {
                Avatar(
                    url = post.avatarUrl,
                    name = post.username,
                    size = KDimens.avatarCard,
                    // 头像共享元素（M3 补完）：与信息流卡片同一套规则，但发起端**类型不同**
                    // （AvatarShareOrigin.Detail）—— 否则"从卡片进这一页"时两端会同时声明
                    // 同一个 key，头像会飞进这一页的作者行（详见 AvatarShareState.origin）
                    sharedKey = avatarKey(post.post.userId).takeIf {
                        flyer.isSource(post.post.userId, post.id, AvatarShareOrigin.Detail)
                    },
                    onClick = onOpenUser?.let { open ->
                        {
                            flyer.fly(post.post.userId, post.id, AvatarShareOrigin.Detail) {
                                open(post.post.userId)
                            }
                        }
                    },
                )
                // 昵称与「时间 · 位置」之间留一档间距（与首页卡片一致：贴一起会显得"时间挨着 id"）
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(KSpacing.xxs),
                ) {
                    Text(
                        text = post.username.ifBlank { "匿名" },
                        style = KType.bodyStrong,
                        color = c.textPrimary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        // 位置跟在时间后面（与首页卡片同一形态）；没填位置不加分隔符
                        text = if (post.location.isBlank()) {
                            post.timeText
                        } else {
                            "${post.timeText} · ${post.location}"
                        },
                        style = KType.footnote,
                        color = c.textMuted,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }

        /**
         * 正文与话题**分开摆**（用户要求「详情页关键词也放图片视频下方」）——
         * 与首页卡片 [PostCard] 完全同一套顺序：正文在上、**关键词在图片/视频下面**。
         *
         * 注意这里**不能再用 `TaggedDescription`**：那是"正文 + 胶囊"打包在一起的组合版，
         * 会把胶囊顶到图片上方。要拆成 `TaggedBody`（只正文）与 `TaggedChips`（只胶囊）两块，
         * 中间隔着配图/视频。
         *
         * `splitTags` 只算一次，两块吃同一份 [TaggedParts]（各自再 `remember` 一次会是两份
         * 一模一样的解析结果，白算）。
         */
        val taggedParts = remember(post.description) { splitTags(post.description) }

        if (post.title.isNotBlank()) {
            Text(post.title, style = KType.subtitle, color = c.textPrimary)
        }
        if (post.description.isNotBlank()) {
            // 详情页不截断正文（列表卡片才截断）
            TaggedBody(
                parts = taggedParts,
                style = KType.body,
                color = c.textPrimary,
            )
        }

        if (post.images.isNotEmpty()) {
            // 共享元素（M3）：与信息流卡片里的配图共用 key（见 postImageKey）
            DetailImageGrid(
                images = post.images,
                onClick = onImageClick,
                postId = post.id,
                imageFlightClip = imageFlightClip,
            )
        } else if (post.hasVideo) {
            // `post` 是跨模块的 public data class 属性，Kotlin 不允许智能转换，先取局部变量
            val url = post.videoUrl
            if (url != null) {
                // 进来就播、带声音（用户要求）：
                //  · 点画面 = 暂停/继续（内联播放器自己处理）；
                //  · 想放大看 / 想精确拖时间 → 走右下角的全屏按钮进沉浸播放器
                //    （内联那根进度条刻意不可拖动）。
                // 视频容器高度按 16:9 定，进度条与全屏钮都画在这个容器内部。
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .aspectRatio(16f / 9f)
                        .clip(RoundedCornerShape(KRadius.row))
                        /**
                         * 底色与卡片那边同款：封面还没加载出来（或加载失败）时，
                         * 这里是**一块主题色占位**而不是一个空白的洞 ——
                         * 早先没有底色，观感就是"视频封面丢了、详情页一片空白"（用户实测反馈）。
                         *
                         * 注意：**不能**在转场期间把这一层藏起来（那是 M5.8 试过又撤掉的做法）——
                         * 目标端一旦因为"共享元素没匹配上"而一直保持隐藏，整块视频区就是空白。
                         * 现在只靠 `playerVisible` 控制播放器（`AndroidView` 必须缺席），
                         * 封面始终在，飞行的那一份落位时不会出现"空窗"。
                         */
                        .background(c.accentSoft),
                ) {
                    /**
                     * 播放器**只在共享元素不再飞的时候才存在**（M3 真机反馈·最终版）。
                     *
                     * 为什么必须"不存在"而不是"藏起来"：播放器是 `AndroidView`，
                     *  · 它的绘制**不走 Compose 绘制管线** —— `alpha` / `graphicsLayer` 对它无效
                     *    （第一轮试过，用户实测"还是有"）；
                     *  · 它**不参与 Compose 的转场变换** —— 页面在滑，它钉在布局位置上不动。
                     * 于是它在转场期间存在就会有两种怪象：
                     *   进入 → 目标位置先出现黑框"等"封面飞过来；
                     *   退出 → 黑底跟着页面滑走、**视频画面留在原地**（残留）。
                     *
                     * 判据用 `SharedTransitionScope.isTransitionActive`（见 [isSharedTransitionActive]）。
                     * 它比页面自身的 `EnterExitState` 更准：**打断返回动画、立刻再进同一页**时，
                     * `AnimatedContent` 复用同一份内容实例、把出场动画倒着播回来，
                     * 那一页的 `currentState/targetState` 都还是 `Visible`（状态上看不出在飞），
                     * 但共享元素确实在飞 —— 这个信号三种情况全覆盖。
                     *
                     * **但退出还得叠加 [isPageLeaving]**（真机反馈·第三轮：`进入正常了，
                     * 退出时又看到播放器在等`）：`isTransitionActive` 要等共享元素**匹配上**
                     * 才为真，而返回的头几帧还没匹配上，播放器已经组合出来了 ——
                     * 那几帧就是黑框。页面自身的出场状态与"有没有匹配上"无关，转场一开始就为真。
                     *
                     * **M5.8 再补上 [isPageTransitioning]**（= `currentState != targetState`）：
                     * 它把前两个信号各自的空窗一起盖上 —— 进场时的头几帧（还没匹配上）、
                     * 以及"页面状态看起来还是 Visible、但确实在转场里"的所有时刻。
                     * 三个信号任一为真都不组合播放器。
                     */
                    val sharedFlying = isSharedTransitionActive() || isPageLeaving() || isPageTransitioning()
                    // 播放器是否在场 —— 只在这一处判断，封面透明度与它保持一致
                    val playerVisible = !sharedFlying
                    // 首帧是否已经画出来（决定"盖在上面的封面能不能淡掉"）
                    var firstFrame by remember(playerVisible) { mutableStateOf(false) }
                    // 封面透明度：播放器缺席时**立刻**回到不透明（不能淡回！
                    // 否则退出/回飞的那几帧会是一个透明的洞）；
                    // 只有"播放器在场且已出首帧"时才淡出，露出视频。
                    val coverFade = remember { Animatable(1f) }
                    LaunchedEffect(playerVisible, firstFrame) {
                        if (playerVisible && firstFrame) {
                            coverFade.animateTo(0f, KMotion.effects())
                        } else {
                            coverFade.snapTo(1f)
                        }
                    }

                    if (playerVisible) {
                        KVideoPlayer(
                            url = url,
                            autoPlay = true,
                            muted = false,
                            loop = true,
                            title = post.title.ifBlank { null },
                            onFullscreen = onVideoClick,
                            onFirstFrame = { firstFrame = true },
                            modifier = Modifier.fillMaxSize(),
                        )
                    }

                    /**
                     * 封面层（共享元素 M3）：与信息流卡片的视频封面共用 key。
                     *
                     * 画在播放器**之上**（在这个 Box 里排在后面）：
                     * 播放器刚组合出来的那一小段是纯黑的（ExoPlayer 还在准备），
                     * 封面盖在上面正好遮住这段黑 —— 等 `onFirstFrame` 到了再淡掉，
                     * 全程不会出现"封面 → 黑 → 视频"的闪黑。
                     *
                     * 为什么 key 挂在封面这个纯 Compose 元素上、而不是播放器容器上：
                     * 共享元素在转场期间会被画进 `SharedTransitionScope` 的覆盖层，
                     * 而播放器是 `AndroidView` —— 挂上去会出黑块或重复实例
                     * （与 `res/values/styles.xml` 里 `surface_type=texture_view` 是同一类坑）。
                     * 两端都是 16:9，所以这一趟是**纯缩放**，观感最干净。
                     *
                     * 用 `sharedElement`（不是 `sharedBounds`）：后者会让**目标端留在原地画**，
                     * 返回信息流时卡片那个视频位会先自己显示封面在那儿"等"（用户实测反馈：
                     * "播放器还没到位就有图在原位置等待了"）。`sharedElement` 飞行期间只在覆盖层画。
                     *
                     * M5.8：声明计数（[declareSharedPeer]）与卡片那边成对 ——
                     * 目标端要据此判断"对面在不在"，才敢在飞行接上前先把自己藏起来。
                     */
                    if (post.videoCoverUrl != null) {
                        AsyncImage(
                            // 与卡片端同一个键（rememberVideoCoverRequest）—— 共享元素两端
                            // 必须同键同尺寸，否则目标端第一帧是空的。见该函数的长注释。
                            model = rememberVideoCoverRequest(post.videoCoverUrl),
                            contentDescription = null,
                            contentScale = ContentScale.Crop,
                            modifier = Modifier
                                .fillMaxSize()
                                .sharedElementIfAvailable(postVideoKey(post.id), imageFlightClip)
                                .declareSharedPeer(postVideoKey(post.id))
                                // 圆角写在共享元素自己的链上：覆盖层只保留元素自身的修饰符，
                                // 外层容器的 clip 不会跟进去（否则飞行中是直角，落位变圆角）
                                .clip(RoundedCornerShape(KRadius.row))
                                // 绘制期读取，淡出过程不触发重组。
                                // **播放器不在场时强制不透明**（而不是等下面那个 LaunchedEffect
                                // 把 Animatable 弹回 1）：`snapTo` 发生在组合之后的副作用里，
                                // 而退出的第一帧就要画 —— 等它就等于第一帧是个透明的洞。
                                .graphicsLayer { alpha = if (playerVisible) coverFade.value else 1f },
                        )
                    }
                }
            } else {
                // 理论上不会有（hasVideo 由 videoUrl 推出），但真到了这一步要给个可点的封面兜底
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .aspectRatio(16f / 9f)
                        .sharedBoundsIfAvailable(postVideoKey(post.id))
                        .clip(RoundedCornerShape(KRadius.row))
                        .background(c.accentSoft)
                        .clickable(onClick = onVideoClick),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("▶ 视频", style = KType.caption, color = c.textPrimary)
                }
            }
        }

        /**
         * 关键词（话题胶囊）：放在**配图 / 视频下面**（用户要求，与首页卡片同一顺序）。
         * 只在真有话题时才有内容（`TaggedChips` 自己会因空列表而不画）。
         */
        TaggedChips(parts = taggedParts, onTagClick = onTagClick)

        /**
         * 操作栏：**直接复用首页那张卡片的同一份实现**（[PostActions]）。
         *
         * 用户要求：「详情页跟首页 5 个元素共用同一份显示出来，而不是只显示 4 个」。
         *
         * 改之前这里是一份**自己的三连**（赞 / 评论 / 收藏，间距 `Spacing.lg`、图标 20dp），
         * 而首页那份是五连（赞 / 评论 / 转发 / 分享 / 收藏，间距 `Spacing.md`、图标 18dp）——
         * 同一件事两处实现，于是详情页少了转发与分享两个入口，
         * 连图标尺寸与间距都和首页对不上（切页时那一排会"跳一下"）。
         *
         * 现在两页走同一个函数：顺序、间距、图标尺寸（[ACTION_ICON]）、选中态
         * （点赞实心心 / 转发 accent / 收藏实心）全站只有一处定义。
         *
         * `onEdit = null`：详情页没有"卡片上直接编辑"的入口（编辑在右上角「…」里，
         * 那是帖子自己的动作菜单，与列表上的杂物不是一回事）。
         */
        PostActions(
            post = post,
            onLike = onLike,
            onBookmark = onBookmark,
            onRepost = onRepost,
            onComment = onComment,
            onShare = onShare,
            canEdit = false,
            onEdit = null,
        )
    }
}

/**
 * 详情页配图：**1 张 → 按原图比例完整显示（不裁切）**；2 张 → 两列方块；
 * 3 张及以上 → 三列方块网格（方块是"缩略图墙"的既定形态，点开可看全图）。
 *
 * 单图为什么不再用 4:3 通栏：早期按设计稿铺成 4:3 + `ContentScale.Crop`，
 * 遇到**手机截屏/长图（约 9:19.5）或横图**时只会露出中间一条，
 * 用户实测反馈"点进去像 UI 残影 / 图片显示不全" —— 详情页的职责就是把图看清楚，
 * 所以单图按原始比例铺满宽度；只有超过 3:1 的极端长图才回退 `Fit` 兜底。
 */
@Composable
private fun DetailImageGrid(
    images: List<String>,
    onClick: (List<String>, Int, Long?) -> Unit,
    postId: Long,
    /** 配图飞行的顶栏裁剪（见 [topBarOverlayClip]） */
    imageFlightClip: SharedTransitionScope.OverlayClip = NoOverlayClip,
) {
    val c = KTheme.colors
    // 详情页的配图**不在卡片里**，可用宽度 = 屏宽 - 页面左右边距（KSpacing.md × 2）。
    // 不能用列表卡片那个 KGridWidth()（那个多减了两个卡片内边距，图片会窄 32dp、右侧留空）。
    // 校验：390 屏宽 → 358 可用 → 两列各 (358-8)/2 = 175，与设计稿实测的 175dp 方块一致。
    val available = androidx.compose.ui.platform.LocalConfiguration.current.screenWidthDp.dp - KSpacing.md * 2
    val gap = KSpacing.xs
    // 长按任意一格 = 存这一张（点还是原来的"打开全屏"）—— 与信息流卡片同一套
    val saveMedia = rememberMediaSave()
    if (images.size == 1) {
        SingleDetailImage(
            url = images[0],
            width = available,
            onClick = { onClick(images, 0, postId) },
            sharedKey = postImageKey(postId, 0),
            postId = postId,
            imageFlightClip = imageFlightClip,
        )
        return
    }
    val cols = if (images.size == 2) 2 else 3
    val cell = (available - gap * (cols - 1)) / cols
    Column(verticalArrangement = Arrangement.spacedBy(gap)) {
        images.chunked(cols).forEachIndexed { rowIndex, rowItems ->
            Row(horizontalArrangement = Arrangement.spacedBy(gap)) {
                rowItems.forEachIndexed { indexInRow, url ->
                    val globalIndex = rowIndex * cols + indexInRow
                    // 自己建 painter 而不是用 AsyncImage：查看器的飞行要用它的**原图宽高比**
                    // （登记给 ViewerOrigins），并且请求带显式内存缓存键 —— 查看器拿它当飞行占位图。
                    // 用现成的 painter 就不会多解一次码。
                    val painter =
                        coil3.compose.rememberAsyncImagePainter(model = rememberThumbRequest(url))
                    Box(
                        modifier = Modifier
                            // 共享元素：与卡片网格里同一 index 的那一格对齐（卡片 ↔ 详情那条飞行）。
                            // 全屏查看器不参与这条 key —— 它的飞行由 ViewerOrigins 自己算。
                            //
                            // ★ 2026-09-24：与 SingleDetailImage 一致，**不传 renderInOverlay**
                            // （= true，走覆盖层）。理由与取证数据见 SingleDetailImage 的注释：
                            // `false` 会让"飞行那一份"根本不存在，两端各自原地画 → 看起来闪。
                            .sharedElementIfAvailable(postImageKey(postId, globalIndex), imageFlightClip)
                            // 登记"这一格在哪 + 取景比例 + 圆角"，供全屏查看器的进出场飞行
                            // （圆角与下面那行 `clip(...)` 必须一致 —— 飞行图要从圆角变到全屏的直角）
                            .registerViewerOrigin(postId, globalIndex, painter, KRadius.row)
                            .size(cell)
                            .clip(RoundedCornerShape(KRadius.row))
                            .background(c.accentSoft)
                            .combinedClickable(
                                onClick = { onClick(images, globalIndex, postId) },
                                onLongClick = { saveMedia(url, MediaKind.Image) },
                            ),
                    ) {
                        Image(
                            painter = painter,
                            contentDescription = null,
                            contentScale = ContentScale.Crop,
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                }
            }
        }
    }
}

/**
 * 单图：按**原图宽高比**铺满可用宽度（长图会很高，但详情页本来就能滚，看图优先）。
 *
 * 宽高比从 Coil 的 painter 取；还没加载出来时先按 4:3 占位，加载完自动纠正。
 * 超过 3:1（极端长图）时高度封顶并 `Fit`，避免一张图占掉十几屏。
 */
@Composable
private fun SingleDetailImage(
    url: String,
    width: androidx.compose.ui.unit.Dp,
    onClick: () -> Unit,
    sharedKey: String,
    postId: Long,
    /** 配图飞行的顶栏裁剪（见 [topBarOverlayClip]） */
    imageFlightClip: SharedTransitionScope.OverlayClip = NoOverlayClip,
) {
    val c = KTheme.colors
    // 长按存这一张（与九宫格那一路同一套弹层）
    val saveMedia = rememberMediaSave()
    // 显式内存缓存键（见 rememberThumbRequest）：查看器要拿这一张当飞行的占位图
    val painter = coil3.compose.rememberAsyncImagePainter(model = rememberThumbRequest(url))
    // 实测过的比例优先（见 rememberImageAspect）：从别处返回这一页时高度不会先矮一截再弹回来
    val ratio = rememberImageAspect(url, painter)
    val naturalHeight = width / ratio
    val maxHeight = width * 3f
    val height = naturalHeight.coerceAtMost(maxHeight)
    Box(
        modifier = Modifier
            /**
             * 共享元素（M3）：信息流卡片的通栏配图 → 这里。
             *
             * ★★ 2026-09-20：这一族 key（`postImageKey`）**只有两个端点** —— 卡片格 ↔ 这里的详情格。
             * 查看器**不参与**（它完全手算几何飞行）。
             *
             * ⚠️ 上一版注释把"查看器里那一页也声明同一个 key"说成"打开时跳变"的根因，**是错的**：
             * 查看器覆盖层组合在 `AnimatedContent` 内容 lambda 之外，`LocalSharedElementScopes`
             * 为 null，那一行 `sharedElementIfAvailable` 是**死代码**（详见 `ImageViewer.kt` 里的更正）。
             *
             * "第一次打开跳变"的真根因是**飞行起点取错了矩形**（转场中间态 / 下层卡片那一格），
             * 证据与修法见 [ViewerOrigins] 的类注释。两端高度规则不同（卡片按原比例、
             * 详情页封顶 3:1）这件事依旧成立 —— `sharedElement` 一样会把**边界**插值过去。
             */
            // （注：这里曾挂 `.zIndex(1f)` —— 那是"页面内飞行"时期的补丁，让飞行那份不被
            //  后续 item 压住。改回覆盖层后飞行那份画在页面之上，zIndex 已无意义，故移除。）
            /**
             * ★★ 2026-09-24：**改回 `renderInOverlay = true`**（即不传该参数）。
             *
             * 先说被推翻的旧结论：09-23 为了让"进详情后立刻上滑长图"时顶栏毛玻璃不断档，
             * 把这一端改成 `renderInOverlay = false`（页面内飞行）。代价当时没看出来 ——
             * **`sharedElement` 语义下，"飞行的那一份"只存在于覆盖层**：
             * `SharedElementEntry.shouldRenderInOverlay` 里 `renderInOverlayDuringTransition`
             * 是必经条件，一关掉它就恒 false → **根本没有任何东西在飞**。
             * （库源码 1.12.1 `SharedElementEntry.kt` 226-238 行的 `shouldRenderInOverlay` /
             *   `shouldRenderInPlace` 两个判据，已逐条核对。）
             *
             * 真机取证（`KFLY` 探针，2026-09-24 15:25:19 那次 Push）：
             * ```
             * 19.316  转场开始
             * 19.360  img-card   draw#2 size=1216x1621   ← 卡片在自己位置画
             * 19.364  img-detail f=0    size≈1216x1769   ← 详情页也在自己位置画
             * 19.377  img-card   draw#3
             * 19.383  img-card   draw#4                  ← 两端一路交替画到转场结束
             * ```
             * 即：屏幕上**同时存在两份完整的图**（卡片一份、详情一份），中间那 200ms
             * 既没有"一份图从卡片飞到详情"，又叠着页面淡入 —— 用户看到的就是"闪一下"。
             *
             * 顺带排除的两个假设（都有数据）：目标端 painter **第 0 帧就已就绪**
             * （`intrinsicSize=1920x2560`，不是 NaN）→ 不是"首帧无内容"；
             * `ratio` 全程 0.75、`h100` 全程 1768.7 → 也不是"占位比例重排"。
             *
             * 副作用（顶栏毛玻璃折射留白）已由**顶栏在转场期间降级为纯色**兜住，
             * 见本页 `rememberTopBarGlass(canBlur = canBlur && !isPageTransitioning(), …)`。
             */
            .sharedElementIfAvailable(sharedKey, imageFlightClip)
            // 登记"这一格在哪 + 取景比例 + 圆角"，供全屏查看器的进出场飞行（M5.2 / M5.5）
            // 圆角与下面那行 `clip(...)` 必须一致
            .registerViewerOrigin(postId, 0, painter, KRadius.row)
            .size(width = width, height = height)
            .clip(RoundedCornerShape(KRadius.row))
            .background(c.accentSoft)
            .combinedClickable(
                onClick = onClick,
                onLongClick = { saveMedia(url, MediaKind.Image) },
            ),
    ) {
        Image(
            painter = painter,
            contentDescription = null,
            // 未被封顶时 FillWidth 正好等于原始比例（等于没裁切）；封顶时才 Fit
            contentScale = if (naturalHeight > maxHeight) ContentScale.Fit else ContentScale.FillWidth,
            modifier = Modifier.fillMaxSize(),
        )
    }
}

/**
 * 一条评论（含一条缩进的回复层）。
 *
 * 设计稿：头像 → 名字 → 内容 → 时间（都是左对齐，时间在内容下方）。
 * 交互：点整行 = 回复这条评论；长按自己的评论 = 删除（弹菜单，与聊天页同一套视觉）。
 */
@Composable
private fun CommentBlock(
    comment: CommentRepository.CommentUi,
    onReply: (CommentRepository.CommentUi) -> Unit,
    onDelete: (Long) -> Unit,
    isLoggedIn: Boolean,
    modifier: Modifier = Modifier,
    /**
     * 正在播删除动画的 id（见调用点 `deletingCommentIds`）。
     *
     * 只有**回复**用得上：顶级评论走 LazyColumn 的 `animateItem()` 淡出，
     * 而回复嵌在父评论里、没有 LazyColumn 那一层，得自己包 [AnimatedVisibility]。
     */
    deletingIds: Set<Long> = emptySet(),
) {
    val c = KTheme.colors
    val animationsEnabled = LocalAnimationsEnabled.current
    Column(
        /**
         * 高度变化（回复被删掉一条）由它平滑收起。
         *
         * 这是"淡化消失"能用在回复上的前提：行的退出动画只做**淡出**（与顶级评论同一套），
         * 少掉的那点高度交给它 —— 否则行一移除，下面的行会硬跳上来。
         */
        modifier = modifier.animateContentSize(animationSpec = KMotion.spatial()),
        verticalArrangement = Arrangement.spacedBy(KSpacing.xs),
    ) {
        CommentRow(comment = comment, onReply = onReply, onDelete = onDelete, isLoggedIn = isLoggedIn)
        comment.replies.forEach { reply ->
            /**
             * 回复行的退出动画：**与顶级评论统一，都走"淡化消失"**（用户要求）。
             *
             * 所以这里只 fadeOut —— 高度收起的活交给上面那个 `animateContentSize`。
             * （早先是 `fadeOut + shrinkVertically` 两条一起跑，观感与顶级评论的淡出不一致。）
             *
             * `visible = false` 时它仍留在组合里把 exit 播完 —— 那一行不会"啪"地不见。
             * 降级（系统关动画）时用 `None`：状态本身不需要动画也成立。
             */
            AnimatedVisibility(
                visible = reply.id !in deletingIds,
                exit = if (animationsEnabled) {
                    fadeOut(animationSpec = KMotion.effects())
                } else {
                    ExitTransition.None
                },
            ) {
                Row(modifier = Modifier.padding(start = KDimens.avatarCard + KSpacing.xs)) {
                    CommentRow(comment = reply, onReply = onReply, onDelete = onDelete, isLoggedIn = isLoggedIn)
                }
            }
        }
    }
}

/**
 * 删除后等多久再真正把那一行从数据里摘掉（毫秒）。
 *
 * 必须**不小于** [CommentBlock] 里那个退出动画的时长 —— 摘早了那一行就没了内容、
 * 动画被腰斩（看着像闪一下）。退出只剩一次 `fadeOut(KMotion.effects())`，
 * 那是 `spring(dampingRatio = 1f, stiffness = 1600f)`，实测收尾约 200~250ms，这里取 260 留余量。
 * （高度收起的 `animateContentSize` 在摘掉之后才开始跑，不占这个窗口。）
 */
private const val DELETED_ROW_ANIM_MS = 260L

/**
 * 发完评论后、开始滚动之前，等输入法收完的时长（毫秒）。
 *
 * 收起 IME 会让列表可用高度从"键盘上方那一段"变回整屏。滚动若与收键盘同时发起，
 * 目标位置是按**旧高度**算的，落位后要再修正一次 —— 真机上就是"评论完跳一下"（用户实测）。
 * 系统收起键盘通常 200~300ms，这里取 300：稍微多等一点没有代价（反正滚动本身也是动画），
 * 但等少了就白等。
 */
private const val KEYBOARD_SETTLE_MS = 300L

@Composable
private fun CommentRow(
    comment: CommentRepository.CommentUi,
    onReply: (CommentRepository.CommentUi) -> Unit,
    onDelete: (Long) -> Unit,
    isLoggedIn: Boolean,
) {
    val c = KTheme.colors
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onReply(comment) }
            .padding(vertical = KSpacing.xxs),
        horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
    ) {
        Avatar(url = comment.avatarUrl, name = comment.raw.username, size = KDimens.avatarCard)
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                text = comment.raw.username.ifBlank { "匿名" },
                style = KType.bodyStrong,
                color = c.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (comment.raw.parentUsername != null) {
                // 回复别人的评论：在正文前标出"回复 @谁"（服务端会把父评论作者名带下来）
                Text(
                    text = "回复 @${comment.raw.parentUsername}",
                    style = KType.caption,
                    color = c.accent,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Text(comment.raw.content, style = KType.body, color = c.textSecondary)
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(KSpacing.sm),
            ) {
                Text(comment.timeText, style = KType.footnote, color = c.textMuted)
                if (isLoggedIn) {
                    Text(
                        text = "回复",
                        style = KType.footnote,
                        color = c.textMuted,
                        modifier = Modifier.clickable { onReply(comment) },
                    )
                }
                if (comment.isMine) {
                    Text(
                        text = "删除",
                        style = KType.footnote,
                        color = c.danger,
                        modifier = Modifier.clickable { onDelete(comment.id) },
                    )
                }
            }
        }
    }
}

/**
 * 详情页内联提示。
 *
 * 为什么不用 [KToast]：那个会为底部导航胶囊预留 101dp（详情页是沉浸态、没有胶囊），
 * 直接用会在输入条上方留出一大块空白。
 */
@Composable
private fun PostToast(text: String, onDismiss: () -> Unit, modifier: Modifier = Modifier) {
    val c = KTheme.colors
    LaunchedEffect(text) {
        kotlinx.coroutines.delay(1600)
        onDismiss()
    }
    Box(modifier = modifier.padding(bottom = 88.dp)) {
        Box(
            modifier = Modifier
                .clip(RoundedCornerShape(KRadius.row))
                .background(c.surfaceRaised)
                .padding(horizontal = KSpacing.md, vertical = KSpacing.xs),
        ) {
            Text(text, style = KType.caption, color = c.textPrimary)
        }
    }
}









