package top.kuangdada.k.core.data

import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import top.kuangdada.k.core.data.model.VoiceInbound
import top.kuangdada.k.core.data.model.VoiceOutbound
import top.kuangdada.k.core.data.model.VoiceOutboundType

/**
 * ============================================================
 * 语音信令客户端（VoiceSignalingClient）
 * ============================================================
 * 只负责**一条 WebSocket 的生命周期**与协议收发，不掺任何 WebRTC/音频逻辑 ——
 * 这样信令层的 bug（连不上、认证失败、重连策略）与媒体层的 bug 能分开定位。
 *
 * 三个服务端约束都已落实：
 *  1. **鉴权走查询串**：登录用户用一次性票据 `?ticket=`（`POST /api/voice/ticket`），
 *     访客不带凭证（服务端会分配负数 id + "未登录-N"）；`?token=` 是已废弃的兼容路径。
 *  2. **心跳**：服务端每 30s ping，客户端必须回 pong —— **OkHttp 自动回 pong**，
 *     所以不需要手写心跳；但连接要设 `pingInterval` 以便及早发现半开连接。
 *  3. **关闭码语义**：4001（认证失败/封禁）与 4004（同网络连接过多）是**终止类**，
 *     不能重连 —— 服务端明确说"客户端据此结束会话，不再按 3s 间隔重连"。
 */
class VoiceSignalingClient(
    private val baseUrl: String,
    private val tokenProvider: () -> String?,
) {

    /** 连接状态（UI 直接映射成文案） */
    enum class State { Idle, Connecting, Connected, Closed, Failed }

    interface Listener {
        fun onState(state: State, detail: String?)

        /** 收到一条下行消息 */
        fun onMessage(message: VoiceInbound)

        /** 服务端给了 error 文案（不是连接层错误） */
        fun onServerError(message: String)
    }

    private var socket: WebSocket? = null
    private var listener: Listener? = null

    /** 终止类关闭：4001 认证失败 / 4004 连接过多 —— 设了它就不再重连 */
    var terminal: Boolean = false
        private set

    var state: State = State.Idle
        private set

    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        // 20s 无任何帧就当连接已死（服务端 30s ping 一次；比它短一点能更早发现）
        .pingInterval(20, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS) // WebSocket 长连接不能有读超时
        .build()

    /**
     * 建连。
     *
     * @param ticket 登录用户的一次性票据；null = 以访客身份连接
     */
    fun connect(ticket: String?, listener: Listener) {
        this.listener = listener
        terminal = false
        setState(State.Connecting, null)

        val wsScheme = if (baseUrl.startsWith("https")) "wss" else "ws"
        val host = baseUrl.removePrefix("https://").removePrefix("http://").trimEnd('/')
        val query = when {
            !ticket.isNullOrBlank() -> "?ticket=$ticket"
            // 兼容路径：服务端会记一条"仍用已废弃的 ?token="，能不走近量不走
            else -> tokenProvider()?.takeIf { it.isNotBlank() }?.let { "?token=$it" } ?: ""
        }
        val url = "$wsScheme://$host/api/voice/ws$query"

        val request = Request.Builder().url(url).build()
        socket = client.newWebSocket(request, object : WebSocketListener() {

            override fun onOpen(webSocket: WebSocket, response: Response) {
                setState(State.Connected, null)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val inbound = runCatching {
                    KJson.decodeFromString(VoiceInbound.serializer(), text)
                }.getOrNull() ?: return
                if (inbound.type == "error" || inbound.errorText != null) {
                    this@VoiceSignalingClient.listener?.onServerError(
                        inbound.errorText ?: inbound.message?.content ?: "语音服务返回错误"
                    )
                }
                this@VoiceSignalingClient.listener?.onMessage(inbound)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                // 回一个 close 帧，让服务端尽快释放席位（IP 并发上限是有配额的）
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                // 4001/4004 是终止类（服务端语义），设了标记让上层不要重连
                if (code == 4001 || code == 4004) terminal = true
                setState(State.Closed, "code=$code ${reason}".trim())
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                setState(State.Failed, t.message)
            }
        })
    }

    fun send(message: VoiceOutbound): Boolean {
        val ws = socket ?: return false
        val body = runCatching { KJson.encodeToString(VoiceOutbound.serializer(), message) }.getOrNull()
            ?: return false
        return ws.send(body)
    }

    // ---- 便捷方法（把 type + 字段的对应关系固定在这里，避免调用方写错） ----

    fun join(roomId: Long, listener: Boolean = false) = send(
        VoiceOutbound(type = VoiceOutboundType.Join, roomId = roomId, listener = listener)
    )

    fun leave() = send(VoiceOutbound(type = VoiceOutboundType.Leave))

    fun setMuted(muted: Boolean) = send(VoiceOutbound(type = VoiceOutboundType.Mute, muted = muted))

    /** 信令负载：SDP 或 ICE 候选，原样透传（服务端不解析） */
    fun signal(to: Long, data: JsonElement) = send(
        VoiceOutbound(type = VoiceOutboundType.Signal, to = to, data = data)
    )

    /** 便捷：发一条 JSON 对象信令（`{kind:'sdp', sdp:'…'}` 之类） */
    fun signalObject(to: Long, payload: Map<String, String>) {
        val data = buildJsonObject {
            payload.forEach { (k, v) -> put(k, JsonPrimitive(v)) }
        }
        signal(to, data)
    }

    fun chat(content: String) = send(
        VoiceOutbound(type = VoiceOutboundType.Chat, content = content)
    )

    fun close() {
        socket?.close(1000, "client close")
        socket = null
        setState(State.Closed, "client close")
    }

    private fun setState(next: State, detail: String?) {
        state = next
        listener?.onState(next, detail)
    }
}
