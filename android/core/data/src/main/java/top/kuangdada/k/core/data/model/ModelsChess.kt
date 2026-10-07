package top.kuangdada.k.core.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import top.kuangdada.k.core.data.KJson
import top.kuangdada.k.core.data.chess.ChessMove
import top.kuangdada.k.core.data.chess.ChessSide
import top.kuangdada.k.core.data.chess.ChessSquare
import top.kuangdada.k.core.data.chess.isChessPiece

/**
 * ============================================================
 * 房间对战象棋：WS 协议消息（**手工镜像** `shared/src/chess/protocol.ts`）
 * ============================================================
 * 复用语音信令通道 `/api/voice/ws`（**不是**新开一条 WebSocket），
 * 消息名统一 `game-` 前缀，C→S 由服务端逐字段窄化校验，
 * 权威状态机在 `server/src/voice/game/chessGameManager.ts`。
 *
 * ## 为什么单独一套 DTO，而不是往 [VoiceInbound] 上继续加可空字段
 * `game-*` 的载荷形状与信令消息毫无交集（席位/棋钟/被吃子/记谱都是嵌套结构），
 * 往那个"宽松信封"上加十几个字段会把信令层的可读性拖垮；而**多态 sealed 层次
 * 恰好能表达"每个 type 带哪些字段"**（`type` 就是 kotlinx 的类判别字段），
 * 所以分流点放在 [top.kuangdada.k.core.data.VoiceSignalingClient]：按前缀拆出来，
 * 用 [ChessServerMsg.serializer] 解，交给独立的 `onChessMessage` 回调。
 *
 * ## 字段类型为什么是 String 而不是 enum
 * 服务端只增不改，且 `status`/`result`/`reason` 后续还会加值（二期就加过
 * `timeout`/`perpetual`）。用 enum 时**一个新值会让整条消息解码失败**、
 * 静默丢掉（`coerceInputValues` 只救"有默认值的字段"），而丢一条 `game-moved`
 * 的表现是"棋盘不动了"——很难查。所以标量一律收 String，由上层
 * [toChessSide]/[ChessGameEndReasonWire] 之类做有默认值的映射。
 *
 * ## ★ 上行（C→S）一律走 [ChessClientJson]（`encodeDefaults = true`）
 * kotlinx 默认**省略等于默认值的字段**，而"坐标 0"是合法值（红方底线 r=0、
 * 最左一路 f=0）。用默认配置编码的走子报文会把 0 吃掉，服务端报
 * 「着法坐标无效」—— 见 [ChessSquareDto] 与 [encodeChessClientMsg] 的注释。
 * 契约测试：`ChessContractsTest`（`android:test`）。
 */

// ---------------------------------------------------------------
// 公共结构
// ---------------------------------------------------------------

/** 对局参与者身份（服务端以 hub 在线成员信息填充；含访客负数 id） */
@Serializable
data class ChessPlayerInfo(
    val userId: Long = 0,
    val username: String = "",
    val avatar: String? = null,
)

/**
 * 双方剩余总时长（毫秒）。
 *
 * [turnStartedAt]/[deadline] 为**轮到方**的计时锚点：
 * `deadline = turnStartedAt + min(每步限时, 轮到方剩余总时长)`；
 * 轮到方的真实剩余 = `min(clocks[turn], deadline - now)`，客户端据此本地走秒 ——
 * now 用"本机时钟 + [serverNow] 算出的钟差"校准，设备时钟不准也显示得对。
 * 终局后 `deadline = 0`（不再计时）。
 *
 * [paused]（三期）：对局被暂停时为 true（服务端已把已耗时间扣进 red/black、
 * deadline 同步归 0），客户端据此冻结走秒、禁走子；快照携带它，重进房恢复暂停态。
 * [serverNow]：服务端封包那一刻的 epoch 毫秒，客户端在消息到达时记
 * `offset = serverNow - 本机 System.currentTimeMillis()`，走秒用校准后的 now ——
 * 不然两台设备时钟有偏差时，同一局面在双方屏幕上显示的剩余对不上。
 */
@Serializable
data class ChessClocks(
    val red: Long = 0,
    val black: Long = 0,
    val turnStartedAt: Long = 0,
    val deadline: Long = 0,
    val paused: Boolean = false,
    val serverNow: Long = 0,
)

/** 被吃子陈列：red = 红方吃获的黑子，black = 黑方吃获的红子 */
@Serializable
data class ChessCaptured(
    val red: List<String> = emptyList(),
    val black: List<String> = emptyList(),
)

