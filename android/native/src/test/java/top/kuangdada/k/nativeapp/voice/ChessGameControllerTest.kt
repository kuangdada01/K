package top.kuangdada.k.nativeapp.voice

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import top.kuangdada.k.core.data.chess.ChessSide
import top.kuangdada.k.core.data.chess.ChessSquare
import top.kuangdada.k.core.data.model.ChessCaptured
import top.kuangdada.k.core.data.model.ChessClientMsg
import top.kuangdada.k.core.data.model.ChessClocks
import top.kuangdada.k.core.data.model.ChessDrawDeclinedMsg
import top.kuangdada.k.core.data.model.ChessDrawOfferMsg
import top.kuangdada.k.core.data.model.ChessDrawOfferedMsg
import top.kuangdada.k.core.data.model.ChessDrawRespondMsg
import top.kuangdada.k.core.data.model.ChessEndedMsg
import top.kuangdada.k.core.data.model.ChessErrorMsg
import top.kuangdada.k.core.data.model.ChessInviteCancelMsg
import top.kuangdada.k.core.data.model.ChessInviteMsg
import top.kuangdada.k.core.data.model.ChessInviteReceivedMsg
import top.kuangdada.k.core.data.model.ChessInviteRespondMsg
import top.kuangdada.k.core.data.model.ChessInviteResultMsg
import top.kuangdada.k.core.data.model.ChessMoveDto
import top.kuangdada.k.core.data.model.ChessMoveMsg
import top.kuangdada.k.core.data.model.ChessMovedMsg
import top.kuangdada.k.core.data.model.ChessPlayerInfo
import top.kuangdada.k.core.data.model.ChessRematchMsg
import top.kuangdada.k.core.data.model.ChessRematchOfferedMsg
import top.kuangdada.k.core.data.model.ChessRematchResetMsg
import top.kuangdada.k.core.data.model.ChessResignMsg
import top.kuangdada.k.core.data.model.ChessServerMsg
import top.kuangdada.k.core.data.model.ChessSnapshotMsg
import top.kuangdada.k.core.data.model.ChessSquareDto
import top.kuangdada.k.core.data.model.ChessStartedMsg
import top.kuangdada.k.core.data.model.ChessUndoDeclinedMsg
import top.kuangdada.k.core.data.model.ChessUndoOfferMsg
import top.kuangdada.k.core.data.model.ChessUndoOfferedMsg
import top.kuangdada.k.core.data.model.ChessUndoRespondMsg
import top.kuangdada.k.core.data.model.ChessUndoneMsg

/**
 * ============================================================
 * 对战象棋客户端状态机单测（**逐条镜像** `client/src/voice/chess/useChessGame.test.tsx`）
 * ============================================================
 * 覆盖服务端 `game-*` 消息到视图状态的映射，以及动作上行消息的形状。
 * 两端跑同一组断言，是为了让"安卓端和 Web 端看到的棋局一致"这件事**可验证** ——
 * 这类状态机错了不会报错，只表现为"横幅不消失""按钮点不动""终局后卡死"。
 */
class ChessGameControllerTest {

    private val alice = ChessPlayerInfo(userId = 1, username = "alice")
    private val bob = ChessPlayerInfo(userId = 2, username = "bob")
    private val initialFen = "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w"
    private val clocks = ChessClocks(red = 600_000, black = 600_000, turnStartedAt = 1000, deadline = 90_000)

    private class Harness(val selfId: Long) {
        val sent = mutableListOf<ChessClientMsg>()
        val controller = ChessGameController(selfUserId = { selfId }, send = { sent.add(it) })
        fun feed(msg: ChessServerMsg) = controller.onMessage(msg)
        fun last(): ChessClientMsg = sent.last()
    }

    private fun started(red: ChessPlayerInfo = alice, black: ChessPlayerInfo = bob) = ChessStartedMsg(
        gameId = "g1", red = red, black = black, fen = initialFen, turn = "red", clocks = clocks,
    )

