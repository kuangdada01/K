package top.kuangdada.k.nativeapp.ui

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.TextUnit
import kotlin.math.abs
import kotlin.math.roundToInt
import top.kuangdada.k.core.data.chess.CHESS_EMPTY
import top.kuangdada.k.core.data.chess.ChessMove
import top.kuangdada.k.core.data.chess.ChessSide
import top.kuangdada.k.core.data.chess.ChessSquare
import top.kuangdada.k.core.data.chess.at
import top.kuangdada.k.core.data.chess.legalMoves
import top.kuangdada.k.core.data.chess.parseFen
import top.kuangdada.k.core.data.chess.pieceSide
import top.kuangdada.k.core.data.chess.sameSquare
import top.kuangdada.k.core.designsystem.theme.KTheme
import top.kuangdada.k.core.designsystem.theme.LocalAnimationsEnabled

/**
 * ============================================================
 * 中国象棋棋盘（Canvas 自绘，镜像 Web 端 `ChessBoard.tsx` 的 SVG）
 * ============================================================
 * 9×10 交点盘面：河界、九宫斜线、炮位/兵位角标、棋子、选子高亮、
 * 合法落点提示（由同源引擎算出）、上一步标记、被绝杀老将脉冲。
 *
 * 视角：[flipped] = true 时黑方在下（**引擎坐标不变，只翻转显示**）。
 * 交互只对"轮到己方"的棋手开放；观战者（[mySide] = null）只读。
 *
 * 几何与 Web 端**逐字一致**（CELL/MARGIN/棋子半径都取自那边的 SVG viewBox），
 * 这样两端的盘面比例、留白、棋子大小看起来是同一个东西。所有绘制都按
 * "棋盘单位 × k" 换算（k = 实际宽度 / 528），所以任何屏宽下比例都不变。
 *
 * 配色是**固定色**（木色盘面 + 朱红/墨黑棋子），刻意不走主题令牌：
 * 棋盘是一个"实物"，浅色主题下是它、深色主题下也是它 —— 与 Web 端
 * `chess.module.css` 里那组硬编码色值同源，改一处要同步对端。
 */

// ---- 棋盘几何（单位 = Web 端 SVG 的 viewBox 单位）----
private const val CELL = 60f
private const val MARGIN = 36f
private const val W = CELL * 8 + MARGIN * 2
private const val H = CELL * 9 + MARGIN * 2
private const val PIECE_R = 26f

/**
 * 棋盘用字：红方简体、黑方传统（最常见的对照盘面写法，与 Web 端 `ChessBoard.tsx` 一致）。
 *
 * `internal` 而不是 `private`：[ChessGamePanel] 的被吃子陈列要用同一套字
 * （否则"红获：車馬砲"与棋盘上的字对不上）。注意与**记谱**用字不同：
 * 那边是简体（`ChessNotation.pieceDisplayName` 的"车马炮卒"）。
 */
internal val PIECE_CHARS: Map<Char, String> = mapOf(
    'K' to "帅", 'A' to "仕", 'B' to "相", 'R' to "车", 'N' to "马", 'C' to "炮", 'P' to "兵",
    'k' to "將", 'a' to "士", 'b' to "象", 'r' to "車", 'n' to "馬", 'c' to "砲", 'p' to "卒",
)

/** 炮位/兵位的角标点（纯装饰，与 Web 端同一组坐标） */
private val STAR_POINTS: List<Pair<Int, Int>> = listOf(
    1 to 2, 7 to 2, 1 to 7, 7 to 7,
    0 to 3, 2 to 3, 4 to 3, 6 to 3, 8 to 3,
    0 to 6, 2 to 6, 4 to 6, 6 to 6, 8 to 6,
)

/** 九宫斜线（起点 f,r → 终点 f,r） */
private val PALACE_LINES: List<IntArray> = listOf(
    intArrayOf(3, 0, 5, 2),
    intArrayOf(5, 0, 3, 2),
    intArrayOf(3, 7, 5, 9),
    intArrayOf(5, 7, 3, 9),
)

/** 棋盘固定配色（与 Web 端 `chess.module.css` 的棋盘段一一对应） */
private object BoardColors {
    val woodFill = Color(0xFFE8D5AE)
    val woodLine = Color(0xFF8A6D3B)
    val riverRed = Color(0xFF8A5A2B)
    val riverBlack = Color(0xFF3D3D3D)
    val pieceFill = Color(0xFFF6E7C8)
    val pieceRed = Color(0xFFB03A2E)
    val pieceBlack = Color(0xFF2C3440)
}

