package top.kuangdada.k.core.data.api

import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * 关注接口（server/src/routes/friends.ts）。
 *
 * 三个端点的形状都不一样，必须按字面记（服务端历史演进的产物）：
 *  · `GET    /api/friends/status/:id` → `{ is_following }`（**没有**粉丝数）
 *  · `POST   /api/friends/:id`        → `{ is_following, followers_count }`
 *  · `DELETE /api/friends/:id`        → `{ is_following, followers_count }`
 *
 * 两个"写错就静默出事"的点：
 *  1. 状态端点返回的是 **`is_following`（蛇形）**，不是 `isFollowing` ——
 *     字段名写错时 kotlinx.serialization 会走默认值 `false`（因为下面都给了默认值），
 *     表现出来是"关注过的人一进主页又变成未关注"，不报任何错；
 *  2. 关注/取关**只能认响应里的 `is_following`**，不能拿"请求成功"当结果：
 *     `POST` 走的是 `INSERT OR IGNORE`（重复关注也是 200），
 *     `DELETE` 对没关注过的用户同样返回 200 且 `is_following: false`。
 *
 * 三个端点**都要求登录**（`authMiddleware`）：未登录时服务端 401，
 * 客户端应当先弹登录而不是先发请求（见 UserProfileScreen 的 onRequireLogin 分支）。
 *
 * 关注自己是 400「不能关注自己」、目标不存在是 404「用户不存在」——
 * 这两种都不该被当成网络错误，文案由服务端给（`displayMessage` 会带出来）。
 */
interface FriendsApi {

    /** 当前登录用户是否关注了 `id`。注意字段名是蛇形的 `is_following` */
    @GET("api/friends/status/{id}")
    suspend fun status(@Path("id") userId: Long): FollowStatusDto

    /** 关注（幂等：重复关注不报错，返回最新的关注状态与粉丝数） */
    @POST("api/friends/{id}")
    suspend fun follow(@Path("id") userId: Long): FollowResultDto

    /** 取消关注（幂等：没关注过也返回 200） */
    @DELETE("api/friends/{id}")
    suspend fun unfollow(@Path("id") userId: Long): FollowResultDto

    /**
     * 某个用户的**粉丝列表**（谁关注了 Ta）。
     *
     * ⚠️ 必须**带上 `page`**（≥1）才会拿到分页形状；不带 page 的是老客户端形状
     * `{ users, has_more }`（服务端对那个形状钉死了「不新增字段」，App 不用）。
     * 排序由服务端做：**共同关注优先**（互关 → 我关注了 Ta → Ta 关注了我 → 用户名），
     * 客户端不要自己再排 —— 翻页窗口是按服务端顺序切的，本地重排会把人排乱。
     */
    @GET("api/friends/followers/{id}")
    suspend fun followers(
        @Path("id") userId: Long,
        @Query("page") page: Int,
        @Query("limit") limit: Int,
        /** 服务端搜索（用户名模糊 + id 子串）；空 = 不过滤 */
        @Query("q") query: String? = null,
    ): FollowListDto

    /** 某个用户的**关注列表**（Ta 关注了谁），形状与 [followers] 对称 */
    @GET("api/friends/following/{id}")
    suspend fun following(
        @Path("id") userId: Long,
        @Query("page") page: Int,
        @Query("limit") limit: Int,
        @Query("q") query: String? = null,
    ): FollowListDto
}

/** `GET /api/friends/status/:id` 的响应 */
@Serializable
data class FollowStatusDto(
    @SerialName("is_following") val isFollowing: Boolean = false,
)

/** `POST` / `DELETE /api/friends/:id` 的响应 */
@Serializable
data class FollowResultDto(
    @SerialName("is_following") val isFollowing: Boolean = false,
    /**
     * 目标用户的粉丝数（**关注/取关后的最新值**）。
     *
     * 为什么必须用它回填界面上那个数字：服务端的关注关系与 `GET /users/:id` 的
     * `followers_count` 是两次请求，不回填的话"点了关注，粉丝数还是旧的"。
     */
    @SerialName("followers_count") val followersCount: Int = 0,
)

/**
 * 关注/粉丝列表里的**一个人**（`GET /api/friends/{followers,following}/:id`，分页形状）。
 *
 * 三个关系字段都是 **0/1 整数**而不是布尔：服务端它们是 SQLite `EXISTS(...)` 的直出值
 * （与 Web 弹窗的 `is_following: number` 同源）。写成 `Boolean` 的话 kotlinx.serialization
 * 对 JSON 数字 `1` 直接抛异常（isLenient 也不救布尔），整页列表会变成错误页 ——
 * 所以这里必须是 Int，由仓库层再映射成 Kotlin 布尔。
 */
@Serializable
data class FollowUserDto(
    val id: Long = 0,
    val username: String = "",
    val avatar: String? = null,
    val bio: String = "",
    /** **查看者**是否关注了这个人 */
    @SerialName("is_following") val isFollowing: Int = 0,
    /** 这个人是否关注了**查看者** */
    @SerialName("follows_viewer") val followsViewer: Int = 0,
    /** 两人互相关注（= is_following && follows_viewer，服务端算好免得客户端再推） */
    @SerialName("is_mutual") val isMutual: Int = 0,
)

/**
 * `GET /api/friends/{followers,following}/:id?page=` 的响应（**分页形状**）。
 *
 * `totalPages` 决定还要不要继续翻页（与 Web 弹窗同一判据）；
 * `total` 是当前搜索词下命中的总人数（UI 拿它画「共 N 人」可选）。
 */
@Serializable
data class FollowListDto(
    val users: List<FollowUserDto> = emptyList(),
    val total: Int = 0,
    val page: Int = 1,
    val limit: Int = 20,
    val totalPages: Int = 0,
    @SerialName("has_more") val hasMore: Boolean = false,
)