    private fun moved(seq: Int, turn: String, status: String = "playing") = ChessMovedMsg(
        gameId = "g1",
        seq = seq,
        move = ChessMoveDto(
            from = ChessSquareDto(7, 2),
            to = ChessSquareDto(4, 2),
            piece = "C",
        ),
        fen = "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P4P1P1/1C2C4/9/RNBAKABNR b",
        turn = turn,
        check = false,
        status = status,
        notation = "炮二平五",
        clocks = clocks,
    )

    // ---------------------------------------------------------------
    // 空闲 / 邀请
    // ---------------------------------------------------------------

    @Test
    fun `空闲态 面板不渲染`() {
        val h = Harness(1)
        assertFalse(h.controller.state.value.showPanel)
        assertNull(h.controller.state.value.game)
    }

    @Test
    fun `收到邀请 横幅就位 回执按 inviteId 精准清除`() {
        val h = Harness(1)
        h.feed(ChessInviteReceivedMsg(inviteId = "inv1", from = bob, side = "red", expiresAt = 999))
        assertTrue(h.controller.state.value.showPanel)
        assertEquals("inv1", h.controller.state.value.invite?.inviteId)

        // 不匹配的回执不影响已收到的邀请
        h.feed(ChessInviteResultMsg(inviteId = "inv-other", outcome = "declined"))
        assertEquals("inv1", h.controller.state.value.invite?.inviteId)

        // 匹配的作废回执（发起方离房/撤销）清掉横幅
        h.feed(ChessInviteResultMsg(inviteId = "inv1", outcome = "cancelled"))
        assertNull(h.controller.state.value.invite)
    }

    @Test
    fun `game-error 不影响既有状态 但给出一条提示`() {
        val h = Harness(1)
        h.feed(started())
        val toasts = collectMessages(h.controller) {
            h.feed(ChessErrorMsg(code = "not-your-turn", message = "还没轮到你"))
        }
        assertEquals("g1", h.controller.state.value.game?.gameId)
        assertEquals(listOf("还没轮到你"), toasts)
    }

    @Test
    fun `邀请回执的三种提示文案`() {
        val h = Harness(1)
        assertEquals(
            listOf("对方拒绝了你的对局邀请"),
            collectMessages(h.controller) {
                h.feed(ChessInviteResultMsg(inviteId = "x", outcome = "declined"))
            },
        )
        assertEquals(
            listOf("对局邀请已过期"),
            collectMessages(h.controller) {
                h.feed(ChessInviteResultMsg(inviteId = "x", outcome = "expired"))
            },
        )
        // accepted 不提示（紧接着就有 game-started 建立盘面）
        assertEquals(
            emptyList<String>(),
            collectMessages(h.controller) {
                h.feed(ChessInviteResultMsg(inviteId = "x", outcome = "accepted"))
            },
        )
    }

    // ---------------------------------------------------------------
    // 开局 / 走子 / 终局
    // ---------------------------------------------------------------

    @Test
    fun `开局建盘 走子增量 终局置位 收起回空闲`() {
        val h = Harness(1)
        h.feed(started())
        val g = h.controller.state.value.game!!
        assertEquals("g1", g.gameId)
        assertEquals(ChessSide.Red, g.turn)
        assertEquals("playing", g.status)
        assertEquals(0, g.moveCount)
        assertNull(g.lastMove)
        assertEquals(ChessSide.Red, h.controller.mySideOf(1))
        assertEquals(ChessSide.Black, h.controller.mySideOf(2))
        assertNull(h.controller.mySideOf(99))

        h.feed(moved(0, "black"))
        val after = h.controller.state.value.game!!
        assertEquals(ChessSide.Black, after.turn)
        assertEquals(1, after.moveCount)
        assertEquals(ChessSquare(7, 2), after.lastMove?.from)
        assertEquals(ChessSquare(4, 2), after.lastMove?.to)

        h.feed(ChessEndedMsg(gameId = "g1", result = "red-win", reason = "resign"))
        assertEquals("red-win", h.controller.state.value.game?.status)
        assertEquals(ChessGameController.EndedView("red-win", "resign"), h.controller.state.value.ended)

        h.controller.dismissEnded()
        assertFalse(h.controller.state.value.showPanel)
    }

