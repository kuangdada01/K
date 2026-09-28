package top.kuangdada.k.core.data.chess

/**
 * ============================================================
 * 中国象棋引擎：基础类型（**手工镜像** `shared/src/chess/types.ts`）
 * ============================================================
 * 坐标系约定（引擎与 UI 共用，与 Web 端逐字一致）：
 *  - f（file/纵线）：0-8，红方视角从左到右；
 *  - r（rank/横线）：0-9，0 = 红方底线、9 = 黑方底线；
 *  - 交点索引 = r * 9 + f；
 *  - 红方"前进"为 r+1，黑方为 r-1；过河：红 r>=5、黑 r<=4。
 * 棋子单字符：红方大写（R车 N马 B相 A仕 K帅 C炮 P兵）、黑方小写。
 *
 * ⚠️ 本包是 `shared/src/chess` 的 Kotlin 镜像。工程里**没有** TS→Kotlin 的代码生成
 * 步骤（同样的先例：`VOICE_MAX_ROOM_SIZE`、`CHAT_MAX_CHARS`），所以规则是
 * 「改 shared 必须同步改这里、行为逐字相同」——配套单测 [ChessEngineTest] 与
 * `shared/src/chess/game.test.ts` 的断言一一对应。
 *
 * 为什么值得镜像一整份引擎（而不是把合法落点也交给服务端下发）：
 * 客户端要用它算「点选后能走哪儿」的合法落点提示、本地判将军/绝杀老将位置 ——
 * 这些都是**每次点选都要立即出结果**的交互，走一趟网络来回的体感差一个量级。
 * 服务端仍是唯一权威（`chessGameManager` 用同一套规则裁决），这里只做提示与渲染。
 */

/** 空点（棋盘数组里的占位字符） */
const val CHESS_EMPTY: Char = '\u0000'

/**
 * 棋盘：长度 90 的字符数组，index = r * 9 + f，空点为 [CHESS_EMPTY]。
 *
 * 用 `CharArray` 而不是 `List<Char?>`：合法着法生成要递归到 perft 三层
 * （79666 个叶子），装箱会让真机上算一次"点选提示"就掉帧。
 */
typealias ChessBoard = CharArray

/** 阵营 */
enum class ChessSide {
    Red,
    Black;

    val other: ChessSide get() = if (this == Red) Black else Red
}

/** 棋盘交点 */
data class ChessSquare(val f: Int, val r: Int)

/** 一着棋（[captured] = null 表示吃空） */
data class ChessMove(
    val from: ChessSquare,
    val to: ChessSquare,
    val piece: Char,
    val captured: Char?,
)

/** 对局状态（协议广播里的 'playing' / 'red-win' / 'black-win' / 'draw'） */
enum class ChessGameStatus { Playing, RedWin, BlackWin, Draw }

/**
 * 引擎级终局原因。
 *
 * 认输/断线/超时等**对局层**原因由服务端协议补充（见 [ChessGameEndReason]）——
 * 引擎自己只会判出这五种。
 */
enum class ChessEndReason { Checkmate, Stalemate, Insufficient, Repetition, Perpetual }

/**
 * 引擎对局状态。
 *
 * [positionKeys] 为「棋盘 + 行棋方」串的历史（含初始局面），供三次重复局面与长将判负使用；
 * [checkFlags] 与 [moves] 一一对应，记录每着之后轮到方是否被将（长将判负的判定依据）。
 */
data class ChessGameState(
    val board: ChessBoard,
    val turn: ChessSide,
    val status: ChessGameStatus,
    val statusReason: ChessEndReason?,
    val moves: List<ChessMove>,
    val checkFlags: List<Boolean>,
    val positionKeys: List<String>,
)
