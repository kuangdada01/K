package top.kuangdada.k.nativeapp.voice

import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import top.kuangdada.k.core.data.chess.ChessMove
import top.kuangdada.k.core.data.chess.ChessSide
import top.kuangdada.k.core.data.chess.ChessSquare
import top.kuangdada.k.core.data.chess.isInCheck
import top.kuangdada.k.core.data.chess.parseFen
import top.kuangdada.k.core.data.chess.pieceSide
import top.kuangdada.k.core.data.model.ChessCaptured
import top.kuangdada.k.core.data.model.ChessClientMsg
import top.kuangdada.k.core.data.model.ChessClocks
import top.kuangdada.k.core.data.model.ChessDrawDeclinedMsg
import top.kuangdada.k.core.data.model.ChessDrawOfferMsg
import top.kuangdada.k.core.data.model.ChessDrawOfferedMsg
import top.kuangdada.k.core.data.model.ChessDrawRespondMsg
import top.kuangdada.k.core.data.model.ChessEndReasonWire
import top.kuangdada.k.core.data.model.ChessEndedMsg
import top.kuangdada.k.core.data.model.ChessErrorMsg
import top.kuangdada.k.core.data.model.ChessInviteCancelMsg
import top.kuangdada.k.core.data.model.ChessInviteMsg
import top.kuangdada.k.core.data.model.ChessInviteReceivedMsg
import top.kuangdada.k.core.data.model.ChessInviteRespondMsg
import top.kuangdada.k.core.data.model.ChessInviteResultMsg
import top.kuangdada.k.core.data.model.ChessMoveMsg
import top.kuangdada.k.core.data.model.ChessMovedMsg
import top.kuangdada.k.core.data.model.ChessPlayerInfo
import top.kuangdada.k.core.data.model.ChessRematchMsg
import top.kuangdada.k.core.data.model.ChessRematchOfferedMsg
import top.kuangdada.k.core.data.model.ChessRematchResetMsg
import top.kuangdada.k.core.data.model.ChessResignMsg
import top.kuangdada.k.core.data.model.ChessServerMsg
import top.kuangdada.k.core.data.model.ChessSnapshotMsg
import top.kuangdada.k.core.data.model.ChessStartedMsg
import top.kuangdada.k.core.data.model.ChessUndoDeclinedMsg
import top.kuangdada.k.core.data.model.ChessUndoOfferMsg
import top.kuangdada.k.core.data.model.ChessUndoOfferedMsg
import top.kuangdada.k.core.data.model.ChessUndoRespondMsg
import top.kuangdada.k.core.data.model.ChessUndoneMsg
import top.kuangdada.k.core.data.model.toChessSide
import top.kuangdada.k.core.data.model.toDto
import top.kuangdada.k.core.data.model.toEngineMove

/**
 * ============================================================
 * 房间对战象棋：客户端状态机（**镜像** `client/src/voice/chess/useChessGame.ts`）
 * ============================================================
 * 服务端权威：本类只维护"视图状态"（当前盘面 / 邀请 / 求和 / 终局横幅），
 * 所有走子合法性、回合归属、胜负判定都在服务端（`chessGameManager.ts` +
 * 同源引擎）。收到 `game-error` 时以一句提示告知语义化原因。
 *
 * 与 Web 端的两处结构差异（都是平台性的，不是口径差异）：
 *  1. Web 是 React hook（`useState` + `useMemo`）；原生没有"重组即重算"的模型，
 *     所以这里是普通类 + [MutableStateFlow]，**状态写入走 [MutableStateFlow.update]**
 *     （CAS 循环）—— 因为 [onMessage] 跑在 OkHttp 的 WebSocket 读线程上，不是主线程；
 *  2. Web 的 `showToast` 是模块级单例；这里用 [messages] 这个 SharedFlow 把它
 *     送进 Compose（房间页用一个常驻的提示条消费）。
 *
 * ⚠️ **状态更新 lambda 里不要放副作用**（`_messages.tryEmit` 这类）：
 * `update` 在并发下有可能会重跑 lambda（CAS 失败重试），提示就会重复弹。
 * 所以凡是"改状态 + 提示"的分支，都先取快照、`update` 完再发提示。
 *
 * 两个运行期依赖都用 **函数** 注入而不是持有 `VoiceSignalingClient`：
 *  · [selfUserId]：服务端会**校正**访客的占位负数 id，必须实时读，
 *    不能在构造时快照（否则"再来一局"的 rematchBy 判据永远不成立）；
 *  · [send]：由 [VoiceRoomController] 转发到当前的信令连接
 *    （连接在进房时才建、退房时销毁）。
 */
