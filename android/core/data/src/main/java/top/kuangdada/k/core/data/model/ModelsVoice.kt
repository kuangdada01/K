package top.kuangdada.k.core.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * ============================================================
 * 语音房信令（server/src/voice/ws.ts + messageHandlers.ts）
 * ============================================================
 * 端点是 `/api/voice/ws`（**WebSocket 协议**，不是 SSE）。
 *
 * 鉴权（三种形态，优先级：一次性票据 > token 查询参数 > 访客）：
 *  · `?ticket=` —— 登录用户首选：`POST /api/voice/ticket` 换一次性票据（30s 有效、读后即删），
 *    避免把 JWT 放进 URL（会进 nginx access log）；
 *  · `?token=` —— 兼容旧客户端，服务端会记一条"仍用已废弃的 ?token= 建连"；
 *  · 无凭证 —— 未登录访客：服务端按 IP 分配**负数 id** + "未登录-N" 显示名。
 *
 * 心跳：服务端每 30s ping 一次，客户端必须在 30s 内回 pong，否则被 terminate。
 * **OkHttp 的 WebSocket 会自动回 pong**，所以不需要手写。
 *
 * 关闭码（终态 vs 可重连）：
 *  · 4001 认证失败/账号封禁中 → **不要重连**
 *  · 4004 同一网络的语音连接过多 → **不要重连**（服务端明确说 4004 是终止类）
 *  · 其他 → 可退避重连
 */

// ---------------------------------------------------------------
// ICE 配置（GET /api/voice/ice）
// ---------------------------------------------------------------

@Serializable
data class IceServer(
    /**
     * **服务端两种形态混用**：STUN 那组给的是数组，TURN 那条给的是单个字符串
     * （符合 WebRTC 的 `RTCIceServer.urls: string | string[]` 规范）。
     * 所以必须用兼容序列化器 —— 只按 `List<String>` 解会在 TURN 那条上抛异常，
     * 真机表现是"房间提示：获取配置失败：服务端返回的数据格式异常"。
     */
    @Serializable(with = StringListOrSingleSerializer::class)
    val urls: List<String> = emptyList(),
    val username: String? = null,
    val credential: String? = null,
)

@Serializable
data class IceConfigResponse(
    @SerialName("iceServers") val iceServers: List<IceServer> = emptyList(),
)

// ---------------------------------------------------------------
// 参与者
// ---------------------------------------------------------------

@Serializable
data class VoiceParticipantDto(
    val userId: Long = 0,
    val username: String = "",
    val avatar: String? = null,
    /** 是否关闭麦克风（听者模式同样为 true） */
    val muted: Boolean = false,
    /** 无麦克风权限、仅收听的成员 */
    val listener: Boolean = false,
    /** 正在共享屏幕（全房间最多一人，服务端互斥保证） */
    val sharing: Boolean = false,
    /**
     * 共享方**声明的采集像素尺寸**（服务端放进 `share-changed` 与房间成员信息里的 width/height）。
     *
     * **唯一事实来源是 `shared/src/types.ts` 的 `VoiceParticipant.width`**（那里写着完整约定：
     * 采集分辨率而非编码后的发送分辨率；可选字段，老客户端不发/老服务端不转；
     * 数值非法等价于未声明）。安卓侧只消费它：进房那一刻就能定下共享画面比例，
     * 不必等接收探针量到首帧 —— 否则画面框会先按 16:9 撑开、首帧再收边（"跳一下"）。
     * null / 非正数 = 未声明，回落到接收探针。
     */
    val width: Int? = null,
    val height: Int? = null,
)

// ---------------------------------------------------------------
// 下行（S→C）
// ---------------------------------------------------------------

/**
 * 服务端下行消息。
 *
 * ⚠️ 服务端**不是**把 `type` 与 payload 平铺成固定形状的 —— 不同 type 带的字段不同
 * （`joined` 带 participants+self、`signal` 带 from+data、`error` 只带 message…）。
 * 所以这里用「宽松信封」：先解出 `type` 与已知的可选字段，未知字段忽略。
 * 这与 Web 端 `wsSignaling.ts` 的处理方式一致。
 */
