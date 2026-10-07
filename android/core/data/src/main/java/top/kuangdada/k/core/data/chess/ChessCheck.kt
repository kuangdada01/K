package top.kuangdada.k.core.data.chess

/**
 * ============================================================
 * 将军判定与合法着法过滤（**手工镜像** `shared/src/chess/check.ts`）
 * ============================================================
 * [isInCheck] 用"定向扫描"而非全量伪合法着法扫描：直线方向同时覆盖
 * 车、炮（隔一屏风）与将帅照面（纵向第一子是敌帅/将），马按
 * "反查 8 个攻击位 + 蹩腿"判定，兵按攻击方向判定；仕/相永远攻击
 * 不到对方九宫，无需参与。合法着法 = 伪合法 - 走后己方被将/照面。
 */

/** 马"反查"表：从被将点看，攻击者的偏移与其蹩腿点偏移（相对被将点） */
private val KNIGHT_ATTACKERS: List<IntArray> = listOf(
    intArrayOf(-1, -2, -1, -1),
    intArrayOf(1, -2, 1, -1),
    intArrayOf(-1, 2, -1, 1),
    intArrayOf(1, 2, 1, 1),
    intArrayOf(-2, -1, -1, -1),
    intArrayOf(2, -1, 1, -1),
    intArrayOf(-2, 1, -1, 1),
    intArrayOf(2, 1, 1, 1),
)

/** 找某方的帅/将；不在盘上返回 null（防御式，正常对局不会出现） */
fun findKing(board: ChessBoard, side: ChessSide): ChessSquare? {
    val target = if (side == ChessSide.Red) 'K' else 'k'
    for (r in 0..9) {
        for (f in 0..8) {
            if (at(board, f, r) == target) return ChessSquare(f, r)
        }
    }
    return null
}

/** [side] 的帅/将当前是否被攻击（含将帅照面 —— 照面等价于被将，走成照面的棋不合法） */
fun isInCheck(board: ChessBoard, side: ChessSide): Boolean {
    val k = findKing(board, side) ?: return true // 无帅/将按被将处理
    val enemy = side.other

    for ((df, dr) in ORTHO) {
        // 第一子：车（敌）或照面（纵向第一子为敌帅/将）
        var f = k.f + df
        var r = k.r + dr
        while (inBoard(f, r) && at(board, f, r) == null) {
            f += df
            r += dr
        }
        if (!inBoard(f, r)) continue
        val first = at(board, f, r)!!
        if (pieceSide(first) == enemy) {
            val t = first.lowercaseChar()
            if (t == 'r' || (t == 'k' && df == 0)) return true
        }
        // 炮：越过屏风（屏风可为任意一方棋子）找第二子
        var f2 = f + df
        var r2 = r + dr
        while (inBoard(f2, r2) && at(board, f2, r2) == null) {
            f2 += df
            r2 += dr
        }
        val second = if (inBoard(f2, r2)) at(board, f2, r2) else null
        if (second != null && pieceSide(second) == enemy && second.lowercaseChar() == 'c') return true
    }

    // 马：8 个攻击位（各自带蹩腿判定）
    for (a in KNIGHT_ATTACKERS) {
        val f = k.f + a[0]
        val r = k.r + a[1]
        if (!inBoard(f, r)) continue
        val p = at(board, f, r) ?: continue
        if (pieceSide(p) != enemy || p.lowercaseChar() != 'n') continue
        if (at(board, k.f + a[2], k.r + a[3]) == null) return true
    }

    // 兵/卒：正前方一格（敌兵向我的前进方向），过河兵另有两侧
    val forwardFrom = if (enemy == ChessSide.Black) 1 else -1
    val front = at(board, k.f, k.r + forwardFrom)
    if (front != null && pieceSide(front) == enemy && front.lowercaseChar() == 'p') return true
    for (df in intArrayOf(-1, 1)) {
        val sp = at(board, k.f + df, k.r) ?: continue
        if (pieceSide(sp) != enemy || sp.lowercaseChar() != 'p') continue
        val crossed = if (enemy == ChessSide.Black) k.r <= 4 else k.r >= 5
        if (crossed) return true
    }
    return false
}

/** 合法着法：伪合法 - 走后己方被将/照面（同一函数既做服务端裁决口径、也做客户端落点提示） */
fun legalMoves(board: ChessBoard, turn: ChessSide): List<ChessMove> {
    val out = ArrayList<ChessMove>(64)
    for (r in 0..9) {
        for (f in 0..8) {
            val p = at(board, f, r) ?: continue
            if (pieceSide(p) != turn) continue
            for (m in pseudoMovesFrom(board, ChessSquare(f, r))) {
                if (!isInCheck(applyToBoard(board, m), turn)) out.add(m)
            }
        }
    }
    return out
}
