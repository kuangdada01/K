package top.kuangdada.k.nativeapp.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import top.kuangdada.k.core.data.ApiResult
import top.kuangdada.k.core.data.PostRepository
import top.kuangdada.k.core.data.displayMessage
import top.kuangdada.k.core.designsystem.component.KButton
import top.kuangdada.k.core.designsystem.component.KPlaceholder
import top.kuangdada.k.core.designsystem.component.KListSkeleton
import top.kuangdada.k.core.designsystem.component.KPlaceholderKind
import top.kuangdada.k.core.designsystem.theme.KDimens
import top.kuangdada.k.core.designsystem.theme.KSpacing
import top.kuangdada.k.core.designsystem.theme.KTheme
import top.kuangdada.k.core.designsystem.theme.KType

/**
 * ============================================================
 * 首页信息流
 * ============================================================
 * 覆盖：分页续拉、下拉刷新、点赞/收藏/转发的乐观更新、loading / empty / error 三态，
 * 以及**游客可浏览**（服务端 `/api/posts` 是 optionalAuth，只有互动要求登录）。
 *
 * 列表状态由外部传入的 [list] 持有 —— 它由 AppShell 创建一次并跨 tab 存活，
 * 所以切到别的 tab 再回来不会重新拉取、也不会丢滚动位置。
 *
 * 页头按设计稿重做：**「首页」标题 + 右上角 38px 圆形搜索钮**。
 * 原实现把「已登录：xxx」「服务端地址」和一个「刷新」按钮裸露在页头上 ——
 * 那是开发期脚手架（还会随截图泄漏服务端地址），不是设计稿里的界面元素；
 * 刷新改由**下拉手势**承担，游客的登录入口在「主页」tab。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FeedScreen(
    posts: PostRepository,
    list: PostRepository.PostList,
    /** 打开「搜索发现」（页头右上角圆钮）。设计稿映射表：搜索发现高亮「首页」 */
    onOpenExplore: () -> Unit,
    /** 自增即触发重新拉取（发布成功后由 Shell 增加，让用户立刻看到自己的新帖） */
    refreshKey: Int = 0,
    myUserId: Long = 0,
    /** 是否已登录：未登录时点互动不发光标请求，直接拉起登录弹层 */
    isLoggedIn: Boolean = false,
    /** 未登录点互动 → 拉起登录弹层（AppShell 传 push Login） */
    onRequireLogin: () -> Unit = {},
    onEdit: ((top.kuangdada.k.core.data.PostUi) -> Unit)? = null,
    /**
     * 打开帖子详情。
     *
     * 首页**只有这一个"进入内容"的目标**：点卡片、点配图、点视频封面、点评论数都走它。
     * 全屏看图与全屏播放都属于详情页里的动作（用户明确要求："首页帖子点了不要进入图片
     * 或者视频，应该是进入帖子详情页，再点图片视频就是全屏观看"）。
     */
    onOpenPost: ((postId: Long) -> Unit)? = null,
    /** 点正文里的 #话题 → 搜该话题的相关帖子 */
    onTagClick: ((String) -> Unit)? = null,
    /**
     * 点卡片上的**头像 / 昵称** → 进这个人的主页（由 AppShell 推他人主页）。
     * 点的是**自己**时 AppShell 会切到「主页」tab（见 openUserProfile 的注释）。
     */
    onOpenUser: ((userId: Long) -> Unit)? = null,
) {
    val c = KTheme.colors
    val state by list.state.collectAsState()
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()
    val context = androidx.compose.ui.platform.LocalContext.current
    var toast by remember { mutableStateOf<String?>(null) }

    /**
     * ---- 首页**不再自动播放视频**（M6.5，用户明确要求："取消首页视频的自动播放"）----
     *
     * 这里原来有一整套"视口中心最近的那条视频帖 → 连续聚焦 3 秒 → 静音自动播放"的判定
     * （`videoPostIds` / `candidatePostId` / `focusedPostId` 三个状态 + 两个 `LaunchedEffect`）。
     * 它带来过一连串麻烦：卡片里出现的播放器是 `AndroidView`，**不参与 Compose 的转场变换**，
     * 于是返回/进入详情时会出现"播放器框在原位置等飞行"（为此加过三重信号判断把播放器藏起来），
     * 而且它和视频封面的共享元素抢同一块区域。用户最终拍板：**首页不要自动播放**。
     *
     * 现在首页的视频帖就是**静态封面 + 右上角「视频」胶囊**，点它进详情页（那边才播）。
     * 要恢复自动播放的话：把 `PostCard.VideoCover` 的 `videoActive` 那条分支一起拿回来
     * （见 `docs/android-motion-plan.md` M6.5 记录，那里写了需要还原哪几处）。
     */

    LaunchedEffect(list) { list.loadIfEmpty() }

    // 外部要求刷新（例如刚发布完）
    LaunchedEffect(refreshKey) {
        if (refreshKey > 0) list.refresh()
    }

    // 滚到接近底部自动续拉
    LaunchedEffect(listState, list) {
        snapshotFlow { listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0 }
            .distinctUntilChanged()
            .collect { last ->
                val s = list.state.value
                if (last >= s.posts.size - 3 && s.posts.isNotEmpty()) list.loadMore()
            }
    }

    Box(modifier = Modifier.fillMaxSize().background(c.bgPage)) {
        // 下拉刷新 —— 取代了原先页头上的「刷新」按钮（设计稿页头只有标题与搜索）
        PullToRefreshBox(
            isRefreshing = state.refreshing,
            onRefresh = { scope.launch { list.refresh() } },
            modifier = Modifier.fillMaxSize(),
        ) {
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(
                    start = KSpacing.md,
                    end = KSpacing.md,
                    // 这里**不能**有 top：顶栏（FeedHeader）自己挂 kTopBar 决定垂直位置，
                    // 再给列表一档顶部内边距就是两处叠加（本页原来是 8dp，Tab 页是 16dp，
                    // 于是同一层级的页面顶栏差了 12dp）。
                    // 底部这档是另一件事：悬浮胶囊不占布局，靠它留位（否则最后一条被永久盖住）。
                    bottom = KDimens.navScrollPadding + KSpacing.lg,
                ),
                verticalArrangement = Arrangement.spacedBy(KSpacing.sm),
            ) {
                item { FeedHeader(onOpenExplore = onOpenExplore) }

                when {
                    state.loading && state.posts.isEmpty() -> item {
                        // 内容骨架（M4）：形状贴着信息流卡片，内容补上时版式是连续的。
                        // 取 3 张是因为一屏通常能看到 2~3 张卡片 —— 骨架屏"铺满首屏"才有意义。
                        KListSkeleton(
                            modifier = Modifier.padding(
                                top = KSpacing.xs,
                                bottom = KDimens.navScrollPadding,
                            ),
                            items = 3,
                        )
                    }

                    state.error != null && state.posts.isEmpty() -> item {
                        KPlaceholder(
                            kind = KPlaceholderKind.Error,
                            title = "加载失败",
                            description = state.error?.displayMessage,
                            action = { KButton("重试", onClick = { scope.launch { list.refresh() } }) },
                        )
                    }

                    state.posts.isEmpty() && !state.loading -> item {
                        KPlaceholder(
                            kind = KPlaceholderKind.Empty,
                            title = "还没有内容",
                            description = "信息流是空的，刷新试试",
                        )
                    }

                    else -> items(state.posts, key = { it.id }) { post ->
                        PostCard(
                            post = post,
                            // 信息流里的**所有**点击（含配图与视频封面）都进帖子详情页。
                            //
                            // 用户反馈："首页帖子点了不要进入图片或者视频，应该是进入帖子详情页，
                            // 再点图片视频就是全屏观看"。也就是说首页只负责"发现"，
                            // 全屏看图/播放是详情页里的动作 —— 在此之前点配图会**直接弹全屏查看器**、
                            // 点视频封面会直接进播放器，既容易误触，也让人看不到正文与评论。
                            onImageClick = onOpenPost?.let { open -> { _, _, _ -> open(post.id) } },
                            onLike = {
                                if (!isLoggedIn) { onRequireLogin() } else scope.launch {
                                    when (val r = posts.toggleLike(post.id)) {
                                        is ApiResult.Failure -> toast = r.error.displayMessage
                                        else -> Unit
                                    }
                                }
                            },
                            onBookmark = {
                                if (!isLoggedIn) { onRequireLogin() } else scope.launch {
                                    when (val r = posts.toggleBookmark(post.id)) {
                                        is ApiResult.Success -> toast = if (r.data) "已收藏" else "已取消收藏"
                                        is ApiResult.Failure -> toast = r.error.displayMessage
                                    }
                                }
                            },
                            onRepost = {
                                if (!isLoggedIn) { onRequireLogin() } else scope.launch {
                                    when (val r = posts.toggleRepost(post.id)) {
                                        is ApiResult.Success -> toast = if (r.data) "已转发" else "已取消转发"
                                        is ApiResult.Failure -> toast = r.error.displayMessage
                                    }
                                }
                            },
                            onClick = { onOpenPost?.invoke(post.id) },
                            myUserId = myUserId,
                            onEdit = onEdit,
                            // 评论图标原来是空实现（点了没反应），现在进详情页写评论
                            onComment = onOpenPost?.let { open -> { open(post.id) } },
                            // 视频封面同样进详情页（与配图一致）。
                            // **首页不自动播放**（M6.5，用户要求）：卡片上只有静态封面 +「视频」胶囊，
                            // 播放只发生在详情页里（那边进来就播、带声音）。
                            onVideoClick = onOpenPost?.let { open -> { open(post.id) } },
                            // 正文里的 #话题可点 → 搜该话题
                            onTagClick = onTagClick,
                            // 作者头像 / 昵称 → 这个人的主页
                            onOpenUser = onOpenUser,
                            onShare = {
                                // 系统分享 + 服务端计数（每用户每帖只计一次）
                                shareText(context, "$PROFILE_SHARE_BASE/post/${post.id}", "分享帖子")
                                scope.launch { posts.markShared(post.id) }
                            },
                            // 增删/重排自然滑动（M4）。key 已经是帖子 id，所以"插一条进来/删一条"
                            // 都是位移过渡而不是整列表跳一下（默认帧率无关的弹簧，不写裸时长）
                            modifier = Modifier.animateItem(),
                        )
                    }
                }

                if (state.loadingMore) {
                    item {
                        Box(
                            Modifier.fillMaxWidth().padding(KSpacing.md),
                            contentAlignment = Alignment.Center,
                        ) {
                            CircularProgressIndicator(color = c.accent, modifier = Modifier.size(20.dp))
                        }
                    }
                }
                if (state.endReached && state.posts.isNotEmpty()) {
                    item {
                        Box(
                            Modifier.fillMaxWidth().padding(KSpacing.md),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text("没有更多了", style = KType.footnote, color = c.textMuted)
                        }
                    }
                }
            }
        }

        if (toast != null) {
            KToast(
                text = toast!!,
                onDismiss = { toast = null },
                modifier = Modifier.align(Alignment.BottomCenter),
            )
        }
    }
}

