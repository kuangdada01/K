package top.kuangdada.k.core.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import top.kuangdada.k.core.data.api.CommentDto
import top.kuangdada.k.core.data.api.CommentLikeResult
import top.kuangdada.k.core.data.api.CreateCommentRequest

/**
 * ============================================================
 * 评论仓库（server/src/routes/posts/comments.ts）
 * ============================================================
 * 三个服务端语义必须照搬：
 *
 * 1. **列表是"按父评论+时间"的扁平数组**（不是嵌套 JSON）：顶级评论与它的回复混在同一个数组里，
 *    靠 `parent_id` / `parent_username` 表达关系。所以要在客户端 [buildTree] 组一层树
 *    —— 不组的话回复会以"看起来像顶级评论"的样子插在中间。
 * 2. `after_id` 是**顶级评论 id 的升序游标**（不是 offset），分页续拉传"上一页最后一条顶级评论 id"。
 *    另外：**不传任何分页参数**时服务端返回"完整评论树"（老契约、有硬上限），
 *    所以调用点要么只读详情接口内嵌的那份，要么显式带 `limit`。
 * 3. 发表评论是 `{ content, parentId }`，`parentId` 非空 = 回复；服务端会额外校验
 *    父评论属于同一帖子，并给被回复者/作者发通知。
 */
class CommentRepository(private val session: SessionRepository) {

    private val baseUrl: String get() = session.api.baseUrl

    /**
     * 评论的**会话内缓存**（postId → 已组好树的列表）。
     *
     * 为什么需要：详情页在"进全屏视频 / 退回来"这一跳里会**离开组合**，它的评论列表是
     * 页面本地状态，跟着一起没了 —— 回来时只能重新拉一遍，屏幕上先空 1~2 秒
     * （转一个加载圈）。用户实测的原话是"退出全屏中间还有一个绿圈转 1-2 秒"。
     *
     * 留一份上次的结果，回来先画它、**同时后台刷新**：观感与首页的帖子缓存一致，
     * 也不会因为"这一秒里别人正好评论了"而显示旧数据（刷新回来会覆盖）。
     *
     * 容量 8 条帖子：详情页的评论是"看完就走"的，不需要按浏览历史无限攒。
     */
    private val cache = object : LinkedHashMap<Long, List<CommentUi>>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Long, List<CommentUi>>?) =
            size > COMMENT_CACHE_MAX
    }

    /** 上次拉到的评论（`null` = 这个帖子还没拉过）。UI 用它做首帧种子 */
    @Synchronized
    fun cached(postId: Long): List<CommentUi>? = cache[postId]

    /** 记一份最新的评论（首屏拉到、增删改之后由详情页同步进来） */
    @Synchronized
    fun remember(postId: Long, list: List<CommentUi>) {
        cache[postId] = list
    }

    /** 丢掉某个帖子的评论缓存（删帖时用） */
    @Synchronized
    fun forget(postId: Long) {
        cache.remove(postId)
    }

    /** 评论在 UI 侧的表示（含头像绝对地址、相对时间、是否本人、一层回复） */
    data class CommentUi(
        val raw: CommentDto,
        val avatarUrl: String?,
        val timeText: String,
        val isMine: Boolean,
        val replies: List<CommentUi> = emptyList(),
    ) {
        val id: Long get() = raw.id
    }

    /**
     * 拉一页评论。
     *
     * @param afterId 续拉时传**上一页最后一条顶级评论**的 id；首页传 null
     * @return 顶级评论（含各自的回复）与"是否还有更多"
     */
    suspend fun list(postId: Long, afterId: Long? = null, limit: Int = 20): ApiResult<Pair<List<CommentUi>, Boolean>> =
        call {
            val r = session.api.posts.comments(postId = postId, afterId = afterId, limit = limit)
            // 续拉时不能只按本页组树：本页的回复可能挂在上一页的顶级评论下（服务端是扁平返回），
            // 这种情况它会被当作顶级评论显示 —— 可接受（回复内容与作者名都在），
            // 真正的修复是让服务端按父评论分页，属于接口演进。
            val page = buildCommentTree(r.comments, session.tokens.userId, baseUrl) to r.hasMore
            // 只有**第一页**才是"完整首屏"，才写缓存（续拉是往已有列表上追加，
            // 直接覆盖会把用户已经看到的上一页也丢掉）
            if (afterId == null) remember(postId, page.first)
            page
        }

    /** 发表评论（[parentId] 非空 = 回复某条评论） */
    suspend fun create(postId: Long, content: String, parentId: Long? = null): ApiResult<CommentUi> = call {
        val dto = session.api.posts.createComment(postId, CreateCommentRequest(content.trim(), parentId))
        dto.toUi(isMine = dto.userId == session.tokens.userId)
    }

    /** 删除自己的评论（服务端只允许删自己的，级联删子回复） */
    suspend fun delete(commentId: Long): ApiResult<Unit> = call {
        // 响应体（SimpleSuccess）在这里丢掉：块尾表达式的值由声明返回类型 ApiResult<Unit> 定为 Unit。
        // 原来多写了一个尾随 `Unit` —— 它是纯表达式，编译器报 UNUSED_EXPRESSION（全量重编可见）。
        session.api.posts.deleteComment(commentId)
    }

    /** 评论点赞/取消（[liked] 传当前状态，内部决定调 POST 还是 DELETE） */
    suspend fun toggleLike(commentId: Long, liked: Boolean): ApiResult<CommentLikeResult> = call {
        if (liked) session.api.posts.unlikeComment(commentId) else session.api.posts.likeComment(commentId)
    }

    // ---------------------------------------------------------------

    private fun CommentDto.toUi(isMine: Boolean, replies: List<CommentUi> = emptyList()): CommentUi =
        CommentUi(
            raw = this,
            avatarUrl = resolveUrl(avatar, baseUrl),
            timeText = relativeTime(createdAt),
            isMine = isMine,
            replies = replies,
        )

    private suspend fun <T> call(block: suspend () -> T): ApiResult<T> =
        withContext(Dispatchers.IO) {
            try {
                ApiResult.Success(block())
            } catch (t: Throwable) {
                ApiResult.Failure(mapErrorFromThrowable(t))
            }
        }
}

