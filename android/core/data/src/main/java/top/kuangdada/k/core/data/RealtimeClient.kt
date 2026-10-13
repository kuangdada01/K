package top.kuangdada.k.core.data

import android.util.Log
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources

/**
 * ============================================================
 * 实时事件流（SSE）—— 取代"手动下拉才更新"
 * ============================================================
 * 与 Web 版 `client/src/hooks/useSse.ts` **同一套语义**（那份是参考实现，逐条对齐）：
 *
 *  · **认证靠一次性票据**：`POST /api/events/ticket` 用 Bearer 换一张短时票据，
 *    再 `GET /api/events?ticket=...` 建长连接。JWT 不进 URL（否则会落进反代 access log）。
 *  · **票据一次性 + 短有效期 ⇒ 不能用 SSE 自带的自动重连**（重放同一 URL 会 401），
 *    只能自己退避重连：1s 起、每次 ×2、封顶 30s，**连接成功后复位**。
 *  · **`kicked` 事件**（同账号并发连接超过服务端上限 5 条时服务端踢掉最早的）：
 *    收到就关掉且**不再重连**，否则新旧连接互相顶来顶去形成震荡环。
 *  · 事件类型（服务端 `sse.ts` + 各业务调用点）：
 *      - `message`      新私信，payload `{ from, to }`（收发双方都会收到）
 *      - `notification` 新互动通知，payload `{ comment_id, post_id }`
 *      - `announcement` 新公告，payload `{ announcement_id }`
 *
 * 为什么单独建 OkHttpClient：KApi 那个 readTimeout 是 20s，而 SSE 是长连接
 * （服务端心跳 25s 一次）—— 用同一个客户端的话每次都会被自己掐断。
 *
 * ## 连接状态（2026-10 新增）
 *
 * [status] 把"现在连着没有"变成可观测的状态。加它的直接原因是排查
 * 「挂了后台收不到通知」时，客户端与服务端**互相看不出对方的状态**：
 * 服务端只在"没有在线连接"时打日志（`事件已丢弃`），而客户端一旦因为
 * `kicked` / 半死连接静默失聪，界面与日志上完全没有痕迹。
 *
 * ⚠️ 另见 [readTimeout] 的一个固有风险：读超时是 0（长连接不能被读超时掐断），
 * 而 OkHttp 不开 TCP keepalive —— 链路"半死"（切网、NAT 重绑、服务端静默关闭）
 * 时读会**永远挂着、不抛异常、也不重连**。所以后台还有一层轮询兜底
 * （见 `InboxStore.retainPoll`），不把"能收到"完全押在这条连接上。
 */
class RealtimeClient(private val session: SessionRepository) : NotificationSource {

    /** 连接状态（诊断页与日志用；不参与业务判断，业务判断看是否收到事件） */
    enum class Status {
        /** 没在连（未登录 / 已 [stop]） */
        Idle,

        /** 正在换票据或建连接 */
        Connecting,

        /** 连接已建立（收到过 `onOpen`） */
        Connected,

        /** 断开后退避重连中 */
        Retrying,

        /**
         * 被服务端顶掉（同账号并发连接超过上限）。
         *
         * 会退避很久再试（见 [KICK_RETRY_MS]），但**不再永久退出**：一端被顶掉后
         * 本进程内再也收不到任何事件，而用户看到的是"App 开着却没反应"。
         */
        Kicked,
    }