@Serializable
data class VoiceInbound(
    val type: String = "",
    val roomId: Long? = null,
    val participants: List<VoiceParticipantDto> = emptyList(),
    val self: VoiceParticipantDto? = null,
    val participant: VoiceParticipantDto? = null,
    val userId: Long? = null,
    val from: Long? = null,
    /** 信令负载（SDP offer/answer 或 ICE 候选），原样透传给 WebRTC */
    val data: JsonElement? = null,
    val muted: Boolean? = null,
    val level: String? = null,
    val active: Boolean? = null,
    val audio: Boolean? = null,
    /**
     * 共享方声明的采集像素尺寸（只有 `share-changed` 且 `active=true` 时才带）。
     * 语义与缺省行为见 [VoiceParticipantDto.width] —— 那份注释指向 shared/src/types.ts 的唯一事实来源。
     */
    val width: Int? = null,
    val height: Int? = null,
    val message: VoiceChatMessage? = null,
    val reason: String? = null,
    /** `error` 消息的文案（同时也可能带 type=error） */
    val errorText: String? = null,
)

/** 下行消息的 type 常量（避免各处写字符串字面量写错） */
object VoiceInboundType {
    const val Joined = "joined"
    const val PeerJoined = "peer-joined"
    const val PeerLeft = "peer-left"
    const val Signal = "signal"
    const val MuteChanged = "mute-changed"
    const val PeerQuality = "peer-quality"
    const val ShareChanged = "share-changed"
    const val ShareForceStop = "share-force-stop"
    const val Chat = "chat"
    const val ChatCleared = "chat-cleared"
    const val RoomClosed = "room-closed"
    const val Error = "error"
}

// ---------------------------------------------------------------
// 上行（C→S）
// ---------------------------------------------------------------

/**
 * 客户端上行消息。
 *
 * 用一个 data class 而不是每类一个类型：字段都可空，按 `type` 填对应的那几个 ——
 * 与 Web 端一致，也让"发错字段"这种错误在序列化时自然暴露（多余的 null 不会发出，
 * 因为 explicitNulls = false）。
 */
@Serializable
data class VoiceOutbound(
    val type: String,
    val roomId: Long? = null,
    val listener: Boolean? = null,
    val muted: Boolean? = null,
    val level: String? = null,
    val audio: Boolean? = null,
    /** 共享方声明的采集像素尺寸（只随 `share-start` 上行；语义见 [VoiceParticipantDto.width]） */
    val width: Int? = null,
    val height: Int? = null,
    val to: Long? = null,
    val data: JsonElement? = null,
    val content: String? = null,
)

object VoiceOutboundType {
    const val Join = "join"
    const val Leave = "leave"
    const val Mute = "mute"
    const val Quality = "quality"
    const val ShareStart = "share-start"
    const val ShareStop = "share-stop"
    const val Chat = "chat"
    const val Signal = "signal"
}

/**
 * 房间参与上限 —— **镜像 `shared/src/constants/voice.ts` 的 `VOICE_MAX_ROOM_SIZE`**（事实来源，当前 10）。
 *
 * 为什么不能直接引：`@k/shared` 是 TypeScript 包（npm workspace），安卓侧是 Gradle/Kotlin 模块，
 * 工程里**没有** TS→Kotlin 的代码生成步骤；跨端常量一直是手工镜像的（同样的先例：
 * `VoiceRoomController.CHAT_MAX_CHARS` 对应 `VOICE_CHAT_MAX_LEN`）。
 * 所以规则是"改 shared 必须同步改这里、数值逐字相同"，而不是各写各的。
 *
 * 这里原来是 **12**（比服务端大 2）：服务端 join 时按 10 拒绝，客户端却按 12 放行，
 * 于是超员房间会在"看起来还能进"的时候被服务端回一句「房间已满」。
 */
const val VOICE_MAX_ROOM_SIZE = 10

/**
 * `GET /api/voice/rooms/:id/messages` 的响应。
 *
 * `has_more` 表示"还有更早的历史"（首屏/向更早翻页时才为 true）。
 */
@Serializable
data class VoiceRoomMessagesResponse(
    val messages: List<VoiceChatMessage> = emptyList(),
    @SerialName("has_more") val hasMore: Boolean = false,
)
