package top.kuangdada.k.nativeapp.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Shader
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
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
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
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
import top.kuangdada.k.nativeapp.R

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
 * 棋盘是一个"实物"，浅色主题下是它、深色主题下也是它。
 * 质感是 Android 端自绘的升级版（外框/木纹/立体棋子全部程序化画，不引入图片
 * 资源）：几何比例仍与 Web 端逐字一致，但配色不再与 Web 的平涂同源 ——
 * 调色只动 [BoardColors]。
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

/** 炮位/兵位角标几何：臂贴着网格线（距线 [STAR_GAP]）、从靠近交点的内角向外伸 [STAR_LEN]（与 Web 端同参） */
private const val STAR_GAP = 2f
private const val STAR_LEN = 9f

/** 棋盘固定配色（实物质感版；调色只动这里） */
private object BoardColors {
    // 盘面木色（竖向微渐变 + 木纹 + 角部压暗）
    val faceTop = Color(0xFFF2D9A4)
    val faceBottom = Color(0xFFE3BC80)
    val grain = Color(0xFF8A5A28)
    val line = Color(0xFF7E5626)
    val riverText = Color(0xFF7A5228)
    // 外框（深木 + 外缘描边）
    val frameTop = Color(0xFF8F5F35)
    val frameBottom = Color(0xFF5F3F1D)
    val frameEdge = Color(0xFF3F2A14).copy(alpha = 0.55f)
    // 棋子（受光木子：芯部亮、边缘深）
    val pieceCore = Color(0xFFFCF3DB)
    val pieceMid = Color(0xFFF2DFB2)
    val pieceRim = Color(0xFFD5B478)
    val pieceRing = Color(0xFFAE8A50)
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
        val context = LocalContext.current
        // k = 实际宽度 / 棋盘单位宽度：所有坐标乘它。
        // 用 BoxWithConstraints 实测宽度而不是拿 dp 常量换算 —— 棋盘宽度由调用方
        // （面板的可用宽度）决定，写死会在窄屏上溢出。
        val k = with(density) { maxWidth.toPx() } / W
        // 棋子文字尺寸也是"棋盘单位"：与 Web 端 CSS 的 26px 同源（墨迹居中见绘制处）
        val pieceFont = with(density) { (26f * k).toSp() }
        val riverFont = with(density) { (26f * k).toSp() }
        val textMeasurer = rememberTextMeasurer()
        // 每个棋子字只量一次（14 个字 × 当前字号）：getBoundingBox 给出墨迹包围盒
        val measuredChars = remember(pieceFont) { mutableMapOf<Char, TextLayoutResult>() }

        /** 棋盘单位 → 屏内像素 */
        fun px(units: Float) = units * k
        /** 纵线 f 的横坐标（含翻转） */
        fun cx(f: Int) = px(MARGIN + (if (flipped) 8 - f else f) * CELL)
        /** 横线 r 的纵坐标（含翻转） */
        fun cy(r: Int) = px(MARGIN + (if (flipped) r else 9 - r) * CELL)