    @Test
    fun `走子同步 记谱追加 被吃子累积 时钟更新`() {
        val h = Harness(1)
        h.feed(started())
        h.feed(
            ChessMovedMsg(
                gameId = "g1",
                seq = 0,
                move = ChessMoveDto(ChessSquareDto(7, 2), ChessSquareDto(4, 2), "C", "p"),
                fen = "x b",
                turn = "black",
                check = false,
                status = "playing",
                notation = "炮二平五",
                clocks = ChessClocks(red = 590_000, black = 600_000, turnStartedAt = 2000, deadline = 89_000),
            )
        )
        val g = h.controller.state.value.game!!
        assertEquals(1, g.moveCount)
        assertEquals(listOf("炮二平五"), g.notations)
        assertEquals(590_000L, g.clocks.red)
        assertEquals(2000L, g.clocks.turnStartedAt)
        // 红方吃获黑卒 → captured.red
        assertEquals(listOf("p"), g.captured.red)
        assertTrue(g.captured.black.isEmpty())
    }

    @Test
    fun `快照恢复 断线重连与观战者后进房以快照为准`() {
        val h = Harness(99) // 观战者
        h.feed(
            ChessSnapshotMsg(
                gameId = "g9",
                red = alice,
                black = bob,
                fen = initialFen,
                turn = "red",
                status = "playing",
                endReason = null,
                lastMove = ChessMoveDto(ChessSquareDto(0, 0), ChessSquareDto(0, 1), "R"),
                moveCount = 3,
                clocks = clocks,
                captured = ChessCaptured(red = listOf("p")),
                notations = listOf("兵九进一"),
            )
        )
        val g = h.controller.state.value.game!!
        assertEquals("g9", g.gameId)
        assertEquals(3, g.moveCount)
        assertEquals(listOf("兵九进一"), g.notations)
        assertEquals(listOf("p"), g.captured.red)
        assertNull(h.controller.mySideOf(99))
    }

    @Test
    fun `终局快照恢复终局横幅 不再卡死`() {
        val h = Harness(1)
        h.feed(started())
        h.feed(
            ChessSnapshotMsg(
                gameId = "g1",
                red = alice,
                black = bob,
                fen = initialFen,
                turn = "black",
                status = "black-win",
                endReason = "checkmate",
                lastMove = null,
                moveCount = 3,
                clocks = clocks,
                notations = listOf("炮二平五", "卒3进1", "炮五进四"),
            )
        )
        assertEquals("black-win", h.controller.state.value.game?.status)
        assertEquals(ChessGameController.EndedView("black-win", "checkmate"), h.controller.state.value.ended)
        h.controller.dismissEnded()
        assertFalse(h.controller.state.value.showPanel)
    }

    // ---------------------------------------------------------------
    // 悔棋 / 求和 / 再来一局
    // ---------------------------------------------------------------

    @Test
    fun `悔棋 offered 置横幅 undone 全量恢复`() {
        val h = Harness(1)
        h.feed(started())
        h.feed(moved(0, "black"))
        h.feed(ChessUndoOfferedMsg(gameId = "g1", from = 2))
        assertEquals(2L, h.controller.state.value.undoOfferFrom)

        h.feed(
            ChessUndoneMsg(
                gameId = "g1",
                fen = initialFen,
                turn = "red",
                status = "playing",
                lastMove = null,
                moveCount = 0,
                clocks = clocks,
                notations = emptyList(),
            )
        )
        val g = h.controller.state.value.game!!
        assertEquals(0, g.moveCount)
        assertEquals(ChessSide.Red, g.turn)
        assertTrue(g.notations.isEmpty())
        assertNull(h.controller.state.value.undoOfferFrom)
    }

    @Test
    fun `求和 declined 提示 悔棋 declined 提示`() {
        val h = Harness(1)
        assertEquals(
            listOf("对方拒绝了求和"),
            collectMessages(h.controller) { h.feed(ChessDrawDeclinedMsg(gameId = "g1", byUserId = 2)) },
        )
        assertEquals(
            listOf("对方拒绝了你的悔棋请求"),
            collectMessages(h.controller) { h.feed(ChessUndoDeclinedMsg(gameId = "g1", byUserId = 2)) },
        )
    }

