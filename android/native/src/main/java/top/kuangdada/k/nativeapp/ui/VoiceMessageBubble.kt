package top.kuangdada.k.nativeapp.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.dp
import top.kuangdada.k.core.data.MessageRepository
import top.kuangdada.k.core.designsystem.theme.KRadius
import top.kuangdada.k.core.designsystem.theme.KSpacing
import top.kuangdada.k.core.designsystem.theme.KTheme
import top.kuangdada.k.core.designsystem.theme.KType

/**
 * ============================================================
 * 语音消息气泡（按 2026-10-19 参考图：播放键 + 波形 + 秒数）
 * ============================================================
 * 参考图里没有倍速、没有第二行控制条 —— 气泡只有一条「圆钮 + 波形 + 2″」。
 * 倍速已按要求**删除**；听筒/扬声器与转文字收进长按菜单（聊天页的 ChatContextMenu），
 * 保持气泡本身干净。转写结果**另起一个文字气泡**（不塞进语音气泡里），见 ChatScreen。
 *
 * 交互：
 *  · 点气泡 = 播放/暂停（同一时间只播一条，由 [VoicePlaybackController] 保证）；
 *  · 波形上横向拖动 = 定位，已播/未播由柱色 + 一条竖进度线表示；
 *  · 长按 = 引用 / 撤回 / 转文字 / 听筒切换。
 *
 * 波形是服务端下发的 0–100 振幅（约 32 根），这里降采样到 16 根 —— 参考图的
 * 柱子更疏，32 根在 120dp 宽度里会糊成一片。
 */
@Composable
fun VoiceMessageBubble(
    msg: MessageRepository.MessageUi,
    controller: VoicePlaybackController,
    onLongPress: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = KTheme.colors
    val mine = msg.isMine
    val bg = if (mine) c.accent else c.surface
    val fg = if (mine) c.onAccent else c.textPrimary
    val activeBar = if (mine) c.onAccent else c.accentText
    val inactiveBar = if (mine) c.onAccent.copy(alpha = 0.35f) else c.textMuted.copy(alpha = 0.42f)

    val active = controller.currentId == msg.raw.id
    val playing = active && controller.isPlaying
    val totalMs = if (active && controller.durationMs > 0) controller.durationMs else msg.audioDurationMs
    val positionMs = if (active) controller.positionMs else 0L
    val progress = if (totalMs > 0) (positionMs.toFloat() / totalMs).coerceIn(0f, 1f) else 0f

    // 宽度随时长增长（120dp → 220dp）；参考图里 2 秒的语音也有一段较宽的波形
    val width = (120f + 100f * (msg.audioDurationMs / 60_000f).coerceIn(0f, 1f)).dp

    Column(
        modifier = modifier
            .width(width)
            .clip(RoundedCornerShape(KRadius.row))
            .background(bg)
            .combinedClickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = {
                    msg.audioUrl?.let { controller.toggle(msg.raw.id, it, msg.audioDurationMs) }
                },
                onLongClick = onLongPress,
            )
            .padding(horizontal = KSpacing.sm, vertical = 6.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
        ) {
            PlayPauseCircle(playing = playing, fg = fg)
            Waveform(
                bars = msg.audioWaveform,
                progress = progress,
                activeColor = activeBar,
                inactiveColor = inactiveBar,
                modifier = Modifier.weight(1f),
                onSeek = { fraction -> controller.seekToFraction(fraction) },
            )
            Text(
                text = formatVoiceDurationShort(totalMs),
                style = KType.footnote,
                color = fg.copy(alpha = 0.82f),
            )
        }
    }
}

