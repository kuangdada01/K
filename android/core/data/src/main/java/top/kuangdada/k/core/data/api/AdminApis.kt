package top.kuangdada.k.core.data.api

import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.PUT
import retrofit2.http.Path
import retrofit2.http.Query
import top.kuangdada.k.core.data.model.AdminAnnouncementPage
import top.kuangdada.k.core.data.model.AdminAnnouncementRow
import top.kuangdada.k.core.data.model.AdminPostPage
import top.kuangdada.k.core.data.model.AdminUserPage
import top.kuangdada.k.core.data.model.AdminUsersResponse
import top.kuangdada.k.core.data.model.AnnouncementsResponse
import top.kuangdada.k.core.data.model.BanRequest
import top.kuangdada.k.core.data.model.BanResult
import top.kuangdada.k.core.data.model.CreateAnnouncementRequest
import top.kuangdada.k.core.data.model.NotificationsResponse
import top.kuangdada.k.core.data.model.ResetPasswordRequest2
import top.kuangdada.k.core.data.model.SimpleSuccess

/**
 * 管理后台接口（server/src/routes/admin/ 的 users / posts / announcements 三个子路由）。
 *
 * 认证 + 管理员权限由组合入口的全局中间件保障（`authMiddleware → adminMiddleware`），
 * 所以这里不需要在路径上做任何额外处理；非管理员调用会直接 403。
 *
 * **一律带 `page` 参数**：服务端对用户/公告列表有两种响应形状（老客户端不带 page 走
 * `{ rows, has_more }`），带 `page` 才走分页形状 —— 这样客户端只需处理一种形状。
 */
interface AdminApi {

    // ---- 用户 ----

    @GET("api/admin/users")
    suspend fun users(
        @Query("page") page: Int = 1,
        @Query("limit") limit: Int = 20,
        @Query("q") query: String? = null,
    ): AdminUserPage

    /** 公告指定用户时用的轻量搜索（最多 10 条） */
    @GET("api/admin/users/search")
    suspend fun searchUsers(@Query("q") query: String): AdminUsersResponse

    @DELETE("api/admin/users/{id}")
    suspend fun deleteUser(@Path("id") userId: Long): SimpleSuccess

    @PUT("api/admin/users/{id}/password")
    suspend fun resetPassword(
        @Path("id") userId: Long,
        @Body body: ResetPasswordRequest2,
    ): SimpleSuccess

    /** 封禁天数只允许 1 / 7 / 30 / 365（服务端 schema 校验） */
    @POST("api/admin/users/{id}/ban")
    suspend fun ban(@Path("id") userId: Long, @Body body: BanRequest): BanResult

    @POST("api/admin/users/{id}/unban")
    suspend fun unban(@Path("id") userId: Long): BanResult

    // ---- 帖子 ----

    @GET("api/admin/posts")
    suspend fun posts(
        @Query("page") page: Int = 1,
        @Query("limit") limit: Int = 20,
        @Query("q") query: String? = null,
    ): AdminPostPage

    @DELETE("api/admin/posts/{id}")
    suspend fun deletePost(@Path("id") postId: Long): SimpleSuccess

    // ---- 公告 ----

    @GET("api/admin/announcements")
    suspend fun announcements(
        @Query("page") page: Int = 1,
        @Query("limit") limit: Int = 20,
        @Query("q") query: String? = null,
    ): AdminAnnouncementPage

    @POST("api/admin/announcements")
    suspend fun createAnnouncement(@Body body: CreateAnnouncementRequest): AdminAnnouncementRow

    @DELETE("api/admin/announcements/{id}")
    suspend fun deleteAnnouncement(@Path("id") id: Long): SimpleSuccess
}

/**
 * 公告（面向普通用户，`/api/announcements`）
 *
 * 注意这两个端点的认证要求不同（已核对源码）：
 *  · `GET /` 需要登录（authMiddleware）
 *  · `PUT /:id/read` 也需要登录
 * 与 `/api/posts` 那种 optionalAuth 的公开接口不一样。
 */
interface AnnouncementApi {

    @GET("api/announcements")
    suspend fun list(): AnnouncementsResponse

    @PUT("api/announcements/{id}/read")
    suspend fun markRead(@Path("id") id: Long): SimpleSuccess
}

/**
 * 通知（`/api/notifications`，评论/回复等互动通知）
 *
 * 三个端点都需要登录。当前 UI 只做**展示**（消息页「通知」标签），
 * 标记已读的端点先接到仓库层备用 —— 页面上还没有"点开一条通知去帖子详情"的流
 * （原生端没有帖子详情页），所以不自动标记，避免"看了却没读"或"没看就标读"两边不讨好。
 */
interface NotificationsApi {

    @GET("api/notifications")
    suspend fun list(): NotificationsResponse

    @PUT("api/notifications/read")
    suspend fun markAllRead(): SimpleSuccess

    @PUT("api/notifications/{id}/read")
    suspend fun markRead(@Path("id") id: Long): SimpleSuccess
}