        /**
         * 立体木子：右下月牙落影 + 左上受光的渐变盘体 + 盘体内高光 + 外缘环 + 内圈刻线。
         * 全部程序化画（无图片资源），受光方式对齐实物棋子。
         * 声明成 DrawScope 的局部扩展：只在该层 Canvas 的绘制作用域里可调。
         */
        fun DrawScope.drawPiece(center: Offset, isRed: Boolean) {
            val r = px(PIECE_R)
            // 落影：两枚与子同大的实心黑圆偏移右下，被盘体盖住只露月牙。
            // ★ 别改回"径向渐变软影"：渐变圆比子大、四周都露，在盘面上是一圈灰雾（实测翻车）。
            drawCircle(Color.Black.copy(alpha = 0.32f), r, center + Offset(px(3f), px(4f)))
            drawCircle(Color.Black.copy(alpha = 0.15f), r, center + Offset(px(5.5f), px(7f)))
            // 盘体：高光偏左上，边缘过渡到深木色
            drawCircle(
                Brush.radialGradient(
                    0f to BoardColors.pieceCore,
                    0.55f to BoardColors.pieceMid,
                    1f to BoardColors.pieceRim,
                    center = center - Offset(r * 0.32f, r * 0.38f),
                    radius = r * 1.6f,
                ),
                radius = r,
                center = center,
            )
            // 左上高光：半径收在盘体内（0.48r）——再大就溢出棋子边缘，在盘面上拖出白雾
            val hl = center - Offset(r * 0.34f, r * 0.42f)
            drawCircle(
                Brush.radialGradient(
                    0f to Color.White.copy(alpha = 0.30f),
                    1f to Color.Transparent,
                    center = hl,
                    radius = r * 0.48f,
                ),
                radius = r * 0.48f,
                center = hl,
            )
            // 外缘环（深木色收边）+ 内圈刻线（红黑各随其字）
            drawCircle(BoardColors.pieceRing, r, center, style = Stroke(px(1.5f)))
            val side = if (isRed) BoardColors.pieceRed else BoardColors.pieceBlack
            drawCircle(side.copy(alpha = 0.92f), r * 0.76f, center, style = Stroke(px(1.7f)))
        }

        // ---- 盘面绘制拆两层 Canvas ----
        // 底层：外框/盘面/木纹/网格 —— 只依赖尺寸与翻转，静态内容单独一层，
        // 走子/选中/绝杀脉冲的高频重绘不会连木纹一起重画。
        // 顶层：棋子与各类标记。河界文字夹在两层之间（层级要求见下）。
        val facePathPx = remember(k) {
            Path().apply {
                addRoundRect(
                    RoundRect(18f * k, 18f * k, (W - 18f) * k, (H - 21f) * k, CornerRadius(8f * k)),
                )
            }
        }

        // 盘面木纹：真实贴图（Poly Haven silver_oak_veneer_01，CC0，调米黄后 16KB），
        // 与 Web 端 <image> 同一文件。解码后缩放到盘面像素尺寸（BitmapShader CLAMP）整幅盖上。
        val woodBrush = remember(context, k) {
            val faceW = px(W - 36f).toInt().coerceAtLeast(1)
            val faceH = px(H - 39f).toInt().coerceAtLeast(1)
            val src = BitmapFactory.decodeResource(context.resources, R.drawable.chess_wood)
            val scaled = Bitmap.createScaledBitmap(src, faceW, faceH, true)
            ShaderBrush(BitmapShader(scaled, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP))
        }

