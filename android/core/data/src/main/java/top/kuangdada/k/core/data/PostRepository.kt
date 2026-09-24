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
     * **单帖状态表**：`postId -> 这一条帖子的最新状态`。
     *
     * 为什么需要它（用户实测反馈：「五个元素只在首页生效在详情页不生效啊，2 套动效？
     * 用首页的就行了，一套共用联动的」）：
     *
     * 详情页原来把帖子存成自己的一份 `mutableStateOf(posts.cached(postId))` 快照 ——
     * 它**完全在 `lists` 之外**，于是 `applyToAll` 遍历所有列表也碰不到它。
     * 结果就是单向联动：详情页 `refreshDetail` 会写回列表（所以首页跟着变），
     * 而**首页点赞/收藏/转发，详情页那颗心纹丝不动**（连 `KLikeButton` 的弹跳/填色
     * 都触发不了，因为它的 `liked` 参数压根没变）。
     *
     * 现在这里维护一份按 id 索引的状态流：详情页 `collectAsState` 它，
     * 于是**详情页与首页读的是同一份数据**，互动一动两边同时变 —— 一套、联动。
     *
     * 为什么是"状态表"而不是"详情页自己 collect 所有列表"：
     * 详情页只关心一条帖子，让它去遍历所有列表找自己那条既慢又绕；
     * 而且"这条帖子在哪个列表里"是个偶然事实（首页/搜索/主页都可能没加载过它）。
     */
    private val detailStates = LinkedHashMap<Long, MutableStateFlow<PostUi?>>()

    /** 取某条帖子的状态流（没有就建一个初始为空的）—— 详情页订阅它 */
    @Synchronized
    fun detailFlow(postId: Long): StateFlow<PostUi?> {
        detailStates[postId]?.let { return it.asStateFlow() }
        // 容量上限：详情页的状态流不会自己消失（订阅者走了也没人通知仓库），
        // 一路刷下去这张表会变成一份无限增长的帖子缓存。超过上限就丢最老的 ——
        // 丢掉的后果只是"那条帖子以后要重新种子一次"，没有正确性问题。
        while (detailStates.size >= DETAIL_CACHE_MAX) {
            val oldest = detailStates.keys.firstOrNull() ?: break
            detailStates.remove(oldest)
        }
        return MutableStateFlow<PostUi?>(null).also { detailStates[postId] = it }.asStateFlow()
    }

    /**
     * 往单帖状态表里推一条最新状态（[applyToAll] / [refreshDetail] 里调）。
     *
     * 只在**这条帖子的流已经被创建**时推 —— 没人订阅就没必要留着，
     * 否则一个用户的浏览历史会把这张表撑成一份无限增长的帖子缓存。
     */
    @Synchronized
    private fun pushDetail(postId: Long, ui: PostUi) {
        detailStates[postId]?.value = ui
    }

    /** 让单帖状态表里那条失效（本地摘帖时调，详情页据此知道"这条没了"） */
    @Synchronized
    private fun clearDetail(postId: Long) {
        detailStates[postId]?.value = null
    }

    /**
     * **首帧种子**：把一条帖子塞进单帖状态流，让详情页进来就有内容可画。
     *
     * 只在**当前为空**时写 —— 详情页可能是在"流里已经有更新鲜的状态"之后才组合的
     * （比如从详情页返回列表又立刻点进同一条），这时拿列表缓存去覆盖会把新状态写旧。
     *
     * @return 是否真的写进去了（调用方一般不需要，方便测试/调试）
     */
    @Synchronized
    fun seedDetail(postId: Long, ui: PostUi): Boolean {
        val flow = detailStates[postId] ?: return false
        if (flow.value != null) return false
        flow.value = ui
        return true
    }

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

    /**
     * 收藏 / 取消收藏。
     *
     * **除了就地把标记位同步到所有列表，还要同步维护「我的收藏」那份列表的成员**：
     * 成功收藏要把这条帖**插进去**、取消收藏要把它**摘掉**。只用 [applyToAll] 的话，
     * 收藏页里根本不会出现刚收藏的帖子（那条帖压根不在它的 `posts` 数组里，
     * 没有东西可改）—— 用户看到的就是"收藏完进主页没更新，必须重启 App"。
     */
    suspend fun toggleBookmark(postId: Long): ApiResult<Boolean> {
        val target = findPost(postId) ?: return ApiResult.Failure(ApiError.Unknown("帖子不存在"))
        val next = !target.isBookmarked
        applyToAll(postId) { it.copy(post = it.post.copy(bookmarked = if (next) 1 else 0)) }
        if (next) {
            ensureInList(Source.Bookmarks, postId) { it.copy(post = it.post.copy(bookmarked = 1)) }
        } else {
            removeFromList(Source.Bookmarks, postId)
        }
        return when (val result = request { if (next) session.api.posts.bookmark(postId) else session.api.posts.unbookmark(postId) }) {
            is ApiResult.Success -> {
                applyToAll(postId) { it.copy(post = it.post.copy(bookmarked = result.data.bookmarked.toIntFlag())) }
                ApiResult.Success(result.data.bookmarked)
            }
            is ApiResult.Failure -> {
                // 回滚：标记位还原，成员也还原（收藏失败不该在收藏页里留下一条）
                applyToAll(postId) { target }
                if (next) removeFromList(Source.Bookmarks, postId) else Unit
                result
            }
        }
    }

    /**
     * 转发 / 取消转发。成员同步的理由与 [toggleBookmark] 完全相同，
     * 只是作用在「我的转发」那份列表（`Source.Reposts`）上。
     */
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
        if (next) {
            // 注意：这里的 transform 只做**幂等赋值**，不做增量计算 ——
            // `findPost` 取到的那份已经过了上面 `applyToAll` 的乐观更新（repostCount 已经 +1），
            // 再写一次 `+1` 会变成 +2（同一份数据被更新两遍）。
            ensureInList(Source.Reposts, postId) {
                it.copy(post = it.post.copy(reposted = 1))
            }
        } else {
            removeFromList(Source.Reposts, postId)
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
                if (next) removeFromList(Source.Reposts, postId) else Unit
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
     *
     * ⚠️ 也要直接推**单帖状态表**：深链进来时列表里没有这条帖子，
     * `applyToAll` 的 `map` 扫过去没有可改的 → 详情页拿到的就还是旧状态。
     */
    suspend fun refreshDetail(postId: Long): ApiResult<PostUi> {
        val result = request { session.api.posts.detail(postId).post.toUi(baseUrl) }
        if (result is ApiResult.Success) {
            applyToAll(postId) { result.data }
            // 列表里没这条时上面那行是空转，这里直接落到单帖状态（详情页订阅的正是它）
            pushDetail(postId, result.data)
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
        // 单帖状态也要清 —— 否则详情页还留着一条已经被删掉的帖子（点进来看得见、互动全失败）
        clearDetail(postId)
    }

    /**
     * 找一条帖子的当前状态：先扫所有列表，再兜底查**单帖状态表**。
     *
     * 第二段兜底是必须的：详情页可能是**深链直接进来的**（通知/分享链接），
     * 那时任何列表里都没有这条帖子 —— 只查列表的话 `toggleLike` 会直接返回
     * "帖子不存在"，用户点了赞**没有任何反应**（连报错都因为被忽略而看不见）。
     */
    @Synchronized
    private fun findPost(postId: Long): PostUi? =
        lists.firstNotNullOfOrNull { l -> l.snapshot().posts.firstOrNull { it.id == postId } }
            ?: detailStates[postId]?.value

    @Synchronized
    private fun applyToAll(postId: Long, transform: (PostUi) -> PostUi) {
        lists.forEach { list ->
            list.mutate { st ->
                st.copy(posts = st.posts.map { if (it.id == postId) transform(it) else it })
            }
        }
        // 同步单帖状态表 —— 详情页订阅的就是它（这正"一套联动"的落点）
        detailStates[postId]?.let { flow -> flow.value?.let { flow.value = transform(it) } }
    }

    /**
     * 把一条帖子**插到**某个 source 对应列表的最前面（该列表尚未创建 / 未加载过则什么都不做）。
     *
     * 为什么需要"插"这个动作（用户实测反馈：「点了收藏/转发进个人主页没更新，必须重启 App」）：
     * [applyToAll] 只做"就地改一条**已经躺在列表里**的帖子"，而收藏/转发列表的语义是
     * **帖子的增减** —— 收藏成功要**多出一条**，[applyToAll] 永远做不到这件事。
     * 于是刚收藏的帖子在收藏页里根本不存在，直到重启（列表重建、重新拉接口）才出现。
     *
     * 判断"要不要插"用的是 `listFor` 那套 key（用户 id + source）：
     *  · 列表还没有实例 → 不建也不插，反正用户第一次进那一页会 `loadIfEmpty()` 拉到全量；
     *  · 有实例但 `loaded == false` → 同理不插（这一次拉取会把全量带回来，插了反而可能重复）；
     *  · 有实例且已加载 → 插到最前（服务端也是按时间倒序，最新的在最前）。
     */
    @Synchronized
    private fun ensureInList(source: Source, postId: Long, transform: (PostUi) -> PostUi) {
        val list = listsBySource[session.tokens.userId to source] ?: return
        val st = list.snapshot()
        if (!st.loaded) return
        if (st.posts.any { it.id == postId }) return
        // 这条帖此刻不在目标列表里，所以只能从别的已加载列表里取它的最新样子
        // （标记位刚被 applyToAll 改过，取到的一定是改完的那份）
        val ui = findPost(postId) ?: return
        list.mutate { it.copy(posts = listOf(transform(ui)) + it.posts) }
    }

    /**
     * 把一条帖子从某个 source 对应列表里**摘掉**（该列表不存在则什么都不做）。
     *
     * 与 [ensureInList] 配对：取消收藏/取消转发之后，那条帖子就不该留在「收藏 / 转发」页里了 ——
     * [applyToAll] 只会把它的 `bookmarked` / `reposted` 标成 0，卡片照旧留在页面上，
     * 看起来就像"取消没生效"。
     */
    @Synchronized
    private fun removeFromList(source: Source, postId: Long) {
        val list = listsBySource[session.tokens.userId to source] ?: return
        list.mutate { st ->
            val next = st.posts.filterNot { it.id == postId }
            if (next.size == st.posts.size) st else st.copy(posts = next)
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

/**
 * 单帖状态表上限。
 *
 * 详情页每看一条帖子就建一个状态流，而**订阅者离开时仓库收不到通知**
 * （Compose 的 `collectAsState` 只是停止收集，不会告诉仓库"我不要了"）——
 * 没有上限的话一路刷下去这张表就是一份无限增长的帖子缓存。
 *
 * ⚠️ 淘汰按**插入顺序**（`LinkedHashMap` 的迭代序），不是"最近未使用"——
 * 所以理论上可能淘汰掉一条**仍被订阅**的流。取 32 就是为了让这件事实际不会发生：
 * 要连续浏览 32 条不同帖子的详情页才会触发，而那时被淘汰的那条早已不在屏幕上
 * （详情页是一次只显示一个的全屏页，不存在"同时订阅 32 条"的真实场景）。
 * 真被淘汰了的后果也只是"那个还开着的页面不再跟随互动更新"，不会崩。
 */
private const val DETAIL_CACHE_MAX = 32
