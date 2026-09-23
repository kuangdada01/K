package top.kuangdada.k.core.data

import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.asRequestBody
import top.kuangdada.k.core.data.model.BookChapter
import top.kuangdada.k.core.data.model.BookDetail
import top.kuangdada.k.core.data.model.BookSummary
import top.kuangdada.k.core.data.model.CreateRoomRequest
import top.kuangdada.k.core.data.model.UpdateProfileRequest
import top.kuangdada.k.core.data.model.User
import top.kuangdada.k.core.data.model.UserProfile
import top.kuangdada.k.core.data.model.VoiceChatMessage
import top.kuangdada.k.core.data.model.VoiceRoom

/**
 * 图书仓库（server/src/routes/books.ts）
 *
 * 章节正文是 `text/plain`，必须自己读字符串（见 BookApi 的注释）；PDF 章节走附件下载，
 * 所以这里把「是不是 PDF」暴露给 UI，由 UI 决定用系统查看器而不是当文本渲染。
 */
class BookRepository(private val session: SessionRepository) {

    private val baseUrl: String get() = session.api.baseUrl

    /** 章节正文（文本章节） */
    data class ChapterContent(
        val bookId: String,
        val chapter: BookChapter,
        val text: String,
    )

    /**
     * 上次成功拉到的书目（**进程内缓存**）。
     *
     * 为什么要有：页面离开组合后它的 `remember` 状态就没了，切走再回来只能重新拉 ——
     * 表现就是"每点一次图书 tab 都转一次圈"。仓库是进程级单例，把上次的结果留在这里，
     * 重进页面先渲染它、再静默后台刷新，用户看到的是"秒开"。
     */
    @Volatile
    var cachedList: List<BookSummary> = emptyList()
        private set

    suspend fun list(): ApiResult<List<BookSummary>> =
        call { session.api.books.list().books }.also { r ->
            if (r is ApiResult.Success) cachedList = r.data
        }

    suspend fun detail(bookId: String): ApiResult<BookDetail> =
        call { session.api.books.detail(bookId) }

    /**
     * 拉章节正文。
     *
     * 两个坑：
     *  · 服务端是 `text/plain`，用 ResponseBody 自己读；
     *  · 单章有大小上限（服务端 `MAX_CHAPTER_BYTES`），超限回 413 而不是截断 ——
     *    413 的错误信封是 JSON，但响应头是 text/plain，所以这里**不能用 HttpException 的
     *    errorBody 直接当 JSON 解**，交给统一的 mapError 走状态码兜底即可。
     */
    suspend fun chapter(bookId: String, chapter: BookChapter): ApiResult<ChapterContent> =
        call {
            val body = session.api.books.chapterText(bookId, chapter.file)
            val text = body.use { it.string() }
            ChapterContent(bookId = bookId, chapter = chapter, text = text)
        }

    /** 封面的绝对地址（服务端给的是 `/api/books/<id>/cover` 相对路径） */
    fun coverUrl(book: BookSummary): String? = resolveUrl(book.cover, baseUrl)

    fun coverUrl(book: BookDetail): String? = resolveUrl(book.cover, baseUrl)

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
 * 用户资料仓库（server/src/routes/users.ts）
 *
 * 归一化约定：**服务端的 `username` 就是界面上的「昵称」**（只有一个列，登录/注册/帖子署名共用），
 * 所以 [updateProfile] 的形参叫 `nickname` 是刻意的 —— 调用方（资料编辑页）读起来与设计稿一致，
 * 而落到请求体时映射回 `username`。别在这里改回 `username` 再让 UI 去解释。
 */
class UserRepository(private val session: SessionRepository) {

    private val baseUrl: String get() = session.api.baseUrl

