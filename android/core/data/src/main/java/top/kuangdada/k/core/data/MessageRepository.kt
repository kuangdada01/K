package top.kuangdada.k.core.data

import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.BufferedSink
import okio.Buffer
import okio.source
import top.kuangdada.k.core.data.api.DeleteTempVideoRequest
import top.kuangdada.k.core.data.api.TempVideoStatus
import top.kuangdada.k.core.data.model.ConversationDto
import top.kuangdada.k.core.data.model.MessageDto
import top.kuangdada.k.core.data.model.NotificationDto
import top.kuangdada.k.core.data.model.Post

/**
 * ============================================================
 * 私信仓库（server/src/routes/messages.ts）
 * ============================================================
 * 三个服务端语义必须照搬：
 *  1. **历史是游标分页**（`before_id` 取当前最旧一条的 id），不是页码；
 *  2. `PUT /read` 标记的是**全部**消息已读（没有"按会话标记"）；
 *  3. `POST /messages` 是 **multipart**，字段名固定 `receiverId`/`content`/`image`/`quotedMessageId`。
 */
class MessageRepository(private val session: SessionRepository) {

    private val baseUrl: String get() = session.api.baseUrl

    data class ConversationUi(
        val raw: ConversationDto,
        val avatarUrl: String?,
        val timeText: String,
    )

    data class MessageUi(
        val raw: MessageDto,
        val isMine: Boolean,
        val imageUrl: String?,
        val timeText: String,
    )

    data class NotificationUi(
        val raw: NotificationDto,
        val avatarUrl: String?,
        val timeText: String,
    )

    /**
     * 上次成功拉到的会话 / 通知（**进程内缓存**）。
     *
     * 切走再回来时页面状态会被销毁，靠它先把内容画出来、再静默刷新 ——
     * 否则"每进一次消息 tab 都转一次圈"。
     *
     * 缓存**跟着用户 id**：换账号登录后不能先闪出上一个人的会话。
     */
    @Volatile
    private var cacheOwnerId: Long = 0

    @Volatile
    private var cachedConversationsRaw: List<ConversationUi> = emptyList()

    @Volatile
    private var cachedNotificationsRaw: List<NotificationUi> = emptyList()

    /**
     * **每个会话最近一次拉到的首屏历史**（进程内，按 partnerId）。
     *
     * 与 [cachedConversations] 同一个理由：进聊天页时先用它把消息画出来，页面**不出现加载圈**
     * （用户反馈：「点进对话消息中间有个加载圈」）。切走时页面状态本来会被销毁，没有这份缓存
     * 就必然要等一次网络往返，那一圈就没法真正去掉。
     *
     * 只留**首屏那一页**（`beforeId == null` 的结果）：向上翻出来的旧页没有必要留，
     * 留了反而变成"第二份数据集"（谁负责失效、谁负责合并都得再想一遍）。
     * 本地改动（发送 / 撤回 / 清空 / 翻页）由聊天页用 [rememberHistory] 回写。
     */
    @Volatile
    private var cachedHistoryRaw: Map<Long, Pair<List<MessageUi>, Boolean>> = emptyMap()

    val cachedConversations: List<ConversationUi>
        get() = if (cacheOwnerId == session.tokens.userId) cachedConversationsRaw else emptyList()

    val cachedNotifications: List<NotificationUi>
        get() = if (cacheOwnerId == session.tokens.userId) cachedNotificationsRaw else emptyList()

    /** 某个会话的首屏历史缓存；没缓存过（或换了账号）返回 null，调用方按"要加载"处理 */
    fun cachedHistory(partnerId: Long): Pair<List<MessageUi>, Boolean>? =
        if (cacheOwnerId == session.tokens.userId) cachedHistoryRaw[partnerId] else null

    /**
     * 回写历史缓存。
     *
     * 由聊天页在自身列表变化时调用（发送 / 撤回 / 清空 / 翻页）—— 只由 [history] 写入的话，
     * 这些本地改动要等到"下一次真的拉了首屏"才进缓存，中间重进会话会先闪出旧内容
     * （最明显的是**已撤回的那条会再出现一下**才消失）。
     *
     * `messages` 为空时**丢掉这个会话的缓存**：能走到这里只有两种可能 —— 用户清空了聊天记录，
     * 或者这次没拉到；两种情况都不该再留一份可以回放的旧内容。
     */
    fun rememberHistory(partnerId: Long, messages: List<MessageUi>, hasMore: Boolean) {
        rememberCacheOwner()
        cachedHistoryRaw = if (messages.isEmpty()) {
            cachedHistoryRaw - partnerId
        } else {
            cachedHistoryRaw + (partnerId to (messages to hasMore))
        }
    }