    @Test
    fun `求和请求 置横幅 应答复位`() {
        val h = Harness(1)
        h.feed(started())
        h.feed(ChessDrawOfferedMsg(gameId = "g1", from = 2))
        assertEquals(2L, h.controller.state.value.drawOfferFrom)
        h.controller.respondDraw("g1", false)
        assertNull(h.controller.state.value.drawOfferFrom)
        assertEquals(ChessDrawRespondMsg(gameId = "g1", accept = false), h.last())
    }

    @Test
    fun `再来一局 offered 与 reset 映射 动作乐观置位`() {
        val h = Harness(1)
        h.feed(started())
        h.feed(ChessRematchOfferedMsg(gameId = "g1", from = 2))
        assertEquals(2L, h.controller.state.value.game?.rematchBy)
        h.feed(ChessRematchResetMsg(gameId = "g1"))
        assertNull(h.controller.state.value.game?.rematchBy)

        h.controller.rematch("g1")
        assertEquals(ChessRematchMsg("g1"), h.last())
        // 乐观置位：按钮立即转"等待对方"
        assertEquals(1L, h.controller.state.value.game?.rematchBy)
        // 对方随后也点了：横幅换成"对方想再来一局 · 点击开始"（rematchBy 变对方）
        h.feed(ChessRematchOfferedMsg(gameId = "g1", from = 2))
        assertEquals(2L, h.controller.state.value.game?.rematchBy)
    }

    // ---------------------------------------------------------------
    // 上行消息形状
    // ---------------------------------------------------------------

    @Test
    fun `动作上行消息形状正确`() {
        val h = Harness(1)
        h.controller.inviteUser(2, "bob", "random")
        assertEquals(ChessInviteMsg(toUserId = 2, side = "random"), h.last())
        assertEquals(2L, h.controller.state.value.outgoing?.toUserId)
        assertEquals("bob", h.controller.state.value.outgoing?.toName)

        h.controller.move("g1", 0, ChessSquare(7, 2), ChessSquare(4, 2))
        assertEquals(
            ChessMoveMsg("g1", 0, ChessSquareDto(7, 2), ChessSquareDto(4, 2)),
            h.last(),
        )

        h.controller.offerDraw("g1")
        assertEquals(ChessDrawOfferMsg("g1"), h.last())
        h.controller.offerUndo("g1")
        assertEquals(ChessUndoOfferMsg("g1"), h.last())
        h.controller.respondUndo("g1", true)
        assertEquals(ChessUndoRespondMsg("g1", true), h.last())
        h.controller.resign("g1")
        assertEquals(ChessResignMsg("g1"), h.last())
        h.controller.respondInvite("inv1", true)
        assertEquals(ChessInviteRespondMsg("inv1", true), h.last())
        h.controller.cancelInvite("pending-2")
        assertEquals(ChessInviteCancelMsg("pending-2"), h.last())
    }

    @Test
    fun `reset 清空全部状态`() {
        val h = Harness(1)
        h.feed(started())
        h.feed(moved(0, "black"))
        h.controller.reset()
        val s = h.controller.state.value
        assertNull(s.game)
        assertNull(s.invite)
        assertNull(s.outgoing)
        assertNull(s.drawOfferFrom)
        assertNull(s.undoOfferFrom)
        assertNull(s.ended)
        assertFalse(s.showPanel)
    }

    // ---------------------------------------------------------------
    // 终局快照的取舍（"早就结束的残局不该自己弹出来"）
    // ---------------------------------------------------------------

    private fun snapshot(gameId: String, status: String, endReason: String? = null) = ChessSnapshotMsg(
        gameId = gameId,
        red = alice,
        black = bob,
        fen = initialFen,
        turn = "black",
        status = status,
        endReason = endReason,
        lastMove = null,
        moveCount = 3,
        clocks = clocks,
        notations = listOf("炮二平五"),
    )

