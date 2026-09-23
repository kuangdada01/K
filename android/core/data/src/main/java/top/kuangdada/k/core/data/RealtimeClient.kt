package top.kuangdada.k.core.data

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
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
 */
class RealtimeClient(private val session: SessionRepository) {

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
    ) {
        val isMessage: Boolean get() = type == "message"
        val isNotification: Boolean get() = type == "notification"
        val isAnnouncement: Boolean get() = type == "announcement"
    }

    private val _events = MutableSharedFlow<Event>(extraBufferCapacity = 32)

    /** 事件流（多个页面可同时收集；`extraBufferCapacity` 保证没有收集者时不阻塞发送方） */
    val events: SharedFlow<Event> = _events

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
     * 调用时机由 UI 层决定：**已登录且在前台**才连；退到后台/退出登录就 [stop]
     * （一直挂着白耗电，服务端也有 5 条/账号的上限）。
     */
    fun start(scope: CoroutineScope) {
        if (job?.isActive == true) return
        job = scope.launch { runLoop() }
    }

    fun stop() {
        job?.cancel()
        job = null
        source?.cancel()
        source = null
    }

    private suspend fun runLoop() {
        var backoffMs = 1_000L
        while (currentCoroutineContext().isActive) {
            if (session.tokens.token.isNullOrEmpty()) return // 退出登录：整条循环结束
            val ticket = fetchTicket()
            if (ticket == null) {
                delay(backoffMs)
                backoffMs = (backoffMs * 2).coerceAtMost(MAX_BACKOFF_MS)
                continue
            }
            when (val outcome = connectOnce(ticket)) {
                Outcome.KICKED -> return
                Outcome.OPENED -> backoffMs = 1_000L // 连上过就复位退避
                Outcome.FAILED -> Unit
            }
            if (!currentCoroutineContext().isActive) return
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
        val url = session.api.baseUrl.trimEnd('/') +
            "/api/events?ticket=" + java.net.URLEncoder.encode(ticket, "UTF-8")

        val listener = object : EventSourceListener() {
            override fun onOpen(eventSource: EventSource, response: Response) {
                opened = true
            }

            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                // 被服务端踢出：关闭且不再重连（见类注释）
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
    }
}
