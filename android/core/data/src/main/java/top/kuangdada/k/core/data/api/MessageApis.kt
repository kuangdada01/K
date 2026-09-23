package top.kuangdada.k.core.data.api

import kotlinx.serialization.Serializable
import okhttp3.MultipartBody
import okhttp3.RequestBody
import okhttp3.ResponseBody
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.HTTP
import retrofit2.http.Multipart
import retrofit2.http.POST
import retrofit2.http.PUT
import retrofit2.http.Part
import retrofit2.http.Path
import retrofit2.http.Query
import retrofit2.http.Streaming
import top.kuangdada.k.core.data.model.ConversationsResponse
import top.kuangdada.k.core.data.model.MessageDto
import top.kuangdada.k.core.data.model.MessageHistoryResponse
import top.kuangdada.k.core.data.model.Post
import top.kuangdada.k.core.data.model.SimpleSuccess

/**
 * 私信接口（server/src/routes/messages.ts）
 *
 * 注意 `POST /api/messages` 是 **multipart**：
 * 字段名固定为 `receiverId` / `content` / `image` / `quotedMessageId`
 * （服务端用 `upload.single('image')`，字段名写错会得到"参数错误"而不是"没收到图片"）。
 */
interface MessageApi {

    @GET("api/messages/conversations")
    suspend fun conversations(): ConversationsResponse

    /** 标记**全部**消息已读（服务端语义就是全部，没有"按会话标记"） */
    @PUT("api/messages/read")
    suspend fun markAllRead(): SimpleSuccess

    /** 消息历史（游标分页）：向上翻页把 [beforeId] 设为当前最旧一条的 id */
    @GET("api/messages/{userId}")
    suspend fun history(
        @Path("userId") userId: Long,
        @Query("limit") limit: Int = 50,
        @Query("before_id") beforeId: Long? = null,
    ): MessageHistoryResponse

    /** 消息图片（存在 uploads_private，**只有收发双方能取**，所以必须带鉴权头） */
    @Streaming
    @GET("api/messages/{id}/media")
    suspend fun media(@Path("id") messageId: Long): ResponseBody

    @Multipart
    @POST("api/messages")
    suspend fun send(
        @Part("receiverId") receiverId: RequestBody,
        @Part("content") content: RequestBody,
        @Part("quotedMessageId") quotedMessageId: RequestBody?,
        @Part image: MultipartBody.Part?,
    ): MessageDto

    /** 撤回单条（只有发送者可以） */
    @DELETE("api/messages/single/{id}")
    suspend fun recall(@Path("id") messageId: Long): SimpleSuccess

    /** 清空与某用户的全部消息 */
    @DELETE("api/messages/{userId}")
    suspend fun clear(@Path("userId") userId: Long): SimpleSuccess
}

/**
 * 发帖接口（multipart）。
 *
 * 服务端字段名：`images`（数组，最多 9 张）/ `title` / `description` / `location` /
 * `close_comments`（'1' 表示关闭）。
 * `close_comments` 是**字符串** '0'/'1'，不是布尔 —— 传 true 会被当成非 '1' 从而静默变成"允许评论"。
 * `location` 是自由文本（如「深圳·南山」），服务端上限 60 字符；空串=不带位置。
 *
 * 视频帖子走**另一套端点**（`POST /api/posts/video`）：服务端把图文帖与视频帖分开建，
 * 视频帖的表单字段是 `video` / `video_url` / `cover` / `description` / `close_comments`，
 * **没有** images / title / location。所以别想着"往图文接口里塞一个视频当第 10 张图"。
 */
interface ComposerApi {

    @Multipart
    @POST("api/posts")
    suspend fun createPost(
        @Part images: List<MultipartBody.Part>,
        @Part("title") title: RequestBody,
        @Part("description") description: RequestBody,
        @Part("location") location: RequestBody,
        @Part("close_comments") closeComments: RequestBody,
    ): Post

    @Multipart
    @PUT("api/posts/{id}")
    suspend fun updatePost(
        @Path("id") postId: Long,
        @Part images: List<MultipartBody.Part>,
        /** 保留的图片 URL，**JSON 数组字符串**（如 `["/uploads/a.jpg"]`） */
        @Part("keepImages") keepImages: RequestBody,
        @Part("description") description: RequestBody,
        @Part("location") location: RequestBody,
        @Part("close_comments") closeComments: RequestBody,
    ): Post