        Canvas(modifier = Modifier.fillMaxSize()) {
            // 整盘落影：两层圆角矩形叠出软边，向右下偏（与棋子受光方向一致）
            drawRoundRect(
                color = Color.Black.copy(alpha = 0.26f),
                topLeft = Offset(px(3f), px(5f)),
                size = Size(px(W - 6f), px(H - 9f)),
                cornerRadius = CornerRadius(px(13f)),
            )
            drawRoundRect(
                color = Color.Black.copy(alpha = 0.12f),
                topLeft = Offset(px(4.5f), px(7.5f)),
                size = Size(px(W - 8f), px(H - 11.5f)),
                cornerRadius = CornerRadius(px(14f)),
            )

            // 外框：深木竖向渐变 + 外缘描边
            drawRoundRect(
                brush = Brush.verticalGradient(
                    listOf(BoardColors.frameTop, BoardColors.frameBottom),
                    startY = 0f,
                    endY = px(H),
                ),
                topLeft = Offset(px(1.5f), px(1.5f)),
                size = Size(px(W - 3f), px(H - 6f)),
                cornerRadius = CornerRadius(px(12f)),
            )
            drawRoundRect(
                color = BoardColors.frameEdge,
                topLeft = Offset(px(1.5f), px(1.5f)),
                size = Size(px(W - 3f), px(H - 6f)),
                cornerRadius = CornerRadius(px(12f)),
                style = Stroke(px(1.2f)),
            )

            // 盘面：浅木底 + 中央提亮 + 竖向木纹 + 角部压暗 + 与外框的"雕刻缝"
            val faceTopLeft = Offset(px(18f), px(18f))
            val faceSize = Size(px(W - 36f), px(H - 39f))
            val faceRadius = CornerRadius(px(8f))
            drawRoundRect(
                brush = Brush.verticalGradient(
                    listOf(BoardColors.faceTop, BoardColors.faceBottom),
                    startY = faceTopLeft.y,
                    endY = faceTopLeft.y + faceSize.height,
                ),
                topLeft = faceTopLeft,
                size = faceSize,
                cornerRadius = faceRadius,
            )
            drawRoundRect(
                brush = Brush.radialGradient(
                    0f to Color.White.copy(alpha = 0.14f),
                    1f to Color.Transparent,
                    center = Offset(px(W / 2f), px(H * 0.38f)),
                    radius = px(W * 0.62f),
                ),
                topLeft = faceTopLeft,
                size = faceSize,
                cornerRadius = faceRadius,
            )
            // 木纹贴图：clip 到盘面圆角矩形，再平移到盘面原点画（BitmapShader 以画布原点为参考）
            clipPath(facePathPx) {
                withTransform({ translate(faceTopLeft.x, faceTopLeft.y) }) {
                    drawRect(brush = woodBrush, topLeft = Offset.Zero, size = faceSize)
                }
            }
            drawRoundRect(
                brush = Brush.radialGradient(
                    0.55f to Color.Transparent,
                    1f to Color.Black.copy(alpha = 0.08f),
                    center = Offset(px(W / 2f), px(H / 2f)),
                    radius = px(W * 0.52f),
                ),
                topLeft = faceTopLeft,
                size = faceSize,
                cornerRadius = faceRadius,
            )
            drawRoundRect(
                color = Color.Black.copy(alpha = 0.30f),
                topLeft = faceTopLeft,
                size = faceSize,
                cornerRadius = faceRadius,
                style = Stroke(px(1.2f)),
            )

            // 网格外框：双线（外粗内细，经典盘面画法；与 Web 端 gridBorderOuter/Inner 同参）
            drawRoundRect(
                color = BoardColors.line,
                topLeft = Offset(px(MARGIN - 9f), px(MARGIN - 9f)),
                size = Size(px(CELL * 8f + 18f), px(CELL * 9f + 18f)),
                cornerRadius = CornerRadius(px(4f)),
                style = Stroke(px(2.2f)),
            )
            drawRoundRect(
                color = BoardColors.line,
                topLeft = Offset(px(MARGIN - 3.5f), px(MARGIN - 3.5f)),
                size = Size(px(CELL * 8f + 7f), px(CELL * 9f + 7f)),
                cornerRadius = CornerRadius(px(2f)),
                style = Stroke(px(1.3f)),
            )

            // 横线
            for (r in 0..9) {
                drawLine(
                    color = BoardColors.line,
                    start = Offset(cx(0), cy(r)),
                    end = Offset(cx(8), cy(r)),
                    strokeWidth = px(1.2f),
                )
            }
            // 纵线：两侧贯通，中间被河界断开
            for (f in 0..8) {
                val fx = cx(f)
                if (f == 0 || f == 8) {
                    drawLine(BoardColors.line, Offset(fx, cy(0)), Offset(fx, cy(9)), px(1.2f))
                } else {
                    drawLine(BoardColors.line, Offset(fx, cy(0)), Offset(fx, cy(4)), px(1.2f))
                    drawLine(BoardColors.line, Offset(fx, cy(5)), Offset(fx, cy(9)), px(1.2f))
                }
            }
            // 九宫斜线
            for (l in PALACE_LINES) {
                drawLine(
                    color = BoardColors.line,
                    start = Offset(cx(l[0]), cy(l[1])),
                    end = Offset(cx(l[2]), cy(l[3])),
                    strokeWidth = px(1.2f),
                )
            }
            // 炮位/兵位角标：每个象限一条"贴线 L"——竖臂贴纵线、横臂贴横线，
            // 角在靠近交点的内角、臂向外伸（与 Web 端 starMarkPath 同参）。
            // 边缘点只画盘内侧的象限（外侧越出纵边）。
            for ((f, r) in STAR_POINTS) {
                val x = cx(f)
                val y = cy(r)
                for (sx in intArrayOf(-1, 1)) {
                    if (f == 0 && sx < 0) continue
                    if (f == 8 && sx > 0) continue
                    for (sy in intArrayOf(-1, 1)) {
                        val cornerX = x + sx * px(STAR_GAP)
                        val cornerY = y + sy * px(STAR_GAP)
                        val outX = x + sx * px(STAR_GAP + STAR_LEN)
                        val outY = y + sy * px(STAR_GAP + STAR_LEN)
                        drawLine(BoardColors.line, Offset(outX, cornerY), Offset(cornerX, cornerY), px(1.8f))
                        drawLine(BoardColors.line, Offset(cornerX, cornerY), Offset(cornerX, outY), px(1.8f))
                    }
                }
            }
        }

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
            color = BoardColors.riverText.copy(alpha = 0.85f),
        )
        RiverLabel(
            text = "漢 界",
            centerX = px(MARGIN + 6f * CELL),
            centerY = px(MARGIN + 4.5f * CELL),
            font = riverFont,
            boxWidthPx = px(CELL * 2f),
            boxHeightPx = px(CELL),
            color = BoardColors.riverText.copy(alpha = 0.85f),
        )

        // ---- 棋子与标记层 ----
        Canvas(modifier = Modifier.fillMaxSize()) {
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

            // 棋子（立体木子）+ 选中圈
            val sel = selected
            for (i in 0 until 90) {
                val p = board[i]
                if (p == CHESS_EMPTY) continue
                val f = i % 9
                val r = i / 9
                val center = Offset(cx(f), cy(r))
                val isRed = pieceSide(p) == ChessSide.Red
                if (sel != null && sel.f == f && sel.r == r) {
                    drawCircle(c.accent, px(PIECE_R + 6f), center, style = Stroke(px(3f)))
                }
                drawPiece(center, isRed)
                // 棋子汉字：直接画进 Canvas（替代旧的每子一个 Text 组合层）。
                // 居中用"墨迹包围盒"：字体把汉字墨迹画在 em 框里的位置因字体而异
                // （"兵"的腿会顶到内圈下缘），按行盒居中永远差一点 —— 量出第一字
                // 的实际墨迹 bbox，把字平移到"墨迹中心 == 内圈圆心"，与设备字体无关。
                val char = PIECE_CHARS[p] ?: "?"
                val layout = measuredChars.getOrPut(p) {
                    textMeasurer.measure(
                        AnnotatedString(char),
                        TextStyle(
                            fontSize = pieceFont,
                            fontWeight = FontWeight.Bold,
                            // 极淡的右下投影：字刻进木头的层次（再重就脏了）
                            shadow = Shadow(Color.Black.copy(alpha = 0.28f), Offset(px(0.8f), px(1.2f)), blurRadius = px(1.5f)),
                        ),
                    )
                }
                val ink = layout.getBoundingBox(0)
                drawText(
                    textLayoutResult = layout,
                    color = if (isRed) BoardColors.pieceRed else BoardColors.pieceBlack,
                    topLeft = center - Offset(ink.center.x, ink.center.y),
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
                // 字底下垫一丝亮边：刻进木头的"凹版"错觉
                shadow = Shadow(Color.White.copy(alpha = 0.35f), Offset(0f, 1f), blurRadius = 2f),
            ),
            color = color,
            maxLines = 1,
        )
    }
}
