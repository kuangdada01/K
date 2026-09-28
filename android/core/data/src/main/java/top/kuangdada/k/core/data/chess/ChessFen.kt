package top.kuangdada.k.core.data.chess

/**
 * ============================================================
 * 棋盘 ⇄ FEN 编解码（**手工镜像** `shared/src/chess/fen.ts`）
 * ============================================================
 * 采用象棋界通用的单行 FEN 记法：斜杠分隔 10 行，从 r=9（黑方底线）
 * 排到 r=0（红方底线）；大写=红、小写=黑、数字=连续空点；
 * 行棋方 'w'=红先、'b'=黑。初始局面：
 *   rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w
 */

/** 初始局面（服务端 `game-started` / `game-snapshot` 都会带，这里用于本地开局兜底） */
const val CHESS_INITIAL_FEN = "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w"

/** 全部合法棋子字符（大写=红、小写=黑） */
private const val ALL_PIECES = "RNBAKCPrnbakcp"

fun isChessPiece(ch: Char): Boolean = ch in ALL_PIECES

/** [parseFen] 的产物（对应 TS 侧的 `{ board, turn }`） */
data class ParsedFen(val board: ChessBoard, val turn: ChessSide)

/**
 * 解析 FEN → 棋盘与行棋方；格式非法抛 [IllegalArgumentException]。
 *
 * 与 Web 端同口径：客户端**不接触原始串**（协议里的 `fen` 一律经此解析），
 * UI 侧调用要 `runCatching` 包住 —— 脏数据不该让棋盘崩掉。
 */
fun parseFen(fen: String): ParsedFen {
    val parts = fen.trim().split(Regex("\\s+"))
    val boardStr = parts.getOrElse(0) { "" }
    val turnChar = parts.getOrElse(1) { "" }
    if (turnChar != "w" && turnChar != "b") {
        throw IllegalArgumentException("非法象棋 FEN（行棋方）: $fen")
    }
    val rows = boardStr.split('/')
    if (rows.size != 10) throw IllegalArgumentException("非法象棋 FEN（行数）: $fen")
    val board = CharArray(90) { CHESS_EMPTY }
    for (i in 0 until 10) {
        val row = rows[i]
        val r = 9 - i
        var f = 0
        for (ch in row) {
            when {
                ch in '1'..'9' -> f += ch - '0'
                isChessPiece(ch) -> {
                    if (f > 8) throw IllegalArgumentException("非法象棋 FEN（越界）: $fen")
                    board[r * 9 + f] = ch
                    f += 1
                }
                else -> throw IllegalArgumentException("非法象棋 FEN（字符 $ch）: $fen")
            }
        }
        if (f != 9) throw IllegalArgumentException("非法象棋 FEN（列数）: $fen")
    }
    return ParsedFen(board, if (turnChar == "w") ChessSide.Red else ChessSide.Black)
}

/** 棋盘 + 行棋方 → FEN（positionKey 与协议广播共用） */
fun boardToFen(board: ChessBoard, turn: ChessSide): String {
    val rows = ArrayList<String>(10)
    for (r in 9 downTo 0) {
        val sb = StringBuilder()
        var empty = 0
        for (f in 0..8) {
            val p = board[r * 9 + f]
            if (p != CHESS_EMPTY) {
                if (empty > 0) {
                    sb.append(empty)
                    empty = 0
                }
                sb.append(p)
            } else {
                empty += 1
            }
        }
        if (empty > 0) sb.append(empty)
        rows.add(sb.toString())
    }
    return rows.joinToString("/") + " " + if (turn == ChessSide.Red) "w" else "b"
}

/** 棋子所属阵营（大写=红）。⚠️ 只对**有效棋子**成立，空点（'\u0000'）不要传进来 */
fun pieceSide(piece: Char): ChessSide =
    if (piece.isUpperCase()) ChessSide.Red else ChessSide.Black
