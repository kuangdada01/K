package top.kuangdada.k.core.data.api

import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.Multipart
import retrofit2.http.POST
import retrofit2.http.PUT
import retrofit2.http.Part
import retrofit2.http.Path
import retrofit2.http.Query
import retrofit2.http.Streaming
import kotlinx.serialization.Serializable
import okhttp3.MultipartBody
import okhttp3.ResponseBody
import top.kuangdada.k.core.data.model.BookDetail
import top.kuangdada.k.core.data.model.BookListResponse
import top.kuangdada.k.core.data.model.PostListWithMore
import top.kuangdada.k.core.data.model.UpdateProfileRequest
import top.kuangdada.k.core.data.model.User
import top.kuangdada.k.core.data.model.UserPostsResponse
import top.kuangdada.k.core.data.model.UserProfile

/**
 * 图书接口（server/src/routes/books.ts）。
 *
 * 两个必须注意的点：
 *  1. 章节内容对文本章节返回 **`text/plain`**（不是 JSON），所以这里用 `ResponseBody`
 *     自己读字符串 —— 交给 JSON converter 会因为内容不是 JSON 而解析失败。
 *  2. PDF 章节走 `res.download()`（`Content-Disposition: attachment`），**不是内联流**，
 *     所以原生侧必须下载到文件再交给系统查看器（或 PdfRenderer），不能当在线图片流用。
 */
interface BookApi {

    @GET("api/books")
    suspend fun list(): BookListResponse

    @GET("api/books/{bookId}")
    suspend fun detail(@Path("bookId") bookId: String): BookDetail

    /**
     * 章节内容（文本）。`file` 是详情里给的相对路径（可能含卷目录，如 `第一卷/001.txt`）。
     * 用 `@Streaming` + `ResponseBody` 以免 Retrofit 试图按 JSON 反序列化。
     */
    @Streaming
    @GET("api/books/{bookId}/content")
    suspend fun chapterText(
        @Path("bookId") bookId: String,
        @Query("file") file: String,
    ): ResponseBody
}

/**
 * 用户接口（server/src/routes/users.ts）。
 * 公开接口（资料 / 用户帖子列表）+ 资料更新 / 头像上传（全部需要 JWT 的走 `/me`）。
 *
 * 「私密文件夹」（`/me/private-images`）已在 09-18 随功能一起删除，这里不再有对应声明。
 */
interface UserApi {

    @GET("api/users/{id}")
    suspend fun profile(@Path("id") userId: Long): UserProfile

    /**
     * 更新个人资料（需认证）。
     *
     * 字段名与**服务端 schema 逐字对齐**（shared/src/schemas/user.ts 的 `updateProfileSchema`）：
     * 我们界面上的「昵称」= 服务端的 `username`（1-30 字符、全局唯一，重名是 400「用户名已被占用」），
     * 「个人简介」= `bio`（≤500 字符）。两个字段都是 optional：**只送改过的那个**即可，
     * 未送出的字段服务端保持原值（`updateProfile` 里按 `!== undefined` 判断）。
     *
     * 返回的是**完整用户对象**（id/username/email/avatar/bio/role/created_at），
     * 所以调用方拿到后可以直接用它刷新会话里的用户缓存。
     * 注意：响应里**不含** post_count / followers_count（那是 `GET /users/:id` 才带的统计），
     * 别拿它去覆盖 [UserProfile]。
     */
    @PUT("api/users/me")
    suspend fun updateProfile(@Body body: UpdateProfileRequest): User

    /**
     * 上传头像（需认证，multipart，字段名固定 `avatar`）。
     *
     * 服务端会按长边 512 重新压缩，并**用返回的文件名为准**（heic 会被转成 jpg，
     * 不能拿本地文件名去猜服务端存下的名字）。返回完整用户对象（含新的 `avatar` 相对路径）。
     */
    @Multipart
    @POST("api/users/avatar")
    suspend fun uploadAvatar(@Part avatar: MultipartBody.Part): User

    @GET("api/users/{id}/posts")
    suspend fun posts(
        @Path("id") userId: Long,
        @Query("page") page: Int = 1,
        @Query("limit") limit: Int = 20,
    ): UserPostsResponse

