package top.kuangdada.k.core.data.chess

/**
 * ============================================================
 * 伪合法着法生成（**手工镜像** `shared/src/chess/moves.ts`）
 * ============================================================
 * 不考虑己方被将 —— 合法性过滤在 [legalMoves]（ChessCheck.kt）。
 * 全部特殊规则在此落实：蹩马腿、塞象眼、炮翻山（隔子吃）、
 * 象不过河、仕帅不出九宫、兵过河横移、将帅不照面（照面按"被将"
 * 处理，见 [isInCheck]）。
 */

/** 直线四方向（车/炮/帅/将用） */
val ORTHO: List<Pair<Int, Int>> = listOf(0 to 1, 0 to -1, 1 to 0, -1 to 0)

/** 跳位：df/dr 是落点偏移，auxF/auxR 是"腿/眼"的偏移（相对起点） */
private data class Jump(val df: Int, val dr: Int, val auxF: Int, val auxR: Int)

/** 马 8 个跳位与其蹩腿点（腿在马位旁、沿长轴朝目标方向一步） */
private val KNIGHT_JUMPS = listOf(
    Jump(1, 2, 0, 1),
    Jump(-1, 2, 0, 1),
    Jump(1, -2, 0, -1),
    Jump(-1, -2, 0, -1),
    Jump(2, 1, 1, 0),
    Jump(-2, 1, -1, 0),
    Jump(2, -1, 1, 0),
    Jump(-2, -1, -1, 0),
)

/** 象 4 个田字位与其塞眼点（中点） */
private val ELEPHANT_JUMPS = listOf(
    Jump(2, 2, 1, 1),
    Jump(-2, 2, -1, 1),
    Jump(2, -2, 1, -1),
    Jump(-2, -2, -1, -1),
)

/** 仕/士九宫内斜行一步的四个方向 */
private val DIAGONAL: List<Pair<Int, Int>> = listOf(1 to 1, 1 to -1, -1 to 1, -1 to -1)

fun inBoard(f: Int, r: Int): Boolean = f in 0..8 && r in 0..9

/** 交点上的棋子；空点返回 null */
fun at(board: ChessBoard, f: Int, r: Int): Char? {
    if (!inBoard(f, r)) return null
    val p = board[r * 9 + f]
    return if (p == CHESS_EMPTY) null else p
}

/** 九宫：f 3-5；红 r 0-2、黑 r 7-9 */
fun inPalace(side: ChessSide, f: Int, r: Int): Boolean =
    f in 3..5 && if (side == ChessSide.Red) r in 0..2 else r in 7..9

/** 兵是否已过河（红 r>=5、黑 r<=4） */
private fun pawnCrossed(side: ChessSide, r: Int): Boolean =
    if (side == ChessSide.Red) r >= 5 else r <= 4

fun sameSquare(a: ChessSquare, b: ChessSquare): Boolean = a.f == b.f && a.r == b.r

/** 走子后的新棋盘（不改动入参） */
fun applyToBoard(board: ChessBoard, move: ChessMove): ChessBoard {
    val next = board.copyOf()
    next[move.from.r * 9 + move.from.f] = CHESS_EMPTY
    next[move.to.r * 9 + move.to.f] = move.piece
    return next
}

/** 某交点上某方棋子的伪合法着法（吃己方子不生成） */
fun pseudoMovesFrom(board: ChessBoard, sq: ChessSquare): List<ChessMove> {
    val piece = at(board, sq.f, sq.r) ?: return emptyList()
    val side = pieceSide(piece)
    val out = ArrayList<ChessMove>(16)
    fun push(f: Int, r: Int) {
        val target = at(board, f, r)
        if (target != null && pieceSide(target) == side) return
        out.add(ChessMove(from = sq, to = ChessSquare(f, r), piece = piece, captured = target))
    }

    when (piece.lowercaseChar()) {
        'k' -> {
            // 帅/将：九宫内直行一步
            for ((df, dr) in ORTHO) {
                val f = sq.f + df
                val r = sq.r + dr
                if (inBoard(f, r) && inPalace(side, f, r)) push(f, r)
            }
        }
        'a' -> {
            // 仕/士：九宫内斜行一步
            for ((df, dr) in DIAGONAL) {
                val f = sq.f + df
                val r = sq.r + dr
                if (inBoard(f, r) && inPalace(side, f, r)) push(f, r)
            }
        }
        'b' -> {
            // 相/象：田字 + 塞象眼 + 不过河
            for (j in ELEPHANT_JUMPS) {
                val f = sq.f + j.df
                val r = sq.r + j.dr
                if (!inBoard(f, r)) continue
                if (if (side == ChessSide.Red) r > 4 else r < 5) continue
                if (at(board, sq.f + j.auxF, sq.r + j.auxR) != null) continue
                push(f, r)
            }
        }
        'n' -> {
            // 马：日字 + 蹩马腿
            for (j in KNIGHT_JUMPS) {
                val f = sq.f + j.df
                val r = sq.r + j.dr
                if (!inBoard(f, r)) continue
                if (at(board, sq.f + j.auxF, sq.r + j.auxR) != null) continue
                push(f, r)
            }
        }
        'r' -> {
            // 车：直线滑行，遇子止（敌子可吃）
            for ((df, dr) in ORTHO) {
                var f = sq.f + df
                var r = sq.r + dr
                while (inBoard(f, r)) {
                    val target = at(board, f, r)
                    if (target != null) {
                        if (pieceSide(target) != side) push(f, r)
                        break
                    }
                    push(f, r)
                    f += df
                    r += dr
                }
            }
        }
        'c' -> {
            // 炮：不吃子时同车（遇子止）；吃子须隔恰一子（翻山）
            for ((df, dr) in ORTHO) {
                var f = sq.f + df
                var r = sq.r + dr
                while (inBoard(f, r) && at(board, f, r) == null) {
                    push(f, r)
                    f += df
                    r += dr
                }
                if (!inBoard(f, r)) continue // 屏风在界外
                var f2 = f + df
                var r2 = r + dr
                while (inBoard(f2, r2) && at(board, f2, r2) == null) {
                    f2 += df
                    r2 += dr
                }
                val second = if (inBoard(f2, r2)) at(board, f2, r2) else null
                if (second != null && pieceSide(second) != side) push(f2, r2)
            }
        }
        'p' -> {
            // 兵/卒：过河前只进；过河后可横移；永不后退
            val forward = if (side == ChessSide.Red) 1 else -1
            val r = sq.r + forward
            if (inBoard(sq.f, r)) push(sq.f, r)
            if (pawnCrossed(side, sq.r)) {
                if (inBoard(sq.f - 1, sq.r)) push(sq.f - 1, sq.r)
                if (inBoard(sq.f + 1, sq.r)) push(sq.f + 1, sq.r)
            }
        }
        else -> Unit
    }
    return out
}

/** 某方全部伪合法着法（将帅照面不算"吃将"—— 照面约束在 [isInCheck] 统一处理） */
fun pseudoMovesForSide(board: ChessBoard, side: ChessSide): List<ChessMove> {
    val out = ArrayList<ChessMove>(64)
    for (r in 0..9) {
        for (f in 0..8) {
            val p = at(board, f, r) ?: continue
            if (pieceSide(p) == side) out.addAll(pseudoMovesFrom(board, ChessSquare(f, r)))
        }
    }
    return out
}