class ChessGameController(
    private val selfUserId: () -> Long,
    private val send: (ChessClientMsg) -> Unit,
) {

    /** 盘面视图状态（棋盘渲染 + 席位判定所需的最小集合） */
    data class GameView(
        val gameId: String,
        val red: ChessPlayerInfo,
        val black: ChessPlayerInfo,
        val fen: String,
        val turn: ChessSide,
        /** 'playing' | 'red-win' | 'black-win' | 'draw'（原样透传，只做展示判定） */
        val status: String,
        val lastMove: ChessMove?,
        val moveCount: Int,
        /** 已点"再来一局"的玩家（终局后；null = 无人点过，= 自己则等待对方） */
        val rematchBy: Long?,
        val clocks: ChessClocks,
        /** 全部着法的中文记谱（棋谱条） */
        val notations: List<String>,
        /** 被吃子陈列：red = 红方吃获的黑子 */
        val captured: ChessCaptured,
    ) {
        val playing: Boolean get() = status == "playing"
    }

    /** 收到的对局邀请 */
    data class InviteView(
        val inviteId: String,
        val from: ChessPlayerInfo,
        val side: String,
        val expiresAt: Long,
    )

    /**
     * 我发出的待应答邀请（"等待对方应答"横幅）。
     *
     * [inviteId] 是**本地占位**（`pending-<toUserId>`）：服务端创建邀请时只把
     * 真实 inviteId 发给被邀方，发起方拿不到。撤销时把这个占位回传 ——
     * 服务端按"发起方本人 + 房间里那唯一一条待处理邀请"识别（见
     * `chessGameManager.handleInviteCancel`）。
     */
    data class OutgoingView(val inviteId: String, val toUserId: Long, val toName: String)

    /** 终局横幅（对局结束后保留，直到用户关闭或新对局开始） */
    data class EndedView(val result: String, val reason: String)

    data class UiState(
        val game: GameView? = null,
        val invite: InviteView? = null,
        val outgoing: OutgoingView? = null,
        /** 对方发来的未决求和（发起方 userId） */
        val drawOfferFrom: Long? = null,
        /** 对方发来的未决悔棋请求（发起方 userId） */
        val undoOfferFrom: Long? = null,
        val ended: EndedView? = null,
    ) {
        /** 面板是否可见（对局/邀请/待应答横幅任一存在即显示） */
        val showPanel: Boolean get() = game != null || invite != null || outgoing != null
    }

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    /**
     * 需要给用户看一眼的一句话（对齐 Web 端 `showToast` 语义）。
     *
     * `extraBufferCapacity` + `tryEmit`：发的人可能就是 WebSocket 读线程，
     * 不能挂起等消费者；丢一条提示的代价远小于阻塞读线程。
     */
    private val _messages = MutableSharedFlow<String>(
        replay = 0,
        extraBufferCapacity = 8,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    val messages: SharedFlow<String> = _messages.asSharedFlow()

    // ---------------------------------------------------------------
    // 下行：服务端 game-* 消息
    // ---------------------------------------------------------------

    fun onMessage(msg: ChessServerMsg) {
        when (msg) {
            is ChessInviteReceivedMsg -> _state.update {
                it.copy(
                    invite = InviteView(
                        inviteId = msg.inviteId,
                        from = msg.from,
                        side = msg.side,
                        expiresAt = msg.expiresAt,
                    )
                )
            }

            is ChessInviteResultMsg -> {
                // 发出的邀请：收到任一回执即清"等待应答"横幅（每客户端同时最多一个）；
                // 收到的邀请：服务端作废（发起方撤销 / 离房）时按 inviteId 清横幅
                _state.update { st ->
                    st.copy(
                        outgoing = null,
                        invite = if (st.invite != null && st.invite.inviteId == msg.inviteId) null else st.invite,
                    )
                }
                val toast = when (msg.outcome) {
                    "declined" -> "对方拒绝了你的对局邀请"
                    "expired" -> "对局邀请已过期"
                    "cancelled" -> "对局邀请已取消"
                    else -> null
                }
                if (toast != null) _messages.tryEmit(toast)
            }

            is ChessStartedMsg -> _state.value = UiState(
                game = GameView(
                    gameId = msg.gameId,
                    red = msg.red,
                    black = msg.black,
                    fen = msg.fen,
                    turn = msg.turn.toChessSide(),
                    status = "playing",
                    lastMove = null,
                    moveCount = 0,
                    rematchBy = null,
                    clocks = msg.clocks,
                    notations = emptyList(),
                    captured = ChessCaptured(),
                )
            )

            is ChessMovedMsg -> {
                val move = msg.move.toEngineMove()
                // 走子音：广播到达即响（己方/对方/观战统一；快照恢复不进此分支）。
                // 吃子走"吃"音；将军时 200ms 后补一声"将军"（与 Web 端节奏一致）。
                if (_state.value.game?.gameId == msg.gameId) {
                    if (move?.captured != null) ChessSounds.capture() else ChessSounds.move()
                    val inCheck = runCatching {
                        val parsed = parseFen(msg.fen)
                        isInCheck(parsed.board, parsed.turn)
                    }.getOrDefault(false)
                    if (inCheck) ChessSounds.check()
                }
                _state.update { st ->
                    val g = st.game
                    if (g == null || g.gameId != msg.gameId) {
                        st
                    } else {
                        st.copy(
                            game = g.copy(
                                fen = msg.fen,
                                turn = msg.turn.toChessSide(),
                                status = msg.status,
                                lastMove = move,
                                moveCount = msg.seq + 1,
                                clocks = msg.clocks,
                                notations = g.notations + msg.notation,
                                captured = appendCaptured(g.captured, move),
                            ),
                            // 盘面一动，未决的求和/悔棋请求就作废（与 Web 端一致）
                            drawOfferFrom = null,
                            undoOfferFrom = null,
                        )
                    }
                }
            }

            is ChessEndedMsg -> {
                // 绝杀专属音（whatcan）：对局以 checkmate 结束时顶掉一切只响这一声。
                // 副作用放在 update 外 —— MutableStateFlow.update 的 lambda 在竞争下会重试，
                // 放里面可能双响。
                if (_state.value.game?.gameId == msg.gameId && msg.reason == ChessEndReasonWire.Checkmate) {
                    ChessSounds.checkmate()
                }
                _state.update { st ->
                    val g = st.game
                    st.copy(
                        game = if (g != null && g.gameId == msg.gameId) g.copy(status = msg.result) else g,
                        drawOfferFrom = null,
                        undoOfferFrom = null,
                        ended = EndedView(msg.result, msg.reason),
                    )
                }
            }

            is ChessSnapshotMsg -> {
                /*
                 * ⚠️ **已经结束、且不是本端亲历的对局，一律不摆出来。**
                 *
                 * 服务端在"房间空掉或开下一局"之前会**一直保留那一局的终局态**，而快照是
                 * `join` 时补发的 —— 于是冷启动/重进房时会把一局早已结束的棋又摆到眼前
                 * （用户实测："冷启动进入第一次还是显示棋盘，明明早就结束了，不应该还留着啊"）。
                 * 这种残局的归属是**对局记录**，不是房间面板。
                 *
                 * 判据用"本端有没有这一局"（[UiState.game] 同 id）而不是时间戳：
                 *  · 正在房里看着它结束 → 我们手上一直有这一局 → 照常恢复终局横幅
                 *    （不然"对局结束了但既没有再来一局、也没有收起棋盘"就变成死局）；
                 *  · 冷启动 / 离房再进房 → 手上什么都没有 → 直接忽略这条快照。
                 *
                 * 进行中的对局**永远显示**（重进房要能接着观战/接着下）。
                 */
                val known = _state.value.game
                if (msg.status != "playing" && (known == null || known.gameId != msg.gameId)) return

                _state.update { st ->
                    st.copy(
                        game = GameView(
                            gameId = msg.gameId,
                            red = msg.red,
                            black = msg.black,
                            fen = msg.fen,
                            turn = msg.turn.toChessSide(),
                            status = msg.status,
                            lastMove = msg.lastMove?.toEngineMove(),
                            moveCount = msg.moveCount,
                            rematchBy = null,
                            clocks = msg.clocks,
                            notations = msg.notations,
                            captured = msg.captured,
                        ),
                        // 终局横幅必须恢复：否则重连之后"对局结束但没有终局条、
                        // 也没有再来一局"，面板变成一块死棋盘 —— Web 端线上实测卡死过。
                        ended = if (msg.status != "playing") {
                            EndedView(msg.status, msg.endReason ?: ChessEndReasonWire.Agreement)
                        } else {
                            null
                        },
                    )
                }
            }

            is ChessDrawOfferedMsg -> _state.update { it.copy(drawOfferFrom = msg.from) }

            is ChessDrawDeclinedMsg -> _messages.tryEmit("对方拒绝了求和")

            is ChessUndoOfferedMsg -> _state.update { it.copy(undoOfferFrom = msg.from) }

            is ChessUndoDeclinedMsg -> _messages.tryEmit("对方拒绝了你的悔棋请求")

            is ChessRematchOfferedMsg -> _state.update { st ->
                val g = st.game
                if (g == null || g.gameId != msg.gameId) st else st.copy(game = g.copy(rematchBy = msg.from))
            }

            is ChessRematchResetMsg -> _state.update { st ->
                val g = st.game
                if (g == null || g.gameId != msg.gameId) st else st.copy(game = g.copy(rematchBy = null))
            }

            is ChessUndoneMsg -> _state.update { st ->
                val g = st.game
                // 悔棋盘面回退也响一声落子（与 Web 端 moveCount 变化触发音效的行为一致）
                if (g != null && g.gameId == msg.gameId) ChessSounds.move()
                if (g == null || g.gameId != msg.gameId) {
                    st
                } else {
                    st.copy(
                        game = g.copy(
                            fen = msg.fen,
                            turn = msg.turn.toChessSide(),
                            status = msg.status,
                            lastMove = msg.lastMove?.toEngineMove(),
                            moveCount = msg.moveCount,
                            clocks = msg.clocks,
                            notations = msg.notations,
                            captured = msg.captured,
                        ),
                        drawOfferFrom = null,
                        undoOfferFrom = null,
                    )
                }
            }

            is ChessErrorMsg -> _messages.tryEmit(msg.message)
        }
    }

    /** 走子后追加被吃子（red = 红方吃获的黑子） */
    private fun appendCaptured(captured: ChessCaptured, move: ChessMove?): ChessCaptured {
        val eaten = move?.captured ?: return captured
        val ch = eaten.toString()
        return if (pieceSide(move.piece) == ChessSide.Red) {
            captured.copy(red = captured.red + ch)
        } else {
            captured.copy(black = captured.black + ch)
        }
    }

    // ---------------------------------------------------------------
    // 上行动作
    // ---------------------------------------------------------------

    /** 向同房间成员发起对局邀请（本地立即进入"等待应答"态） */
    fun inviteUser(toUserId: Long, toName: String, side: String) {
        _state.update { it.copy(outgoing = OutgoingView("pending-$toUserId", toUserId, toName)) }
        send(ChessInviteMsg(toUserId = toUserId, side = side))
    }

    fun respondInvite(inviteId: String, accept: Boolean) {
        _state.update { it.copy(invite = null) }
        send(ChessInviteRespondMsg(inviteId = inviteId, accept = accept))
    }

    fun cancelInvite(inviteId: String) {
        _state.update { it.copy(outgoing = null) }
        send(ChessInviteCancelMsg(inviteId = inviteId))
    }

    /** 走子（from/to 交点坐标；合法性由服务端校验） */
    fun move(gameId: String, seq: Int, from: ChessSquare, to: ChessSquare) {
        send(ChessMoveMsg(gameId = gameId, seq = seq, from = from.toDto(), to = to.toDto()))
    }

    fun resign(gameId: String) {
        send(ChessResignMsg(gameId))
    }

    /** 求和（双方同意才和；对方未决求和时再求即判和） */
    fun offerDraw(gameId: String) {
        send(ChessDrawOfferMsg(gameId))
    }

    fun respondDraw(gameId: String, accept: Boolean) {
        _state.update { it.copy(drawOfferFrom = null) }
        send(ChessDrawRespondMsg(gameId = gameId, accept = accept))
    }

    /** 请求悔棋（撤回自己最近一着；需对方同意） */
    fun offerUndo(gameId: String) {
        send(ChessUndoOfferMsg(gameId))
    }

    fun respondUndo(gameId: String, accept: Boolean) {
        _state.update { it.copy(undoOfferFrom = null) }
        send(ChessUndoRespondMsg(gameId = gameId, accept = accept))
    }

    /** 再来一局：点击后等待对方；对方也点击即立即开新局（随机换边） */
    fun rematch(gameId: String) {
        val self = selfUserId()
        _state.update { st ->
            val g = st.game
            if (g != null && g.gameId == gameId && g.rematchBy == null) {
                st.copy(game = g.copy(rematchBy = self))
            } else {
                st
            }
        }
        send(ChessRematchMsg(gameId))
    }

    /**
     * 收起棋盘（回到空闲）。
     *
     * 不需要另外记"这一局我收起过"：收起的本质就是把 [UiState.game] 置空，
     * 而 [onMessage] 里"已结束且手上没有这一局 → 忽略快照"那条判据会顺手挡住
     * 之后重进房时补发的终局快照（服务端会一直保留那一局）。见那边的注释。
     */
    fun dismissEnded() {
        _state.value = UiState()
    }

    /** 会话结束/离房时清空全部状态（由 [VoiceRoomController.leave] 调用） */
    fun reset() {
        _state.value = UiState()
    }

    /** 某用户在对局中执哪方（观战者 null）；面板据此判定 mySide/myTurn */
    fun mySideOf(userId: Long): ChessSide? {
        val g = _state.value.game ?: return null
        if (g.red.userId == userId) return ChessSide.Red
        if (g.black.userId == userId) return ChessSide.Black
        return null
    }
}