/**
 * 评论缓存最多留几个帖子（见 `CommentRepository.cache`）。
 *
 * 8 是"来回翻几个帖子"的量级：再小会在连续跳转时失效，再大没有意义 ——
 * 评论是详情页的附属内容，用户不会靠它回溯浏览历史。
 */
private const val COMMENT_CACHE_MAX = 8

/**
 * 把服务端的**扁平**评论数组组成一层树（顶级 + 各自的回复）。
 *
 * 抽成顶层纯函数是为了能单测：组树规则有几个"看着无所谓、错了会丢评论"的边界
 * （孤儿回复、跨页回复、同一时间戳的排序），而 `CommentRepository` 本身要 Context
 * 才能构造，单测里起不来。见 `CommentTreeTest`。
 *
 * 两种"孤儿"都不能丢：
 *  · `parent_id == null` → 顶级；
 *  · `parent_id` 指向的父评论**不在本页**（分页 / 被删）→ 也当顶级展示，
 *    否则用户会看到"回复凭空消失"。
 */
internal fun buildCommentTree(rows: List<CommentDto>, myUserId: Long, baseUrl: String): List<CommentRepository.CommentUi> {
    val byId = rows.associateBy { it.id }
    val children = HashMap<Long, MutableList<CommentDto>>()
    rows.forEach { row ->
        val parent = row.parentId
        if (parent != null && byId.containsKey(parent)) {
            children.getOrPut(parent) { mutableListOf() } += row
        }
    }
    fun CommentDto.toUi(replies: List<CommentRepository.CommentUi> = emptyList()) =
        CommentRepository.CommentUi(
            raw = this,
            avatarUrl = resolveUrl(avatar, baseUrl),
            timeText = relativeTime(createdAt),
            isMine = userId == myUserId,
            replies = replies,
        )
    return rows
        .filter { it.parentId == null || !byId.containsKey(it.parentId) }
        .sortedWith(compareBy({ it.createdAt }, { it.id }))
        .map { root ->
            root.toUi(
                replies = children[root.id].orEmpty()
                    .sortedWith(compareBy({ it.createdAt }, { it.id }))
                    .map { it.toUi() },
            )
        }
}