    /**
     * 某个用户**转发**的帖子（`GET /api/users/:id/reposts`）—— 他人主页的「转发」标签。
     *
     * 认证: 可选（`optionalAuth`）。登录时服务端按**观察者**算 `liked` / `reposted`
     * —— 少了这一步，点开别人的转发列表所有心都是空的，用户会以为自己的点赞丢了。
     *
     * 响应是 `{ posts, has_more }`（**没有分页字段**）：服务端对这份列表只做硬上限
     * 截断（见 server/src/lib/listLimits.ts），所以别指望 `page` / `totalPages`。
     */
    @GET("api/users/{id}/reposts")
    suspend fun reposts(@Path("id") userId: Long): PostListWithMore
}
/**
 * 语音房间接口（server/src/routes/voice.ts）。
 *
 * 本阶段只做**房间列表**（设计稿的"语音 · 房间列表"一级页）。
 * 房内的 WebRTC + WS 信令 + 录制属于 M3 —— 那块是全项目最复杂的一部分，不掺进来。
 */
interface VoiceApi {

    @GET("api/voice/rooms")
    suspend fun rooms(): top.kuangdada.k.core.data.model.VoiceRoomListResponse

    @POST("api/voice/rooms")
    suspend fun createRoom(@Body body: top.kuangdada.k.core.data.model.CreateRoomRequest): top.kuangdada.k.core.data.model.CreateRoomResponse

    /** 上传房间封面：先传拿 URL（服务端压缩到长边 1440），建房时随 CreateRoomRequest 带回 */
    @Multipart
    @POST("api/voice/rooms/cover")
    suspend fun uploadRoomCover(@Part cover: MultipartBody.Part): top.kuangdada.k.core.data.model.RoomCoverResponse

    /**
     * 删除房间（创建者或管理员）。
     * 访客建的房没有登录态可鉴权，用建房响应里下发一次的 x-voice-owner-token 头；
     * 登录用户的房间靠会话鉴权，传 null。
     */
    @DELETE("api/voice/rooms/{id}")
    suspend fun deleteRoom(
        @Path("id") id: Long,
        @Header("x-voice-owner-token") ownerToken: String?,
    ): top.kuangdada.k.core.data.model.DeleteRoomResponse

    /** 登录用户连语音 WS 前用它换一次性票据（避免把 JWT 放进查询串） */
    @POST("api/voice/ticket")
    suspend fun ticket(): top.kuangdada.k.core.data.model.TicketResponse

    /**
     * ICE 配置（STUN/TURN）。
     *
     * 注意：这个端点**不需要登录**（服务端是 `asyncHandler` 无 authMiddleware）——
     * 访客进房也要能拿到 ICE 配置，否则访客永远建不起连接。
     */
    @GET("api/voice/ice")
    suspend fun ice(): top.kuangdada.k.core.data.model.IceConfigResponse

    /**
     * 房间聊天记录（`GET /api/voice/rooms/:id/messages`，持久化历史）。
     *
     * **进房时必须拉一次**，否则只能看到"进房之后"的实时消息 ——
     * 别人（例如 Web 端）在你进房前说的话一条都看不到，表现就是"聊天没有跟 Web 互通"
     * （用户实测反馈）。服务端是可选认证、游客可读。
     *
     * 不传游标 = 最近 `limit` 条（首屏）；`before_id` 向更早翻、`after_id` 补增量。
     */
    @GET("api/voice/rooms/{id}/messages")
    suspend fun roomMessages(
        @Path("id") roomId: Long,
        @Query("before_id") beforeId: Long? = null,
        @Query("after_id") afterId: Long? = null,
        @Query("limit") limit: Int = 50,
    ): top.kuangdada.k.core.data.model.VoiceRoomMessagesResponse

    /**
     * 清空房间聊天记录（设计稿「文字聊天」右上角的「清空」）。
     *
     * 权限在服务端把关：**房间创建者或管理员**才能删（Web 端同一接口）。
     * 非创建者调用会拿到 403 —— UI 那边按 `VoiceRoom.isCreator` 决定画不画这个按钮。
     */
    @DELETE("api/voice/rooms/{id}/messages")
    suspend fun clearRoomMessages(@Path("id") roomId: Long): top.kuangdada.k.core.data.model.SimpleSuccess
}
