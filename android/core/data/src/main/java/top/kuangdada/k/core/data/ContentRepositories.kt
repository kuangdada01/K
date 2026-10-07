package top.kuangdada.k.core.data

import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.asRequestBody
import top.kuangdada.k.core.data.model.BookChapter
import top.kuangdada.k.core.data.model.BookDetail
import top.kuangdada.k.core.data.model.BookSummary
import top.kuangdada.k.core.data.model.CloudBookProgress
import top.kuangdada.k.core.data.model.CloudBookProgressListEnvelope
import top.kuangdada.k.core.data.model.CloudBookProgressRequest
import top.kuangdada.k.core.data.model.CreateRoomRequest
import top.kuangdada.k.core.data.model.TtsRequest
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

    /**
     * 云端进度写盘用的进程级作用域：退出阅读器（onDispose）那一刻组合作用域已经没了，
     * 「把最后这次位置写上云」必须挂在它上面才活得过页面销毁。
     */
    private val cloudWriteScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** 当前登录状态 —— 云端记忆只在登录后开启，未登录保持既有的进程内记忆 */
    val isLoggedIn: Boolean get() = session.isLoggedIn

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

    /**
     * 拉云端阅读进度（重装/换设备后恢复「继续阅读」）。
     * 未登录直接返回 Success(null)，调用方无需再判登录。
     */
    suspend fun cloudProgress(bookId: String): ApiResult<CloudBookProgress?> =
        if (!session.isLoggedIn) {
            ApiResult.Success(null)
        } else {
            call { session.api.books.getProgress(bookId).progress }
        }

    /**
     * 覆盖写入云端阅读进度（挂起版）。
     * 云端记忆是锦上添花：离线/接口失败返回 Failure 即可，不该打扰阅读。
     */
    /** 拉该用户**全部**图书的云端进度（图书列表一次性水合用） */
    suspend fun allCloudProgress(): ApiResult<List<CloudBookProgress>> =
        if (!session.isLoggedIn) {
            ApiResult.Success(emptyList())
        } else {
            call { session.api.books.getAllProgress().progress }
        }

    suspend fun saveCloudProgress(
        bookId: String,
        chapterIndex: Int,
        chapterFile: String,
        para: Int,
        charOffset: Int,
    ): ApiResult<CloudBookProgress?> {
        if (!session.isLoggedIn) return ApiResult.Success(null)
        return call {
            session.api.books.putProgress(
                bookId,
                CloudBookProgressRequest(chapterIndex, chapterFile, para, charOffset),
            ).progress
        }
    }

    /**
     * 发后即忘版：给**退出阅读器**（onDispose）用 —— 组合作用域已死，
     * 写入挂在 [cloudWriteScope] 上，这次「最后的位置」才能发出去。
     */
    fun saveCloudProgressAsync(
        bookId: String,
        chapterIndex: Int,
        chapterFile: String,
        para: Int,
        charOffset: Int,
        /** 写入结束（true=成功）回调；回调已切主线程，可直接弹 Toast */
        onDone: ((Boolean) -> Unit)? = null,
    ) {
        if (!session.isLoggedIn) return
        cloudWriteScope.launch {
            val ok = saveCloudProgress(bookId, chapterIndex, chapterFile, para, charOffset) is ApiResult.Success
            if (onDone != null) withContext(Dispatchers.Main) { onDone(ok) }
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

    /**
     * 任意用户行的头像绝对地址（关注/粉丝列表等接口里 `avatar` 是相对路径或 null）。
     * 与上面的 profile 重载并存：列表行没有完整 UserProfile 可包。
     */
    fun avatarUrl(path: String?): String? = resolveUrl(path, baseUrl)

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
 */
class VoiceRepository(
    private val session: SessionRepository,
) {

    private val baseUrl: String get() = session.api.baseUrl

    /** 上次成功拉到的房间列表（进程内缓存）：重进语音 tab 先渲染它，不再每次转圈 */
    @Volatile
    var cachedRooms: List<VoiceRoom> = emptyList()
        private set

    /**
     * 访客建房的所有权令牌：建房响应下发一次，删除该房间时随头带回。
     * 登录用户建的房不需要令牌（服务端按会话鉴权）。
     * 加密凭证存储持久化（重启后仍能删除自己建的房）；这里只留一份**房间 id** 的
     * 进程内快照 —— “是否我建的房”在房间列表页高频查询，不该逐条过加密 prefs。
     */
    private val ownGuestRoomIds: MutableSet<Long> =
        java.util.concurrent.ConcurrentHashMap.newKeySet<Long>().also { s ->
            s.addAll(session.tokens.guestOwnerTokenIds())
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
                    ownGuestRoomIds.add(res.room.id)
                    session.tokens.setGuestOwnerToken(res.room.id, token)
                }
                ApiResult.Success(res.room)
            } catch (t: Throwable) {
                ApiResult.Failure(mapErrorFromThrowable(t))
            }
        }

    /** 这是不是我（本机访客身份）建的房：建房时落盘的令牌还在，删除时能带上 */
    fun isOwnGuestRoom(roomId: Long): Boolean = ownGuestRoomIds.contains(roomId)

    /** 删除房间（创建者或管理员；访客建房自动带上建房时留存的所有权令牌） */
    suspend fun deleteRoom(id: Long): ApiResult<Boolean> =
        withContext(Dispatchers.IO) {
            try {
                val token = if (ownGuestRoomIds.contains(id)) session.tokens.guestOwnerToken(id) else null
                val ok = session.api.voice.deleteRoom(id, token).success
                if (ok) {
                    ownGuestRoomIds.remove(id)
                    session.tokens.setGuestOwnerToken(id, null)
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

    /**
     * 云端朗读合成（`POST /api/tts`，见 server/src/routes/tts.ts）。
     *
     * 返回**音频字节**（mp3），由调用方（`ChatReader`）落成临时文件交给 `MediaPlayer` 播。
     * 为什么不在这里直接播：播放器生命周期要跟页面走（退出房间必须立刻停），
     * 仓库层是无状态的网络层，掺进播放器会让"谁负责释放"变得含糊。
     *
     * 权限/费用口径与 Web 端完全一致：接口本身允许游客（房间支持未登录访客），
     * 所以服务端按「登录用户 30 次/分、游客 6 次/分/IP」限流 —— 429 的文案会原样带给用户。
     */
    suspend fun speakCloud(text: String, voiceKey: String): ApiResult<ByteArray> =
        withContext(Dispatchers.IO) {
            try {
                ApiResult.Success(session.api.tts.speak(TtsRequest(text = text, voice = voiceKey)).bytes())
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