    /** 服务端推送的事件 */
    @Serializable
    data class Event(
        val type: String = "",
        @SerialName("post_id") val postId: Long? = null,
        @SerialName("comment_id") val commentId: Long? = null,
        @SerialName("announcement_id") val announcementId: Long? = null,
        /** 私信事件里的发送者 id */
        val from: Long? = null,
        /** 私信事件里的接收者 id */
        val to: Long? = null,
        /**
         * 撤回事件里"被撤回的那条消息 id"。
         *
         * ⚠️ 服务端的撤回走的是**同一个 `message` 事件类型**
         * （`{ from, to, recalled }`，见 `services/message.service.ts`），
         * 所以通知栏必须能把它和新消息区分开 —— 否则"对方撤回一条消息"
         * 会在通知栏提示成"对方给你发了一条消息"。
         */
        val recalled: Long? = null,
    ) {
        val isMessage: Boolean get() = type == "message"
        /** 真正的**新消息**（排除撤回）：通知栏只认这个，不认 [isMessage] 本身 */
        val isNewMessage: Boolean get() = type == "message" && recalled == null
        val isNotification: Boolean get() = type == "notification"
        val isAnnouncement: Boolean get() = type == "announcement"
    }

    /**
     * 事件缓冲：`extraBufferCapacity` 保证没有收集者时不阻塞发送方；
     * `DROP_OLDEST` 保证慢消费者（collect 内联等网络的页面）挂住时丢弃最旧事件
     * 而不是静默丢**最新**事件 —— 多人连发消息突发超过缓冲时，丢旧的顶多少弹一条
     * 旧通知（角标由刷新对账兜住），丢新的则用户永远看不到刚发生的那条
     * （与 `ChessGameController` 的信令消息流同一策略）。
     */
    private val _events = MutableSharedFlow<Event>(
        extraBufferCapacity = 32,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )

    /** 事件流（多个页面可同时收集；`extraBufferCapacity` 保证没有收集者时不阻塞发送方） */
    override val events: SharedFlow<Event> = _events

    private val _status = MutableStateFlow(Status.Idle)

    /** 当前连接状态（诊断入口读它；状态机见 [Status]） */
    val status: StateFlow<Status> = _status.asStateFlow()


    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            // 0 = 不限时：长连接不能被读超时掐断
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .writeTimeout(15, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()
    }

    private var job: Job? = null
    private var source: EventSource? = null

    /**
     * 开始连接（幂等：重复调用不会开第二条）。
     *
     * 调用时机由 `AppShell` 的生命周期驱动：ON_START 连上、ON_STOP 主动断开
     * （退到后台就不再持有连接，服务端据此转厂商推送，见 server/src/sse.ts）；
     * 退出登录时 [runLoop] 自己会发现没有 token 并结束循环。
     */
    fun start(scope: CoroutineScope) {
        if (job?.isActive == true) return
        _status.value = Status.Connecting
        job = scope.launch { runLoop() }
    }

    fun stop() {
        job?.cancel()
        job = null
        source?.cancel()
        source = null
        _status.value = Status.Idle
    }

    private suspend fun runLoop() {
        var backoffMs = 1_000L
        while (currentCoroutineContext().isActive) {
            if (session.tokens.token.isNullOrEmpty()) {
                // 退出登录：整条循环结束（状态归 Idle，别让诊断页显示"还在连"）
                _status.value = Status.Idle
                return
            }
            val ticket = fetchTicket()
            if (ticket == null) {
                // 换票据失败（网络抖动 / 401）：退避后重试
                _status.value = Status.Retrying
                delay(backoffMs)
                backoffMs = (backoffMs * 2).coerceAtMost(MAX_BACKOFF_MS)
                continue
            }
            when (val outcome = connectOnce(ticket)) {
                /**
                 * 被服务端顶掉：**不再像以前那样直接结束整条循环**。
                 *
                 * 以前 `return` 的后果是"本进程内永久失聪"：被顶掉后再也不会重连，
                 * 而用户看到的是"App 开着、别人发消息没有任何反应"（症状与"服务端
                 * 没有在线连接"完全一样，排查时极其误导）。现在退避一段较长的时间再试，
                 * 既不与刚建立的那条连接互相顶来顶去，又能自愈。
                 */
                Outcome.KICKED -> {
                    _status.value = Status.Kicked
                    Log.w(TAG, "SSE 被服务端顶掉（同账号连接数超限），${KICK_RETRY_MS / 1000}s 后重试")
                    delay(KICK_RETRY_MS)
                    backoffMs = 1_000L
                    continue
                }
                Outcome.OPENED -> backoffMs = 1_000L // 连上过就复位退避
                Outcome.FAILED -> Unit
            }
            if (!currentCoroutineContext().isActive) return
            _status.value = Status.Retrying
            delay(backoffMs)
            backoffMs = (backoffMs * 2).coerceAtMost(MAX_BACKOFF_MS)
        }
    }

