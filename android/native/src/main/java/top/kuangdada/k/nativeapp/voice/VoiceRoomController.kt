package top.kuangdada.k.nativeapp.voice

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import top.kuangdada.k.core.data.ApiResult
import top.kuangdada.k.core.data.VoiceRepository
import top.kuangdada.k.core.data.VoiceSignalingClient
import top.kuangdada.k.core.data.displayMessage
import top.kuangdada.k.core.data.dayDividerText
import top.kuangdada.k.core.data.model.VoiceInbound
import top.kuangdada.k.core.data.model.VoiceInboundType
import top.kuangdada.k.core.data.model.VoiceParticipantDto
import top.kuangdada.k.core.data.model.VoiceRoom

/**
 * ============================================================
 * 语音房控制器（VoiceRoomController）
 * ============================================================
 * 把三块拼起来：**信令（OkHttp WebSocket）→ 会话（WebRTC mesh）→ UI 状态（StateFlow）**。
 *
 * 进房时序（严格按服务端设计）：
 *  1. 拿麦克风权限（**必须在 start() 之前**，否则 AudioRecord 无效、只表现为"本地静音"）
 *  2. 登录用户换一次性票据；访客不带票据（服务端分配负数 id + "未登录-N"）
 *  3. `GET /api/voice/ice` 拿 STUN/TURN（**这个端点不需要登录**，访客也能拿）
 *  4. 建 WebRTC、连 WS、发 `join`
 *  5. 收到 `joined` → 拿 `participants`（既有成员）与 `self`（服务端校正后的身份）
 *     → **由本端对每个既有成员发 offer**（服务端定的确定性规则，避免双方同时 offer）
 *  6. 之后 `peer-joined` 的新成员由对方发起 offer，本端只应答
 *
 * 一个必须记住的坑：`self` 是服务端**校正后**的身份 —— 访客的负数 id 由服务端分配，
 * 客户端进房前用的占位 id 是错的。WebRTC 的信令路由（`signal.to`）依赖这个 id，
 * 不校正就会"信令发给了不存在的用户"，表现为永远连不上。
 */