/**
 * 棋盘交点。
 *
 * ⚠️ 这两个字段**有默认值**（0），而 [KJson] 没开 `encodeDefaults` —— 所以上行编码
 * 必须走 [ChessClientJson]（那边显式开了），否则 f/r 等于 0 时字段会被整个丢掉：
 * 从底线（r=0）或最左一路（f=0）出子的报文会变成 `{"from":{}}`，服务端
 * `parseSquare` 取不到数字 → 回 `bad-message`「着法坐标无效」，
 * 用户看到的就是"底线上的车马相仕帅一步都走不动"（09-29 真机实测）。
 * 默认值保留是为了下行（快照/广播）解码容错，别删。
 */
@Serializable
data class ChessSquareDto(val f: Int = 0, val r: Int = 0)

/** 一着棋（[captured] = null 表示吃空） */
@Serializable
data class ChessMoveDto(
    val from: ChessSquareDto = ChessSquareDto(),
    val to: ChessSquareDto = ChessSquareDto(),
    val piece: String = "",
    val captured: String? = null,
)

/** 棋盘交点 → 引擎坐标 */
fun ChessSquareDto.toSquare(): ChessSquare = ChessSquare(f, r)

/** 引擎坐标 → 棋盘交点（上行 `game-move` 用） */
fun ChessSquare.toDto(): ChessSquareDto = ChessSquareDto(f, r)

/**
 * 协议着法 → 引擎着法。
 *
 * 脏数据（棋子字符不是合法棋子）返回 null —— 快照/广播里的着法要用于渲染
 * "上一步标记"，解析不了就宁可不画标记，也不能让整块棋盘崩掉。
 */
fun ChessMoveDto.toEngineMove(): ChessMove? {
    val p = piece.singleOrNull()?.takeIf { isChessPiece(it) } ?: return null
    val cap = captured?.singleOrNull()?.takeIf { isChessPiece(it) }
    return ChessMove(from = from.toSquare(), to = to.toSquare(), piece = p, captured = cap)
}

// ---------------------------------------------------------------
// 阵营的线格式（引擎用 enum，协议用 'red'/'black'）
// ---------------------------------------------------------------

fun ChessSide.toWireSide(): String = if (this == ChessSide.Red) "red" else "black"

/** 解析协议里的阵营；未知值按红方处理（服务端只会有 red/black） */
fun String.toChessSide(): ChessSide = if (this == "black") ChessSide.Black else ChessSide.Red

// ---------------------------------------------------------------
// 下行（S→C）
// ---------------------------------------------------------------

/** 对局结束原因（引擎级 + 对局层）。终局横幅文案见 `ChessGamePanel` */
object ChessEndReasonWire {
    const val Checkmate = "checkmate"
    const val Stalemate = "stalemate"
    const val Insufficient = "insufficient"
    const val Repetition = "repetition"
    const val Perpetual = "perpetual"
    const val Resign = "resign"
    const val Disconnect = "disconnect"
    const val Timeout = "timeout"
    const val Agreement = "agreement"
}

/** S→C 对局消息联合（`type` 即 kotlinx 的类判别字段，值与服务端逐字相同） */
@Serializable
sealed interface ChessServerMsg

@Serializable
@SerialName("game-invite-received")
data class ChessInviteReceivedMsg(
    val inviteId: String = "",
    val from: ChessPlayerInfo = ChessPlayerInfo(),
    /** 发起方选边：'red' | 'black' | 'random' */
    val side: String = "random",
    /** 绝对过期时间（`Date.now()` 口径），客户端倒计时用 */
    val expiresAt: Long = 0,
) : ChessServerMsg

@Serializable
@SerialName("game-invite-result")
data class ChessInviteResultMsg(
    val inviteId: String = "",
    /** 'accepted' | 'declined' | 'expired' | 'cancelled' */
    val outcome: String = "",
) : ChessServerMsg

@Serializable
@SerialName("game-started")
data class ChessStartedMsg(
    val gameId: String = "",
    val red: ChessPlayerInfo = ChessPlayerInfo(),
    val black: ChessPlayerInfo = ChessPlayerInfo(),
    val fen: String = "",
    val turn: String = "red",
    val clocks: ChessClocks = ChessClocks(),
) : ChessServerMsg

@Serializable
@SerialName("game-moved")
data class ChessMovedMsg(
    val gameId: String = "",
    /** 该步在着法序列中的序号（0 起，等于服务端 `moves.length`） */
    val seq: Int = 0,
    val move: ChessMoveDto = ChessMoveDto(),
    val fen: String = "",
    val turn: String = "red",
    /** 该步后轮到方是否被将军（客户端据此提示"将军"） */
    val check: Boolean = false,
    /** 'playing' | 'red-win' | 'black-win' | 'draw' */
    val status: String = "playing",
    /** 该步的中文记谱（"炮二平五"） */
    val notation: String = "",
    val clocks: ChessClocks = ChessClocks(),
) : ChessServerMsg

