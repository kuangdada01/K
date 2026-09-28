package top.kuangdada.k.core.data.chess

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ============================================================
 * 中国象棋引擎单测（**逐条镜像** `shared/src/chess/game.test.ts`）
 * ============================================================
 * 这组用例的存在理由：Kotlin 引擎是 TS 引擎的**手工镜像**（工程里没有代码生成），
 * 一旦两边走法口径漂移，症状是"安卓端能走的棋被服务端拒绝"或"提示的落点其实非法" ——
 * 前者表现为莫名其妙的 game-error，后者表现为点了没反应。所以断言必须与 Web 端一一对应，
 * 尤其是 perft 基准（44 / 1920 / 79666，公开标准值）—— 它一票否决整份走法生成。
 *
 * 坐标系：f 0-8 纵线、r 0-9 横线（0=红方底线）；FEN 从 r=9 排到 r=0。
 */
class ChessEngineTest {

    private fun sq(f: Int, r: Int) = ChessSquare(f, r)

    /** 落点集合转排序后的 "f,r" 键数组（单字符坐标，字典序即数值序），便于全等比较 */
    private fun toKeys(moves: List<ChessMove>): List<String> =
        moves.map { "${it.to.f},${it.to.r}" }.sorted()

    /** 从 FEN 直接构造"进行中"对局状态（终局判定测试用） */
    private fun stateFromFen(fen: String): ChessGameState {
        val (board, turn) = parseFen(fen)
        return ChessGameState(
            board = board,
            turn = turn,
            status = ChessGameStatus.Playing,
            statusReason = null,
            moves = emptyList(),
            checkFlags = emptyList(),
            positionKeys = listOf(positionKey(board, turn)),
        )
    }

    private fun perft(board: ChessBoard, turn: ChessSide, depth: Int): Int {
        if (depth == 0) return 1
        var n = 0
        for (m in legalMoves(board, turn)) {
            n += perft(applyToBoard(board, m), turn.other, depth - 1)
        }
        return n
    }

    // ---------------------------------------------------------------
    // FEN 编解码
    // ---------------------------------------------------------------

    @Test
    fun `初始局面解析 32子 红黑各16 红先`() {
        val (board, turn) = parseFen(CHESS_INITIAL_FEN)
        assertEquals(ChessSide.Red, turn)
        val pieces = (0 until 90).map { board[it] }.filter { it != CHESS_EMPTY }
        assertEquals(32, pieces.size)
        assertEquals(16, pieces.count { pieceSide(it) == ChessSide.Red })
        assertEquals('K', at(board, 4, 0))
        assertEquals('k', at(board, 4, 9))
        assertEquals('C', at(board, 1, 2))
        assertEquals('P', at(board, 0, 3))
        assertEquals('p', at(board, 0, 6))
    }

    @Test
    fun `FEN 往返一致 初始局面与中盘局面`() {
        assertEquals(CHESS_INITIAL_FEN, boardToFen(parseFen(CHESS_INITIAL_FEN).board, ChessSide.Red))
        val mid = "2r1ak3/4a4/4b4/9/9/9/9/4B4/4A4/2R1K4 b"
        val parsed = parseFen(mid)
        assertEquals(mid, boardToFen(parsed.board, parsed.turn))
    }

    @Test
    fun `非法 FEN 报错 行数 未知字符 行棋方`() {
        assertThrows(IllegalArgumentException::class.java) { parseFen("rnbakabnr w") }
        assertThrows(IllegalArgumentException::class.java) {
            parseFen("rnbakabnr/9/9/9/9/9/9/9/9/RNBKABNR w") // 末行列数!=9
        }
        assertThrows(IllegalArgumentException::class.java) { parseFen("x9/9/9/9/9/9/9/9/9/9 w") }
        assertThrows(IllegalArgumentException::class.java) { parseFen("9/9/9/9/9/9/9/9/9/9 x") }
    }

    // ---------------------------------------------------------------
    // 走法特例
    // ---------------------------------------------------------------