    /**
     * 上次成功拉到的资料（**进程内缓存**，按用户 id）。
     *
     * 为什么必须有：主页每次进入都会重新请求 `/users/:id`，而**首帧 `profile` 还是 null**
     * —— 头像位于是空的/null，要等接口回来才画上。表现出来就是"每次进主页头像都要重新加载一次"
     * （用户实测反馈）。有了缓存，重进主页首帧直接就是上次的头像与昵称，随后静默刷新。
     *
     * 与 [BookRepository.cachedList] 同一个思路（页面离开组合后 `remember` 就没了，
     * 仓库是进程级单例，把上次结果留在它这里）。
     */
    @Volatile
    private var cachedProfiles: Map<Long, UserProfile> = emptyMap()

    /** 上次已知的资料（没有就 null）。**不发请求**，供页面首帧直接渲染 */
    fun cachedProfile(userId: Long): UserProfile? = cachedProfiles[userId]

    suspend fun profile(userId: Long): ApiResult<UserProfile> =
        withContext(Dispatchers.IO) {
            try {
                val p = session.api.users.profile(userId)
                // 只增不改：这里只是缓存，失败时保留旧值（页面拿到的是 ApiResult）
                cachedProfiles = cachedProfiles + (userId to p)
                ApiResult.Success(p)
            } catch (t: Throwable) {
                ApiResult.Failure(mapErrorFromThrowable(t))
            }
        }

    /**
     * 保存资料（PUT /api/users/me）。
     *
     * 只送**传进来的这两个字段**：两个都是 optional，服务端按「未提供 = 保持原值」处理，
     * 将来加字段（比如主页链接）也不会因为这里的请求体而互相覆盖。
     *
     * 成功后返回服务端给的完整用户对象 —— 调用方要拿它去刷新 [SessionRepository] 里的用户缓存，
     * 否则「改完昵称，帖子卡片上的署名还是旧的」。
     *
     * @param nickname 对应服务端 `username`（1-30 字符、全局唯一；重名会返回 400「用户名已被占用」）
     * @param bio 个人简介（服务端上限 500 字符）
     */
    suspend fun updateProfile(nickname: String, bio: String): ApiResult<User> = call {
        session.api.users.updateProfile(
            UpdateProfileRequest(
                username = nickname.trim().ifBlank { null },
                bio = bio,
            )
        )
    }

    /**
     * 上传头像（POST /api/users/avatar，multipart 字段名固定 `avatar`）。
     *
     * 服务端会按长边 512 重压、并**以它返回的文件名为准**（heic 会转成 jpg），
     * 所以这里只读响应里的 `avatar`，不去猜本地文件名。
     *
     * @param mimeType 必须与文件内容匹配（服务端按扩展名 + mimetype 双校验；默认 jpeg）
     */
    suspend fun uploadAvatar(file: File, mimeType: String = "image/jpeg"): ApiResult<User> = call {
        val part = MultipartBody.Part.createFormData(
            "avatar",
            file.name,
            file.asRequestBody(mimeType.toMediaType()),
        )
        session.api.users.uploadAvatar(part)
    }

