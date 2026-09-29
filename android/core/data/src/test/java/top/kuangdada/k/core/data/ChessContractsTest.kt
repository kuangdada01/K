package top.kuangdada.k.core.data

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import top.kuangdada.k.core.data.chess.ChessSquare
import top.kuangdada.k.core.data.model.ChessClientMsg
import top.kuangdada.k.core.data.model.ChessDrawRespondMsg
import top.kuangdada.k.core.data.model.ChessInviteMsg
import top.kuangdada.k.core.data.model.ChessMoveMsg
import top.kuangdada.k.core.data.model.ChessSquareDto
import top.kuangdada.k.core.data.model.ChessUndoRespondMsg
import top.kuangdada.k.core.data.model.encodeChessClientMsg
import top.kuangdada.k.core.data.model.toDto

/**
 * ============================================================
 * 对战象棋**上行**报文的线上契约（`ModelsChess.kt` 的编码侧）
 * ============================================================
 * ★ 钉住的是 09-29 真机实测的一个 bug：**红方底线（r=0）与最左一路（f=0）的子一步都走不动**，
 * App 里弹「着法坐标无效」。链路是：
 *
 * ```
 * ChessBoardView 点击 → 引擎坐标 (f,r) → ChessSquare.toDto() → ChessMoveMsg
 *   → encodeChessClientMsg → JSON → 服务端 chessGameManager.parseSquare
 * ```
 *
 * 断在编码这一步：`ChessSquareDto` 的两个分量默认值是 0，而 kotlinx **默认
 * `encodeDefaults = false`** —— 值等于默认值的字段会被整个省略。于是
 * 从 (0,0) 走到 (0,1) 的报文变成 `{"from":{},"to":{"r":1}}`，
 * 服务端 `parseSquare` 取不到 `number` 类型的分量 → 直接回
 * `game-error/bad-message`「着法坐标无效」（服务端不区分"缺字段"与"越界"）。
 * 只影响 f 或 r 恰好为 0 的着法 —— 恰好就是整个底线与最左一路，所以看起来像
 * "某些子走不了"，而不是"象棋坏了"。
 *
 * 这个测试**不复用** [encodeChessClientMsg] 的实现细节，而是自己按服务端
 * `parseSquare` 的口径（见 `server/src/voice/game/chessGameManager.ts:159`）
 * 逐字段窄化一遍：必须是整数、f∈[0,8]、r∈[0,9]。
 */
class ChessContractsTest {

    // ------------------------------------------------------------------
    // 服务端口径的窄化（逐条镜像 parseSquare，改服务端就要改这里）
    // ------------------------------------------------------------------

    /** 等价于服务端 `parseSquare(v)`：返回 null = 服务端会回「着法坐标无效」 */
    private fun parseSquareLikeServer(v: JsonObject?): Pair<Int, Int>? {
        if (v == null) return null
        val f = (v["f"] as? JsonPrimitive)?.takeIf { it.isString.not() }?.int ?: return null
        val r = (v["r"] as? JsonPrimitive)?.takeIf { it.isString.not() }?.int ?: return null
        if (f !in 0..8) return null
        if (r !in 0..9) return null
        return f to r
    }

    /** 拆出一条上行报文的 from/to（服务端读的就是这两个字段） */
    private fun squares(msg: ChessClientMsg): Pair<Pair<Int, Int>?, Pair<Int, Int>?> {
        val obj = KJson.parseToJsonElement(encodeChessClientMsg(msg)).jsonObject
        val from = (obj["from"] as? JsonObject)?.let { parseSquareLikeServer(it) }
        val to = (obj["to"] as? JsonObject)?.let { parseSquareLikeServer(it) }
        return from to to
    }

    // ------------------------------------------------------------------
    // ★ 回归：坐标里出现 0 不能被编码器吃掉
    // ------------------------------------------------------------------