    private fun rememberCacheOwner() {
        val id = session.tokens.userId
        // 换账号：历史缓存按 partnerId 存，两个人的 key 会重合 —— 必须整份丢掉。
        // 另外两份是单值、写入即覆盖，不存在这个问题。
        if (id != cacheOwnerId) cachedHistoryRaw = emptyMap()
        cacheOwnerId = id
    }

    suspend fun conversations(): ApiResult<List<ConversationUi>> = call {
        session.api.messages.conversations().conversations.map {
            ConversationUi(
                raw = it,
                avatarUrl = resolveUrl(it.avatar, baseUrl),
                timeText = relativeTime(it.lastMessageAt),
            )
        }
    }.also { r ->
        if (r is ApiResult.Success) {
            rememberCacheOwner()
            cachedConversationsRaw = r.data
        }
    }

    /**
     * 互动通知（评论/回复），消息页「通知」标签用。
     *
     * 服务端 `GET /api/notifications` 返回 `{ notifications, unread_count }`。
     *
     * 这里**不在拉取时自动标记已读** —— 那会让"划过去看一眼"也变成已读。
     * 标记已读由用户点击某条通知时触发（见 [markNotificationRead]）。
     */
    suspend fun notifications(): ApiResult<List<NotificationUi>> = call {
        session.api.notifications.list().notifications.map {
            NotificationUi(
                raw = it,
                avatarUrl = resolveUrl(it.fromAvatar, baseUrl),
                timeText = relativeTime(it.createdAt),
            )
        }
    }.also { r ->
        if (r is ApiResult.Success) {
            rememberCacheOwner()
            cachedNotificationsRaw = r.data
        }
    }

    /**
     * 把一条通知标记为已读（`PUT /api/notifications/:id/read`）。
     *
     * **先改本地缓存再打接口**：点击通知会立刻跳去帖子详情，等接口回来时页面已经切走了，
     * 那份"未读红点"要到下次拉取才消失 —— 用户看到的就是"点了还是未读"。
     * 本地先置位，红点当场消失；接口失败也不回滚（已读是弱语义，不值得为它把红点弹回来）。
     */
    suspend fun markNotificationRead(id: Long): ApiResult<Unit> {
        cachedNotificationsRaw = cachedNotificationsRaw.map {
            if (it.raw.id == id) it.copy(raw = it.raw.copy(read = 1)) else it
        }
        return call { session.api.notifications.markRead(id) }
    }

    /**
     * 未读总数（私信 + 通知），导航角标用。
     *
     * 为什么单独一个方法：角标要在**任意页面**都能实时更新（SSE 事件到达时），
     * 而消息页没被组合时它的会话/通知状态并不存在。口径与 Web 版
     * `selectUnreadTotal`（私信未读 + 通知未读）一致。
     */
    suspend fun unreadTotal(): ApiResult<Int> = call {
        val conversations = session.api.messages.conversations().conversations.sumOf { it.unreadCount }
        val notifications = session.api.notifications.list().notifications.count { !it.isRead }
        conversations + notifications
    }

    /**
     * 消息历史。
     *
     * @param beforeId 向上翻页时传**当前最旧一条**的 id；首次加载传 null
     */
    suspend fun history(
        partnerId: Long,
        beforeId: Long? = null,
        limit: Int = 50,
    ): ApiResult<Pair<List<MessageUi>, Boolean>> {
        val myId = session.tokens.userId
        return call {
            val r = session.api.messages.history(partnerId, limit, beforeId)
            val mapped = r.messages.map { m ->
                MessageUi(
                    raw = m,
                    isMine = m.senderId == myId,
                    imageUrl = resolveUrl(m.imageUrl, baseUrl),
                    // 聊天页只显示「时:分」：日期由日期分隔条负责（见 PostUi.timeOfDay）
                    timeText = timeOfDay(m.createdAt),
                )
            }
            mapped to r.hasMore
        }.also { r ->
            // 只缓存首屏那一页（见 cachedHistoryRaw 的注释）；向上翻出来的旧页不入缓存
            if (r is ApiResult.Success && beforeId == null) {
                rememberCacheOwner()
                cachedHistoryRaw = cachedHistoryRaw + (partnerId to r.data)
            }
        }
    }