    fun avatarUrl(profile: UserProfile): String? = resolveUrl(profile.avatar, baseUrl)

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
 * 语音房间仓库（本阶段只做**列表与创建**；房内的 WebRTC/信令/录制属 M3）
 *
 * 访客也能建房：服务端在建房响应里**只此一次**下发 `ownerToken`，
 * 客户端必须持久化它（删除/清聊时经 `X-Voice-Owner-Token` 带上）。
 * 本轮只做列表展示 + 建房入口，令牌持久化随 M3 的房内一起做。
 */
class VoiceRepository(
    private val session: SessionRepository,
    /** 访客房间的所有权令牌要跨进程存活（重启后仍能删除自己的房），需要本机存储 */
    appContext: android.content.Context,
) {

    private val baseUrl: String get() = session.api.baseUrl

    private val ownerTokenPrefs =
        appContext.getSharedPreferences("voice_owner_tokens", android.content.Context.MODE_PRIVATE)

    /** 上次成功拉到的房间列表（进程内缓存）：重进语音 tab 先渲染它，不再每次转圈 */
    @Volatile
    var cachedRooms: List<VoiceRoom> = emptyList()
        private set

    /**
     * 访客建房的所有权令牌：建房响应下发一次，删除该房间时随头带回。
     * 登录用户建的房不需要令牌（服务端按会话鉴权）。
     * 持久化到 SharedPreferences —— 重启后仍能删除自己建的房（IP 锚点会随网络切换失效）。
     */
    private val ownerTokens: MutableMap<Long, String> = mutableMapOf<Long, String>().also { m ->
        ownerTokenPrefs.all.forEach { (k, v) ->
            val id = k.toLongOrNull()
            if (id != null && v is String) m[id] = v
        }
    }

    suspend fun rooms(): ApiResult<List<VoiceRoom>> =
        withContext(Dispatchers.IO) {
            try {
                ApiResult.Success(session.api.voice.rooms().rooms)
            } catch (t: Throwable) {
                ApiResult.Failure(mapErrorFromThrowable(t))
            }
        }.also { r -> if (r is ApiResult.Success) cachedRooms = r.data }

    suspend fun createRoom(
        name: String,
        description: String,
        coverUrl: String? = null,
    ): ApiResult<VoiceRoom> =
        withContext(Dispatchers.IO) {
            try {
                val res = session.api.voice.createRoom(CreateRoomRequest(name, description, coverUrl))
                // 访客房间的所有权令牌：落盘留存（重启后仍可删除自己建的房）
                res.ownerToken?.let { token ->
                    ownerTokens[res.room.id] = token
                    ownerTokenPrefs.edit().putString(res.room.id.toString(), token).apply()
                }
                ApiResult.Success(res.room)
            } catch (t: Throwable) {
                ApiResult.Failure(mapErrorFromThrowable(t))
            }
        }

    /** 这是不是我（本机访客身份）建的房：建房时落盘的令牌还在，删除时能带上 */
    fun isOwnGuestRoom(roomId: Long): Boolean = ownerTokens.containsKey(roomId)

    /** 删除房间（创建者或管理员；访客建房自动带上建房时留存的所有权令牌） */
    suspend fun deleteRoom(id: Long): ApiResult<Boolean> =
        withContext(Dispatchers.IO) {
            try {
                val ok = session.api.voice.deleteRoom(id, ownerTokens[id]).success
                if (ok) {
                    ownerTokens.remove(id)
                    ownerTokenPrefs.edit().remove(id.toString()).apply()
                }
                ApiResult.Success(ok)
            } catch (t: Throwable) {
                ApiResult.Failure(mapErrorFromThrowable(t))
            }
        }

    /**
     * 上传房间封面：服务端压缩到长边 1440 后返回相对 URL（/uploads/voice-covers/…）。
     * 与头像同一套 multipart 形态；调用方负责把相对地址经 [roomCoverUrl] 解析成绝对地址。
     */
    suspend fun uploadRoomCover(file: File, mimeType: String): ApiResult<String> =
        withContext(Dispatchers.IO) {
            try {
                val part = MultipartBody.Part.createFormData(
                    name = "cover",
                    filename = file.name,
                    body = file.asRequestBody(mimeType.toMediaType()),
                )
                ApiResult.Success(session.api.voice.uploadRoomCover(part).url)
            } catch (t: Throwable) {
                ApiResult.Failure(mapErrorFromThrowable(t))
            }
        }

    fun roomCoverUrl(room: VoiceRoom): String? = resolveUrl(room.coverUrl, baseUrl)

    fun roomAvatarUrl(room: VoiceRoom): String? = resolveUrl(room.creatorAvatar, baseUrl)

    /**
     * 换一次性的语音连接票据（登录用户）。
     * 30 秒有效、只能用一次 —— 拿到就立刻建连，不要缓存。
     */
    suspend fun ticket(): ApiResult<String> =
        withContext(Dispatchers.IO) {
            try {
                ApiResult.Success(session.api.voice.ticket().ticket)
            } catch (t: Throwable) {
                ApiResult.Failure(mapErrorFromThrowable(t))
            }
        }

    /**
     * ICE 配置（STUN/TURN）。
     * 这个端点**不需要登录** —— 访客也要能拿到配置，否则访客永远建不起连接。
     */
    suspend fun ice(): ApiResult<IceConfig> =
        withContext(Dispatchers.IO) {
            try {
                val response = session.api.voice.ice()
                ApiResult.Success(
                    IceConfig(
                        servers = response.iceServers.mapNotNull { server ->
                            val urls = server.urls.filter { it.isNotBlank() }
                            if (urls.isEmpty()) null
                            else IceServerEntry(urls = urls, username = server.username, credential = server.credential)
                        }
                    )
                )
            } catch (t: Throwable) {
                // 诊断用：把真实异常打出来。
                // 这类"数据格式异常"如果只映射成一句用户文案，排查时完全无从下手
                // （是哪个字段、什么形状、是解析还是 HTTP 错误都不知道）。
                android.util.Log.e("KICE", "拉取 ICE 配置失败", t)
                ApiResult.Failure(mapErrorFromThrowable(t))
            }
        }

    /** 建连所需的全部信息 */
    data class IceConfig(val servers: List<IceServerEntry>)

    data class IceServerEntry(
        val urls: List<String>,
        val username: String?,
        val credential: String?,
    ) {
        /**
         * 是否有可用的公网 STUN/TURN。
         *
         * 为什么要判：如果服务端没配 TURN，两家都在 NAT 后就可能完全建不起连接
         * （只有 STUN 时对称 NAT 会失败）。UI 需要把这种情况说清楚，
         * 而不是让用户对着"连接中"一直等。
         */
        val hasTurn: Boolean get() = urls.any { it.startsWith("turn:") || it.startsWith("turns:") }
    }

    /**
     * 房间聊天历史（`GET /api/voice/rooms/:id/messages`）。
     *
     * 进房时拉一次最近 [limit] 条：**不拉就只能看到进房之后的实时消息** ——
     * 别人在你进房前说的话一条都没有，看起来就是"聊天没跟 Web 互通"。
     * 服务端可选认证、游客可读。
     */
    suspend fun roomMessages(roomId: Long, limit: Int = 50): ApiResult<List<VoiceChatMessage>> =
        withContext(Dispatchers.IO) {
            try {
                ApiResult.Success(session.api.voice.roomMessages(roomId = roomId, limit = limit).messages)
            } catch (t: Throwable) {
                ApiResult.Failure(mapErrorFromThrowable(t))
            }
        }

    /**
     * 清空房间聊天记录（`DELETE /api/voice/rooms/:id/messages`，设计稿「文字聊天 → 清空」）。
     *
     * 权限由服务端把关（创建者或管理员，Web 端同一接口），非创建者会拿到 403；
     * UI 那边先按 `VoiceRoom.isCreator` 决定画不画这个按钮，这里只负责调接口。
     * 清空后服务端会向房间广播 `chat-cleared`，在场所有人的本地列表都会跟着清掉。
     */
    suspend fun clearRoomMessages(roomId: Long): ApiResult<Unit> =
        withContext(Dispatchers.IO) {
            try {
                session.api.voice.clearRoomMessages(roomId)
                ApiResult.Success(Unit)
            } catch (t: Throwable) {
                ApiResult.Failure(mapErrorFromThrowable(t))
            }
        }

    /** 便捷：建一个信令客户端（封装 baseUrl 与 token 取值） */
    fun signalingClient(): VoiceSignalingClient =
        VoiceSignalingClient(baseUrl = baseUrl, tokenProvider = { session.tokens.token })

    /**
     * 当前是否已登录（决定 WS 用一次性票据还是以访客身份连）。
     * **返回 token 本身而不是布尔**，因为调用方通常紧接着要用它做判断依据。
     */
    fun currentToken(): String? = session.tokens.token

    /** 参与者头像的绝对地址（WS 下发的 avatar 是相对路径） */
    fun avatarUrl(path: String?): String? = resolveUrl(path, baseUrl)
}