    @Test
    fun `蹩马腿 腿位有子则两个跳位不可达`() {
        // 红马 (4,4)，腿位 (4,5) 放红兵：跳 (3,6)/(5,6) 被蹩；其余 6 个跳位正常
        val (board, _) = parseFen("9/9/9/9/4P4/4N4/9/9/9/9 w")
        assertEquals(
            listOf("2,3", "2,5", "3,2", "5,2", "6,3", "6,5"),
            toKeys(pseudoMovesFrom(board, sq(4, 4))),
        )
    }

    @Test
    fun `塞象眼与象不过河 中点有子不可飞`() {
        // 红相 (2,0)：飞 (4,2) 的眼 (3,1) 被红仕占 → 只能飞 (0,2)
        val (board, _) = parseFen("9/9/9/9/9/9/9/9/3A5/2B1K4 w")
        assertEquals(listOf("0,2"), toKeys(pseudoMovesFrom(board, sq(2, 0))))
    }

    @Test
    fun `炮翻山 无屏风不吃 隔恰一子才吃 隔两子不吃`() {
        fun captures(board: ChessBoard): List<String> =
            pseudoMovesFrom(board, sq(4, 4))
                .filter { it.captured != null }
                .map { "${it.to.f},${it.to.r}:${it.captured}" }
                .sorted()
        // 无屏风：红炮 (4,4) 只滑行不吃（黑将 (4,9) 也不能隔空吃）
        assertEquals(emptyList<String>(), captures(parseFen("4k4/9/9/9/9/4C4/9/9/9/9 w").board))
        // 恰一子屏风（红兵 (4,6)）：吃屏风后第一子黑卒 (4,8)
        assertEquals(listOf("4,8:p"), captures(parseFen("4k4/4p4/9/4P4/9/4C4/9/9/9/9 w").board))
        // 两子屏风（红兵 (4,6) + 红兵 (4,7)）：屏风后第一子是己方 → 不吃
        assertEquals(emptyList<String>(), captures(parseFen("4k4/4p4/4P4/4P4/9/4C4/9/9/9/9 w").board))
    }

    @Test
    fun `帅不出九宫 仕不出九宫`() {
        val (board, _) = parseFen("9/9/9/9/9/9/9/9/9/4K4 w")
        assertEquals(listOf("3,0", "4,1", "5,0"), toKeys(pseudoMovesFrom(board, sq(4, 0))))
        val (b2, _) = parseFen("9/9/9/9/9/9/9/9/9/3A1K3 w")
        assertEquals(listOf("4,1"), toKeys(pseudoMovesFrom(b2, sq(3, 0))))
    }

    @Test
    fun `兵 过河前只进 过河后可横移 永不后退`() {
        // 红兵 (4,3) 未过河：只能进 (4,4)
        assertEquals(listOf("4,4"), toKeys(pseudoMovesFrom(parseFen("9/9/9/9/9/9/4P4/9/9/9 w").board, sq(4, 3))))
        // 红兵 (4,6) 已过河：进 (4,7) + 横移 (3,6)/(5,6)
        assertEquals(
            listOf("3,6", "4,7", "5,6"),
            toKeys(pseudoMovesFrom(parseFen("9/9/9/4P4/9/9/9/9/9/9 w").board, sq(4, 6))),
        )
        // 黑卒 (4,5) 未过河（黑 r<=4 才算过河）：只能进 (4,4)
        assertEquals(
            listOf("4,4"),
            toKeys(pseudoMovesFrom(parseFen("9/9/9/9/4p4/9/9/9/9/9 w").board, sq(4, 5))),
        )
    }

    // ---------------------------------------------------------------
    // 将军判定
    // ---------------------------------------------------------------

    @Test
    fun `马攻击与蹩腿影响将军判定`() {
        // 红马 (2,8) 攻击黑将 (4,9)，腿位 (3,8)
        assertTrue(isInCheck(parseFen("4k4/2N6/9/9/9/9/9/9/9/7K1 w").board, ChessSide.Black))
        // 腿位 (3,8) 放黑子 → 蹩腿，不再将军
        assertTrue(!isInCheck(parseFen("4k4/2Nb5/9/9/9/9/9/9/9/7K1 w").board, ChessSide.Black))
    }

