package top.kuangdada.k.core.data

import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import top.kuangdada.k.core.data.model.ChessClientMsg
import top.kuangdada.k.core.data.model.ChessServerMsg
import top.kuangdada.k.core.data.model.VoiceInbound
import top.kuangdada.k.core.data.model.VoiceOutbound
import top.kuangdada.k.core.data.model.VoiceOutboundType
import top.kuangdada.k.core.data.model.decodeChessServerMsg
import top.kuangdada.k.core.data.model.encodeChessClientMsg

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

        /**
         * 收到一条**对局象棋**消息（`game-` 前缀）。
         *
         * 与 [onMessage] 分开走：`game-*` 的载荷与信令毫无交集（席位/棋钟/被吃子/记谱
         * 都是嵌套结构），硬塞进 [VoiceInbound] 那个"宽松信封"只会把两边都搞乱。
         * 分流点在 [onMessage] 里按前缀做，解码形状见
         * [top.kuangdada.k.core.data.model.ChessServerMsg]。
         *
         * 默认空实现：只有房间页关心对局，不需要所有实现都写一遍。
         */
        fun onChessMessage(message: ChessServerMsg) = Unit

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

    /**
     * 共享 OkHttp client（companion 单例）。老实现是实例字段 —— 每次进房 new 一个，
     * :core:data 里一度有 4 份独立 client，连接池/TLS 会话/线程池全部不复用
     * （2026-09-28 审查项）。信令 WebSocket 的超时/ping 参数全项目只有这一种口径，
     * 共享是安全的。
     */
    private val client: OkHttpClient get() = CLIENT

    companion object {
        private val CLIENT: OkHttpClient by lazy {
            OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                // 20s 无任何帧就当连接已死（服务端 30s ping 一次；比它短一点能更早发现）
                .pingInterval(20, TimeUnit.SECONDS)
                .readTimeout(0, TimeUnit.MILLISECONDS) // WebSocket 长连接不能有读超时
                .build()
        }
    }

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
        // 二次 connect 前先掐掉旧连接：不 cancel 的话旧 WebSocket 泄漏，
        // 占着服务端"同 IP 连接数"的配额（当前调用方恰好每次重建实例规避了它，
        // 但契约上是隐患 —— 2026-09-28 审查项）
        socket?.cancel()
        socket = client.newWebSocket(request, object : WebSocketListener() {

            override fun onOpen(webSocket: WebSocket, response: Response) {
                setState(State.Connected, null)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                // 对局象棋：`game-` 前缀在服务端是**统一转发**给 chessGameManager 的
                // （messageHandlers.ts 的 default 分支），客户端也照同样的规则分流。
                // 顺序很重要：必须先判前缀 —— `game-error` 的 `message` 是**字符串**，
                // 而 VoiceInbound.message 期望的是聊天对象，走下面那条会在解码时抛异常
                // 被 runCatching 吞成 null，整条消息静默丢失。
                //
                // ★ 单次解析（2026-09-28 审查项）：老实现先 parse 一遍取 `type` 分流、
                //   命中后**再从字符串**完整 decode 一遍 —— SDP/ICE/棋类载荷有数 KB，
                //   高频交换时解析开销翻倍。现在 parse 一次成 JsonObject，两条分支都
                //   从同一个元素解码（decodeFromJsonElement）。
                val root = runCatching { KJson.parseToJsonElement(text).jsonObject }.getOrNull()
                    ?: return
                val type = root["type"]?.jsonPrimitive?.contentOrNull
                if (type != null && type.startsWith("game-")) {
                    val chess = decodeChessServerMsg(root)
                    if (chess != null) {
                        this@VoiceSignalingClient.listener?.onChessMessage(chess)
                    }
                    return
                }
                val inbound = runCatching {
                    KJson.decodeFromJsonElement(VoiceInbound.serializer(), root)
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

    /**
     * 进房。
     *
     * [muted] **要跟着 join 一起发**，不能只靠进来之后再补一条 `mute`：
     * 客户端在"正在连接语音服务"那几秒里就能点闭麦（那时 `signaling` 还没建好，
     * `setMuted` 发不出去），只发 join 的话服务端记的是"此人在麦" ——
     * 别人的麦位卡是绿点、说话灯还会为他点亮，而本地音轨其实已经关了。
     * 服务端的 join 分支本来就认 `msg.muted`（`messageHandlers` 里 `muted: !!msg.muted || listener`），
     * 带上它就一次到位。
     */
    fun join(roomId: Long, listener: Boolean = false, muted: Boolean = false) = send(
        VoiceOutbound(
            type = VoiceOutboundType.Join,
            roomId = roomId,
            listener = listener,
            muted = muted,
        )
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

    /**
     * 发一条**对局象棋**上行消息（`game-*`）。
     *
     * 走同一条 WebSocket、同一个 `send` 队列：服务端按 `game-` 前缀把它转给
     * chessGameManager，不需要任何额外建连或鉴权。
     */
    fun sendChess(message: ChessClientMsg): Boolean {
        val ws = socket ?: return false
        val body = runCatching { encodeChessClientMsg(message) }.getOrNull() ?: return false
        return ws.send(body)
    }

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
