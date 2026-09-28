package top.kuangdada.k.nativeapp.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.PI
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlinx.coroutines.delay
import top.kuangdada.k.core.data.chess.ChessSide
import top.kuangdada.k.core.data.chess.ChessSquare
import top.kuangdada.k.core.data.chess.findKing
import top.kuangdada.k.core.data.chess.isInCheck
import top.kuangdada.k.core.data.chess.parseFen
import top.kuangdada.k.core.data.model.ChessClocks
import top.kuangdada.k.core.designsystem.theme.KRadius
import top.kuangdada.k.core.designsystem.theme.KSpacing
import top.kuangdada.k.core.designsystem.theme.KTheme
import top.kuangdada.k.core.designsystem.theme.KType
import top.kuangdada.k.core.designsystem.theme.LocalAnimationsEnabled
import top.kuangdada.k.nativeapp.voice.ChessGameController

/**
 * ============================================================
 * 对战象棋面板（镜像 Web 端 `components/voice/chess/ChessGamePanel.tsx`）
 * ============================================================
 * 屏幕共享舞台下方的对局容器：邀请横幅（收到的/发出的）、状态条
 * （双方席位 / 棋钟 / 轮次 / 将军提示）、棋盘、被吃子陈列、棋谱条、
 * 悔棋/求和/认输操作、终局横幅、绝杀动画。
 *
 * 棋钟：服务端权威（超时由服务端裁决判负），这里只按广播的 clocks
 * （剩余总时长 + 轮到方计时锚点）本地走秒。
 *
 * **无对局时不渲染** —— 对局入口在成员卡上的「对弈」按钮（与 Web 端一致：
 * 那边整个面板也只在 `chess.showPanel` 为真时才挂载）。
 */