    /**
     * 发消息。`content` 与 `image` 至少要有一个（服务端 schema 校验）。
     * 图片走 multipart 的 `image` 字段。
     */
    suspend fun send(
        receiverId: Long,
        content: String,
        image: File? = null,
        quotedMessageId: Long? = null,
    ): ApiResult<MessageUi> {
        val myId = session.tokens.userId
        return call {
            val receiverPart = receiverId.toString().toRequestBody(TEXT)
            val contentPart = content.toRequestBody(TEXT)
            val quotedPart = quotedMessageId?.toString()?.toRequestBody(TEXT)
            val imagePart = image?.let {
                MultipartBody.Part.createFormData("image", it.name, it.asRequestBody(JPEG))
            }
            val dto = session.api.messages.send(receiverPart, contentPart, quotedPart, imagePart)
            MessageUi(
                raw = dto,
                isMine = dto.senderId == myId,
                imageUrl = resolveUrl(dto.imageUrl, baseUrl),
                timeText = timeOfDay(dto.createdAt),
            )
        }
    }

    suspend fun recall(messageId: Long): ApiResult<Unit> =
        call { session.api.messages.recall(messageId) }

    suspend fun clearConversation(partnerId: Long): ApiResult<Unit> =
        call { session.api.messages.clear(partnerId) }

    suspend fun markAllRead(): ApiResult<Unit> =
        call { session.api.messages.markAllRead() }

    /**
     * 消息图片的鉴权头。
     *
     * 图片存在 `uploads_private`，**只有收发双方能取**（服务端判 sender/receiver），
     * 所以 Coil 加载时必须带 `Authorization` —— 否则一律 403，表现为"图片永远白块"。
     */
    fun imageHeaders(): Map<String, String> =
        session.tokens.token?.let { mapOf("Authorization" to "Bearer $it") } ?: emptyMap()

    private suspend fun <T> call(block: suspend () -> T): ApiResult<T> =
        withContext(Dispatchers.IO) {
            try {
                ApiResult.Success(block())
            } catch (t: Throwable) {
                ApiResult.Failure(mapErrorFromThrowable(t))
            }
        }

    private companion object {
        val TEXT = "text/plain".toMediaType()
        val JPEG = "image/jpeg".toMediaType()
    }
}

/**
 * ============================================================
 * 发帖仓库（server/src/routes/posts 的创建与编辑）
 * ============================================================
 * 关键契约：`close_comments` 是**字符串** '0'/'1'（不是布尔）；
 * 编辑时 `keepImages` 是**JSON 数组字符串**。
 *
 * @param onContentChanged 发布/编辑成功后调（由 AppShell 接到 [PostRepository.bumpContentVersion]）。
 *
 * 为什么用回调而不是直接持有 [PostRepository]：两边的依赖方向是
 * `posts`（列表/互动）与 `composer`（写）并列，互相引一个会绕成环；
 * 而"写完要通知谁"本来就是装配层（AppShell）该决定的事。
 */
