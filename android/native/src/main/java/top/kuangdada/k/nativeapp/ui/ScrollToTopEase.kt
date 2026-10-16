package top.kuangdada.k.nativeapp.ui

import androidx.compose.foundation.MutatePriority
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp

/**
 * ============================================================
 * 双击「首页」滚回顶部的缓动动画（先快后慢）
 * ============================================================
 *
 * 2026-10-16 用户反馈：原来的 `animateScrollToItem(0)` **太快太生硬** —— 它内部是
 * 高刚度弹簧，长距离时几乎瞬移，看不出滚动过程。要求改成"先快后慢"的非线性动画。
 *
 * 为什么不直接 `animateScrollBy(distance, tween(...))`：`LazyList` 未测量项的高度
 * 不可知 —— 滚远了以后"到顶的真实像素距离"根本算不出来，只能拿可见项均高外推，
 * 估不准就会在结尾留下肉眼可见的残差跳变（估多了会中途顶死、估少了弹簧补跳）。
 *
 * 这里的实现是**每帧闭环重规划**的速度指数衰减：
 *  1. 目标速度 = 剩余距离 × [decayPerSecond]（封顶 [maxVelocityDpPerMs]）——
 *     起步快慢随距离走（先快），越接近顶部速度越低（后慢），收尾自然贴顶，无残差；
 *  2. "剩余距离"每帧从 [LazyListState.layoutInfo] 现算：item 0 可见后是**精确值**
 *     （firstVisibleItemScrollOffset），可见之前用可见项均高外推 —— 帖子卡片高度
 *     参差也无妨，闭环每帧自我修正，外推误差不会累积；
 *  3. 速度上限防超远距离第一帧瞬移一整屏：远距离呈"恒速冲刺 + 减速滑行"两段观感。
 *
 * 手势与并发：跑在 `scroll(MutatePriority.Default)` 里，用户手指一碰列表（拖拽同级
 * 优先级、后来者胜）动画立即让位，不会抢手势；连续双击时旧的 LaunchedEffect 协程
 * 被取消、从当前位置重启新一轮动画。
 */
suspend fun LazyListState.animateScrollToTopDecelerate(
    density: Density,
    /** 衰减系数（1/秒）：越大起步越猛、收尾越急。走完 95% 路程 ≈ 3/λ 秒（5 → 0.6s）。 */
    decayPerSecond: Float = 5f,
    /** 起步速度上限（dp/ms，按 density 转 px）：大致等于一次快速滑动的初速。 */
    maxVelocityDpPerMs: Float = 4.5f,
) {
    // 已经在顶部就没有可滚的（双击时列表贴顶是常态）
    if (firstVisibleItemIndex == 0 && firstVisibleItemScrollOffset == 0) return
    val maxVelocityPxPerMs = with(density) { maxVelocityDpPerMs.dp.toPx() }

    scroll(MutatePriority.Default) {
        val startNanos = withFrameNanos { it }
        var lastNanos = startNanos
        while (true) {
            val now = withFrameNanos { it }
            // 帧间隔（毫秒），兜底避免除零
            val dtMs = ((now - lastNanos) / 1_000_000f).coerceAtLeast(0.001f)
            lastNanos = now

            val remaining = estimateDistanceToTop()
            // 收尾：剩余不足 1px（item 0 可见后的精确残差）或 2s 保险丝超时 ——
            // 一次 scrollBy 滚到顶，越界部分会被 LazyList 钳在 0，肉眼无感
            if (remaining < 1f || now - startNanos > 2_000_000_000L) {
                scrollBy(-remaining)
                return@scroll
            }
            // 速度 = 剩余距离 × λ（指数衰减：先快后慢），封顶防远距离瞬移
            val velocityPxPerMs =
                (remaining * decayPerSecond / 1_000f).coerceAtMost(maxVelocityPxPerMs)
            scrollBy(-velocityPxPerMs * dtMs)
        }
    }
}

/**
 * 到列表顶部的剩余距离（px，恒为正）。
 * item 0 可见 → 精确值（其相对视口顶的偏移）；否则用可见项均高（含项间距）对
 * 未测量项外推 —— 反正每帧重算，外推误差不会累积。
 */
private fun LazyListState.estimateDistanceToTop(): Float {
    val info = layoutInfo
    val first = info.visibleItemsInfo.firstOrNull() ?: return 0f
    if (first.index == 0) return (-first.offset).toFloat()
    val avg = info.visibleItemsInfo.sumOf { it.size + info.mainAxisItemSpacing }.toFloat() /
        info.visibleItemsInfo.size
    // 当前绝对滚动位 ≈ 前面未测量项总高 + 本项已滚出视口的部分（offset ≤ 0）
    return avg * first.index - first.offset
}
