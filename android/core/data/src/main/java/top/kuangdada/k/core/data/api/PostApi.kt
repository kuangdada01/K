package top.kuangdada.k.core.data.api

import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query
import top.kuangdada.k.core.data.model.BookmarkResult
import top.kuangdada.k.core.data.model.LikeResult
import top.kuangdada.k.core.data.model.Post
import top.kuangdada.k.core.data.model.PostListWithMore
import top.kuangdada.k.core.data.model.PostPage
import top.kuangdada.k.core.data.model.RepostResult
import top.kuangdada.k.core.data.model.ShareResult
import top.kuangdada.k.core.data.model.SimpleSuccess

/**
 * 帖子接口（server/src/routes/posts 下的 crud / interactions / comments / media），前缀 /api/posts
 *
 * 三个形状差异必须记住（服务端历史演进留下的）：
 *  · `GET /api/posts`            → `{ posts, total, page, totalPages }`（totalPages 驼峰）
 *  · `GET /api/posts/search`     → 同上
 *  · `GET /api/posts/bookmarks/me`、`/reposts/me` → `{ posts, has_more }`（**没有分页字段**，服务端硬上限截断）
 *  · `GET /api/posts/:id`        → `{ post, comments, comments_has_more, comments_total }`
 *
 * 注意：KDoc 里**不要**写带通配符的路径（形如 "posts" 后紧跟斜杠星号）——
 * Kotlin 的块注释**支持嵌套**，一个没闭合的注释起始符会把整份文件都注释掉。
 * 本次就踩了这个坑，表现为"整个 PostApi 未解析"，排查了很久。写路径时请写全名或用反引号包住。
 */
interface PostApi {

    @GET("api/posts")
    suspend fun feed(
        @Query("page") page: Int = 1,
        @Query("limit") limit: Int = 20,
    ): PostPage

    @GET("api/posts/search")
    suspend fun search(
        @Query("q") keyword: String? = null,
        @Query("tag") tag: String? = null,
        @Query("page") page: Int = 1,
        @Query("limit") limit: Int = 20,
    ): PostPage

    @GET("api/posts/bookmarks/me")
    suspend fun bookmarks(): PostListWithMore

    @GET("api/posts/reposts/me")
    suspend fun reposts(): PostListWithMore

    @GET("api/posts/{id}")
    suspend fun detail(@Path("id") id: Long): PostDetailResponse

    /**
     * 删除**自己的**帖子（`server/src/routes/posts/crud.ts` 的 `DELETE /:id`）。
     *
     * 认证必须；服务端在 `postService.deletePost(postId, req.user!.id)` 里校验归属，
     * 删别人的会 403。级联：评论/点赞/通知由外键清理，图片/视频/封面文件由服务端删磁盘。
     *
     * 响应形状是 `{ message: 'Post deleted' }`，与登录那批 `{ message }` 接口同形（[SimpleSuccess]）。
     */
    @DELETE("api/posts/{id}")
    suspend fun deletePost(@Path("id") id: Long): SimpleSuccess

    // ---- 互动（全部要求登录） ----

    @POST("api/posts/{id}/like")
    suspend fun like(@Path("id") id: Long): LikeResult

    @DELETE("api/posts/{id}/like")
    suspend fun unlike(@Path("id") id: Long): LikeResult

    @POST("api/posts/{id}/bookmark")
    suspend fun bookmark(@Path("id") id: Long): BookmarkResult

    @DELETE("api/posts/{id}/bookmark")
    suspend fun unbookmark(@Path("id") id: Long): BookmarkResult

    @POST("api/posts/{id}/repost")
    suspend fun repost(@Path("id") id: Long): RepostResult

    @DELETE("api/posts/{id}/repost")
    suspend fun unrepost(@Path("id") id: Long): RepostResult

    @POST("api/posts/{id}/share")
    suspend fun share(@Path("id") id: Long): ShareResult

    // ---- 评论（server/src/routes/posts/comments.ts） ----

    /**
     * 评论列表。**带 `after_id` 或 `limit` 才走分页形态**（服务端判断：
     * 两个参数都没有时返回"完整评论树"，而完整树在热帖上没有上限保护会被硬截断）。
     * 所以这里两个参数都显式传，永远走分页分支。
     */
    @GET("api/posts/{id}/comments")
    suspend fun comments(
        @Path("id") postId: Long,
        @Query("after_id") afterId: Long? = null,
        @Query("limit") limit: Int? = null,
    ): PostCommentsResponse

    /** 发表评论 / 回复（`parentId` 非空即回复；服务端会校验父评论属于同一帖子） */
    @POST("api/posts/{id}/comments")
    suspend fun createComment(
        @Path("id") postId: Long,
        @Body body: CreateCommentRequest,
    ): CommentDto

    /** 删除自己的评论 */
    @DELETE("api/posts/comments/{id}")
    suspend fun deleteComment(@Path("id") commentId: Long): SimpleSuccess

    @POST("api/posts/comments/{id}/like")
    suspend fun likeComment(@Path("id") commentId: Long): CommentLikeResult

    @DELETE("api/posts/comments/{id}/like")
    suspend fun unlikeComment(@Path("id") commentId: Long): CommentLikeResult
}

/** GET /api/posts/:id 的响应（本轮只用 post，评论留给后续里程碑） */
@kotlinx.serialization.Serializable
data class PostDetailResponse(
    val post: Post,
    val comments: List<CommentDto> = emptyList(),
    @kotlinx.serialization.SerialName("comments_has_more") val commentsHasMore: Boolean = false,
    @kotlinx.serialization.SerialName("comments_total") val commentsTotal: Int = 0,
)

/** 评论（shared/src/types.ts Comment）。本轮只读展示用，字段与类型严格对齐。 */
@kotlinx.serialization.Serializable
data class CommentDto(
    val id: Long,
    @kotlinx.serialization.SerialName("user_id") val userId: Long,
    @kotlinx.serialization.SerialName("post_id") val postId: Long,
    @kotlinx.serialization.SerialName("parent_id") val parentId: Long? = null,
    val content: String = "",
    @kotlinx.serialization.SerialName("created_at") val createdAt: String = "",
    val username: String = "",
    val avatar: String? = null,
    @kotlinx.serialization.SerialName("like_count") val likeCount: Int = 0,
    val liked: Int? = null,
    @kotlinx.serialization.SerialName("parent_content") val parentContent: String? = null,
    @kotlinx.serialization.SerialName("parent_username") val parentUsername: String? = null,
)

/** GET /api/posts/:id/comments 的分页响应 */
@kotlinx.serialization.Serializable
data class PostCommentsResponse(
    val comments: List<CommentDto> = emptyList(),
    @kotlinx.serialization.SerialName("has_more") val hasMore: Boolean = false,
)

/**
 * 发表评论的请求体，字段与 `shared/src/schemas/post.ts` 的 `commentSchema` 对齐
 * （`content` 去空白后 1..500 字；`parentId` 可空 = 顶级评论）。
 */
@kotlinx.serialization.Serializable
data class CreateCommentRequest(
    val content: String,
    val parentId: Long? = null,
)

/** 评论点赞结果（`POST/DELETE /api/posts/comments/:id/like`） */
@kotlinx.serialization.Serializable
data class CommentLikeResult(
    val liked: Boolean = false,
    @kotlinx.serialization.SerialName("like_count") val likeCount: Int = 0,
)