    /**
     * 上传视频到**临时目录**（`uploads/temp/`），返回 `{ url: "/uploads/temp/temp-….mp4" }`。
     *
     * 为什么发帖要分两步：正式发布前用户还在写正文，而 300MB 视频要传几分钟。
     * 先传临时目录可以让上传与编辑并行，且服务端会**后台串行转码**成通用 H.264
     * （转码完成后同 URL 原地替换内容）。发布时再把这个 URL 交给 [createVideoPost]，
     * 服务端只是把文件从 temp 移到正式目录，不二次上传。
     *
     * 表单字段名必须是 `video`（服务端 `single('video')`，写错得到的是"请选择视频"）。
     */
    @Multipart
    @POST("api/posts/video-temp")
    suspend fun uploadVideoTemp(
        @Part video: MultipartBody.Part,
    ): TempVideoResponse

    /**
     * 查询临时视频的转码状态：`done`（已可播）/ `encoding`（排队或转码中）/ `missing`（文件没了）。
     *
     * 只要 [TempVideoStatus] 不是 done 就别急着发布 —— 未转码完的 HEVC/4K 在部分设备上
     * 播不出来，用户会以为"发出去是坏的"。
     */
    @GET("api/posts/video-temp/status")
    suspend fun tempVideoStatus(
        @Query("url") url: String,
    ): TempVideoStatus

    /** 放弃发布时清理临时视频（不清理会占满该用户在 temp 目录的配额，24h 后才被 TTL 扫掉） */
    @HTTP(method = "DELETE", path = "api/posts/video-temp", hasBody = true)
    suspend fun deleteTempVideo(
        @Body body: DeleteTempVideoRequest,
    ): SimpleSuccess

    /**
     * 用已上传的临时视频创建视频帖子（服务端 `video_url` 分支）。
     *
     * [cover] 可选：**M6.6 起客户端可以自己挑封面**（设计稿的「选封面」面板 ——
     * 从视频里抽一帧，或从相册选一张图）。不传时服务端会用 ffmpeg 自动截帧
     * （`generateVideoCover`），所以"没挑过封面"这条路径依然成立 —— 默认就是首帧。
     *
     * 表单字段名必须是 `cover`（服务端 `videoUpload.fields([{name:'video'},{name:'cover'}])`），
     * 且它只接受**图片**扩展名与图片 mime（jpg/png/gif/webp），视频扩展名会被 fileFilter 拒掉。
     * `description` 与 `close_comments` 是仅有的两个文本字段（视频帖没有 title / location）。
     */
    @Multipart
    @POST("api/posts/video")
    suspend fun createVideoPost(
        /** 临时视频路径，如 `/uploads/temp/temp-123-456.mp4` */
        @Part("video_url") videoUrl: RequestBody,
        @Part("description") description: RequestBody,
        @Part("close_comments") closeComments: RequestBody,
        /** 可选封面（挑过封面才传；不传 = 服务端自动截首帧） */
        @Part cover: MultipartBody.Part? = null,
    ): Post
}

/** `POST /api/posts/video-temp` 的响应（server/src/routes/posts/media.ts） */
@Serializable
data class TempVideoResponse(
    /** 相对路径；展示要拼绝对地址，回传服务端要**原样相对路径** */
    val url: String = "",
)

/** `GET /api/posts/video-temp/status` 的响应 */
@Serializable
data class TempVideoStatus(
    /** done / encoding / missing；未知值按"还没好"处理 */
    val status: String = "encoding",
) {
    val isDone: Boolean get() = status == "done"
    val isMissing: Boolean get() = status == "missing"
}

/** `DELETE /api/posts/video-temp` 的请求体 */
@Serializable
data class DeleteTempVideoRequest(
    val url: String,
)

/**
 * 服务端事件流（SSE）：`POST /api/events/ticket` 换一次性票据，
 * 再 `GET /api/events?ticket=...` 建立长连接。
 *
 * 为什么用票据而不是把 JWT 放查询串：JWT 会进 nginx access log 等渠道。
 * 票据 30 秒有效、只能用一次。原生侧 M3 先用轮询兜底，SSE 接线放 M3 后半。
 */
interface EventApi {

    @POST("api/events/ticket")
    suspend fun ticket(): top.kuangdada.k.core.data.model.TicketResponse
}