class ComposerRepository(
    private val session: SessionRepository,
    private val onContentChanged: () -> Unit = {},
) {

    suspend fun createPost(
        title: String,
        description: String,
        /** 位置（自由文本，空串=不带位置）；服务端上限 60 字符 */
        location: String,
        images: List<File>,
        closeComments: Boolean,
    ): ApiResult<Post> = call {
        val parts = images.map { file ->
            MultipartBody.Part.createFormData("images", file.name, file.asRequestBody(JPEG))
        }
        session.api.composer.createPost(
            images = parts,
            title = title.toRequestBody(TEXT),
            description = description.toRequestBody(TEXT),
            location = location.toRequestBody(TEXT),
            closeComments = (if (closeComments) "1" else "0").toRequestBody(TEXT),
        )
    }.also { if (it is ApiResult.Success) onContentChanged() }

    suspend fun updatePost(
        postId: Long,
        description: String,
        keepImages: List<String>,
        newImages: List<File>,
        /** 位置：**必须回传**（服务端不传时会保留原值，但显式回传才能改） */
        location: String,
        closeComments: Boolean,
    ): ApiResult<Post> = call {
        val json = keepImages.joinToString(prefix = "[", postfix = "]") { "\"$it\"" }
        val parts = newImages.map { file ->
            MultipartBody.Part.createFormData("images", file.name, file.asRequestBody(JPEG))
        }
        session.api.composer.updatePost(
            postId = postId,
            images = parts,
            keepImages = json.toRequestBody(TEXT),
            description = description.toRequestBody(TEXT),
            location = location.toRequestBody(TEXT),
            closeComments = (if (closeComments) "1" else "0").toRequestBody(TEXT),
        )
    }.also { if (it is ApiResult.Success) onContentChanged() }

    // ------------------------------------------------------------------
    // 视频帖子：临时上传 → 轮询转码 → 用 video_url 正式发布
    // ------------------------------------------------------------------

    /**
     * 上传视频到临时目录（发布前调用，正文编辑与上传并行）。
     *
     * 走 [KApi.composerMedia]（长超时通道）而不是普通的 `composer`：
     * 大文件上行几分钟，普通通道 30s 就断了。
     *
     * [onProgress] 回传 0..100；服务端还要把文件从 socket 收完才响应，所以
     * 进度到 100 之后仍会有一小段等待，UI 文案要覆盖这个阶段（"上传完成，正在处理…"）。
     */
    suspend fun uploadTempVideo(
        video: File,
        /** 原始文件名（含扩展名）：服务端按扩展名白名单判定，丢失扩展名会直接被 400 拒绝 */
        originalName: String,
        onProgress: ((Int) -> Unit)? = null,
    ): ApiResult<String> = call {
        val part = MultipartBody.Part.createFormData(
            "video",
            originalName,
            video.asUploadBody(VIDEO_UPLOAD_MEDIA_TYPE, onProgress),
        )
        session.api.composerMedia.uploadVideoTemp(part).url
    }

    /** 查询临时视频转码状态（发布前轮询）；返回 done / encoding / missing */
    suspend fun tempVideoStatus(videoUrl: String): ApiResult<TempVideoStatus> =
        call { session.api.composerMedia.tempVideoStatus(videoUrl) }

    /**
     * 放弃发布：删除临时视频并释放服务端的上传会话。
     *
     * **失败要吞掉**（返回 Unit）：这是清理路径，用户已经离开这个页面了，
     * 弹一个"删除失败"没有任何可操作的后续；服务端还有 24h TTL 兜底。
     *
     * 注意 `runCatching` 的结果是**故意丢弃**的（吞掉失败），块尾不需要再写一个 `Unit`
     * —— 它是纯表达式，编译器会报 UNUSED_EXPRESSION；返回类型由 `ApiResult<Unit>` 定死。
     */
    suspend fun discardTempVideo(videoUrl: String): ApiResult<Unit> = call {
        runCatching { session.api.composerMedia.deleteTempVideo(DeleteTempVideoRequest(videoUrl)) }
    }

    /**
     * 用已上传的临时视频发布视频帖子。
     *
     * [cover] 是**用户挑的封面图**（设计稿「选封面」面板：从视频抽一帧、或从相册选一张图）。
     * 不传（null）时服务端会从视频自动截首帧（`generateVideoCover`）——
     * 也就是设计稿说的"点完成才确认封面，不然默认第一帧是封面"：
     * 默认那条路径压根不需要客户端做任何事，只有用户真的挑了才多传一张图。
     */
    suspend fun createVideoPost(
        videoUrl: String,
        description: String,
        closeComments: Boolean,
        cover: File? = null,
    ): ApiResult<Post> = call {
        session.api.composerMedia.createVideoPost(
            videoUrl = videoUrl.toRequestBody(TEXT),
            description = description.toRequestBody(TEXT),
            closeComments = (if (closeComments) "1" else "0").toRequestBody(TEXT),
            // 字段名必须是 `cover`（服务端 fields 里就是这么声明的）；mime 用 image/jpeg ——
            // 服务端对 cover 的 fileFilter 要求"图片扩展名 + 图片 mime"同时满足
            cover = cover?.let {
                MultipartBody.Part.createFormData("cover", it.name, it.asRequestBody(JPEG))
            },
        )
    }.also { if (it is ApiResult.Success) onContentChanged() }

    private suspend fun <T> call(block: suspend () -> T): ApiResult<T> =
        withContext(Dispatchers.IO) {
            try {
                ApiResult.Success(block())
            } catch (t: Throwable) {
                ApiResult.Failure(mapErrorFromThrowable(t))
            }
        }

    private companion object {
        val TEXT = "text/plain".toMediaType()
        val JPEG = "image/jpeg".toMediaType()

        /**
         * 视频 multipart 的 Content-Type：**故意报 octet-stream**。
         *
         * 服务端 fileFilter 接受 `video/` 开头的类型 **或** `application/octet-stream`，
         * 但要求文件名的扩展名在白名单里（`VIDEO_EXTS`，见 server/src/routes/posts/media.ts）。
         * 所以判定实际落在扩展名上；这里谎报 `video/mp4` 反而会在
         * "mov 被当成 mp4" 这类边界上误导服务端的后续处理。
         *
         * 注意别在这个注释里写出 `video` + 斜杠 + 星号 的字样：
         * Kotlin 的块注释**不嵌套**，注释里出现连续的斜杠星号会提前结束注释，
         * 后面整段代码就被当成语法错误（本轮真的踩过：报的是文件末尾 "Unclosed comment"）。
         */
        val VIDEO_UPLOAD_MEDIA_TYPE = "application/octet-stream".toMediaType()
    }
}