@Composable
fun ChessGamePanel(
    chess: ChessGameController,
    selfUserId: Long,
    modifier: Modifier = Modifier,
) {
    val c = KTheme.colors
    val animationsEnabled = LocalAnimationsEnabled.current
    val ui by chess.state.collectAsState()
    val game = ui.game

    // ---- 无对局：只渲染邀请 / 待应答横幅 ----
    // 注意"早就结束的残局"根本不会走到这里 —— 控制器在收快照时就把它们挡掉了
    // （见 ChessGameController 里那条"已结束且非本端亲历 → 忽略"的注释）。
    if (game == null) {
        val invite = ui.invite
        val outgoing = ui.outgoing
        if (invite == null && outgoing == null) return
        Column(
            modifier = modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(KRadius.card))
                .background(c.surface)
                .padding(KSpacing.md),
            verticalArrangement = Arrangement.spacedBy(KSpacing.xs),
        ) {
            if (invite != null) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
                ) {
                    Text(
                        // `side` 是**发起方**的选择，所以被邀方读作"他执红/他执黑"
                        text = "${invite.from.username} 邀你对弈（${sideChoiceLabel(invite.side)}）",
                        style = KType.footnote,
                        color = c.textPrimary,
                        modifier = Modifier.weight(1f),
                    )
                    ChessPillButton("接受", primary = true) { chess.respondInvite(invite.inviteId, true) }
                    ChessPillButton("拒绝") { chess.respondInvite(invite.inviteId, false) }
                }
            }
            if (outgoing != null) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
                ) {
                    Text(
                        text = "已向 ${outgoing.toName} 发出对局邀请，等待应答…",
                        style = KType.footnote,
                        color = c.textPrimary,
                        modifier = Modifier.weight(1f),
                    )
                    ChessPillButton("撤销") { chess.cancelInvite(outgoing.inviteId) }
                }
            }
        }
        return
    }

    val mySide = when (selfUserId) {
        game.red.userId -> ChessSide.Red
        game.black.userId -> ChessSide.Black
        else -> null
    }
    val playing = game.playing
    val myTurn = playing && mySide != null && game.turn == mySide
    val self = selfUserId

    // ---- 本地走秒（500ms 步进足够平滑；对局结束即停表）----
    // ★ ticker 在下面两个 ChessSeatClock 里各管各的（2026-09-28 审查项）：老实现把
    // `now` 放在面板 body 读，对局全程每 500ms 整块面板（含棋盘 Canvas 与 32 个汉字）
    // 全量重组一次。收进钟表自己的作用域后，走秒只重组两行席位，棋盘纹丝不动。

    // 将军提示由客户端用同源引擎从 FEN 现算（快照也就不需要额外字段）
    val inCheck = remember(game.fen, playing) {
        if (!playing) false
        else runCatching { parseFen(game.fen) }
            .map { isInCheck(it.board, it.turn) }
            .getOrDefault(false)
    }

    // ---- 绝杀动画（checkmate 专属）：棋盘震动 + 红光 + "绝杀"大字，2.8s ----
    // ⚠️ 定时器必须与"读 ended"那句解耦成两个 effect（Web 端踩过这个坑）：
    // 同一个 effect 里既有依赖又有清理时，2.8s 内只要再来一条会写 game 的消息
    // （对方点「再来一局」→ game-rematch-offered）就会先跑清理函数清掉定时器，
    // 而本次执行又被去重键提前 return（不再补定时器）→ 震动与红光永不结束。
    var checkmateFx by remember { mutableStateOf(false) }
    var cmKey by remember { mutableStateOf("") }
    LaunchedEffect(ui.ended?.reason, game.gameId) {
        val ended = ui.ended
        if (ended != null && ended.reason == ChessEndReasonName.Checkmate && cmKey != game.gameId) {
            cmKey = game.gameId
            checkmateFx = true
        }
    }
    LaunchedEffect(checkmateFx) {
        if (checkmateFx) {
            delay(2800)
            checkmateFx = false
        }
    }
    // 震动：只在绝杀动画期间启动（无条件开一个无限动画会让整块面板每帧重组）
    val shakePhase = if (checkmateFx && animationsEnabled) {
        val transition = rememberInfiniteTransition(label = "mateShake")
        transition.animateFloat(
            initialValue = 0f,
            targetValue = (2f * PI).toFloat(),
            animationSpec = infiniteRepeatable(tween(450, easing = LinearEasing)),
            label = "mateShakePhase",
        )
    } else {
        null
    }
    // 红光：随动画一起淡出
    val redGlow = remember { Animatable(0f) }
    LaunchedEffect(checkmateFx) {
        if (checkmateFx) {
            redGlow.snapTo(1f)
            redGlow.animateTo(0f, tween(2800))
        } else {
            redGlow.snapTo(0f)
        }
    }
    // 被绝杀方的老将位置（同源引擎 findKing，红光脉冲高亮）
    val mateKing: ChessSquare? = remember(checkmateFx, game.fen, ui.ended?.result) {
        val result = ui.ended?.result ?: return@remember null
        if (!checkmateFx || result == "draw") return@remember null
        val loser = if (result == "red-win") ChessSide.Black else ChessSide.Red
        runCatching { findKing(parseFen(game.fen).board, loser) }.getOrNull()
    }

    // 视角：棋手固定己方在下；观战者默认红下、可手动翻转
    var spectatorFlipped by remember { mutableStateOf(false) }
    val flipped = mySide == ChessSide.Black || (mySide == null && spectatorFlipped)

    var confirmResign by remember { mutableStateOf(false) }

    // 走子回调要 `remember`：否则每次重组都是新 lambda，棋盘的 Canvas 与 32 个汉字
    // 全都无法跳过重组（绝杀震动那段会逐帧重组，代价明显）
    val onMove: (ChessSquare, ChessSquare) -> Unit = remember(game.gameId, game.moveCount) {
        { from, to -> chess.move(game.gameId, game.moveCount, from, to) }
    }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(KRadius.card))
            .background(c.surface)
            .padding(KSpacing.md),
        verticalArrangement = Arrangement.spacedBy(KSpacing.xs),
    ) {
        // ---- 状态条：席位 + 棋钟 + 轮次/将军 ----
        // 布局对齐 Web 端 `.statusBar`：`space-between` + 三块**自然宽度**，
        // 于是"红 昵称 棋钟"三个元素挨在一起、贴左边，黑方镜像贴右边、中间那列居中。
        // ⚠️ 别给昵称加 `weight(1f)`：它会吸掉整半边的余量，把棋钟顶到半边边缘
        // —— 结果是"昵称与自己的棋钟之间拉开一大段空白，而棋钟又和中间那列贴住"
        // （用户实测截图里就是这个样子）。昵称改用 `widthIn(max=)` 限宽 + 省略号。
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            ChessSeatClock(
                name = game.red.username,
                chip = "红",
                chipColor = BoardPieceRed,
                clocks = game.clocks,
                side = ChessSide.Red,
                turn = game.turn,
                playing = playing,
                trailing = false,
            )
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(
                    text = when {
                        !playing -> "对局结束"
                        myTurn -> "轮到你走"
                        game.turn == ChessSide.Red -> "轮到红方"
                        else -> "轮到黑方"
                    },
                    style = KType.tiny,
                    color = c.textMuted,
                    maxLines = 1,
                )
                if (inCheck && playing) {
                    Text(
                        text = "将军！",
                        style = KType.tiny,
                        color = c.danger,
                        modifier = Modifier
                            .clip(RoundedCornerShape(KRadius.chip))
                            .background(c.dangerSoft)
                            .padding(horizontal = 4.dp),
                    )
                }
            }
            // 黑方那半边的"槽"：席位 + 观战者的翻转钮（观战时才有）。
            // 用一层 Row 包住是为了让 `space-between` 仍然只有三块 —— 直接摆成第 4 个子节点的话，
            // 翻转钮会被排到最右边、把黑方席位挤到中间去。
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
            ) {
                ChessSeatClock(
                    name = game.black.username,
                    chip = "黑",
                    chipColor = c.textPrimary,
                    clocks = game.clocks,
                    side = ChessSide.Black,
                    turn = game.turn,
                    playing = playing,
                    trailing = true,
                )
                if (mySide == null) {
                    ChessPillButton("翻面") { spectatorFlipped = !spectatorFlipped }
                }
            }
        }

        // ---- 被吃子陈列（各自吃获的战利品）----
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(KSpacing.sm),
        ) {
            Text(
                text = "红获：${capturedText(game.captured.red)}",
                style = KType.tiny,
                color = c.textMuted,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = "黑获：${capturedText(game.captured.black)}",
                style = KType.tiny,
                color = c.textMuted,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }

        // ---- 未决的求和 / 悔棋请求 ----
        if (ui.drawOfferFrom != null && playing) {
            ChessBanner("对方提议和棋") {
                ChessPillButton("同意", primary = true) { chess.respondDraw(game.gameId, true) }
                ChessPillButton("继续") { chess.respondDraw(game.gameId, false) }
            }
        }
        if (ui.undoOfferFrom != null && playing) {
            ChessBanner("对方请求悔棋") {
                ChessPillButton("同意", primary = true) { chess.respondUndo(game.gameId, true) }
                ChessPillButton("拒绝") { chess.respondUndo(game.gameId, false) }
            }
        }

        // ---- 棋盘（绝杀时震动 + 红光 + 大字）----
        Box(
            modifier = Modifier.fillMaxWidth(),
            contentAlignment = Alignment.Center,
        ) {
            Box(
                modifier = Modifier
                    // 震动走 graphicsLayer：读动画 State 只更新图层，不触发重组
                    .graphicsLayer {
                        val phase = shakePhase
                        if (phase != null) translationX = sin(phase.value) * 5.dp.toPx()
                    }
                    .widthIn(max = 460.dp),
            ) {
                ChessBoardView(
                    fen = game.fen,
                    lastMove = game.lastMove,
                    mySide = mySide,
                    myTurn = myTurn,
                    flipped = flipped,
                    kingHighlight = mateKing,
                    onMove = onMove,
                )
            }
            if (checkmateFx) {
                Box(
                    modifier = Modifier
                        .matchParentSize()
                        .graphicsLayer { alpha = redGlow.value }
                        .background(
                            Brush.radialGradient(
                                colors = listOf(
                                    BoardPieceRed.copy(alpha = 0.4f),
                                    BoardPieceRed.copy(alpha = 0f),
                                ),
                            ),
                        ),
                    contentAlignment = Alignment.Center,
                ) {
                    // 40sp 是"绝杀"这两个字的书法感尺寸：比正文大得多才对得上 Web 端
                    // `.mateSplash` 的视觉分量（不是正文排版，所以不走 KType 的档位）
                    Text(text = "绝杀", style = KType.title, color = BoardPieceRed, fontSize = 40.sp)
                }
            }
        }

        // ---- 棋谱条（中文记谱）：最近 4 着 + 总手数 ----
        if (game.notations.isNotEmpty()) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
            ) {
                Text("第 ${game.moveCount} 手", style = KType.tiny, color = c.textMuted)
                Text(
                    text = notationTail(game.notations),
                    style = KType.tiny,
                    color = c.textSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }

        // ---- 操作条：棋手显示悔棋/求和/认输，观战显示观战提示 ----
        if (playing && mySide != null) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
            ) {
                /**
                 * 「悔棋」**常驻显示**（不再用 Web 端那条 `moveCount > 0` 的门控）。
                 *
                 * 那条判据的后果是"开局第一手之前这一格是空的"，用户只会读到
                 * **"悔棋怎么没了"** —— 一个会随棋局进度突然出现的按钮，比一个
                 * 一直在那儿、点了给一句人话的按钮难懂得多。第一手之前点下去，
                 * 服务端会回 `bad-message`「你还没有走出可悔的棋」，那句提示本身就是
                 * 最准确的解释（不是死按钮：它一定有反馈）。
                 */
                ChessPillButton("悔棋") { chess.offerUndo(game.gameId) }
                ChessPillButton("求和") { chess.offerDraw(game.gameId) }
                ChessPillButton("认输", danger = true) { confirmResign = true }
            }
        }
        if (playing && mySide == null) {
            Text(
                text = "观战中（${game.red.username} vs ${game.black.username}）",
                style = KType.tiny,
                color = c.textMuted,
            )
        }

        // ---- 兜底：对局已结束但没有终局信息（异常情况）也要给出出口 ----
        if (!playing && ui.ended == null) {
            ChessBanner("对局结束") {
                ChessPillButton("收起棋盘") { chess.dismissEnded() }
            }
        }

        // ---- 终局横幅 ----
        val ended = ui.ended
        if (!playing && ended != null) {
            val (title, mine) = endedViewText(ended.result, mySide)
            Column(
                modifier = Modifier.fillMaxWidth(),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(KSpacing.xxs),
            ) {
                Text(
                    text = title,
                    style = KType.subtitle,
                    color = when (mine) {
                        true -> c.success
                        false -> c.danger
                        null -> c.textPrimary
                    },
                )
                Text(
                    text = endedDetail(ended.result, ended.reason, game.red.username, game.black.username),
                    style = KType.tiny,
                    color = c.textMuted,
                    textAlign = TextAlign.Center,
                )
                if (mySide != null) {
                    when (game.rematchBy) {
                        // 自己已点：等对方（Web 端也是禁用态文案）
                        self -> ChessPillButton("等待对方再来一局…", enabled = false) {}
                        // 对方已点：点击即开局
                        null -> {
                            ChessPillButton("再来一局", primary = true) { chess.rematch(game.gameId) }
                            Text(
                                text = "双方都点「再来一局」即立即开始下一盘（换边）",
                                style = KType.tiny,
                                color = c.textMuted,
                            )
                        }
                        else -> ChessPillButton("对方想再来一局 · 点击开始", primary = true) {
                            chess.rematch(game.gameId)
                        }
                    }
                }
                ChessPillButton("收起棋盘") { chess.dismissEnded() }
            }
        }
    }

    // 认输的二次确认（破坏性操作，与房间页「清空聊天记录」同一套写法）
    if (confirmResign) {
        KAlertDialog(
            title = "认输",
            text = "确定认输吗？本局将判你负。",
            confirmText = "认输",
            dismissText = "继续下",
            danger = true,
            onDismissRequest = { confirmResign = false },
            onConfirm = {
                confirmResign = false
                chess.resign(game.gameId)
            },
        )
    }
}