    @Test
    fun `炮将军需要恰一子屏风`() {
        // 黑仕 (4,8) 作屏风，红炮 (4,4) 将军黑将 (4,9)
        assertTrue(isInCheck(parseFen("4k4/4a4/9/9/9/4C4/9/9/9/9 w").board, ChessSide.Black))
        // 无屏风：炮不将军
        assertTrue(!isInCheck(parseFen("4k4/9/9/9/9/4C4/9/9/9/9 w").board, ChessSide.Black))
    }

    @Test
    fun `兵的攻击 正前方一格 过河兵才有侧向攻击`() {
        // 过河红兵 (4,8) 正前攻击黑将 (4,9)
        assertTrue(isInCheck(parseFen("4k4/4P4/9/9/9/9/9/9/9/4K4 w").board, ChessSide.Black))
        // 过河红兵 (4,6) 侧向攻击 (3,6) 处的黑将
        assertTrue(isInCheck(parseFen("9/9/9/3kP4/9/9/9/9/9/9 w").board, ChessSide.Black))
        // 未过河红兵 (4,1) 无侧向攻击：(3,1) 处黑将不被攻击
        assertTrue(!isInCheck(parseFen("9/9/9/9/9/9/9/3k5/4P4/9 w").board, ChessSide.Black))
    }

    // ---------------------------------------------------------------
    // 合法性与禁手
    // ---------------------------------------------------------------

    @Test
    fun `送将禁手 被牵制的车不能离开将军线 沿线移动合法`() {
        // 红帅 (3,0)、红车 (3,1)、黑车 (3,9)、黑将 (4,9)：红车被牵制
        val (board, _) = parseFen("3rk4/9/9/9/9/9/9/9/3R5/3K5 w")
        val rookTos = legalMoves(board, ChessSide.Red)
            .filter { it.from.f == 3 && it.from.r == 1 }
            .map { it.to }
        assertTrue(rookTos.all { it.f == 3 })
        assertTrue(rookTos.any { it.r in 2..8 })
    }

    @Test
    fun `将帅照面禁手 离开遮挡线的着法非法`() {
        // 红帅 (4,1)、红兵 (4,6)（遮挡）、黑将 (4,9)：兵横移即照面 → 只能进 (4,7)
        val (board, _) = parseFen("4k4/9/9/4P4/9/9/9/9/4K4/9 w")
        val pawnTos = legalMoves(board, ChessSide.Red).filter { it.piece == 'P' }.map { it.to }
        assertEquals(listOf(sq(4, 7)), pawnTos)
    }

    // ---------------------------------------------------------------
    // 终局判定
    // ---------------------------------------------------------------

    @Test
    fun `初始局面 perft 基准 44 1920 79666`() {
        val (board, turn) = parseFen(CHESS_INITIAL_FEN)
        assertEquals(44, legalMoves(board, turn).size)
        assertEquals(1920, perft(board, ChessSide.Red, 2))
        assertEquals(79666, perft(board, ChessSide.Red, 3))
    }

    @Test
    fun `将死判负`() {
        // 黑将 (3,9)；红车 (4,4)→(4,9) 将军：该車被 (4,0) 車保护（不可吃），
        // 逃点 (3,8) 被 (0,8) 車控制 → 将死
        val next = applyMove(stateFromFen("3k5/R8/9/9/9/4R4/9/9/9/4R3K w"), sq(4, 4), sq(4, 9))
        assertNotNull(next)
        assertEquals(ChessGameStatus.RedWin, next!!.status)
        assertEquals(ChessEndReason.Checkmate, next.statusReason)
    }

    @Test
    fun `困毙判负 中国象棋无子可走等于输`() {
        // 黑将 (3,9)；红兵 (4,7)→(4,8)：黑将两个逃点均被兵控制，且黑将未被将军 → 困毙
        val next = applyMove(stateFromFen("3k5/9/4P4/9/9/9/9/9/9/5K3 w"), sq(4, 7), sq(4, 8))
        assertNotNull(next)
        assertEquals(ChessGameStatus.RedWin, next!!.status)
        assertEquals(ChessEndReason.Stalemate, next.statusReason)
    }

