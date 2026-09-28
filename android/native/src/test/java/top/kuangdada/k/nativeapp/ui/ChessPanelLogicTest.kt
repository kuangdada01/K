package top.kuangdada.k.nativeapp.ui

import org.junit.Assert.assertEquals
import org.junit.Test
import top.kuangdada.k.core.data.chess.ChessSide
import top.kuangdada.k.core.data.model.ChessClocks

/**
 * ============================================================
 * 对局面板的纯逻辑单测（棋钟/文案口径）
 * ============================================================
 * 这几支函数错了**都不会报错**，只会让界面"看着怪"：
 *  · 棋钟口径错 → 走秒跳变、或剩余时间与服务端裁决不一致（观感是"明明还有时间却判我超时"）；
 *  · 终局/被吃子/记谱文案错 → 用户读到的信息与真实的棋局不符。
 * 所以口径要与 Web 端 `ChessGamePanel.tsx` 逐条对齐。
 */
class ChessPanelLogicTest {

    private val clocks = ChessClocks(red = 600_000, black = 590_000, turnStartedAt = 1000, deadline = 91_000)

    // ---- 棋钟 ----

    @Test
    fun `棋钟文案 毫秒到 mss`() {
        assertEquals("0:00", chessClockText(0))
        assertEquals("0:00", chessClockText(-500)) // 负值按 0 处理
        assertEquals("0:59", chessClockText(59_900))
        assertEquals("1:00", chessClockText(60_000))
        assertEquals("10:00", chessClockText(600_000))
        assertEquals("2:05", chessClockText(125_400))
    }

    @Test
    fun `剩余时间 非轮到方取总时长 轮到方取总时长与单步期限的较小者`() {
        val now = 50_000L
        // 轮到红方：min(600000, 91000-50000=41000) = 41000
        assertEquals(41_000L, remainingOf(clocks, ChessSide.Red, ChessSide.Red, true, now))
        // 黑方不是轮到方：直接是总时长
        assertEquals(590_000L, remainingOf(clocks, ChessSide.Black, ChessSide.Red, true, now))
        // 总时长比单步期限还小（残局读秒）→ 取总时长
        val low = clocks.copy(red = 12_000)
        assertEquals(12_000L, remainingOf(low, ChessSide.Red, ChessSide.Red, true, now))
        // 已过 deadline → 0（不是负数）
        assertEquals(0L, remainingOf(clocks, ChessSide.Red, ChessSide.Red, true, 200_000))
    }

    @Test
    fun `非对局中一律显示总时长 不走秒`() {
        assertEquals(600_000L, remainingOf(clocks, ChessSide.Red, ChessSide.Red, false, 999_999))
        assertEquals(590_000L, remainingOf(clocks, ChessSide.Black, ChessSide.Black, false, 999_999))
    }

    // ---- 被吃子 / 记谱 ----

    @Test
    fun `被吃子陈列 空为破折号 棋子用棋盘汉字`() {
        assertEquals("—", capturedText(emptyList()))
        // 红方吃获的是黑子 → 用黑方传统字；黑方吃获的是红子 → 用红方简体字
        assertEquals("砲 卒", capturedText(listOf("c", "p")))
        assertEquals("车 马", capturedText(listOf("R", "N")))
        // 脏数据（非单字符）原样透出，不崩
        assertEquals("??", capturedText(listOf("??")))
    }

    @Test
    fun `棋谱条 最近四着 超出加省略号`() {
        assertEquals("", notationTail(emptyList()))
        assertEquals("炮二平五", notationTail(listOf("炮二平五")))
        assertEquals("炮二平五，马8进7", notationTail(listOf("炮二平五", "马8进7")))
        assertEquals(
            "…炮二平五，马8进7，马2进3，车九平八",
            notationTail(listOf("兵七进一", "炮二平五", "马8进7", "马2进3", "车九平八")),
        )
    }

    // ---- 终局文案 ----

    @Test
    fun `终局结果文案 胜 负 和 观战`() {
        assertEquals("你赢了" to true, endedViewText("red-win", ChessSide.Red))
        assertEquals("你输了" to false, endedViewText("red-win", ChessSide.Black))
        assertEquals("你赢了" to true, endedViewText("black-win", ChessSide.Black))
        assertEquals("和棋" to null, endedViewText("draw", ChessSide.Red))
        assertEquals("对局结束" to null, endedViewText("red-win", null))
    }

    @Test
    fun `终局说明 非和棋要写出胜方名与原因`() {
        assertEquals(
            "红方 alice 获胜 · 将死",
            endedDetail("red-win", ChessEndReasonName.Checkmate, "alice", "bob"),
        )
        assertEquals(
            "黑方 bob 获胜 · 认输",
            endedDetail("black-win", ChessEndReasonName.Resign, "alice", "bob"),
        )
        assertEquals("双方同意", endedDetail("draw", ChessEndReasonName.Agreement, "alice", "bob"))
        assertEquals("超时判负", endedDetail("draw", ChessEndReasonName.Timeout, "alice", "bob"))
        // 未知原因原样透出（服务端只增不改，旧客户端不能显示空白）
        assertEquals("红方 alice 获胜 · brand-new", endedDetail("red-win", "brand-new", "alice", "bob"))
    }

    // ---- 邀请文案 ----

    @Test
    fun `邀请选边文案`() {
        assertEquals("他执红", sideChoiceLabel("red"))
        assertEquals("他执黑", sideChoiceLabel("black"))
        assertEquals("随机执子", sideChoiceLabel("random"))
        assertEquals("随机执子", sideChoiceLabel(""))
    }

    @Test
    fun `终局原因常量与协议逐字一致`() {
        // 这些字符串是与服务端/Web 端约定的线格式，改一个字符就认不出来了
        assertEquals("checkmate", ChessEndReasonName.Checkmate)
        assertEquals("stalemate", ChessEndReasonName.Stalemate)
        assertEquals("insufficient", ChessEndReasonName.Insufficient)
        assertEquals("repetition", ChessEndReasonName.Repetition)
        assertEquals("perpetual", ChessEndReasonName.Perpetual)
        assertEquals("resign", ChessEndReasonName.Resign)
        assertEquals("disconnect", ChessEndReasonName.Disconnect)
        assertEquals("timeout", ChessEndReasonName.Timeout)
        assertEquals("agreement", ChessEndReasonName.Agreement)
    }

    @Test
    fun `终局原因未知时不是 null 也不是空白`() {
        assertEquals("whatever", endedDetail("draw", "whatever", "a", "b"))
    }
}