/** 邀请发起方选边的文案（`side` 是**发起方**的选择） */
internal fun sideChoiceLabel(side: String): String = when (side) {
    "red" -> "他执红"
    "black" -> "他执黑"
    else -> "随机执子"
}

// ---------------------------------------------------------------
// 纯逻辑（无 Compose 依赖，可单测）
// ---------------------------------------------------------------

/** 终局原因名（引擎级 + 对局层）。用常量而不是枚举：服务端只增不改 */
internal object ChessEndReasonName {
    const val Checkmate = "checkmate"
    const val Stalemate = "stalemate"
    const val Insufficient = "insufficient"
    const val Repetition = "repetition"
    const val Perpetual = "perpetual"
    const val Resign = "resign"
    const val Disconnect = "disconnect"
    const val Timeout = "timeout"
    const val Agreement = "agreement"
}

/** 棋钟展示口径：毫秒 → m:ss（负值按 0 处理，与 Web 端 `formatClock` 一致） */
internal fun chessClockText(ms: Long): String {
    val total = max(0L, ms / 1000)
    return "${total / 60}:${(total % 60).toString().padStart(2, '0')}"
}

/**
 * 某侧当前剩余：轮到方取 总时长 与 单步期限 的较小者（与服务端的判定一致）。
 *
 * 口径来自协议：`deadline = turnStartedAt + min(每步限时, 轮到方剩余总时长)`，
 * 所以"轮到方的真实剩余"就是 `min(clocks[side], deadline - now)`。
 */