class VoiceRoomController(
    private val context: Context,
    private val voice: VoiceRepository,
    private val room: VoiceRoom,
    /** 房间内文字聊天（WS 的 chat 事件，服务端会入库并广播） */
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main),
) {

    enum class Phase { Idle, Preparing, Connecting, Joined, Closed, Failed }

    data class PeerUi(
        val userId: Long,
        val username: String,
        val avatarUrl: String?,
        val muted: Boolean,
        val listener: Boolean,
        val sharing: Boolean,
        /**
         * 该成员**自报**的网络质量（good / fair / poor；null = 尚未上报）。
         *
         * 注意语义：这是对方自己报的，不是我们测出来的 —— 服务端只是转发。
         * 所以它反映"对方的上行感受"，不是"我们听到的效果"。
         */
        val quality: String? = null,
    )

    data class ChatUi(
        val id: Long,
        val senderId: Long,
        val username: String,
        /** 发言人头像的绝对地址（设计稿的消息行是「头像 + 名字 时间 + 内容」） */
        val avatarUrl: String? = null,
        /** 「14:32」这种短时间（今天只显示时分，跨天带日期）——与 Web 端同一口径 */
        val timeText: String = "",
        val content: String,
        val isMine: Boolean,
        /** 这条是不是**刚收到的**（朗读只读新消息，不把进房时拉到的历史念一遍） */
        val live: Boolean = false,
    )

    data class State(
        val phase: Phase = Phase.Idle,
        val roomName: String = "",
        val selfUserId: Long = 0,
        val selfUsername: String = "",
        val peers: List<PeerUi> = emptyList(),
        /**
         * 正在说话的成员（含自己）—— 麦位**边框点亮**用（M6）。
         *
         * 来源是 WebRTC 统计里的音频幅度（见 [SpeakingGate]），只在翻转时更新；
         * 闭麦、对端离开、自己退出时都会被清掉，所以它不会留下"已经走了还在亮"的残影。
         */
        val speakingUserIds: Set<Long> = emptySet(),
        val chat: List<ChatUi> = emptyList(),
        val micEnabled: Boolean = true,
        val error: String? = null,
        /** 服务端是否配了 TURN。没有 TURN 时对称 NAT 会连不上，UI 要提示 */
        val hasTurn: Boolean = false,
        /** 已接通音频的对端数（用于"正在连接音频…"的进度感） */
        val audioConnected: Int = 0,
        val terminal: Boolean = false,
        /** 正在共享屏幕的是谁（0 = 无人共享） */
        val sharingUserId: Long = 0,
        /** 共享画面的视频轨（UI 用它渲染） */
        val remoteVideoTrack: org.webrtc.VideoTrack? = null,
        /**
         * 共享画面的**真实宽高比**（0 = 还没收到帧，UI 回落 16:9）。
         *
         * 必须是 State 里的字段而不是直接读会话里的 `@Volatile`：UI 在组合期取值，
         * volatile 变化不会触发重组，容器尺寸就永远停在首帧之前的值。
         */
        val remoteVideoAspect: Float = 0f,
        /**
         * 共享者**声明的采集尺寸**（服务端 `share-changed` / 房间成员信息里的 width/height）。
         *
         * 这是画面比例的**最高优先来源**：进房收到 `joined.participants` 或收到
         * `share-changed(active=true)` 时就已经知道，于是画面框**在首帧到达之前**就是正确比例
         * （否则只能等接收探针量到帧尺寸，观感是"先填满 16:9 再收成 16:10 + 左右黑边"）。
         *
         * null = 未声明（老客户端不发 / 老服务端不转 / 数值非法）→ 回落到
         * [remoteVideoAspect] 与 16:9 兜底，行为与加这个字段之前**逐字一致**。
         * 字段语义见 `VoiceParticipantDto.width`（唯一事实来源：shared/src/types.ts）。
         */
        val remoteShareSize: Pair<Int, Int>? = null,
        /** 本端是否正在共享 */
        val selfSharing: Boolean = false,
        /**
         * 共享方**是否带了系统声音**（服务端 `share-changed.audio`）。
         *
         * 只有为 true 时观看端的「声音」图标才有意义 —— 否则点了什么都不会发生。
         */
        val shareHasAudio: Boolean = false,
        /** 观看端是否静音了共享声音（声音图标的状态） */
        val shareAudioMuted: Boolean = false,
        /** 全房间混音录制（M3 第 16 项） */
        val recording: Boolean = false,
        val recordStartedAt: Long? = null,
        /** 录制结束后的成品文件（UI 用来提示 + 分享） */
        val recordedFile: java.io.File? = null,
        /** 录制格式说明（"Android 没有 MP3 编码器，已用 AAC"这类如实告知） */
        val recordFormatNote: String? = null,
    )

    private val _state = MutableStateFlow(State(roomName = room.name))
    val state: StateFlow<State> = _state.asStateFlow()

    private var signaling: VoiceSignalingClient? = null
    private var session: VoiceSession? = null
    private var myId: Long = 0
    private var micEnabled = true
    /**
     * 旁听模式（只听不发）：进入时不开麦克风。
     *
     * 注意**房间人数上限不在这里把关**：服务端 join 时会按 `VOICE_MAX_ROOM_SIZE` 拒绝，
     * 客户端侧的"满员就别让进"闸门在**房间列表**（`VoiceRoomsScreen` + `canJoinVoiceRoom`）。
     * （原先这里挂着一句"上限由服务端把关，这里只做 UI 提示"，但它悬在一个早已删掉的字段上，
     * 容易让人误以为房内已有闸门 —— 删掉，避免后来者据此判断失误。）
     */
    private var listenerMode = false

    init {
        // WebRTC → 信令：把 SDP/ICE 发出去
        // （session 在 start 时才建，所以这里用回调代理到当前实例）
    }

    // ---------------------------------------------------------------
    // 进房
    // ---------------------------------------------------------------

    /**
     * @param micGranted 调用方必须先确认已经拿到 RECORD_AUDIO 权限
     */
    fun join(micGranted: Boolean, listener: Boolean = false) {
        if (_state.value.phase != Phase.Idle && _state.value.phase != Phase.Failed) return
        listenerMode = listener
        scope.launch {
            _state.update { it.copy(phase = Phase.Preparing, error = null) }

            // 1) ICE 配置（不需要登录，访客也能拿）
            val iceConfig = when (val r = voice.ice()) {
                is ApiResult.Success -> r.data
                is ApiResult.Failure -> {
                    _state.update { it.copy(phase = Phase.Failed, error = "获取网络配置失败：${r.error.displayMessage}") }
                    return@launch
                }
            }
            _state.update { it.copy(hasTurn = iceConfig.servers.any { s -> s.hasTurn }) }

            // 2) 登录用户换一次性票据；访客不带（服务端分配负数 id）
            val ticket = if (voiceSignalingTicketNeeded()) {
                when (val r = voice.ticket()) {
                    is ApiResult.Success -> r.data
                    is ApiResult.Failure -> {
                        _state.update {
                            it.copy(phase = Phase.Failed, error = "获取语音票据失败：${r.error.displayMessage}")
                        }
                        return@launch
                    }
                }
            } else {
                null
            }

            // 3) WebRTC（没有录音权限时不启动 —— 越早暴露越好）
            if (!micGranted && !listener) {
                _state.update {
                    it.copy(phase = Phase.Failed, error = "没有麦克风权限：请允许录音后再进房，或以「只听」方式进入")
                }
                return@launch
            }

            val voiceSession = VoiceSession(context, VoiceSession.toIceServers(iceConfig))
            session = voiceSession
            voiceSession.setListener(object : VoiceSession.Listener {
                override fun onSendSignal(targetUserId: Long, data: JsonObject) {
                    signaling?.signal(targetUserId, data)
                }

                override fun onRemoteAudioAttached(userId: Long) {
                    _state.update { it.copy(audioConnected = it.audioConnected + 1) }
                }

                override fun onRemoteVideoAttached(userId: Long, track: org.webrtc.VideoTrack) {
                    // 屏幕共享（全房间最多一人，服务端互斥保证）
                    _state.update {
                        it.copy(sharingUserId = userId, remoteVideoTrack = track, remoteVideoAspect = 0f)
                    }
                }

                override fun onRemoteVideoAspect(aspect: Float) {
                    // 首帧/分辨率变化时才回调（会话侧已去抖）
                    _state.update { it.copy(remoteVideoAspect = aspect) }
                }

                override fun onNegotiationRequested(userId: Long) = Unit

                override fun onSpeaking(userId: Long, speaking: Boolean) {
                    // 只改这一个集合（每次翻转一次），麦位卡读它画边框
                    _state.update { st ->
                        if (speaking) st.copy(speakingUserIds = st.speakingUserIds + userId)
                        else st.copy(speakingUserIds = st.speakingUserIds - userId)
                    }
                }

                override fun onSelfSpeaking(speaking: Boolean) {
                    val me = myId
                    if (me == 0L) return
                    _state.update { st ->
                        if (speaking) st.copy(speakingUserIds = st.speakingUserIds + me)
                        else st.copy(speakingUserIds = st.speakingUserIds - me)
                    }
                }

                override fun onError(message: String) {
                    _state.update { it.copy(error = message) }
                }
            })
            if (micGranted || listener) voiceSession.start()
            voiceSession.setMicEnabled(micEnabled && !listener)

            // 4) 信令
            val client = (voice.signalingClient())
            signaling = client
            // 时间线起点（M6.12）：从这里到"首帧渲染完成"之间每一段都会打日志，
            // 用来回答"为什么要等 3~4 秒"——是信令/ICE 慢，还是渲染器挂载/首帧慢
            ShareFlow.join()
            client.connect(ticket, object : VoiceSignalingClient.Listener {
                override fun onState(state: VoiceSignalingClient.State, detail: String?) {
                    when (state) {
                        VoiceSignalingClient.State.Connected ->
                            _state.update { it.copy(phase = Phase.Connecting) }
                        VoiceSignalingClient.State.Failed ->
                            _state.update {
                                it.copy(
                                    phase = Phase.Failed,
                                    error = "语音连接失败${detail?.let { d -> "：$d" } ?: ""}",
                                )
                            }
                        VoiceSignalingClient.State.Closed -> {
                            if (client.terminal) {
                                _state.update {
                                    it.copy(
                                        phase = Phase.Failed,
                                        terminal = true,
                                        error = "语音连接被服务端关闭（认证失败 / 同一网络连接过多），不会自动重连",
                                    )
                                }
                            } else if (_state.value.phase != Phase.Failed) {
                                _state.update { it.copy(phase = Phase.Closed) }
                            }
                        }
                        else -> Unit
                    }
                }

                override fun onMessage(message: VoiceInbound) = handleInbound(message)

                override fun onServerError(message: String) {
                    _state.update { it.copy(error = message) }
                }
            })

            // 5) join（连上之后由 onState(Connected) 触发；这里等一小会儿再发，
            //    或者直接发 —— OkHttp 会排队到连接建立。直接发更简单且不引入定时器）
            client.join(room.id, listener = listener)
            voiceSession.setJoined(true)
        }
    }

    /** 是否该为这次建连取票据（登录用户才需要） */
    private fun voiceSignalingTicketNeeded(): Boolean = voice.currentToken() != null

    // ---------------------------------------------------------------
    // 下行消息处理
    // ---------------------------------------------------------------

    private fun handleInbound(message: VoiceInbound) {
        val s = session ?: return
        when (message.type) {
            VoiceInboundType.Joined -> {
                // self 是服务端**校正后**的身份（访客的负数 id 由服务端分配）
                val self = message.self
                if (self != null) {
                    myId = self.userId
                    _state.update { it.copy(selfUserId = self.userId, selfUsername = self.username) }
                }
                val existing = message.participants.filter { it.userId != myId }
                // 进房时若已有人在共享：从他的成员信息里直接读出声明的采集尺寸，
                // 画面框从第一帧起就是正确比例（这就是"首帧之前就知道比例"的关键一步）
                val sharerSize = existing.firstOrNull { it.sharing }.let { shareSizeOf(it?.width, it?.height) }
                if (sharerSize != null) ShareFlow.declaredSize(sharerSize.first, sharerSize.second)
                _state.update {
                    it.copy(
                        phase = Phase.Joined,
                        peers = existing.map { p -> p.toUi() },
                        remoteShareSize = sharerSize,
                    )
                }
                // **进房成功才起前台服务**：Android 14+ 后台采集麦克风必须由它持有，
                // 否则锁屏后系统会静默静音采集（界面还在、别人听不到你说话）。
                // 放在 joined 之后而不是 join 之前：万一认证失败，也不会留下一个假通知。
                VoiceForegroundService.start(
                    context = context,
                    title = _state.value.roomName.ifBlank { "语音房" },
                    text = "${existing.size + 1} 人在房",
                    // 点通知跳回这个房间（而不是只打开 App 首页）
                    roomId = room.id,
                )
                // 确定性规则：**新加入者**对既有成员发 offer
                existing.forEach { p -> s.offerTo(p.userId) }
                // 拉历史聊天记录：**服务端的持久化历史**（Web 端与你进房前的消息都在这里）。
                // 不拉的话只能看到进房之后的实时消息 —— 用户看到的就是"聊天没跟 Web 互通"。
                scope.launch { loadChatHistory() }
            }

            VoiceInboundType.PeerJoined -> {
                val p = message.participant ?: return
                if (p.userId == myId) return
                _state.update { st ->
                    if (st.peers.any { it.userId == p.userId }) st
                    else st.copy(peers = st.peers + p.toUi())
                }
                // 对方会给我们发 offer，这里不主动发起（避免双方同时 offer）
            }

            VoiceInboundType.PeerLeft -> {
                val userId = message.userId ?: return
                s.removePeer(userId)
                _state.update { st ->
                    st.copy(
                        peers = st.peers.filterNot { it.userId == userId },
                        audioConnected = (st.audioConnected - 1).coerceAtLeast(0),
                        // 人走了灯就得灭（会话那边也会报一次 false，这里兜底）
                        speakingUserIds = st.speakingUserIds - userId,
                    )
                }
            }

            VoiceInboundType.Signal -> {
                val from = message.from ?: return
                val data = message.data as? JsonObject ?: return
                s.handleSignal(from, data)
            }

            VoiceInboundType.MuteChanged -> {
                val userId = message.userId ?: return
                val muted = message.muted ?: return
                _state.update { st ->
                    st.copy(
                        peers = st.peers.map { if (it.userId == userId) it.copy(muted = muted) else it },
                        // 闭麦的人不该以"正在说话"亮着（会话那边也会收，这里兜底）
                        speakingUserIds = if (muted) st.speakingUserIds - userId else st.speakingUserIds,
                    )
                }
            }

            VoiceInboundType.PeerQuality -> {
                // 成员的**自报**网络质量。`level` 为 null 表示清除该成员的残留状态
                // （Web 版的 onPeerQuality 明确说明了这一点），所以这里要支持清空。
                val userId = message.userId ?: return
                val level = message.level?.takeIf { it in QUALITY_LEVELS }
                _state.update { st ->
                    st.copy(
                        peers = st.peers.map {
                            if (it.userId == userId) it.copy(quality = level) else it
                        }
                    )
                }
            }

            VoiceInboundType.ShareChanged -> {
                val userId = message.userId ?: return
                val active = message.active ?: false
                val declared = if (active) shareSizeOf(message.width, message.height) else null
                if (active) ShareFlow.declaredSize(declared?.first, declared?.second)
                _state.update { st ->
                    // 服务端保证同一时刻最多一人共享，所以置 true 时把其他人清掉
                    st.copy(
                        peers = st.peers.map {
                            when {
                                it.userId == userId -> it.copy(sharing = active)
                                active -> it.copy(sharing = false)
                                else -> it
                            }
                        },
                        sharingUserId = if (active) userId else if (st.sharingUserId == userId) 0 else st.sharingUserId,
                        // 共享者停止时清掉画面（对方的视频轨不会自己消失）
                        remoteVideoTrack = if (active) st.remoteVideoTrack else null,
                        // 比例是"上一路画面"的，必须一起清 —— 否则下一次共享会先按旧比例撑开
                        remoteVideoAspect = if (active) st.remoteVideoAspect else 0f,
                        // 声明的尺寸同理：只有"当前共享者停了"才清（别人停共享不该动这一路的比例来源），
                        // active=true 但对方没带尺寸（老客户端）时写 null → 回落接收探针
                        remoteShareSize = when {
                            active -> declared
                            st.sharingUserId == userId -> null
                            else -> st.remoteShareSize
                        },
                        // 对方是否带了系统声音（决定观看端的「声音」图标画不画）
                        shareHasAudio = if (active) (message.audio == true) else false,
                    )
                }
            }

            VoiceInboundType.ShareForceStop -> {
                // 被抢占（别人开始共享）：本端要真的停下采集，而不只是改 UI
                session?.stopScreenShare()
                _state.update { st ->
                    st.copy(
                        peers = st.peers.map { it.copy(sharing = false) },
                        sharingUserId = 0,
                        remoteVideoTrack = null,
                        remoteVideoAspect = 0f,
                        remoteShareSize = null,
                        selfSharing = false,
                    )
                }
            }

            VoiceInboundType.Chat -> {
                val m = message.message ?: return
                _state.update { st ->
                    // 按 id 去重（服务端会广播给包括发送者在内的所有人，本端也会本地回显）
                    if (st.chat.any { it.id == m.id }) st
                    else st.copy(
                        chat = st.chat + ChatUi(
                            id = m.id,
                            senderId = m.senderId,
                            username = m.username,
                            avatarUrl = voice.avatarUrl(m.avatar),
                            timeText = chatTimeText(m.createdAt),
                            content = m.content,
                            isMine = m.senderId == myId,
                            // 实时收到的才算"新消息"：朗读只念它，进房时拉到的历史不念
                            live = true,
                        )
                    )
                }
            }

            VoiceInboundType.ChatCleared -> {
                _state.update { it.copy(chat = emptyList()) }
            }

            VoiceInboundType.RoomClosed -> {
                _state.update {
                    it.copy(
                        phase = Phase.Closed,
                        terminal = true,
                        error = message.reason ?: "房间已被关闭",
                    )
                }
                leave()
            }

            VoiceInboundType.Error -> {
                _state.update { it.copy(error = message.errorText ?: message.message?.content ?: "语音房错误") }
            }

            else -> Unit
        }
    }

    // ---------------------------------------------------------------
    // 控制
    // ---------------------------------------------------------------

    fun toggleMic() {
        micEnabled = !micEnabled
        session?.setMicEnabled(micEnabled)
        // 录制侧也要知道：闭麦时自己的声音不能进录制（与 Web 版 setMutedGate 语义一致）
        session?.recorder?.setSelfMuted(!micEnabled)
        signaling?.setMuted(!micEnabled)
        _state.update {
            it.copy(
                micEnabled = micEnabled,
                // 闭麦的人不该以"正在说话"亮着（会话那边也会收，这里兜底）
                speakingUserIds = if (micEnabled) it.speakingUserIds else it.speakingUserIds - myId,
            )
        }
    }

    /**
     * 拉房间聊天历史（`GET /api/voice/rooms/:id/messages`）。
     *
     * 两个必须处理对的点：
     *  1. **与实时消息合并、按 id 去重**：拉取是异步的，这期间 WS 可能已经推来新消息 ——
     *     直接 `chat = 历史` 会把刚收到的那条覆盖掉，表现为"刚说的话自己消失"。
     *     所以取并集后按 id 排序（服务端 id 单调递增 = 时间序）。
     *  2. **失败静默**：历史拉不到只是少几条旧消息，不该在房间里弹错误 ——
     *     实时聊天仍然是通的，弹个错反而让人以为聊天坏了。
     */
    private suspend fun loadChatHistory() {
        when (val r = voice.roomMessages(room.id)) {
            is ApiResult.Success -> {
                val history = r.data
                if (history.isEmpty()) return
                _state.update { st ->
                    // history 是**消息 DTO**、st.chat 是**UI 模型**，两者类型不同，
                    // 所以按 id 取并集时只用 id 参与比较，最后再统一映射成 ChatUi
                    // （直接相加会因为元素类型不一致而推断失败）。
                    val seen = LinkedHashSet<Long>()
                    val ids = buildList {
                        // 先放历史、再放实时：同 id 时保留先出现的那个，顺序后面按 id 排
                        (history.map { it.id } + st.chat.map { it.id }).forEach { id ->
                            if (seen.add(id)) add(id)
                        }
                    }
                    val byId = (history.associateBy { it.id })
                    st.copy(
                        chat = ids.sorted().mapNotNull { id ->
                            val m = byId[id]
                            if (m != null) {
                                ChatUi(
                                    id = m.id,
                                    senderId = m.senderId,
                                    username = m.username,
                                    avatarUrl = voice.avatarUrl(m.avatar),
                                    timeText = chatTimeText(m.createdAt),
                                    content = m.content,
                                    isMine = m.senderId == myId,
                                )
                            } else {
                                // 历史里没有 → 是刚收到的实时消息，直接用已有的 UI 模型
                                st.chat.firstOrNull { it.id == id }
                            }
                        }
                    )
                }
            }
            is ApiResult.Failure -> Unit
        }
    }

    fun sendChat(content: String) {
        val text = content.trim()
        if (text.isEmpty()) return
        // 与 Web 端同一个上限（输入框那行"（500 字以内）"不是随口写的）
        signaling?.chat(text.take(CHAT_MAX_CHARS))
    }

    /**
     * 清空本房间聊天记录（设计稿「文字聊天 → 清空」）。
     *
     * 只有房间创建者/管理员会看到这个按钮（UI 按 `VoiceRoom.isCreator` 判断），
     * 但**权限仍然由服务端把关**（非创建者会拿到 403）—— 客户端判断只是"不画那个按钮"。
     * 成功后服务端会广播 `chat-cleared`（本端也会收到，见 handleInbound），
     * 这里顺手先清一次，让点击立刻有反馈。
     */
    fun clearChat() {
        scope.launch {
            when (val r = voice.clearRoomMessages(room.id)) {
                is ApiResult.Success -> _state.update { it.copy(chat = emptyList(), error = null) }
                is ApiResult.Failure ->
                    _state.update { it.copy(error = "清空聊天记录失败：${r.error.displayMessage}") }
            }
        }
    }

    // ---------------------------------------------------------------
    // 屏幕共享
    // ---------------------------------------------------------------

    /**
     * 开始共享。
     *
     * @param permissionData `MediaProjectionManager.createScreenCaptureIntent()` 的结果
     */
    fun startShare(permissionData: android.content.Intent) {
        val s = session ?: return
        val started = s.startScreenShare(
            permissionData = permissionData,
            projectionCallback = object : android.media.projection.MediaProjection.Callback() {
                // 用户在系统弹窗/通知里点"停止共享"时必须跟着停，
                // 否则本端还在采集但对方已收不到画面（Android 14 起不注册这个回调会抛异常）
                override fun onStop() {
                    stopShare()
                }
            },
        )
        if (started) {
            // 服务端负责互斥与抢占：share-start(audio=false) → 广播 share-changed。
            // width/height = 本端采集像素尺寸（可选字段）：观看端（含之后进房的人）
            // 在首帧到达之前就能把画面框按正确比例摆好 —— 语义见 VoiceParticipantDto.width
            val capture = s.localShareCaptureSize
            signaling?.send(
                top.kuangdada.k.core.data.model.VoiceOutbound(
                    type = top.kuangdada.k.core.data.model.VoiceOutboundType.ShareStart,
                    audio = false,
                    width = capture?.first,
                    height = capture?.second,
                )
            )
            _state.update {
                it.copy(
                    selfSharing = true,
                    // **共享者自己也要能看到画面**（本端预览）。
                    // 之前只置了 selfSharing、没置 remoteVideoTrack，而 UI 的渲染条件是
                    // `remoteVideoTrack != null` —— 于是共享者看到的仍是麦位网格，
                    // 表现就是"屏幕共享是黑的/没反应"，其实流已经在发了。
                    // mesh 拓扑里不存在"自己发出去的流绕回来"，所以只能用本地轨。
                    sharingUserId = it.selfUserId,
                    remoteVideoTrack = s.localShareTrack,
                )
            }
            // Android 14+ 要求共享期间前台服务类型包含 mediaProjection
            VoiceForegroundService.start(
                context = context,
                title = _state.value.roomName.ifBlank { "语音房" },
                text = "正在共享屏幕",
                roomId = room.id,
            )
        }
    }

    /**
     * 会话当前的 EGL 上下文（渲染共享画面用）。
     *
     * 让 UI 复用会话已有的上下文，而不是每个渲染器各建一个 `EglBase`
     * —— 后者会随反复开关共享不断堆积 GL 上下文与线程（WebRTC 不回收），
     * 最终表现为共享画面黑屏。返回 null 时 UI 会自建一个并负责释放。
     */
    fun sessionEglContext(): org.webrtc.EglBase.Context? = session?.shareEglContext

    /**
     * 远端共享画面的宽高比（0 = 还没收到帧，UI 回落到 16:9）。
     *
     * **读的是 State 里的字段**（由 `onRemoteVideoAspect` 推送），不是会话上的 `@Volatile`：
     * 组合期读一次 volatile 拿不到后续变化，容器尺寸会一直停在首帧之前的值
     * —— 这正是用户实测「全屏打开没有任何改善」的成因之一。
     * 会话侧只在比例**真的变了**（差值 > 0.005）时才回调，所以不会每帧一次重组。
     */
    fun remoteVideoAspect(): Float = _state.value.remoteVideoAspect

    /**
     * 观看端：开关共享声音（右上角的声音图标）。
     *
     * 与 Web 端「共享声音开关」同语义：只影响**本端听不听**，不影响共享者。
     */
    fun toggleShareAudio() {
        val next = !_state.value.shareAudioMuted
        _state.update { it.copy(shareAudioMuted = next) }
        session?.setReceiveAudioEnabled(!next)
    }

    fun stopShare() {        session?.stopScreenShare()
        signaling?.send(
            top.kuangdada.k.core.data.model.VoiceOutbound(
                type = top.kuangdada.k.core.data.model.VoiceOutboundType.ShareStop,
            )
        )
        _state.update {
            it.copy(
                selfSharing = false,
                // 清掉本端预览；若此时别人在共享，服务端会另发 share-changed 把轨道重新填上
                sharingUserId = if (it.sharingUserId == it.selfUserId) 0 else it.sharingUserId,
                remoteVideoTrack = if (it.sharingUserId == it.selfUserId) null else it.remoteVideoTrack,
                // 声明的尺寸与预览轨同生命周期：自己停了就别再拿它给下一路画面排版
                remoteShareSize = if (it.sharingUserId == it.selfUserId) null else it.remoteShareSize,
            )
        }
    }

    // ---------------------------------------------------------------
    // 全房间混音录制
    // ---------------------------------------------------------------

    /**
     * 开始/停止录制（同一个按钮切换）。
     *
     * 录的是**全房间混音**：远端各路（WebRTC 已混好）+ 开麦时的自己。
     * 与 Web 版对齐的两条语义：
     *  · 闭麦时自己的声音不进录制；
     *  · 录制中途进房的人会被自动录进去（原生侧录的是播放混音输出，天然满足）。
     */
    fun toggleRecording() {
        val s = session ?: return
        if (_state.value.recording) {
            stopRecording()
            return
        }

        val caps = RoomRecorder.capabilities()
        val recorder = RoomRecorder(context) { recording, startedAt, file, error ->
            _state.update {
                it.copy(
                    recording = recording,
                    recordStartedAt = startedAt,
                    recordedFile = file ?: it.recordedFile,
                    error = error ?: it.error,
                )
            }
        }
        recorder.setSelfMuted(!micEnabled)
        s.recorder = recorder

        val error = recorder.start()
        if (error != null) {
            s.recorder = null
            _state.update { it.copy(error = error) }
            return
        }
        _state.update {
            it.copy(
                recording = true,
                recordStartedAt = System.currentTimeMillis(),
                recordedFile = null,
                recordFormatNote = caps.note,
            )
        }
    }

    fun stopRecording() {
        val s = session ?: return
        val file = s.recorder?.stop()
        s.recorder = null
        _state.update {
            it.copy(recording = false, recordStartedAt = null, recordedFile = file)
        }
    }

    /**
     * 把录好的文件交给系统分享面板。
     *
     * 用 FileProvider 而不是直接给 `file://` 路径：Android 7+ 起 `file://` 会抛
     * `FileUriExposedException`，而且接收方应用（微信等）本来也没有读外部存储的权限。
     * 录制的落点在 `Music/K/`，见 `res/xml/file_paths.xml` 的对应声明。
     */
    fun shareRecording(file: java.io.File) {
        runCatching {
            val uri = androidx.core.content.FileProvider.getUriForFile(
                context,
                "${context.packageName}.fileprovider",
                file,
            )
            val mime = when (file.extension.lowercase()) {
                "mp3" -> "audio/mpeg"
                "m4a", "mp4" -> "audio/mp4"
                else -> "audio/*"
            }
            val intent = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
                type = mime
                putExtra(android.content.Intent.EXTRA_STREAM, uri)
                putExtra(android.content.Intent.EXTRA_SUBJECT, "${_state.value.roomName} 的录音")
                addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            val chooser = android.content.Intent.createChooser(intent, "分享录音")
                .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(chooser)
        }.onFailure { t ->
            _state.update { it.copy(error = "分享录音失败：${t.message}（文件在 ${file.absolutePath}）") }
        }
    }

    fun leave() {
        // 退房前先把录制结算落盘：不然文件描述符一关，录的东西就丢了
        runCatching { if (_state.value.recording) stopRecording() }
        runCatching { signaling?.leave() }
        runCatching { signaling?.close() }
        runCatching { session?.stop() }
        // 退房必须收掉前台服务：不收的话通知栏会留一条假通知，
        // 而且服务一直持有麦克风类型的前台状态（系统会持续显示"正在使用麦克风"）
        runCatching { VoiceForegroundService.stop(context) }
        signaling = null
        session = null
        // 退房：所有"正在说话"的灯一起收掉（页面马上就销毁了，但状态要干净）
        _state.update { it.copy(phase = Phase.Closed, speakingUserIds = emptySet()) }
        scope.cancel()
    }

    private fun VoiceParticipantDto.toUi(): PeerUi = PeerUi(
        userId = userId,
        username = username,
        avatarUrl = voice.avatarUrl(avatar),
        muted = muted,
        listener = listener,
        sharing = sharing,
    )

    /**
     * 聊天消息的短时间戳（设计稿：名字右边那串「21:05」）。
     *
     * 复用 `core:data` 里那套：**今天只显示时分，跨天带上日期**（与 Web 端
     * `formatChatTime` 同一口径）。`dayDividerText` 今天那条会带「今天 」前缀，
     * 这里把它去掉 —— 消息行不像分隔条，不需要重复"今天"。
     */
    private fun chatTimeText(iso: String): String =
        dayDividerText(iso).removePrefix("今天 ")

    companion object {
        /** 服务端允许的自报质量档位（见 client/src/voice/types.ts 的 VoiceQualityLevel） */
        val QUALITY_LEVELS = setOf("good", "fair", "poor")

        /** 单条聊天消息的字数上限（与 Web 端输入框的 maxLength 一致） */
        const val CHAT_MAX_CHARS = 500
    }
}

/**
 * 把信令里的 `width`/`height` 收成"声明的采集尺寸"。
 *
 * 缺任一字段、非正数一律当**未声明**（返回 null）→ UI 回落到接收探针/16:9，
 * 与"老客户端不发这两个字段"是同一条路径。字段语义见 [VoiceParticipantDto.width]
 * （唯一事实来源：`shared/src/types.ts` 的 `VoiceParticipant.width`）。
 *
 * 单独抽成顶层纯函数是为了可单测：这个判断错了不会报错，只会让画面框按错误比例排版。
 */
internal fun shareSizeOf(width: Int?, height: Int?): Pair<Int, Int>? =
    if (width != null && height != null && width > 0 && height > 0) width to height else null