@Serializable
@SerialName("game-ended")
data class ChessEndedMsg(
    val gameId: String = "",
    /** 'red-win' | 'black-win' | 'draw' */
    val result: String = "draw",
    val reason: String = ChessEndReasonWire.Agreement,
) : ChessServerMsg

/** 全量快照：新加入者/重连者/观战者恢复局面（终局后也会发，可看最终盘面） */
@Serializable
@SerialName("game-snapshot")
data class ChessSnapshotMsg(
    val gameId: String = "",
    val red: ChessPlayerInfo = ChessPlayerInfo(),
    val black: ChessPlayerInfo = ChessPlayerInfo(),
    val fen: String = "",
    val turn: String = "red",
    val status: String = "playing",
    /** status 非 playing 时的终局原因（刷新后恢复终局横幅用）；playing 时为 null */
    val endReason: String? = null,
    val lastMove: ChessMoveDto? = null,
    val moveCount: Int = 0,
    val clocks: ChessClocks = ChessClocks(),
    val captured: ChessCaptured = ChessCaptured(),
    /** 全部着法的中文记谱（棋谱条用；终局快照也带） */
    val notations: List<String> = emptyList(),
) : ChessServerMsg

@Serializable
@SerialName("game-draw-offered")
data class ChessDrawOfferedMsg(
    val gameId: String = "",
    val from: Long = 0,
) : ChessServerMsg

/** 求和被拒（接受时直接广播 game-ended，不发本消息） */
@Serializable
@SerialName("game-draw-declined")
data class ChessDrawDeclinedMsg(
    val gameId: String = "",
    @SerialName("by") val byUserId: Long = 0,
) : ChessServerMsg

@Serializable
@SerialName("game-undo-offered")
data class ChessUndoOfferedMsg(
    val gameId: String = "",
    val from: Long = 0,
) : ChessServerMsg

@Serializable
@SerialName("game-undo-declined")
data class ChessUndoDeclinedMsg(
    val gameId: String = "",
    @SerialName("by") val byUserId: Long = 0,
) : ChessServerMsg

/** 悔棋生效广播：全房按此恢复盘面/棋钟/棋谱/被吃子 */
@Serializable
@SerialName("game-undone")
data class ChessUndoneMsg(
    val gameId: String = "",
    val fen: String = "",
    val turn: String = "red",
    val status: String = "playing",
    val lastMove: ChessMoveDto? = null,
    val moveCount: Int = 0,
    val clocks: ChessClocks = ChessClocks(),
    val captured: ChessCaptured = ChessCaptured(),
    val notations: List<String> = emptyList(),
) : ChessServerMsg

/** 对局已暂停（任一棋手触发）：clocks.paused=true、deadline=0，客户端冻结走秒并禁走 */
@Serializable
@SerialName("game-paused")
data class ChessPausedMsg(
    val gameId: String = "",
    /** 触发暂停的棋手 userId（客户端据此区分自己/对方的操作做提示） */
    @SerialName("by") val byUserId: Long = 0,
    val clocks: ChessClocks = ChessClocks(),
) : ChessServerMsg

/** 对局继续：clocks.paused=false，deadline 已为轮到方重新起表 */
@Serializable
@SerialName("game-resumed")
data class ChessResumedMsg(
    val gameId: String = "",
    @SerialName("by") val byUserId: Long = 0,
    val clocks: ChessClocks = ChessClocks(),
) : ChessServerMsg

/** 对方已点"再来一局"（本方按钮转为"点击开始"，点击即开局） */
@Serializable
@SerialName("game-rematch-offered")
data class ChessRematchOfferedMsg(
    val gameId: String = "",
    val from: Long = 0,
) : ChessServerMsg

/** 未决的再来一局被清除（发起方离房）；客户端复位按钮态 */
@Serializable
@SerialName("game-rematch-reset")
data class ChessRematchResetMsg(
    val gameId: String = "",
) : ChessServerMsg

@Serializable
@SerialName("game-error")
data class ChessErrorMsg(
    val code: String = "",
    val message: String = "",
) : ChessServerMsg

// ---------------------------------------------------------------
// 上行（C→S）
// ---------------------------------------------------------------

/** C→S 对局消息联合（服务端 `startsWith('game-')` 前缀分发到对局管理器） */
@Serializable
sealed interface ChessClientMsg

@Serializable
@SerialName("game-invite")
data class ChessInviteMsg(
    val toUserId: Long,
    /** 'red' | 'black' | 'random' */
    val side: String,
) : ChessClientMsg

