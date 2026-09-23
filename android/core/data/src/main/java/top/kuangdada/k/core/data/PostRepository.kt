package top.kuangdada.k.core.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withContext
import top.kuangdada.k.core.data.model.PostPage

/**
 * ============================================================
 * 帖子仓库（PostRepository）
 * ============================================================
 * 负责信息流/搜索/用户帖子/收藏/转发的分页与互动。
 *
 * **设计修正（M2 起的形态）**：M1 时仓库里只有一份 feed 状态，一旦"个人主页的帖子"
 * 与"首页信息流"同时存在就会互相污染（点赞一条，另一页也跟着变、分页游标打架）。
 * 现在改成：仓库**无状态**，每个列表由 [newList] 单独创建、各自持有分页游标与数据；
 * 互动（点赞/收藏/转发）由仓库统一执行，并**同步应用到所有已创建的列表**（同一帖子
 * 在多个列表里的状态必须一致，否则首页点过赞、主页里还是未赞）。
 *
 * 两条一直保留的约定：
 *  1. **互动的乐观更新**：先在本地翻转并立刻反映到 UI，成功后用服务端返回的计数校正；
 *     失败回滚并报错。弱网下点一次赞等一秒才有反应是不可接受的。
 *  2. **分页去重**：服务端分页期间若有新帖插入，同一页可能重复返回同一条 —— 按 id 去重，
 *     否则列表里会出现重复卡片。
 */
class PostRepository(private val session: SessionRepository) {

    private val baseUrl: String get() = session.api.baseUrl

    /** 列表数据源：决定拉哪个端点的哪一页 */
    sealed interface Source {
        /** 首页信息流 GET /api/posts */
        data object Feed : Source

        /** 搜索 GET /api/posts/search?q=&tag= */
        data class Search(val keyword: String?, val tag: String?) : Source

        /** 某用户的帖子 GET /api/users/:id/posts */
        data class UserPosts(val userId: Long) : Source

        /**
         * 某用户**转发**的帖子 GET /api/users/:id/reposts（他人主页的「转发」标签）。
         *
         * 与 [Reposts]（`/api/posts/reposts/me`）不是一回事：那个是"我的"，
         * 只有登录用户能看；这个是"某个用户公开的转发"，游客也能看。
         * 两者**响应形状也不同**：都是 `{ posts, has_more }`，但端点完全不同，
         * 混用会让"看别人的主页却拿到自己的转发列表"这种错误悄无声息地发生。
         */
        data class UserReposts(val userId: Long) : Source

        /** 我的收藏 GET /api/posts/bookmarks/me */
        data object Bookmarks : Source

        /** 我的转发 GET /api/posts/reposts/me */
        data object Reposts : Source
    }

    data class ListState(
        val posts: List<PostUi> = emptyList(),
        val page: Int = 0,
        val totalPages: Int = 1,
        val loading: Boolean = false,
        val refreshing: Boolean = false,
        val loadingMore: Boolean = false,
        /**
         * **这一份列表是否已经成功加载过**（与"有没有数据"是两件事）。
         *
         * 必须分开：一个空列表（用户没发过帖子）每次进页面都会被"空"判定为没加载过，
         * 于是每次重新请求 + 转一次圈 —— 用户看到的就是"主页怎么每次点都转圈"。
         */
        val loaded: Boolean = false,
        val error: ApiError? = null,
        val endReached: Boolean = false,
    )