/** 气泡左侧的圆形播放/暂停键（参考图：深色圆底 + 白色图标） */
@Composable
private fun PlayPauseCircle(playing: Boolean, fg: Color) {
    Box(
        modifier = Modifier
            .size(30.dp)
            .clip(CircleShape)
            .background(fg.copy(alpha = 0.12f)),
        contentAlignment = Alignment.Center,
    ) {
        Canvas(modifier = Modifier.size(14.dp)) {
            val w = size.width
            val h = size.height
            if (playing) {
                val barW = w * 0.26f
                drawRoundRect(
                    color = fg,
                    topLeft = Offset(w * 0.16f, h * 0.12f),
                    size = Size(barW, h * 0.76f),
                    cornerRadius = androidx.compose.ui.geometry.CornerRadius(barW * 0.4f),
                )
                drawRoundRect(
                    color = fg,
                    topLeft = Offset(w * 0.58f, h * 0.12f),
                    size = Size(barW, h * 0.76f),
                    cornerRadius = androidx.compose.ui.geometry.CornerRadius(barW * 0.4f),
                )
            } else {
                val path = Path().apply {
                    moveTo(w * 0.22f, h * 0.08f)
                    lineTo(w * 0.88f, h * 0.5f)
                    lineTo(w * 0.22f, h * 0.92f)
                    close()
                }
                drawPath(path, fg)
            }
        }
    }
}

/**
 * 波形：16 根柱 + 一条竖进度线。
 *
 * 已播的柱子用高亮色、未播的用低透明度；进度线画在 `progress * width` 处，
 * 与参考图里那条分界线一致（比逐柱换色更清楚）。
 */
@Composable
private fun Waveform(
    bars: List<Int>,
    progress: Float,
    activeColor: Color,
    inactiveColor: Color,
    modifier: Modifier = Modifier,
    onSeek: (Float) -> Unit,
) {
    val values = remember(bars) { resampleWaveform(bars, VOICE_BUBBLE_BARS) }
    Canvas(
        modifier = modifier
            .height(24.dp)
            .pointerInput(values) {
                detectHorizontalDragGestures(
                    onDragStart = { offset ->
                        if (size.width > 0) onSeek(offset.x / size.width)
                    },
                    onHorizontalDrag = { change, _ ->
                        if (size.width > 0) onSeek(change.position.x / size.width)
                    },
                )
            },
    ) {
        val count = values.size
        val slot = size.width / count
        val barW = (slot * 0.42f).coerceAtLeast(1.2f)
        val playedUntil = progress * count
        values.forEachIndexed { i, v ->
            val h = (size.height * (v / 100f)).coerceAtLeast(2f)
            val x = i * slot + (slot - barW) / 2f
            val y = (size.height - h) / 2f
            drawRoundRect(
                color = if (i < playedUntil) activeColor else inactiveColor,
                topLeft = Offset(x, y),
                size = Size(barW, h),
                cornerRadius = androidx.compose.ui.geometry.CornerRadius(barW / 2f),
            )
        }
        if (progress > 0f) {
            val x = (size.width * progress).coerceIn(0f, size.width)
            drawLine(
                color = activeColor,
                start = Offset(x, 0f),
                end = Offset(x, size.height),
                strokeWidth = 1.5.dp.toPx(),
            )
        }
    }
}

/** 把任意长度的振幅数组压成固定根数（取每段峰值）；空数组画等高柱 */
private fun resampleWaveform(bars: List<Int>, count: Int): List<Int> {
    if (bars.isEmpty()) return List(count) { 18 }
    return List(count) { i ->
        val from = (i * bars.size / count).coerceIn(0, bars.size - 1)
        val to = (((i + 1) * bars.size) / count).coerceIn(from + 1, bars.size)
        bars.subList(from, to).maxOrNull()?.coerceIn(4, 100) ?: 18
    }
}

/** 气泡里的时长：参考图用「2″」而不是「0:02」 */
internal fun formatVoiceDurationShort(ms: Int): String {
    // 四舍五入到秒（2.6s 显示 3″，而不是截断成 2″）
    val seconds = ((ms + 500) / 1000).coerceAtLeast(1).coerceAtMost(60)
    return "$seconds″"
}

/** 参考图的柱子密度：16 根 */
private const val VOICE_BUBBLE_BARS = 16

/** 0:07 / 1:23（录音面板计时用，保留分:秒） */
internal fun formatVoiceDuration(ms: Int): String {
    val totalSeconds = (ms / 1000).coerceAtLeast(0)
    return "%d:%02d".format(totalSeconds / 60, totalSeconds % 60)
}