    private suspend fun fetchTicket(): String? = runCatching {
        session.api.events.ticket().ticket.ifBlank { null }
    }.getOrNull()

    private enum class Outcome { OPENED, FAILED, KICKED }

    /** 建一条连接并挂起，直到它结束（正常关闭 / 失败 / 被踢） */
    private suspend fun connectOnce(ticket: String): Outcome = suspendCancellableCoroutine { cont ->
        var opened = false
        /**
         * `client=android`：向服务端声明"这是原生 App 的连接"。
         *
         * 服务端据此决定**要不要补一条 OPPO 设备推送**（见 server/src/sse.ts 的
         * SseClientKind）：只要有一条 android 连接（= App 在前台），就只走 SSE、
         * 绝不重复提醒；App 退后台会主动断开（AppShell 的 ON_STOP），服务端立刻
         * 看作"手机不在线" → 走系统推送。网页端连接不带这个参数，不会压掉手机提醒。
         */
        val url = session.api.baseUrl.trimEnd('/') +
            "/api/events?client=android&ticket=" + java.net.URLEncoder.encode(ticket, "UTF-8")

        val listener = object : EventSourceListener() {
            override fun onOpen(eventSource: EventSource, response: Response) {
                opened = true
                _status.value = Status.Connected
                Log.i(TAG, "SSE 已连接")
            }

            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                // 被服务端踢出：关闭并交给 runLoop 决定何时重试（见 Outcome.KICKED 的注释）
                if (type == "kicked") {
                    eventSource.cancel()
                    if (source === eventSource) source = null
                    if (cont.isActive) cont.resumeWith(Result.success(Outcome.KICKED))
                    return
                }
                if (data.isBlank()) return
                val event = runCatching { KJson.decodeFromString<Event>(data) }.getOrNull() ?: return
                if (event.type.isBlank()) return
                _events.tryEmit(event)
            }

            override fun onClosed(eventSource: EventSource) {
                if (source === eventSource) source = null
                if (cont.isActive) {
                    cont.resumeWith(Result.success(if (opened) Outcome.OPENED else Outcome.FAILED))
                }
            }

            override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                if (source === eventSource) source = null
                // 连接断了要留下痕迹：这正是"后台收不到消息"时唯一能回收的信息
                Log.w(TAG, "SSE 断开：${t?.message ?: "服务端关闭"}（HTTP ${response?.code ?: "-"}）")
                if (cont.isActive) {
                    cont.resumeWith(Result.success(if (opened) Outcome.OPENED else Outcome.FAILED))
                }
            }
        }

        val es = EventSources.createFactory(client).newEventSource(
            Request.Builder().url(url).build(),
            listener,
        )
        source = es
        cont.invokeOnCancellation { es.cancel() }
    }

    private companion object {
        const val MAX_BACKOFF_MS = 30_000L

        /**
         * 被服务端顶掉后的重试间隔。
         *
         * 刻意远长于普通退避上限（30s）：被顶掉说明同账号的连接数已经超限，
         * 立刻抢回来只会形成"两端互相顶"的震荡环（服务端注释里也是这个顾虑）。
         * 60s 足够让真正的活跃端稳定占位，同时保证本端最多 1 分钟内自愈。
         */
        const val KICK_RETRY_MS = 60_000L

        /** logcat 过滤用：`adb logcat -s KRealtime`（排查"后台收不到通知"时的第一现场） */
        const val TAG = "KRealtime"
    }
}