    /**
     * 一个独立的帖子列表。每个页面（首页 / 主页 / 搜索 / 收藏）各持有一个，
     * 互不影响分页游标。
     */
    inner class PostList internal constructor(private val source: Source) {

        private val _state = MutableStateFlow(ListState())
        val state: StateFlow<ListState> = _state.asStateFlow()

        internal fun snapshot(): ListState = _state.value

        internal fun mutate(transform: (ListState) -> ListState) {
            _state.update(transform)
        }

        suspend fun refresh() {
            _state.update { it.copy(refreshing = true, error = null) }
            load(page = 1, replace = true)
        }

        /** 首次进入时调用（避免每次切换 tab 都重新拉）—— 判据是 [ListState.loaded]，不是"列表空不空" */
        suspend fun loadIfEmpty() {
            if (!_state.value.loaded && !_state.value.loading) refresh()
        }

        suspend fun loadMore() {
            val current = _state.value
            if (current.loading || current.loadingMore || current.endReached) return
            load(page = current.page + 1, replace = false)
        }

        private suspend fun load(page: Int, replace: Boolean) {
            _state.update {
                it.copy(loading = replace && it.posts.isEmpty(), loadingMore = !replace)
            }
            val result = withContext(Dispatchers.IO) {
                try {
                    when (val s = source) {
                        is Source.Feed -> ApiResult.Success(session.api.posts.feed(page))
                        is Source.Search -> ApiResult.Success(
                            session.api.posts.search(keyword = s.keyword, tag = s.tag, page = page)
                        )
                        is Source.UserPosts -> {
                            val r = session.api.users.posts(s.userId, page)
                            ApiResult.Success(PostPage(r.posts, r.total, r.page, r.totalPages))
                        }
                        // 他人转发：端点**没有分页**（服务端硬上限截断 + has_more），
                        // 只能一次给完 —— 与下面收藏/转发同一个处理方式
                        is Source.UserReposts -> {
                            if (page > 1) ApiResult.Success(PostPage()) else {
                                val r = session.api.users.reposts(s.userId)
                                ApiResult.Success(PostPage(r.posts, r.posts.size, 1, 1))
                            }
                        }
                        // 收藏/转发端点**没有分页**（服务端硬上限截断），只能一次给完
                        is Source.Bookmarks -> {
                            if (page > 1) ApiResult.Success(PostPage()) else {
                                val r = session.api.posts.bookmarks()
                                ApiResult.Success(PostPage(r.posts, r.posts.size, 1, 1))
                            }
                        }
                        is Source.Reposts -> {
                            if (page > 1) ApiResult.Success(PostPage()) else {
                                val r = session.api.posts.reposts()
                                ApiResult.Success(PostPage(r.posts, r.posts.size, 1, 1))
                            }
                        }
                    }
                } catch (t: Throwable) {
                    ApiResult.Failure(mapErrorFromThrowable(t))
                }
            }
            when (result) {
                is ApiResult.Success -> applyPage(result.data, replace)
                is ApiResult.Failure -> _state.update {
                    it.copy(
                        loading = false,
                        loadingMore = false,
                        refreshing = false,
                        error = result.error,
                    )
                }
            }
        }

        private fun applyPage(page: PostPage, replace: Boolean) {
            val incoming = page.posts.map { it.toUi(baseUrl) }
            _state.update { st ->
                val merged = if (replace) {
                    incoming
                } else {
                    val seen = st.posts.mapTo(HashSet()) { it.id }
                    st.posts + incoming.filterNot { it.id in seen }
                }
                st.copy(
                    posts = merged,
                    page = page.page,
                    totalPages = if (page.totalPages <= 0) 1 else page.totalPages,
                    loading = false,
                    loadingMore = false,
                    refreshing = false,
                    error = null,
                    endReached = page.page >= page.totalPages,
                    // 成功加载过就打标：之后 `loadIfEmpty()` 不再重复请求（哪怕是空列表）
                    loaded = true,
                )
            }
        }
    }

    /** 所有已创建的列表 —— 互动结果要同步到全部，避免同一帖子在不同页状态不一致 */
    private val lists = mutableListOf<PostList>()

    /**
     * **内容版本号**：发帖 / 编辑 / 删帖成功时自增。
     *
     * 为什么要有它：这些动作改变的是"有哪些帖子"，而**各页面的列表是各自缓存的**
     * （见类注释的"仓库无状态"）。不广播一下，用户从发布页回到主页时，
     * 那份缓存里还是没有刚发的那条 —— 只能重启 App 才看到（用户实测反馈）。
     *
     * 为什么不做成"自动把所有列表标脏"：那会让**点赞/收藏**这类高频互动也触发整表重拉，
     * 而它们只改一条帖子里的数字，已经由 `applyToAll` 就地同步了。
     * 这里刻意只覆盖"增减/改写帖子本身"的三类动作。
     *
     * 消费方式：UI 侧 `collectAsState` 后把它变化当成刷新信号（AppShell 就是这么做的）。
     */
    private val _contentVersion = MutableStateFlow(0)
    val contentVersion: StateFlow<Int> = _contentVersion.asStateFlow()

    /** 内容变了（发帖/编辑/删帖成功后调） */
    fun bumpContentVersion() {
        _contentVersion.update { it + 1 }
    }

    @Synchronized
    fun newList(source: Source): PostList = PostList(source).also { lists.add(it) }

    /**
     * 按 source 复用的列表（见 [listFor]）；搜索源只留最近几次，避免无限增长。
     *
     * key 里带上当前用户 id：收藏/转发这类 source 是**跨账号共用**的
     * （`Source.Bookmarks` 是个 object），不区分用户的话换个账号登录会先看到上一个人的收藏。
     */
    private val listsBySource = LinkedHashMap<Pair<Long, Source>, PostList>()

