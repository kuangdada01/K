package top.kuangdada.k.nativeapp.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
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
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import top.kuangdada.k.core.data.ApiResult
import top.kuangdada.k.core.data.PostRepository
import top.kuangdada.k.core.data.PostUi
import top.kuangdada.k.core.data.SessionRepository
import top.kuangdada.k.core.data.displayMessage
import top.kuangdada.k.core.designsystem.component.KButton
import top.kuangdada.k.core.designsystem.component.KPlaceholder
import top.kuangdada.k.core.designsystem.component.KListSkeleton
import top.kuangdada.k.core.designsystem.component.KPlaceholderKind
import top.kuangdada.k.core.designsystem.component.KTextField
import top.kuangdada.k.core.designsystem.theme.KDimens
import top.kuangdada.k.core.designsystem.theme.KRadius
import top.kuangdada.k.core.designsystem.theme.KSpacing
import top.kuangdada.k.core.designsystem.theme.KTheme
import top.kuangdada.k.core.designsystem.theme.KType
import top.kuangdada.k.nativeapp.ui.viewer.rememberImageViewerSimple

/**
 * ============================================================
 * 搜索发现（设计稿「搜索发现」——高亮首页 tab）
 * ============================================================
 * 设计稿要点：
 *  · **药丸搜索框**：`surface` 底 + `borderStrong` 描边，**不用凹陷色**
 *    （浅色凹陷色与页底只有 1.04:1，读不出边界 —— 凹陷语义已按 Q6 取消）；
 *  · 推荐卡片走实心卡（与首页同一套 PostCard）。
 *
 * 这里**不编造热搜榜**：服务端没有"热搜/推荐话题"接口，编一份假的比空着更糟
 * （用户点进去发现没内容）。首屏只给搜索框，输入后才出结果。
 */