/**
 * 页头：标题 + 右上角圆形搜索钮（设计稿首页形态）。
 *
 * 这里**不要**再放登录状态 / 服务端地址 / 刷新按钮：
 *  · 刷新 → 下拉手势（见 FeedScreen 的 PullToRefreshBox）；
 *  · 未登录 → 「主页」tab 的登录入口（AppShell 传给 ProfileScreen 的 onRequireLogin）。
 *
 * 为什么改成调用通用 [KPageHeader]（原来是一份手写的 Row）：手写那一版行高由 38dp 搜索钮
 * 撑出来，而 [KPageHeader] 在"无右侧钮/36dp 钮"时是另一个行高 —— 同一层级的五个 Tab 页
 * 于是有三个标题 y（真机实测 188/202/206px）。收敛成一个组件后，
 * 标题位置只由组件内部那一条行高规则 + 容器上的 [kTopBar] 决定。
 * 代价是本页页头与列表的间距从 `KSpacing.sm` 变成组件统一的 `KSpacing.xs`（差 4dp）。
 */
@Composable
private fun FeedHeader(onOpenExplore: () -> Unit) {
    val c = KTheme.colors
    KPageHeader(
        title = "首页",
        // 顶栏垂直位置的**唯一**来源（见 KWidgets.kTopBar）：状态栏安全区 + KSpacing.xs。
        modifier = Modifier.kTopBar(),
        trailing = {
            // 需要边界的次级控件一律 surface + borderStrong（项目里不存在「凹陷色」语义：
            // 旧的 --bg-input 与页底只有 1.04:1，边界读不出来）
            Box(
                modifier = Modifier
                    .size(KDimens.headerIconButton)
                    .clip(CircleShape)
                    .background(c.surface)
                    .border(1.dp, c.borderStrong, CircleShape)
                    .clickable(onClickLabel = "搜索", onClick = onOpenExplore),
                contentAlignment = Alignment.Center,
            ) {
                Glyph(tint = c.accent, kind = GlyphKind.Search, size = KDimens.navIcon)
            }
        },
    )
}