    @Test
    fun `三次重复局面判和`() {
        // 双炮在两条空线上来回：第 8 步回到初始局面（第 3 次）→ 判和
        val seq = listOf(
            sq(1, 2) to sq(1, 5),
            sq(7, 7) to sq(7, 4),
            sq(1, 5) to sq(1, 2),
            sq(7, 4) to sq(7, 7),
            sq(1, 2) to sq(1, 5),
            sq(7, 7) to sq(7, 4),
            sq(1, 5) to sq(1, 2),
            sq(7, 4) to sq(7, 7),
        )
        var last = createInitialGameState()
        seq.forEachIndexed { i, (from, to) ->
            val next = applyMove(last, from, to)
            assertNotNull("第 ${i + 1} 着", next)
            last = next!!
            if (i < seq.size - 1) assertEquals("第 ${i + 1} 着后", ChessGameStatus.Playing, last.status)
        }
        assertEquals(ChessGameStatus.Draw, last.status)
        assertEquals(ChessEndReason.Repetition, last.statusReason)
    }

    @Test
    fun `双方均无进攻子力判和`() {
        // 红帅 (4,0)+红仕 (3,0)，黑将 (3,9)+黑士 (4,9)：一步后双方仅剩帅/仕/士 → 判和
        val next = applyMove(stateFromFen("3ka4/9/9/9/9/9/9/9/9/3AK4 w"), sq(3, 0), sq(4, 1))
        assertNotNull(next)
        assertEquals(ChessGameStatus.Draw, next!!.status)
        assertEquals(ChessEndReason.Insufficient, next.statusReason)
    }

    @Test
    fun `applyMove 非法着法返回 null 合法着法不改动入参状态`() {
        val state = createInitialGameState()
        val before = boardToFen(state.board, state.turn)
        assertNull(applyMove(state, sq(4, 0), sq(4, 2))) // 帅走两步：非法
        assertNull(applyMove(state, sq(2, 0), sq(4, 4))) // 相飞越河：非法
        val next = applyMove(state, sq(1, 2), sq(1, 5)) // 炮 (1,2)→(1,5)：合法
        assertNotNull(next)
        assertEquals(ChessSide.Black, next!!.turn)
        assertEquals(1, next.moves.size)
        assertEquals(before, boardToFen(state.board, state.turn))
        assertEquals(0, state.moves.size)
    }

    // ---------------------------------------------------------------
    // 悔棋回退
    // ---------------------------------------------------------------

    @Test
    fun `撤1着 对方未应手 回到自己走前的局面`() {
        var state = createInitialGameState()
        state = applyMove(state, sq(1, 2), sq(1, 5))!!
        assertEquals(1, state.moves.size)
        val undone = undoMove(state, 1)!!
        assertEquals(0, undone.moves.size)
        assertEquals(ChessSide.Red, undone.turn)
        assertEquals(ChessGameStatus.Playing, undone.status)
        assertEquals(1, undone.positionKeys.size)
        assertEquals(CHESS_INITIAL_FEN, boardToFen(undone.board, undone.turn))
    }

    @Test
    fun `撤2着 对方已应手 连同应手一并撤销`() {
        var state = createInitialGameState()
        state = applyMove(state, sq(1, 2), sq(1, 5))!!
        state = applyMove(state, sq(7, 7), sq(7, 4))!!
        assertEquals(2, state.moves.size)
        val undone = undoMove(state, 2)!!
        assertEquals(0, undone.moves.size)
        assertEquals(ChessSide.Red, undone.turn)
        assertEquals(CHESS_INITIAL_FEN, boardToFen(undone.board, undone.turn))
    }

    @Test
    fun `撤1着 对方已应手时只撤对方 轮次随之翻转`() {
        var state = createInitialGameState()
        state = applyMove(state, sq(1, 2), sq(1, 5))!!
        state = applyMove(state, sq(7, 7), sq(7, 4))!!
        val undone = undoMove(state, 1)!!
        assertEquals(1, undone.moves.size)
        assertEquals(ChessSide.Black, undone.turn)
    }