@Composable
fun ExploreScreen(
    posts: PostRepository,
    session: SessionRepository,
    myUserId: Long = 0,
    /** 带着话题进来（点正文里的 #话题）：进来就直接出该话题的结果 */
    initialTag: String? = null,
    onEdit: ((PostUi) -> Unit)? = null,
    /** 打开帖子详情（点卡片 / 点评论数） */
    onOpenPost: ((postId: Long) -> Unit)? = null,
    /** 打开视频播放器（点视频封面） */
    onOpenVideo: ((postId: Long) -> Unit)? = null,
    /** 点结果卡片里的话题 → 换个话题继续搜 */
    onTagClick: ((String) -> Unit)? = null,
    /** 点结果卡片上的头像 / 昵称 → 进这个人的主页（与首页卡片同一套交互） */
    onOpenUser: ((userId: Long) -> Unit)? = null,
) {
    val c = KTheme.colors
    val scope = rememberCoroutineScope()
    val openViewer = rememberImageViewerSimple()
    val listState = rememberLazyListState()
    // 键盘「搜索」键按下后收起键盘（结果就在下面，不收键盘会挡住）
    val focusManager = androidx.compose.ui.platform.LocalFocusManager.current

    // 带着话题进来时，输入框里直接显示 #话题（用户一眼知道在搜什么）
    var keyword by remember(initialTag) {
        mutableStateOf(initialTag?.let { "#$it" }.orEmpty())
    }
    var resultList by remember { mutableStateOf<PostRepository.PostList?>(null) }
    var toast by remember { mutableStateOf<String?>(null) }
    // 已经发起过搜索的查询串：避免"输入框内容没变却重复打接口"
    var lastQuery by remember { mutableStateOf<String?>(null) }

    /**
     * ⚠️ 必须用 `collectAsState()` **订阅**状态，不能写 `resultList?.state?.value`。
     *
     * 踩过的坑（真机 bug）：`.value` 只是"读一次快照"，Compose 不会因此重组 ——
     * 于是 `refresh()` 把 loading 置 true、界面画出转圈之后，接口即使 200 回来
     * （服务端日志里 `GET /api/posts/search?tag=风景 → 200`）也**再也不会重组**，
     * 页面就永远停在转圈。首页一直是对的（用的就是 collectAsState），
     * 只有这里是从一开始就写成 `.value`。
     */
    val emptyState = remember { MutableStateFlow(PostRepository.ListState()) }
    val state by (resultList?.state ?: emptyState).collectAsState()
    val hasSearched = resultList != null

    /**
     * 发起搜索。`#xxx` 走**话题精确匹配**（服务端 `tag` 参数，命中 post_tags），
     * 其余走标题/正文模糊匹配（`q`）—— 与服务端 `/api/posts/search` 的语义一致。
     */
    fun runSearch(raw: String) {
        val text = raw.trim()
        if (text.isEmpty()) return
        val tag = text.removePrefix("#").trim().takeIf { text.startsWith("#") && it.isNotEmpty() }
        val list = posts.newList(
            PostRepository.Source.Search(
                keyword = if (tag == null) text else null,
                tag = tag,
            )
        )
        lastQuery = text
        resultList = list
        scope.launch { list.refresh() }
    }

    // 进页面：带话题 → 立刻出结果；否则等用户输入
    LaunchedEffect(initialTag) {
        if (!initialTag.isNullOrBlank()) runSearch("#$initialTag")
    }

    /**
     * 边打边搜（停手 500ms 再打）：以前只有那个很小的「搜索」两个字能触发，
     * 用户敲完回车没反应 → 反馈"搜索帖子不可用"。
     */
    LaunchedEffect(keyword) {
        val text = keyword.trim()
        if (text.isEmpty()) return@LaunchedEffect
        kotlinx.coroutines.delay(500)
        if (text != lastQuery) runSearch(text)
    }

    // 滚到底自动续拉
    LaunchedEffect(listState, resultList) {
        snapshotFlow { listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0 }
            .distinctUntilChanged()
            .collect { last ->
                val s = resultList?.state?.value
                if (s != null && last >= s.posts.size - 3 && s.posts.isNotEmpty()) {
                    resultList?.loadMore()
                }
            }
    }

    Box(modifier = Modifier.background(c.bgPage)) {
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxWidth(),
            contentPadding = PaddingValues(
                start = KSpacing.md,
                end = KSpacing.md,
                // 这里**不能**有 top：页头那一项自己挂 kTopBar（见 KWidgets.kTopBar）。
                // 原来这档 16dp 叠在页头的 statusBarsPadding 上，本页顶栏被压到状态栏下 24dp。
                bottom = KDimens.navScrollPadding + KSpacing.lg,
            ),
            verticalArrangement = Arrangement.spacedBy(KSpacing.sm),
        ) {
            item {
                Column(
                    // 顶栏垂直位置的唯一来源（状态栏安全区 + KSpacing.xs）
                    modifier = Modifier.kTopBar(),
                    verticalArrangement = Arrangement.spacedBy(KSpacing.sm),
                ) {
                    KPageHeader(title = "发现", subtitle = "搜索帖子内容与 #话题")
                    KTextField(
                        value = keyword,
                        onValueChange = { keyword = it },
                        placeholder = "搜索帖子 / #话题",
                        shape = RoundedCornerShape(KRadius.pill),
                        // 键盘右下角给「搜索」键：以前敲回车毫无反应（只能点右边那两个字）
                        keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                            imeAction = androidx.compose.ui.text.input.ImeAction.Search,
                        ),
                        keyboardActions = androidx.compose.foundation.text.KeyboardActions(
                            onSearch = {
                                runSearch(keyword)
                                focusManager.clearFocus()
                            },
                        ),
                        trailing = {
                            Text(
                                text = "搜索",
                                style = KType.caption,
                                color = if (keyword.isBlank()) c.textMuted else c.accent,
                                modifier = Modifier
                                    .clip(RoundedCornerShape(KRadius.chip))
                                    .clickable(enabled = keyword.isNotBlank()) { runSearch(keyword) }
                                    .padding(horizontal = KSpacing.xs, vertical = KSpacing.xxs),
                            )
                        },
                    )
                }
            }

            when {
                !hasSearched -> item {
                    KPlaceholder(
                        kind = KPlaceholderKind.Empty,
                        title = "输入关键词开始搜索",
                        description = "支持按内容搜索，也支持 #话题 标签。" +
                            "服务端没有热搜榜接口，所以这里不展示榜单。",
                    )
                }

                state.loading && state.posts.isEmpty() -> item {
                    // 内容骨架（M4）：与信息流同一套版式
                    KListSkeleton(modifier = Modifier.padding(vertical = KSpacing.xs), items = 3)
                }

                state.error != null && state.posts.isEmpty() -> item {
                    KPlaceholder(
                        kind = KPlaceholderKind.Error,
                        title = "搜索失败",
                        description = state.error?.displayMessage,
                        action = { KButton("重试", onClick = { runSearch(keyword) }) },
                    )
                }

                state.posts.isEmpty() -> item {
                    KPlaceholder(
                        kind = KPlaceholderKind.Empty,
                        title = "没有匹配的内容",
                        description = "换个关键词或话题标签试试",
                    )
                }

                else -> items(state.posts, key = { it.id }) { post ->
                    PostCard(
                        post = post,
                        myUserId = myUserId,
                        onEdit = onEdit,
                        onImageClick = openViewer,
                        onLike = {
                            scope.launch {
                                when (val r = posts.toggleLike(post.id)) {
                                    is ApiResult.Failure -> toast = r.error.displayMessage
                                    else -> Unit
                                }
                            }
                        },
                        onBookmark = {
                            scope.launch {
                                when (val r = posts.toggleBookmark(post.id)) {
                                    is ApiResult.Success -> toast = if (r.data) "已收藏" else "已取消收藏"
                                    is ApiResult.Failure -> toast = r.error.displayMessage
                                }
                            }
                        },
                        onRepost = {
                            scope.launch {
                                when (val r = posts.toggleRepost(post.id)) {
                                    is ApiResult.Success -> toast = if (r.data) "已转发" else "已取消转发"
                                    is ApiResult.Failure -> toast = r.error.displayMessage
                                }
                            }
                        },
                        onClick = { onOpenPost?.invoke(post.id) },
                        onComment = onOpenPost?.let { open -> { open(post.id) } },
                        onVideoClick = onOpenVideo?.let { open -> { open(post.id) } },
                        onTagClick = onTagClick,
                        // 作者头像 / 昵称 → 这个人的主页
                        onOpenUser = onOpenUser,
                        // 增删/重排自然滑动（M4）
                        modifier = Modifier.animateItem(),
                    )
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

    // session 目前只用于未来的"推荐关注"；显式引用避免"未使用参数"的误导
    remember(session) { session.isLoggedIn }
}
