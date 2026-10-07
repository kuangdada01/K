package top.kuangdada.k.core.designsystem.motion

import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.Dp
import top.kuangdada.k.core.designsystem.theme.KMotion
import top.kuangdada.k.core.designsystem.theme.KMotionOffset
import top.kuangdada.k.core.designsystem.theme.LocalAnimationsEnabled

/**
 * ============================================================
 * 一次性入场（MotionEnterOnce）
 * ============================================================
 * 给**独占资源的重页面**用：语音房（WS + 麦克风 + 前台服务）、视频（ExoPlayer）、阅读器。
 *
 * **聊天页曾经也在这里，M7 移走了**：它的"独占资源"只有一条 SSE 订阅，而那是可多收集的
 * `SharedFlow`、连接不由组合持有 —— 列进来反而让它拿不到和其他二级页一样的左右转场
 * （见 AppShell 里 `isHeavyPage` 的注释）。判断标准要认准"真独占资源"。
 *
 * **为什么不用 `AnimatedVisibility` / `AnimatedContent` 做这些页面**：
 * 那两个 API 的转场要求新旧两屏**同时存在**于组合里（一个进场、一个出场）——
 * 对上面这些页面就等于**同一份独占资源被建两遍**（第二个 ExoPlayer、第二条 WS）。
 * 本包装只做"入场"，**没有出场动画**：离场一瞬间切走，正是我们想要的
 * （麦克风/解码器立刻释放，不做"淡出期间还占着设备"）。
 *
 * 位移与透明度都走 `graphicsLayer`（绘制期属性，不触发重新测量）；
 * `progress.value` 在 lambda 内读取，属于 Compose 的"延迟读取"，只重绘不重组。
 *
 * @param enabled 关掉时直接落到终态（配合 [LocalAnimationsEnabled] 的降级开关）
 * @param offsetY 起始下滑量，默认 [KMotionOffset.enterSlide]
 * @param fade 是否同时淡入。整页淡入会多一次离屏合成（一层全屏 buffer），
 *   低端机上不划算 —— 只要位移不够显眼时可传 `false`，用纯滑入换掉这次合成。
 */
@Composable
fun MotionEnterOnce(
    modifier: Modifier = Modifier,
    enabled: Boolean = LocalAnimationsEnabled.current,
    offsetY: Dp = KMotionOffset.enterSlide,
    fade: Boolean = true,
    content: @Composable () -> Unit,
) {
    // 关掉动效时初值就是终态：连第一帧的"从下方 16dp 开始"都不要出现
    val progress = remember { Animatable(if (enabled) 0f else 1f) }

    LaunchedEffect(enabled) {
        if (enabled) {
            progress.animateTo(targetValue = 1f, animationSpec = KMotion.spatial<Float>())
        } else {
            progress.snapTo(1f)
        }
    }

    Box(
        modifier = modifier.graphicsLayer {
            if (fade) {
                // 空间档有轻微过冲（阻尼比 0.85），alpha 需要夹一下：
                // 越过 1 的部分渲染上无意义，夹掉可以避免某些 ROM 上合成层的边缘瑕疵
                alpha = progress.value.coerceIn(0f, 1f)
            }
            translationY = (1f - progress.value) * offsetY.toPx()
        },
    ) {
        content()
    }
}

/**
 * 弹层**面板**的一次性上滑（遮罩的淡入由调用方负责，见 AppShell 的 AnimatedVisibility）。
 *
 * 为什么做成 Modifier 而不是像 [MotionEnterOnce] 那样包一层：弹层的面板本身已经有
 * `fillMaxWidth` / `clip` / `navigationBarsPadding` 一长串 modifier，再包一层 Box 会多一级
 * 布局、`contentAlignment` 的居中/靠底语义也会跟着变（弹层正好都依赖它）。
 * 直接挂在面板自己的 modifier 链上最不容易改错：
 *
 * ```
 * Column(modifier = Modifier.motionSheetEnter().fillMaxWidth()...) { ... }
 * ```
 *
 * @param enabled 关掉时面板直接到位（跟随系统"移除动画"）
 */
@Composable
fun Modifier.motionSheetEnter(
    offsetY: Dp = KMotionOffset.sheetSlide,
    enabled: Boolean = LocalAnimationsEnabled.current,
): Modifier {
    val progress = remember { Animatable(if (enabled) 0f else 1f) }

    LaunchedEffect(enabled) {
        if (enabled) {
            progress.animateTo(targetValue = 1f, animationSpec = KMotion.spatial<Float>())
        } else {
            progress.snapTo(1f)
        }
    }

    // 只动绘制期属性：弹层出现时不触发面板的重新测量
    return this.graphicsLayer {
        translationY = (1f - progress.value) * offsetY.toPx()
    }
}

