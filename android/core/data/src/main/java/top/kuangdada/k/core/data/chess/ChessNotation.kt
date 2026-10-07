package top.kuangdada.k.core.data.chess

import kotlin.math.abs

/**
 * ============================================================
 * 中文纵线记谱（**手工镜像** `shared/src/chess/notation.ts`）
 * ============================================================
 * 规则（中国象棋竞赛规则的标准记法）：
 *  - 纵线号 = 9 - f（双方一致）：红方视角右起 一~九（汉字），黑方视角左起 1~9；
 *  - 动词：横向平移 = 平；向敌方前进 = 进；回撤 = 退；
 *  - 斜行子（马/相/象/仕/士）进退后跟**目标纵线**；直行子（车/炮/帅/将/兵/卒）
 *    平跟目标纵线、进退跟**步数**；
 *  - 同线同类子 ≥2 时用 前/中/后（4~5 个用 前二三…后）前缀消歧并**省略原纵线**。
 *
 * 注意与棋盘渲染的用字**不同**（Web 端也如此）：记谱用简体（车马炮卒），
 * 棋盘棋子用繁体（車馬砲卒，见 [ChessBoardView] 的汉字表）。
 */

/** 记谱用汉字（简化字） */
private val PIECE_CHARS: Map<ChessSide, Map<Char, Char>> = mapOf(
    ChessSide.Red to mapOf('k' to '帅', 'a' to '仕', 'b' to '相', 'r' to '车', 'n' to '马', 'c' to '炮', 'p' to '兵'),
    ChessSide.Black to mapOf('k' to '将', 'a' to '士', 'b' to '象', 'r' to '车', 'n' to '马', 'c' to '炮', 'p' to '卒'),
)

private val RED_NUMS = listOf('一', '二', '三', '四', '五', '六', '七', '八', '九')

private fun fileLabel(f: Int, side: ChessSide): String {
    val n = 9 - f // 1..9
    return if (side == ChessSide.Red) RED_NUMS[n - 1].toString() else n.toString()
}

/** 棋子显示名（按棋子自身阵营取字：红"兵"、黑"卒"）—— 被吃子陈列用 */
fun pieceDisplayName(piece: Char): String =
    PIECE_CHARS.getValue(pieceSide(piece)).getValue(piece.lowercaseChar()).toString()

/** 同线同类子消歧前缀（idx 按"靠敌方优先"排序后的序号） */
private fun disambiguate(count: Int, idx: Int): String = when {
    count == 2 -> if (idx == 0) "前" else "后"
    count == 3 -> listOf("前", "中", "后")[idx]
    // 4~5 个同线（多兵一线的极端局面）：前、二、三…、后
    idx == 0 -> "前"
    idx == count - 1 -> "后"
    else -> RED_NUMS[idx].toString() // 二、三…
}

/**
 * 计算一着棋的中文记谱。需传入**走子前**的棋盘（同线消歧要看原局）。
 *
 * 服务端在每着广播时已算好并下发（`game-moved.notation`），这里只用于
 * 本地兜底与测试 —— 但口径必须与 Web 端完全一致。
 */
fun moveToChineseNotation(board: ChessBoard, move: ChessMove): String {
    val side = pieceSide(move.piece)
    val t = move.piece.lowercaseChar()
    val pieceChar = PIECE_CHARS.getValue(side).getValue(t)
    val dr = move.to.r - move.from.r
    val dir = when {
        dr == 0 -> "平"
        side == ChessSide.Red -> if (dr > 0) "进" else "退"
        else -> if (dr < 0) "进" else "退"
    }

    // 同线同类子（帅/将唯一，无需消歧）
    var head = "$pieceChar${fileLabel(move.from.f, side)}"
    if (t != 'k') {
        val sameFile = ArrayList<Int>(5)
        for (r in 0..9) {
            val p = board[r * 9 + move.from.f]
            if (p != CHESS_EMPTY && p.lowercaseChar() == t && pieceSide(p) == side) sameFile.add(r)
        }
        if (sameFile.size > 1) {
            // "前" = 更靠近敌方：红方 r 大者在前，黑方 r 小者在前
            val ordered = if (side == ChessSide.Red) sameFile.sortedDescending() else sameFile.sorted()
            val idx = ordered.indexOf(move.from.r)
            head = disambiguate(ordered.size, idx) + pieceChar
        }
    }

    // 斜行子（马象仕）进退跟目标纵线；直行子平跟目标纵线、进退跟步数
    val diagonal = t == 'n' || t == 'b' || t == 'a'
    val tail = if (dir == "平" || diagonal) {
        fileLabel(move.to.f, side)
    } else {
        val steps = abs(dr)
        if (side == ChessSide.Red) RED_NUMS[steps - 1].toString() else steps.toString()
    }
    return "$head$dir$tail"
}