internal fun remainingOf(
    clocks: ChessClocks,
    side: ChessSide,
    turn: ChessSide,
    playing: Boolean,
    now: Long,
): Long {
    val total = if (side == ChessSide.Red) clocks.red else clocks.black
    if (!playing || side != turn) return max(0L, total)
    return max(0L, min(total, clocks.deadline - now))
}

/** 被吃子陈列文案（空 → "—"；棋子用棋盘那套汉字，红黑各自取字） */
internal fun capturedText(pieces: List<String>): String =
    if (pieces.isEmpty()) "—" else pieces.joinToString(" ") { PIECE_CHARS[it.singleOrNull() ?: ' '] ?: it }

/** 棋谱条：最近 4 着 + 省略前缀（与 Web 端同一口径） */
internal fun notationTail(notations: List<String>): String {
    val tail = notations.takeLast(4).joinToString("，")
    return if (notations.size > 4) "…$tail" else tail
}

/** 终局结果文案：胜负文案 + 己方是否获胜（null = 和棋或观战） */
internal fun endedViewText(result: String, mySide: ChessSide?): Pair<String, Boolean?> {
    if (mySide == null) return "对局结束" to null
    if (result == "draw") return "和棋" to null
    val iWin = (result == "red-win" && mySide == ChessSide.Red) ||
        (result == "black-win" && mySide == ChessSide.Black)
    return (if (iWin) "你赢了" else "你输了") to iWin
}

