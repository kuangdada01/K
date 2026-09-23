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
            buildCommentTree(r.comments, session.tokens.userId, baseUrl) to r.hasMore
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