/**
 * 视频文件名 → 小写扩展名（含点），无扩展名时返回空串。
 * 单独抽出来是为了能被单测覆盖：**扩展名丢了服务端一定 400**（"仅支持视频格式文件"）。
 *
 * 这三个都是 `public`（不是 internal）：UI 层（`:native` 的 ComposerScreen）
 * 要在选完视频、开始上传之前就先拦一次"这个格式服务端不收"，
 * 而 `internal` 在这两个 Gradle 模块之间不可见。
 */
fun videoExtension(name: String): String =
    name.substringAfterLast('.', "").let { if (it == name) "" else ".${it.lowercase()}" }

/** 扩展名白名单，与服务端 `VIDEO_EXTS` 一致 */
val VIDEO_EXTENSIONS = setOf(".mp4", ".mov", ".avi", ".webm", ".mkv", ".flv", ".wmv")

/** 服务端能收下的视频文件名（扩展名在白名单内） */
fun isAcceptableVideoName(name: String): Boolean = videoExtension(name) in VIDEO_EXTENSIONS

/**
 * 带进度回调的请求体：每写出一块就报一次百分比。
 *
 * 为什么不用 OkHttp 的 `asRequestBody` 直接包一层：进度必须**在写入过程中**上报，
 * 否则"上传中"只能是一个不确定的转圈。写块大小用 8KB 是 socket 缓冲的常见粒度，
 * 再细只增加回调频率、不会让进度更真实。
 */
private fun File.asUploadBody(
    contentType: okhttp3.MediaType,
    onProgress: ((Int) -> Unit)?,
): RequestBody = object : RequestBody() {
    override fun contentType(): okhttp3.MediaType = contentType
    override fun contentLength(): Long = length()

    override fun writeTo(sink: BufferedSink) {
        // 总长为 0 时无法按比例算进度，直接透传（也避免除零）
        if (length() <= 0L) {
            source().use { src -> sink.writeAll(src) }
            return
        }
        var written = 0L
        var lastPct = -1
        source().use { src ->
            val buffer = Buffer()
            while (true) {
                val read = src.read(buffer, 8192L)
                if (read == -1L) break
                sink.write(buffer, read)
                written += read
                val pct = ((written * 100) / length()).toInt().coerceIn(0, 100)
                if (pct != lastPct) {
                    lastPct = pct
                    onProgress?.invoke(pct)
                }
            }
        }
    }
}

/** `RequestBody` 便于在测试里构造纯文本字段（仓库内部用） */
internal fun String.asTextField(): RequestBody = toRequestBody("text/plain".toMediaType())