/** 点击命中要读的一组"最新值"（见 [ChessBoardView] 里 `rememberUpdatedState` 的注释） */
private class TapState(
    val interactive: Boolean,
    val mySide: ChessSide?,
    val board: CharArray,
    val selected: ChessSquare?,
    val flipped: Boolean,
    val targets: List<ChessSquare>,
    val onMove: (ChessSquare, ChessSquare) -> Unit,
)

@Composable
fun ChessBoardView(
    fen: String,
    lastMove: ChessMove?,
    /** 我执哪方（null = 观战者，只读） */
    mySide: ChessSide?,
    myTurn: Boolean,
    flipped: Boolean,
    /** 被绝杀方的老将位置（红光脉冲高亮；null 不显示） */
    kingHighlight: ChessSquare? = null,
    onMove: (ChessSquare, ChessSquare) -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = KTheme.colors
    val animationsEnabled = LocalAnimationsEnabled.current
    val density = LocalDensity.current

    // 脏数据不该让棋盘崩掉：解析失败就画一块空盘（与"还没开局"看起来一样）
    // ⚠️ `remember` 不能写在 `?:` 右侧（组合期调用必须落在稳定的调用点），先单独取出来
    val emptyBoard = remember { CharArray(90) { CHESS_EMPTY } }
    val parsed = remember(fen) { runCatching { parseFen(fen) }.getOrNull() }
    val board = parsed?.board ?: emptyBoard
    val turn = parsed?.turn ?: ChessSide.Red

    val interactive = mySide != null && myTurn
    var selected by remember { mutableStateOf<ChessSquare?>(null) }
    // 盘面一变就取消选中：否则对方走子/悔棋之后，本方那个高亮圈会挂在原地
    LaunchedEffect(fen) { selected = null }

    val targets: List<ChessSquare> = remember(fen, selected, interactive) {
        val sel = selected
        if (!interactive || sel == null) {
            emptyList()
        } else {
            legalMoves(board, turn).filter { sameSquare(it.from, sel) }.map { it.to }
        }
    }

    // 点击命中要读"最新"的状态，但 pointerInput 不能因为选中变化就重建手势识别器
    // （重建会打断正在进行的手势）→ 用 rememberUpdatedState 把可变值喂进去
    val live = rememberUpdatedState(
        TapState(interactive, mySide, board, selected, flipped, targets, onMove)
    )

    // 老将红光脉冲（0.7s 一个来回，与 Web 端 `kingPulse` 同节奏）
    val pulse = if (kingHighlight != null) {
        val transition = rememberInfiniteTransition(label = "kingPulse")
        transition.animateFloat(
            initialValue = 1f,
            targetValue = 0.25f,
            animationSpec = infiniteRepeatable(tween(350), RepeatMode.Reverse),
            label = "kingPulseAlpha",
        ).value
    } else {
        1f
    }

    BoxWithConstraints(modifier = modifier.aspectRatio(W / H)) {
        // k = 实际宽度 / 棋盘单位宽度：所有坐标乘它。
        // 用 BoxWithConstraints 实测宽度而不是拿 dp 常量换算 —— 棋盘宽度由调用方
        // （面板的可用宽度）决定，写死会在窄屏上溢出。
        val k = with(density) { maxWidth.toPx() } / W
        // 棋子文字尺寸也是"棋盘单位"：Web 端 SVG 里 `font-size: 30px`（同一个 528 单位 viewBox）
        val pieceFont = with(density) { (30f * k).toSp() }
        val pieceBox = with(density) { (PIECE_R * 2f * k).toDp() }
        val riverFont = with(density) { (26f * k).toSp() }
        // 河界文字的整体不透明度（Web 端 `.riverText { opacity: 0.75 }`）
        val riverAlpha = 0.75f

        /** 棋盘单位 → 屏内像素 */
        fun px(units: Float) = units * k
        /** 纵线 f 的横坐标（含翻转） */
        fun cx(f: Int) = px(MARGIN + (if (flipped) 8 - f else f) * CELL)
        /** 横线 r 的纵坐标（含翻转） */
        fun cy(r: Int) = px(MARGIN + (if (flipped) r else 9 - r) * CELL)

        // 盘底：用背景 Box 画，**不画进 Canvas** —— 这样"楚河汉界"才能插在它之上、
        // Canvas（棋子圆底）之下。理由见下面那两处 RiverLabel 的注释。
        Box(
            modifier = Modifier
                .matchParentSize()
                .background(
                    color = BoardColors.woodFill,
                    shape = RoundedCornerShape(with(density) { px(10f).toDp() }),
                ),
        )

        // ---- 楚河（左）/ 漢界（右）----
        // 层级：**必须在棋子之下**。Web 端 SVG 里这两个 `<text>` 排在棋子之前，
        // 所以走进河界那两行（r4/r5）的棋子会把自己的圆底压在字样上。
        // 先前我把它们放在了棋子文字之后 → 字样压在棋子上（用户实测："楚河汉界字样层级比棋子高"）。
        // 位置固定在盘面正中那条带上，不随视角翻转。
        RiverLabel(
            text = "楚 河",
            centerX = px(MARGIN + 2f * CELL),
            centerY = px(MARGIN + 4.5f * CELL),
            font = riverFont,
            boxWidthPx = px(CELL * 2f),
            boxHeightPx = px(CELL),
            color = BoardColors.riverRed.copy(alpha = riverAlpha),
        )
        RiverLabel(
            text = "漢 界",
            centerX = px(MARGIN + 6f * CELL),
            centerY = px(MARGIN + 4.5f * CELL),
            font = riverFont,
            boxWidthPx = px(CELL * 2f),
            boxHeightPx = px(CELL),
            color = BoardColors.riverBlack.copy(alpha = riverAlpha),
        )

        Canvas(modifier = Modifier.fillMaxSize()) {
            // 边框（盘底由上面的背景 Box 提供）
            drawRoundRect(
                color = BoardColors.woodLine,
                topLeft = Offset(px(MARGIN - 8f), px(MARGIN - 8f)),
                size = Size(px(CELL * 8f + 16f), px(CELL * 9f + 16f)),
                cornerRadius = CornerRadius(px(4f)),
                style = Stroke(width = px(2f)),
            )

            // 横线
            for (r in 0..9) {
                drawLine(
                    color = BoardColors.woodLine,
                    start = Offset(cx(0), cy(r)),
                    end = Offset(cx(8), cy(r)),
                    strokeWidth = px(1.2f),
                )
            }
            // 纵线：两侧贯通，中间被河界断开
            for (f in 0..8) {
                val fx = cx(f)
                if (f == 0 || f == 8) {
                    drawLine(BoardColors.woodLine, Offset(fx, cy(0)), Offset(fx, cy(9)), px(1.2f))
                } else {
                    drawLine(BoardColors.woodLine, Offset(fx, cy(0)), Offset(fx, cy(4)), px(1.2f))
                    drawLine(BoardColors.woodLine, Offset(fx, cy(5)), Offset(fx, cy(9)), px(1.2f))
                }
            }
            // 九宫斜线
            for (l in PALACE_LINES) {
                drawLine(
                    color = BoardColors.woodLine,
                    start = Offset(cx(l[0]), cy(l[1])),
                    end = Offset(cx(l[2]), cy(l[3])),
                    strokeWidth = px(1.2f),
                )
            }
            // 炮位/兵位角标
            for ((f, r) in STAR_POINTS) {
                drawCircle(BoardColors.woodLine, radius = px(2.5f), center = Offset(cx(f), cy(r)))
            }

            // 被绝杀老将：红光脉冲（绝杀动画期间）
            if (kingHighlight != null) {
                drawCircle(
                    color = BoardColors.pieceRed.copy(alpha = if (animationsEnabled) pulse else 1f),
                    radius = px(PIECE_R + 7f),
                    center = Offset(cx(kingHighlight.f), cy(kingHighlight.r)),
                    style = Stroke(width = px(3f)),
                )
            }

            // 上一步标记（起点小圈 + 终点外圈）
            if (lastMove != null) {
                val mark = c.accent.copy(alpha = 0.85f)
                drawCircle(mark, px(7f), Offset(cx(lastMove.from.f), cy(lastMove.from.r)), style = Stroke(px(2f)))
                drawCircle(
                    mark,
                    px(PIECE_R + 4f),
                    Offset(cx(lastMove.to.f), cy(lastMove.to.r)),
                    style = Stroke(px(2f)),
                )
            }

            // 棋子圆底 + 选中圈
            val sel = selected
            for (i in 0 until 90) {
                val p = board[i]
                if (p == CHESS_EMPTY) continue
                val f = i % 9
                val r = i / 9
                val center = Offset(cx(f), cy(r))
                val isRed = pieceSide(p) == ChessSide.Red
                if (sel != null && sel.f == f && sel.r == r) {
                    drawCircle(c.accent, px(PIECE_R + 5f), center, style = Stroke(px(3f)))
                }
                drawCircle(BoardColors.pieceFill, px(PIECE_R), center)
                drawCircle(
                    color = if (isRed) BoardColors.pieceRed else BoardColors.pieceBlack,
                    radius = px(PIECE_R),
                    center = center,
                    style = Stroke(width = px(1.5f)),
                )
            }
            // 合法落点：空点画实心小圆、可吃子画外圈
            for (t in targets) {
                val center = Offset(cx(t.f), cy(t.r))
                if (at(board, t.f, t.r) != null) {
                    drawCircle(
                        c.accent.copy(alpha = 0.8f),
                        px(PIECE_R + 4f),
                        center,
                        style = Stroke(px(2.5f)),
                    )
                } else {
                    drawCircle(c.accent.copy(alpha = 0.55f), px(8f), center)
                }
            }
        }

        // 棋子汉字层：画在 Canvas 之上（文字永远压在所有棋盘标记上；但**在河界文字之上**
        // —— 河界文字已经画在这一层之前了）。
        // 用固定尺寸盒子居中，不需要量文字自身尺寸 —— 汉字在 52×52 的方盒里居中即视觉正中。
        for (i in 0 until 90) {
            val p = board[i]
            if (p == CHESS_EMPTY) continue
            val f = i % 9
            val r = i / 9
            val isRed = pieceSide(p) == ChessSide.Red
            val half = PIECE_R
            Box(
                modifier = Modifier
                    .offset {
                        IntOffset(
                            px(MARGIN + (if (flipped) 8 - f else f) * CELL - half).roundToInt(),
                            px(MARGIN + (if (flipped) r else 9 - r) * CELL - half).roundToInt(),
                        )
                    }
                    .size(pieceBox),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = PIECE_CHARS[p] ?: "?",
                    style = TextStyle(
                        fontSize = pieceFont,
                        fontWeight = FontWeight.Bold,
                        textAlign = TextAlign.Center,
                    ),
                    color = if (isRed) BoardColors.pieceRed else BoardColors.pieceBlack,
                    maxLines = 1,
                )
            }
        }

        // 交互层：整盘一个手势识别器，按"最近交点"命中。
        // 命中口径与 Web 端的热区**严格等价**：那边的热区是每个交点一个 CELL×CELL 的
        // 方形（以交点为中心），所以"落在交点 ±CELL/2 的方框内"就是命中它。
        Box(
            modifier = Modifier
                .fillMaxSize()
                .pointerInput(Unit) {
                    // 在 PointerInputScope 里先取一次宽度：`detectTapGestures` 的 lambda
                    // 是普通闭包，直接读 `size` 要靠外层作用域解析，写清楚更不容易踩空
                    val boardWidthPx = size.width.toFloat()
                    detectTapGestures { pos ->
                        val st = live.value
                        if (!st.interactive) return@detectTapGestures
                        val kk = boardWidthPx / W
                        val cellF = (pos.x / kk - MARGIN) / CELL
                        val cellR = (pos.y / kk - MARGIN) / CELL
                        val cf = cellF.roundToInt()
                        val cr = cellR.roundToInt()
                        if (cf !in 0..8 || cr !in 0..9) return@detectTapGestures
                        // 只认交点的半格方框（与 Web 端的热区边界一致）
                        if (abs(cellF - cf) > 0.5f || abs(cellR - cr) > 0.5f) return@detectTapGestures
                        val f = if (st.flipped) 8 - cf else cf
                        val r = if (st.flipped) cr else 9 - cr
                        val square = ChessSquare(f, r)
                        val sel = st.selected
                        if (sel != null && st.targets.any { sameSquare(it, square) }) {
                            st.onMove(sel, square)
                            selected = null
                            return@detectTapGestures
                        }
                        val piece = at(st.board, f, r)
                        if (piece != null && pieceSide(piece) == st.mySide) {
                            selected = if (sel != null && sameSquare(sel, square)) null else square
                            return@detectTapGestures
                        }
                        selected = null
                    }
                },
        )
    }
}

/** 河界文字（用固定尺寸盒子居中的方式定位，见调用点注释） */
@Composable
private fun RiverLabel(
    text: String,
    /** 文字框中心的屏内坐标（px） */
    centerX: Float,
    centerY: Float,
    font: TextUnit,
    /** 文字框尺寸（px） */
    boxWidthPx: Float,
    boxHeightPx: Float,
    color: Color,
) {
    val density = LocalDensity.current
    Box(
        modifier = Modifier
            .offset {
                IntOffset(
                    (centerX - boxWidthPx / 2f).roundToInt(),
                    (centerY - boxHeightPx / 2f).roundToInt(),
                )
            }
            .size(
                with(density) { boxWidthPx.toDp() },
                with(density) { boxHeightPx.toDp() },
            ),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = text,
            style = TextStyle(
                fontSize = font,
                fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center,
            ),
            color = color,
            maxLines = 1,
        )
    }
}