/** 终局说明：显式写出胜方（绝杀/超时/认输都要一眼看到谁赢了） */
internal fun endedDetail(result: String, reason: String, redName: String, blackName: String): String {
    val reasonText = endReasonText(reason)
    if (result == "draw") return reasonText
    val winnerSide = if (result == "red-win") "红方" else "黑方"
    val winnerName = if (result == "red-win") redName else blackName
    return "$winnerSide $winnerName 获胜 · $reasonText"
}

private fun endReasonText(reason: String): String = when (reason) {
    ChessEndReasonName.Checkmate -> "将死"
    ChessEndReasonName.Stalemate -> "困毙"
    ChessEndReasonName.Insufficient -> "双方均无进攻子力"
    ChessEndReasonName.Repetition -> "三次重复局面"
    ChessEndReasonName.Perpetual -> "长将判负"
    ChessEndReasonName.Resign -> "认输"
    ChessEndReasonName.Disconnect -> "对方断线超时"
    ChessEndReasonName.Timeout -> "超时判负"
    ChessEndReasonName.Agreement -> "双方同意"
    else -> reason
}

// ---------------------------------------------------------------
// 小组件
// ---------------------------------------------------------------

/** 红方棋子的朱红（与棋盘同色：席位角标、绝杀红光都用它） */
private val BoardPieceRed = Color(0xFFB03A2E)