    /**
     * 取**同一个 source 的那一份列表**（没有就建）。
     *
     * 为什么不直接用 [newList]：它每次都新建 —— 页面离开组合再回来就是一条空列表，
     * 于是重新拉取、重新转圈（用户看到的"每进一次这个 tab 就转一次圈"）。
     * 同一个 source 复用同一份之后，重进「主页 / 我的转发 / 我的收藏」直接就有数据。
     *
     * 搜索源（每个关键词一个 `Source`）会无限增长，所以只保留最近 [SEARCH_CACHE_MAX] 个。
     */
    @Synchronized
    fun listFor(source: Source): PostList {
        val key = session.tokens.userId to source
        listsBySource[key]?.let { return it }
        val list = newList(source)
        listsBySource[key] = list
        if (source is Source.Search && listsBySource.count { it.key.second is Source.Search } > SEARCH_CACHE_MAX) {
            listsBySource.keys.firstOrNull { it.second is Source.Search }?.let { listsBySource.remove(it) }
        }
        return list
    }

    /**
     * 一个**永不加载**的空列表，供 UI 在"列表尚未建立"（未登录、tab 还没初始化）时兜底。
     *
     * 为什么需要它：Compose 要求 `collectAsState()` **无条件调用**，不能放在 `if`/`when` 分支里。
     * 之前用 `mutableStateOf(...)` 兜底是错的 —— 那是 `State`，不是 `StateFlow`，
     * `collectAsState` 的接收者类型对不上（编译器报的是"无法推断 T / 接收者类型不匹配"）。
     */
    @Synchronized
    fun emptyList(): PostList = PostList(Source.Bookmarks).also { it.mutate { s -> s.copy(endReached = true) } }

    /** 失效：帖子在别处被删除/更新后，用它可以强制整表重拉（本轮未接线，留给 M3） */
    @Synchronized
    fun invalidateAll() {
        lists.forEach { it.mutate { st -> st.copy(page = 0, endReached = false) } }
    }

    // ---------------------------------------------------------------
    // 互动：乐观更新（对所有列表同步生效）
    // ---------------------------------------------------------------

    suspend fun toggleLike(postId: Long): ApiResult<Boolean> {
        val target = findPost(postId) ?: return ApiResult.Failure(ApiError.Unknown("帖子不存在"))
        val next = !target.isLiked
        applyToAll(postId) { ui ->
            ui.copy(
                post = ui.post.copy(
                    liked = if (next) 1 else 0,
                    likeCount = (ui.likeCount + if (next) 1 else -1).coerceAtLeast(0),
                )
            )
        }
        return when (val result = request { if (next) session.api.posts.like(postId) else session.api.posts.unlike(postId) }) {
            is ApiResult.Success -> {
                applyToAll(postId) { ui ->
                    ui.copy(
                        post = ui.post.copy(
                            liked = result.data.liked.toIntFlag(),
                            likeCount = result.data.likeCount,
                        )
                    )
                }
                ApiResult.Success(result.data.liked)
            }
            is ApiResult.Failure -> {
                applyToAll(postId) { target }
                result
            }
        }
    }

    suspend fun toggleBookmark(postId: Long): ApiResult<Boolean> {
        val target = findPost(postId) ?: return ApiResult.Failure(ApiError.Unknown("帖子不存在"))
        val next = !target.isBookmarked
        applyToAll(postId) { it.copy(post = it.post.copy(bookmarked = if (next) 1 else 0)) }
        return when (val result = request { if (next) session.api.posts.bookmark(postId) else session.api.posts.unbookmark(postId) }) {
            is ApiResult.Success -> {
                applyToAll(postId) { it.copy(post = it.post.copy(bookmarked = result.data.bookmarked.toIntFlag())) }
                ApiResult.Success(result.data.bookmarked)
            }
            is ApiResult.Failure -> {
                applyToAll(postId) { target }
                result
            }
        }
    }

    suspend fun toggleRepost(postId: Long): ApiResult<Boolean> {
        val target = findPost(postId) ?: return ApiResult.Failure(ApiError.Unknown("帖子不存在"))
        val next = !target.isReposted
        applyToAll(postId) { ui ->
            ui.copy(
                post = ui.post.copy(
                    reposted = if (next) 1 else 0,
                    repostCount = (ui.repostCount + if (next) 1 else -1).coerceAtLeast(0),
                )
            )
        }
        return when (val result = request { if (next) session.api.posts.repost(postId) else session.api.posts.unrepost(postId) }) {
            is ApiResult.Success -> {
                applyToAll(postId) {
                    it.copy(
                        post = it.post.copy(
                            reposted = result.data.reposted.toIntFlag(),
                            repostCount = result.data.repostCount,
                        )
                    )
                }
                ApiResult.Success(result.data.reposted)
            }
            is ApiResult.Failure -> {
                applyToAll(postId) { target }
                result
            }
        }
    }