    @Test
    fun `悔棋超出历史长度或非法入参返回 null`() {
        val state = createInitialGameState()
        assertNull(undoMove(state, 1))
        assertNull(undoMove(state, 0))
        val one = applyMove(state, sq(1, 2), sq(1, 5))!!
        assertNull(undoMove(one, 2))
    }

    // ---------------------------------------------------------------
    // 长将判负
    // ---------------------------------------------------------------

    @Test
    fun `红车循环长将 第3次重复时红方判负`() {
        // 黑将 (3,9)、红车 (4,9)（正将军）、红帅 (7,0)。循环节 = 黑将横移 + 红车跟将（4 着）
        val state = stateFromFen("3kR4/9/9/9/9/9/9/9/9/7K1 b")
        val seq = listOf(
            sq(3, 9) to sq(3, 8),
            sq(4, 9) to sq(3, 9),
            sq(3, 8) to sq(4, 8),
            sq(3, 9) to sq(4, 9),
            sq(4, 8) to sq(3, 8),
            sq(4, 9) to sq(3, 9),
            sq(3, 8) to sq(4, 8),
            sq(3, 9) to sq(4, 9),
            sq(4, 8) to sq(3, 8),
        )
        var last = state
        seq.forEachIndexed { i, (from, to) ->
            val next = applyMove(last, from, to)
            assertNotNull("第 ${i + 1} 着", next)
            last = next!!
            if (i < seq.size - 1) assertEquals("第 ${i + 1} 着后", ChessGameStatus.Playing, last.status)
        }
        assertEquals(ChessGameStatus.BlackWin, last.status)
        assertEquals(ChessEndReason.Perpetual, last.statusReason)
    }

    // ---------------------------------------------------------------
    // 中文记谱
    // ---------------------------------------------------------------

    @Test
    fun `记谱 炮二平五`() {
        val (board, _) = parseFen(CHESS_INITIAL_FEN)
        assertEquals(
            "炮二平五",
            moveToChineseNotation(board, ChessMove(sq(7, 2), sq(4, 2), 'C', null)),
        )
    }

    @Test
    fun `记谱 马8进7 黑方用阿拉伯数字`() {
        val (board, _) = parseFen(CHESS_INITIAL_FEN)
        assertEquals(
            "马8进7",
            moveToChineseNotation(board, ChessMove(sq(1, 9), sq(2, 7), 'n', null)),
        )
    }

    @Test
    fun `记谱 兵九进一 与 帅五进一 直行子进退跟步数`() {
        val (board, _) = parseFen(CHESS_INITIAL_FEN)
        assertEquals("兵九进一", moveToChineseNotation(board, ChessMove(sq(0, 3), sq(0, 4), 'P', null)))
        assertEquals("帅五进一", moveToChineseNotation(board, ChessMove(sq(4, 0), sq(4, 1), 'K', null)))
    }

    @Test
    fun `记谱 车二进四 直行子进退的步数`() {
        val (board, _) = parseFen(CHESS_INITIAL_FEN)
        assertEquals("车二进四", moveToChineseNotation(board, ChessMove(sq(7, 0), sq(7, 4), 'R', null)))
    }

    @Test
    fun `记谱 同线双车消歧 前车后车且省略原纵线`() {
        // 红双车同在 f0：(0,5) 与 (0,0) —— 走 (0,5)（靠敌方）的是"前车"
        val (board, _) = parseFen("9/9/9/9/R8/9/9/9/9/R7K w")
        assertEquals("前车平八", moveToChineseNotation(board, ChessMove(sq(0, 5), sq(1, 5), 'R', null)))
        assertEquals("后车平八", moveToChineseNotation(board, ChessMove(sq(0, 0), sq(1, 0), 'R', null)))
    }

    @Test
    fun `记谱 吃子也按动作记录 炮八进七打马`() {
        val (board, _) = parseFen(CHESS_INITIAL_FEN)
        assertEquals("炮八进七", moveToChineseNotation(board, ChessMove(sq(1, 2), sq(1, 9), 'C', 'n')))
    }
}