/** 一条横幅：说明文字 + 右侧动作 */
@Composable
private fun ChessBanner(text: String, actions: @Composable () -> Unit) {
    val c = KTheme.colors
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(KRadius.row))
            .background(c.surfaceSunken)
            .padding(horizontal = KSpacing.sm, vertical = KSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
    ) {
        Text(
            text = text,
            style = KType.footnote,
            color = c.textPrimary,
            modifier = Modifier.weight(1f),
        )
        actions()
    }
}

/**
 * 胶囊小按钮（悔棋/求和/认输/接受/拒绝…）。
 *
 * 与房间里「朗读 / 清空」那两个标题行小按钮同形态：描边胶囊 + 文字，
 * 强调动作走 accentSoft、破坏性动作走 dangerSoft。
 */
@Composable
private fun ChessPillButton(
    label: String,
    primary: Boolean = false,
    danger: Boolean = false,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    val c = KTheme.colors
    val bg = when {
        !enabled -> c.disabledSurface
        danger -> c.dangerSoft
        primary -> c.accentSoft
        else -> Color.Transparent
    }
    val fg = when {
        !enabled -> c.textMuted
        danger -> c.danger
        primary -> c.accent
        else -> c.textSecondary
    }
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(KRadius.pill))
            .background(bg)
            .border(
                width = 1.dp,
                color = if (enabled) c.borderSubtle else Color.Transparent,
                shape = RoundedCornerShape(KRadius.pill),
            )
            .clickable(enabled = enabled) { onClick() }
            .padding(horizontal = KSpacing.sm, vertical = KSpacing.xxs),
    ) {
        Text(label, style = KType.tiny, color = fg, maxLines = 1)
    }
}

/**
 * 席位：阵营角标 + 昵称 + 棋钟（[trailing] = 黑方，排布整体镜像，与 Web 端一致）。
 *
 * 宽度由内容决定（调用方不再给 `weight`），昵称用 `widthIn(max)` 限宽 + 省略号 ——
 * 这样它**不会**把棋钟顶开，也不会因为一个超长昵称把状态条挤爆。
 */
/**
 * 单个席位的棋钟：**自带走秒 ticker**（详见面板 body 顶部 ticker 的说明）。
 * 每 500ms 只有这一个 composable 重组，席位之外的棋盘/状态条不受牵连。
 */
@Composable
private fun ChessSeatClock(
    name: String,
    chip: String,
    chipColor: Color,
    clocks: ChessClocks,
    side: ChessSide,
    turn: ChessSide,
    playing: Boolean,
    trailing: Boolean,
) {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(playing) {
        while (playing) {
            now = System.currentTimeMillis()
            delay(500)
        }
    }
    val left = remainingOf(clocks, side, turn, playing, now)
    ChessSeat(
        name = name,
        chip = chip,
        chipColor = chipColor,
        clock = chessClockText(left),
        clockActive = playing && turn == side,
        clockLow = playing && left < 20_000,
        trailing = trailing,
    )
}

@Composable
private fun ChessSeat(
    name: String,
    chip: String,
    chipColor: Color,
    clock: String,
    clockActive: Boolean,
    clockLow: Boolean,
    trailing: Boolean,
) {
    val c = KTheme.colors
    val clockColor = when {
        clockLow -> c.danger
        clockActive -> c.accent
        else -> c.textMuted
    }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(KSpacing.xxs),
    ) {
        if (trailing) Text(clock, style = KType.tiny, color = clockColor)
        if (!trailing) SeatChip(chip, chipColor)
        Text(
            text = name,
            style = KType.tiny,
            color = c.textPrimary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            textAlign = if (trailing) TextAlign.End else TextAlign.Start,
            // 76dp ≈ 11sp 下 9 个汉字/14 个西文字符；再长就省略号（不换行、不顶开棋钟）
            modifier = Modifier.widthIn(max = 76.dp),
        )
        if (!trailing) Text(clock, style = KType.tiny, color = clockColor)
        if (trailing) SeatChip(chip, chipColor)
    }
}

@Composable
private fun SeatChip(text: String, color: Color) {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(KRadius.chip))
            .border(1.dp, color, RoundedCornerShape(KRadius.chip))
            .padding(horizontal = 4.dp),
    ) {
        Text(text, style = KType.tiny, color = color, fontSize = 9.sp)
    }
}