    /**
     * ★ 用户实测报的核心问题：服务端会**一直保留**上一局的终局态，而快照是 `join` 时补发的
     * → 冷启动进房 / 离房再进房，都会把一局早已结束的棋又摆到眼前。
     * 这种残局该去**对局记录**看，不该占着房间面板。
     */
    @Test
    fun `终局快照 本端没见过这一局 直接忽略不显示`() {
        val h = Harness(1) // 冷启动：手上什么都没有
        h.feed(snapshot("stale-1", status = "red-win", endReason = "checkmate"))

        assertNull("早已结束的残局不该被摆出来", h.controller.state.value.game)
        assertNull(h.controller.state.value.ended)
        assertFalse(h.controller.state.value.showPanel)
    }

    /** 进行中的对局**永远**要显示 —— 重进房要能接着观战、接着下 */
    @Test
    fun `进行中的快照 一律显示`() {
        val h = Harness(99) // 观战者
        h.feed(snapshot("live-1", status = "playing"))
        assertEquals("live-1", h.controller.state.value.game?.gameId)
        assertTrue(h.controller.state.value.showPanel)
        assertNull(h.controller.state.value.ended)
    }

    /**
     * 本端**亲历**的终局：同一局的快照要照常恢复终局横幅。
     * 否则一旦连接抖动/服务端补发快照，"对局结束但没有终局条、也没有再来一局"
     * 就成了一块没法操作的死棋盘（Web 端线上实测卡死过同一个坑）。
     */
    @Test
    fun `本端亲历终局后 同一局的快照仍恢复终局横幅`() {
        val h = Harness(1)
        h.feed(started().copy(gameId = "live-2"))
        h.feed(ChessEndedMsg(gameId = "live-2", result = "red-win", reason = "resign"))
        assertTrue(h.controller.state.value.showPanel)

        h.feed(snapshot("live-2", status = "red-win", endReason = "resign"))
        assertEquals("live-2", h.controller.state.value.game?.gameId)
        assertEquals(ChessGameController.EndedView("red-win", "resign"), h.controller.state.value.ended)
        assertTrue(h.controller.state.value.showPanel)
    }

    /** 收起之后 = 手上没有这一局 → 同一局的终局快照也不会再把它弹回来 */
    @Test
    fun `收起棋盘后再收到同一局的终局快照 不会弹回来`() {
        val h = Harness(1)
        h.feed(started().copy(gameId = "live-3"))
        h.feed(ChessEndedMsg(gameId = "live-3", result = "red-win", reason = "resign"))
        h.controller.dismissEnded()
        assertFalse(h.controller.state.value.showPanel)

        h.feed(snapshot("live-3", status = "red-win", endReason = "resign"))
        assertFalse("收起过（=手上没有这一局）就不该再弹回来", h.controller.state.value.showPanel)
        assertNull(h.controller.state.value.game)
    }

    /** 别人邀你开新局时照常显示邀请横幅（终局残局挡掉的是棋盘，不是邀请） */
    @Test
    fun `残局被忽略时 邀请横幅照常显示`() {
        val h = Harness(1)
        h.feed(snapshot("stale-2", status = "draw", endReason = "agreement"))
        assertFalse(h.controller.state.value.showPanel)

        h.feed(ChessInviteReceivedMsg(inviteId = "inv-9", from = bob, side = "red", expiresAt = 999))
        assertTrue(h.controller.state.value.showPanel)
        assertEquals("inv-9", h.controller.state.value.invite?.inviteId)
    }

    /**
     * 订阅 [ChessGameController.messages] 并执行一次 [action]，返回期间收到的提示。
     *
     * 用 `Dispatchers.Unconfined`：`launch` 会在**当前线程立刻**跑到第一个挂起点，
     * 也就是订阅一定在 `action()` 之前建立好 —— 不需要 `yield`/`delay` 这类
     * "赌时序"的写法。
     */
    private fun collectMessages(controller: ChessGameController, action: () -> Unit): List<String> =
        runBlocking {
            val got = mutableListOf<String>()
            val job = launch(Dispatchers.Unconfined) { controller.messages.collect { got.add(it) } }
            action()
            job.cancel()
            got
        }
}
