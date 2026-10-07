package top.kuangdada.k.core.data.chess

/**
 * ============================================================
 * 对局状态机：走子应用、悔棋回退与终局判定
 * （**手工镜像** `shared/src/chess/game.ts`）
 * ============================================================
 * 终局口径（与 `docs/voice-chess-plan.md` §7 一致）：
 *  - 将死/困毙：轮到方无任何合法着法 → 判负（无将 = 将死，有将 = 困毙，
 *    中国象棋两者都判负，与国际象棋的逼和不同）；
 *  - 三次重复局面（棋盘 + 行棋方同串出现第三次）：若循环内一方**每着都将**
 *    （长将）则该方判负（perpetual，亚洲棋规的简化实现 —— 长捉禁着仍不在内）；
 *    否则判和；
 *  - 双方均无进攻子力（仅剩帅/将 + 仕/相）→ 判和。
 */

/** "棋盘 + 行棋方"串：重复局面判定与快照共用 */
fun positionKey(board: ChessBoard, turn: ChessSide): String = boardToFen(board, turn)

fun createInitialGameState(): ChessGameState {
    val (board, turn) = parseFen(CHESS_INITIAL_FEN)
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

/** 双方均无进攻子力（车马炮兵全无）→ 判和 */
fun insufficientMaterial(board: ChessBoard): Boolean {
    for (r in 0..9) {
        for (f in 0..8) {
            val p = at(board, f, r) ?: continue
            when (p.lowercaseChar()) {
                'r', 'n', 'c', 'p' -> return false
            }
        }
    }
    return true
}

/**
 * 三次重复局面的裁决：检查最后一次重复的循环内（两次同串局面之间的着法），
 * 若一方每着都将军（长将）则该方判负，否则判和。
 * 同串局面含行棋方 → 两次出现之间的着法数必为偶数，双方着数相等。
 */
private fun adjudicateRepetition(
    positionKeys: List<String>,
    moves: List<ChessMove>,
    checkFlags: List<Boolean>,
    key: String,
): Pair<ChessGameStatus, ChessEndReason> {
    val firstIdx = positionKeys.indexOf(key).coerceAtLeast(0)
    val allCheck: (ChessSide) -> Boolean = { side ->
        var saw = false
        var failed = false
        for (i in firstIdx until moves.size) {
            if (pieceSide(moves[i].piece) != side) continue
            saw = true
            if (!(checkFlags.getOrNull(i) ?: false)) {
                failed = true
                break
            }
        }
        saw && !failed
    }
    val redPerpetual = allCheck(ChessSide.Red)
    val blackPerpetual = allCheck(ChessSide.Black)
    return when {
        redPerpetual && !blackPerpetual -> ChessGameStatus.BlackWin to ChessEndReason.Perpetual
        blackPerpetual && !redPerpetual -> ChessGameStatus.RedWin to ChessEndReason.Perpetual
        else -> ChessGameStatus.Draw to ChessEndReason.Repetition
    }
}

/**
 * 应用一步棋：在当前合法着法中精确匹配 from→to。
 * 非法返回 null；合法返回**新**状态（不改动入参）—— 与 Web 端同语义。
 */
fun applyMove(state: ChessGameState, from: ChessSquare, to: ChessSquare): ChessGameState? {
    if (state.status != ChessGameStatus.Playing) return null
    val move = legalMoves(state.board, state.turn)
        .firstOrNull { sameSquare(it.from, from) && sameSquare(it.to, to) }
        ?: return null

    val board = applyToBoard(state.board, move)
    val turn = state.turn.other
    val moves = state.moves + move
    val check = isInCheck(board, turn)
    val checkFlags = state.checkFlags + check
    val key = positionKey(board, turn)
    val positionKeys = state.positionKeys + key

    var status = ChessGameStatus.Playing
    var statusReason: ChessEndReason? = null
    val opponentHasMoves = legalMoves(board, turn).isNotEmpty()
    if (!opponentHasMoves) {
        // 轮到方无合法着法：被将 = 将死；未被将 = 困毙。两者均判负。
        status = if (state.turn == ChessSide.Red) ChessGameStatus.RedWin else ChessGameStatus.BlackWin
        statusReason = if (check) ChessEndReason.Checkmate else ChessEndReason.Stalemate
    } else if (positionKeys.count { it == key } >= 3) {
        val (st, reason) = adjudicateRepetition(positionKeys, moves, checkFlags, key)
        return ChessGameState(board, turn, st, reason, moves, checkFlags, positionKeys)
    } else if (insufficientMaterial(board)) {
        status = ChessGameStatus.Draw
        statusReason = ChessEndReason.Insufficient
    }

    return ChessGameState(board, turn, status, statusReason, moves, checkFlags, positionKeys)
}

/**
 * 悔棋回退：撤销末尾 plies 着，回到该局面（行棋方随局面串恢复）。
 * 悔到的局面在历史上必然是"进行中"的合法局面（终局面不会被回退到 ——
 * 服务端只在终局前允许悔棋）。超出历史长度返回 null。
 */
fun undoMove(state: ChessGameState, plies: Int = 1): ChessGameState? {
    if (plies <= 0 || state.moves.size < plies) return null
    val keep = state.moves.size - plies
    val key = state.positionKeys.getOrNull(keep) ?: return null
    val (board, turn) = parseFen(key)
    return ChessGameState(
        board = board,
        turn = turn,
        status = ChessGameStatus.Playing,
        statusReason = null,
        moves = state.moves.take(keep),
        checkFlags = state.checkFlags.take(keep),
        positionKeys = state.positionKeys.take(keep + 1),
    )
}
