package top.kuangdada.k.nativeapp.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import top.kuangdada.k.core.data.ApiResult
import top.kuangdada.k.core.data.MessageRepository
import top.kuangdada.k.core.data.displayMessage
import top.kuangdada.k.core.designsystem.theme.KRadius
import top.kuangdada.k.core.designsystem.theme.KSpacing
import top.kuangdada.k.core.designsystem.theme.KTheme
import top.kuangdada.k.core.designsystem.theme.KType

/**
 * ============================================================
 * 语音消息气泡（QQ 式）
 * ============================================================
 * 结构：播放键 + 波形 + 时长；下面一行小字控制（倍速 / 扬声器·听筒 / 转文字）。
 *
 * ## 交互
 *  · 点整行 = 播放/暂停（同一时间只播一条，由 [VoicePlaybackController] 保证）；
 *  · 在波形上横向拖动 = 定位（按 x 比例 seek，播放中即时生效）；
 *  · 波形已播部分用主题色，未播部分半透明 —— 不需要额外的进度条。
 *
 * ## 波形数据
 * 服务端下发 `audio_waveform`（0–100，约 32 根）。空数组（老消息/异常值）画等高柱，
 * 不至于让气泡塌成一条线。波形是**纯展示**，不依赖解码音频。
 *
 * ## 转文字
 * 点「转文字」→ `POST /api/messages/:id/transcribe`（服务端缓存）。文字展开在
 * 波形下方，再点「收起」合上；失败由页面弹 toast，不在气泡里放错误态。
 */
@Composable
fun VoiceMessageBubble(
    msg: MessageRepository.MessageUi,
    controller: VoicePlaybackController,
    onTranscribe: suspend (Long) -> ApiResult<String>,
    onToast: (String) -> Unit,
    /** 长按气泡（引用 / 撤回）：菜单锚点由外层 Box 记录 */
    onLongPress: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = KTheme.colors
    val mine = msg.isMine
    val bg = if (mine) c.accent else c.surface
    val fg = if (mine) c.onAccent else c.textPrimary
    val activeBar = if (mine) c.onAccent else c.accentText
    val inactiveBar = if (mine) c.onAccent.copy(alpha = 0.35f) else c.textMuted.copy(alpha = 0.45f)
    val subFg = if (mine) c.onAccent.copy(alpha = 0.78f) else c.textSecondary

    val active = controller.currentId == msg.raw.id
    val playing = active && controller.isPlaying
    val totalMs = if (active && controller.durationMs > 0) controller.durationMs else msg.audioDurationMs
    val positionMs = if (active) controller.positionMs else 0L
    val progress = if (totalMs > 0) (positionMs.toFloat() / totalMs).coerceIn(0f, 1f) else 0f

    // 气泡宽度随时长增长（110dp → 220dp），短语音不至于过宽、长语音能拉开波形
    val width = (110f + 110f * (msg.audioDurationMs / 60_000f).coerceIn(0f, 1f)).dp

    var transcript by remember(msg.raw.id) {
        mutableStateOf(msg.audioText?.takeIf { it.isNotBlank() })
    }
    var showTranscript by remember(msg.raw.id) { mutableStateOf(false) }
    var transcribing by remember(msg.raw.id) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    Column(
        modifier = modifier
            .width(width)
            .clip(RoundedCornerShape(KRadius.row))
            .background(bg)
            // 点气泡 = 播放/暂停；长按 = 引用/撤回（与文字气泡同一套菜单）。
            // 下面那一行小字按钮是子节点，自己的点击会优先消费，不受这里影响。
            .combinedClickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = {
                    msg.audioUrl?.let { controller.toggle(msg.raw.id, it, msg.audioDurationMs) }
                },
                onLongClick = onLongPress,
            )
            .padding(horizontal = KSpacing.sm, vertical = KSpacing.xs),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
        ) {
            PlayPauseGlyph(playing = playing, tint = fg)
            Waveform(
                bars = msg.audioWaveform,
                progress = progress,
                activeColor = activeBar,
                inactiveColor = inactiveBar,
                modifier = Modifier.weight(1f),
                onSeek = { fraction -> controller.seekToFraction(fraction) },
            )
            Text(
                text = formatVoiceDuration(totalMs),
                style = KType.footnote,
                color = subFg,
            )
        }

        Spacer(Modifier.height(KSpacing.xxs))
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(KSpacing.sm),
        ) {
            Text(
                text = "${formatSpeed(controller.speed)}x",
                style = KType.tiny,
                color = subFg,
                modifier = Modifier.clickable { controller.cycleSpeed() },
            )
            Text(
                text = if (controller.speakerOn) "扬声器" else "听筒",
                style = KType.tiny,
                color = subFg,
                modifier = Modifier.clickable { controller.toggleSpeaker() },
            )
            Text(
                text = when {
                    transcribing -> "转写中…"
                    showTranscript -> "收起"
                    transcript != null -> "看文字"
                    else -> "转文字"
                },
                style = KType.tiny,
                color = if (mine) c.onAccent else c.accentText,
                modifier = Modifier.clickable(enabled = !transcribing) {
                    if (showTranscript) {
                        showTranscript = false
                        return@clickable
                    }
                    val ready = transcript
                    if (ready != null) {
                        showTranscript = true
                        return@clickable
                    }
                    scope.launch {
                        transcribing = true
                        when (val r = onTranscribe(msg.raw.id)) {
                            is ApiResult.Success -> {
                                transcript = r.data
                                showTranscript = r.data.isNotBlank()
                                if (!showTranscript) onToast("没有识别出文字")
                            }
                            is ApiResult.Failure -> onToast(r.error.displayMessage)
                        }
                        transcribing = false
                    }
                },
            )
        }

        if (showTranscript && transcript != null) {
            Spacer(Modifier.height(KSpacing.xxs))
            Text(
                text = transcript.orEmpty(),
                style = KType.caption,
                color = fg,
            )
        }
    }
}