@Serializable
@SerialName("game-invite-respond")
data class ChessInviteRespondMsg(val inviteId: String, val accept: Boolean) : ChessClientMsg

@Serializable
@SerialName("game-invite-cancel")
data class ChessInviteCancelMsg(val inviteId: String) : ChessClientMsg

/** `seq` = 该步在着法序列中的序号（0 起），单调防重放 */
@Serializable
@SerialName("game-move")
data class ChessMoveMsg(
    val gameId: String,
    val seq: Int,
    val from: ChessSquareDto,
    val to: ChessSquareDto,
) : ChessClientMsg

@Serializable
@SerialName("game-resign")
data class ChessResignMsg(val gameId: String) : ChessClientMsg

@Serializable
@SerialName("game-draw-offer")
data class ChessDrawOfferMsg(val gameId: String) : ChessClientMsg

@Serializable
@SerialName("game-draw-respond")
data class ChessDrawRespondMsg(val gameId: String, val accept: Boolean) : ChessClientMsg

@Serializable
@SerialName("game-undo-offer")
data class ChessUndoOfferMsg(val gameId: String) : ChessClientMsg

@Serializable
@SerialName("game-undo-respond")
data class ChessUndoRespondMsg(val gameId: String, val accept: Boolean) : ChessClientMsg

/** 再来一局：双方都点击时立即开新局（随机换边），无需接受/拒绝步骤 */
@Serializable
@SerialName("game-rematch")
data class ChessRematchMsg(val gameId: String) : ChessClientMsg

/** 暂停对局（任一棋手可触发；服务端把已耗时间扣进剩余并冻结棋钟） */
@Serializable
@SerialName("game-pause")
data class ChessPauseMsg(val gameId: String) : ChessClientMsg

/** 继续对局（暂停期间任一棋手可触发；服务端为轮到方重新起表） */
@Serializable
@SerialName("game-resume")
data class ChessResumeMsg(val gameId: String) : ChessClientMsg

// ---------------------------------------------------------------
// 编解码
// ---------------------------------------------------------------

/**
 * 解一条 S→C 对局消息；不是对局消息/形状不认识返回 null。
 *
 * 调用方（[top.kuangdada.k.core.data.VoiceSignalingClient]）已经按 `game-` 前缀筛过，
 * 这里仍要 runCatching：服务端加了新 `game-xxx` 而客户端还没升级时，
 * 会抛 "Serializer for subclass ... is not found" —— 旧客户端必须**安静忽略**它，
 * 而不是把整条连接搞崩（这正是当初把类型收窄成密封层次的代价，必须在这里兜住）。
 */
fun decodeChessServerMsg(text: String): ChessServerMsg? =
    runCatching { KJson.decodeFromString(ChessServerMsg.serializer(), text) }.getOrNull()

/**
 * 同上的 **JsonElement 版**：调用方已经把整条消息 parse 成 [JsonElement] 用来分流
 * `type`（见 VoiceSignalingClient.onMessage 的单次解析说明），这里直接从元素解码，
 * 不再把字符串 parse 第二遍 —— 棋类消息高频（走子/棋钟），省的是真开销。
 */
fun decodeChessServerMsg(element: JsonElement): ChessServerMsg? =
    runCatching { KJson.decodeFromJsonElement(ChessServerMsg.serializer(), element) }.getOrNull()

/**
 * 上行（C→S）对局消息**专用**的 Json。
 *
 * ★ `encodeDefaults = true` 是这里唯一的存在理由，**别删**：
 * kotlinx 的默认是 `encodeDefaults = false`，即"值等于默认值就省略该字段"。
 * 而 [ChessSquareDto] 的两个分量默认都是 0 → 走子报文里 f 或 r 为 0 时会被
 * 静默省略（`{"from":{"r":2}}`），服务端 `chessGameManager.parseSquare`
 * 要求 f、r 都是整数 → 回 `bad-message`「着法坐标无效」。
 * 表现是"红方底线那一排（r=0）与最左一路（f=0）的子永远走不动"，
 * 其余子照常 —— 09-29 用户在真机上撞到（截图里的「着法坐标无效」）。
 *
 * 上行宁可多送字段（服务端逐字段窄化、未知字段一律忽略），
 * 也绝不能让一个"值为 0 的合法坐标"被编码器吃掉。
 * 解码侧不受影响，继续用 [KJson]。
 */
private val ChessClientJson: Json = Json {
    ignoreUnknownKeys = true
    isLenient = true
    explicitNulls = false
    encodeDefaults = true
}

/** 编一条 C→S 对局消息（`type` 由 sealed 的类判别字段自动带上） */
fun encodeChessClientMsg(msg: ChessClientMsg): String =
    ChessClientJson.encodeToString(ChessClientMsg.serializer(), msg)