    @Test
    fun `底线与最左一路的着法 坐标 0 必须原样送到`() {
        // 红方底线车位 (0,0) → (0,1)：f、r 都是 0（两个分量都等于默认值，最坏情况）
        val (from, to) = squares(ChessMoveMsg(gameId = "g1", seq = 3, from = ChessSquareDto(0, 0), to = ChessSquareDto(0, 1)))
        assertEquals("from 的 f/r 被编码器省略了，服务端会报「着法坐标无效」", 0 to 0, from)
        assertEquals(0 to 1, to)

        // 只丢一个分量的两种形态：f=0（最左一路）、r=0（底线）
        assertEquals(0 to 3, squares(ChessMoveMsg("g1", 0, ChessSquareDto(0, 3), ChessSquareDto(1, 3))).first)
        assertEquals(5 to 0, squares(ChessMoveMsg("g1", 0, ChessSquareDto(5, 0), ChessSquareDto(5, 4))).first)
        assertEquals(7 to 2, squares(ChessMoveMsg("g1", 0, ChessSquareDto(7, 2), ChessSquareDto(4, 2))).first)
    }

    @Test
    fun `棋盘上 90 个交点全部能通过服务端窄化`() {
        for (r in 0..9) {
            for (f in 0..8) {
                val (from, to) = squares(
                    ChessMoveMsg("g1", 0, ChessSquareDto(f, r), ChessSquareDto(8 - f, 9 - r)),
                )
                assertEquals("($f,$r) 作为起点丢了坐标", f to r, from)
                assertEquals("($f,$r) 的落点丢了坐标", (8 - f) to (9 - r), to)
            }
        }
    }

    /** 引擎坐标 → DTO 这一段也别搞反（f 是纵线、r 是横线） */
    @Test
    fun `引擎坐标到 DTO 的映射不串轴`() {
        val msg = ChessMoveMsg("g1", 0, ChessSquare(7, 2).toDto(), ChessSquare(4, 2).toDto())
        val obj = KJson.parseToJsonElement(encodeChessClientMsg(msg)).jsonObject
        assertEquals(7, (obj["from"]!!.jsonObject["f"] as JsonPrimitive).int)
        assertEquals(2, (obj["from"]!!.jsonObject["r"] as JsonPrimitive).int)
    }

    // ------------------------------------------------------------------
    // 其余上行消息的形状（一次编码不能引入 null，也不能丢字段）
    // ------------------------------------------------------------------

    @Test
    fun `走子报文带 gameId 与 seq`() {
        val obj = KJson.parseToJsonElement(
            encodeChessClientMsg(ChessMoveMsg("g9", 12, ChessSquareDto(1, 1), ChessSquareDto(1, 4))),
        ).jsonObject
        assertEquals("game-move", (obj["type"] as JsonPrimitive).content)
        assertEquals("g9", (obj["gameId"] as JsonPrimitive).content)
        assertEquals(12, (obj["seq"] as JsonPrimitive).int)
        assertNotNull(obj["from"])
        assertNotNull(obj["to"])
    }

    @Test
    fun `布尔字段不会因为 false 被省略`() {
        // false 同样是"合法值"，服务端 zod 的布尔分支不接受缺字段
        val draw = KJson.parseToJsonElement(
            encodeChessClientMsg(ChessDrawRespondMsg(gameId = "g1", accept = false)),
        ).jsonObject
        assertEquals(false, (draw["accept"] as JsonPrimitive).content.toBoolean())
        val undo = KJson.parseToJsonElement(
            encodeChessClientMsg(ChessUndoRespondMsg(gameId = "g1", accept = false)),
        ).jsonObject
        assertEquals(false, (undo["accept"] as JsonPrimitive).content.toBoolean())
    }

    @Test
    fun `邀请报文带 toUserId 与选边`() {
        val obj = KJson.parseToJsonElement(
            encodeChessClientMsg(ChessInviteMsg(toUserId = -3, side = "random")),
        ).jsonObject
        assertEquals("game-invite", (obj["type"] as JsonPrimitive).content)
        assertEquals(-3, (obj["toUserId"] as JsonPrimitive).int)
        assertEquals("random", (obj["side"] as JsonPrimitive).content)
    }

    /** 整个上行联合都不能出现 `null`（服务端逐字段窄化，null 一律算非法） */
    @Test
    fun `上行报文里不出现 null`() {
        val msgs = listOf(
            ChessMoveMsg("g1", 0, ChessSquareDto(0, 0), ChessSquareDto(0, 9)),
            ChessInviteMsg(2, "red"),
            ChessDrawRespondMsg("g1", false),
        )
        for (m in msgs) {
            val text = encodeChessClientMsg(m)
            assertTrue("$text 里出现了 null", !text.contains("null"))
        }
    }
}