/** 播放/暂停：纯 Canvas（项目图标集里没有 play/pause，手绘比引资源更可控） */
@Composable
private fun PlayPauseGlyph(playing: Boolean, tint: Color) {
    Canvas(modifier = Modifier.size(20.dp)) {
        val w = size.width
        val h = size.height
        if (playing) {
            val barW = w * 0.22f
            drawRoundRect(
                color = tint,
                topLeft = Offset(w * 0.22f, h * 0.18f),
                size = Size(barW, h * 0.64f),
                cornerRadius = androidx.compose.ui.geometry.CornerRadius(barW * 0.35f),
            )
            drawRoundRect(
                color = tint,
                topLeft = Offset(w * 0.56f, h * 0.18f),
                size = Size(barW, h * 0.64f),
                cornerRadius = androidx.compose.ui.geometry.CornerRadius(barW * 0.35f),
            )
        } else {
            val path = Path().apply {
                moveTo(w * 0.28f, h * 0.16f)
                lineTo(w * 0.82f, h * 0.5f)
                lineTo(w * 0.28f, h * 0.84f)
                close()
            }
            drawPath(path, tint)
        }
    }
}

/**
 * 波形：每根柱是圆角矩形；已播部分按 [progress] 换色。
 * 横向拖动映射为 0..1 的定位比例（拖动中即时 seek）。
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
    val values = remember(bars) {
        if (bars.isEmpty()) List(32) { 18 } else bars.map { it.coerceIn(4, 100) }
    }
    Canvas(
        modifier = modifier
            .height(26.dp)
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
        val barW = (slot * 0.55f).coerceAtLeast(1f)
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
    }
}

/** 0:07 / 1:23（与 QQ 一样只显示分:秒） */
internal fun formatVoiceDuration(ms: Int): String {
    val totalSeconds = (ms / 1000).coerceAtLeast(0)
    return "%d:%02d".format(totalSeconds / 60, totalSeconds % 60)
}

/** 1.0 / 1.5 / 2.0（去掉无意义的 .0 尾巴） */
internal fun formatSpeed(speed: Float): String =
    if (speed == speed.toInt().toFloat()) speed.toInt().toString() else speed.toString()
