package top.kuangdada.k.core.designsystem.component

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import top.kuangdada.k.core.designsystem.theme.KMotion
import top.kuangdada.k.core.designsystem.theme.LocalAnimationsEnabled

/**
 * ============================================================
 * 「呼吸环」（M6）
 * ============================================================
 * 一圈缓慢向外扩散、同时淡出的描边圆 —— 用在语音房**在麦**的麦位上，
 * 让"这个房间有人在说话"这件事在静止画面里也看得出来。
 *
 * **它不是"谁在说话"**：本工程没有每个麦位的音量（`VoiceRoomController.PeerUi`
 * 只有 muted / listener / sharing / quality，`VoiceSession` 也没在远端音轨上挂
 * `AudioTrackSink`）。所以它表达的是**在麦状态**。等到有真实音量信号时，
 * 把 [progress] 换成"由音量驱动的 0..1"即可，半径与不透明度的映射不用动。
 *
 * 抽成独立组件而不是写在麦位里：StyleGuide 的动效专章要**演示同一个实现**
 * （照着抄一遍的示例等于没有验收价值），而语音房只是它现在唯一的真实调用点。
 *
 * @param ringSize 环的直径（一般比头像大一圈：环要能被看见，又不能挤到旁边的卡）
 * @param baseRadiusRatio 起始半径占半径的比例（< 1 表示从"贴着内容"开始扩散）
 * @param maxGrowth 一轮里最多再扩散多少（占半径比例）
 * @param maxAlpha 起始不透明度（扩散到最外圈时降到 0）
 */
@Composable
fun KBreathRing(
    color: Color,
    modifier: Modifier = Modifier,
    ringSize: Dp = 56.dp,
    strokeWidth: Dp = 1.5.dp,
    baseRadiusRatio: Float = 0.86f,
    maxGrowth: Float = 0.14f,
    maxAlpha: Float = 0.38f,
) {
    // 降级：系统要求不要动画时**连 InfiniteTransition 都不创建**（§3-3 的要求是"真的没有动画"）
    if (!LocalAnimationsEnabled.current) return

    val transition = rememberInfiniteTransition(label = "kBreath")
    val progress by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = KMotion.breath, easing = LinearEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "kBreathProgress",
    )

    Canvas(modifier = modifier.size(ringSize)) {
        val t = progress
        drawCircle(
            color = color.copy(alpha = color.alpha * maxAlpha * (1f - t)),
            radius = size.minDimension / 2f * (baseRadiusRatio + maxGrowth * t),
            style = Stroke(width = strokeWidth.toPx()),
        )
    }
}