    /** 分享：服务端只做计数（每用户每帖只计一次），不做实际分享动作 */
    suspend fun markShared(postId: Long): ApiResult<Int> {
        val result = request { session.api.posts.share(postId) }
        if (result is ApiResult.Success) {
            applyToAll(postId) {
                it.copy(post = it.post.copy(shareCount = result.data.shareCount, shared = 1))
            }
        }
        return result.map { it.shareCount }
    }

    // ---------------------------------------------------------------

    /** 供详情页取缓存里的帖子（列表里没有 → null，详情页自己去拉 `GET /api/posts/:id`） */
    fun cached(postId: Long): PostUi? = findPost(postId)

    /**
     * 详情页用：拉单条帖子的最新状态（点赞/收藏/评论数可能已被别处改过）。
     * 拉到后**回写到所有列表**，避免"详情页点了赞、退回列表还是没赞"。
     */
    suspend fun refreshDetail(postId: Long): ApiResult<PostUi> {
        val result = request { session.api.posts.detail(postId).post.toUi(baseUrl) }
        if (result is ApiResult.Success) {
            applyToAll(postId) { result.data }
        }
        return result
    }

    /**
     * 评论数增减：详情页发/删评论后同步到列表卡片。
     * 只改计数、不回写整个帖子对象 —— 详情页拿到的是完整正文，回写会把列表里
     * 有意截断的正文/图片也一起替换掉（表现为"列表里的卡片突然变长"）。
     */
    fun bumpCommentCount(postId: Long, delta: Int) {
        if (delta == 0) return
        applyToAll(postId) { ui ->
            ui.copy(post = ui.post.copy(commentCount = (ui.commentCount + delta).coerceAtLeast(0)))
        }
    }

    /**
     * 删除自己的帖子（`DELETE /api/posts/:id`）。
     *
     * 成功后**立刻把它从所有已加载的列表里摘掉**，不等重新拉取 ——
     * 删完还留在页面上（要手动下拉才消失）是最容易被当成"删除失败"的表现。
     * 服务端已经删了，这里的本地移除是"同步视图"，失败时什么都不动。
     *
     * 与 [applyToAll] 的分工：那个是"就地改一条"，这个是"摘掉一条"。
     */
    suspend fun deletePost(postId: Long): ApiResult<Unit> {
        val result = request { session.api.posts.deletePost(postId); Unit }
        if (result is ApiResult.Success) {
            removeLocal(postId)
            bumpContentVersion()
        }
        return result
    }

    /**
     * 把一条帖子从**所有已加载的列表**里摘掉（不碰服务端）。
     *
     * 两个调用者：
     *  · [deletePost] 成功后同步视图；
     *  · 详情页发现该帖已 404（被别人删了）时，同样要把它从信息流里清掉 ——
     *    否则那条帖子会一直躺在列表里，点进去才发现"加载失败"。
     */
    @Synchronized
    fun removeLocal(postId: Long) {
        lists.forEach { list ->
            list.mutate { st ->
                val next = st.posts.filterNot { it.id == postId }
                // 只有真的少了一条才 copy：没这条帖子的列表保持原引用，
                // 避免触发一批无意义的重组
                if (next.size == st.posts.size) st else st.copy(posts = next)
            }
        }
    }

    @Synchronized
    private fun findPost(postId: Long): PostUi? =
        lists.firstNotNullOfOrNull { l -> l.snapshot().posts.firstOrNull { it.id == postId } }

    @Synchronized
    private fun applyToAll(postId: Long, transform: (PostUi) -> PostUi) {
        lists.forEach { list ->
            list.mutate { st ->
                st.copy(posts = st.posts.map { if (it.id == postId) transform(it) else it })
            }
        }
    }

    private suspend fun <T> request(block: suspend () -> T): ApiResult<T> =
        withContext(Dispatchers.IO) {
            try {
                ApiResult.Success(block())
            } catch (t: Throwable) {
                ApiResult.Failure(mapError(t))
            }
        }
}

private fun Boolean.toIntFlag(): Int = if (this) 1 else 0

/** 搜索列表缓存上限（按关键词缓存，留最近几个就够来回切） */
private const val SEARCH_CACHE_MAX = 8
