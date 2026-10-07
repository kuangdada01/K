package top.kuangdada.k.nativeapp.ui

import kotlin.math.abs

/** 查看器相关诊断日志的统一 tag（真机 logcat 过滤用） */
internal const val VIEWER_LOG_TAG = "KViewer"

internal const val MIN_DRAG_SCALE = 0.75f
internal const val MIN_DRAG_ALPHA = 0.5f
internal const val VIEWER_FLIGHT_MS = 250

/** 翻页滑动（松手后滑到目标页 / 弹回）的时长：220ms 太急看不清滑动过程，
 *  用户要求调慢 —— 320ms 能看清一整段滑动，又不至于拖沓。 */
internal const val VIEWER_PAGE_SETTLE_MS = 320

/** A deliberate flick (at or above this velocity) turns one page in its direction, like
 *  ViewPager2 — no need to drag past any fraction first. Measured on the *pager's own delta
 *  stream* (px/s, positive = toward the next page), NOT on the raw finger velocity: the
 *  thumb's lift-off curl reads as a short reverse burst that flips the raw sign on slow
 *  swipes (85% anti-correlated in field logs), so any raw-velocity rule misfires. */
internal const val VIEWER_FLICK_ADVANCE_PX_S = 1000f

/** 慢拖的提前翻页量：速度没到轻拂门槛的松手，拖过 0.35 页（0.5 − 0.15）就翻。
 *  0.5 的"最近页"规则对看图太钝 —— 拖 40% 弹回来就是用户说的"阻尼大、难滑到第二张"。 */
internal const val VIEWER_ADVANCE_BIAS = 0.15f

internal fun lerpCornerRadius(fromPx: Float, t: Float): Float =
    fromPx * (1f - t).coerceIn(0f, 1f)

internal fun dismissScaleOf(dragFraction: Float): Float =
    (1f - dragFraction).coerceIn(MIN_DRAG_SCALE, 1f)

internal fun dragAlphaOf(dragFraction: Float): Float =
    (1f - 2f * dragFraction).coerceIn(MIN_DRAG_ALPHA, 1f)

/** Black backdrop fades throughout the flight, independently of the image's easing. */
internal fun flightMaskAlphaOf(t: Float): Float {
    val f = t.coerceIn(0f, 1f)
    return f * f * (3f - 2f * f)
}

internal fun viewerMaskAlpha(transitioning: Boolean, maskT: Float, dragFraction: Float): Float =
    dragAlphaOf(dragFraction) * if (transitioning) flightMaskAlphaOf(maskT) else 1f

internal fun viewerTransitionAlpha(from: Float, to: Float, progress: Float): Float =
    from + (to - from) * flightMaskAlphaOf(progress)

/** A fling may complete at most one page from the page where this gesture began. */
internal fun viewerPageTarget(
    position: Float,
    velocityPx: Float,
    pageWidth: Float,
    startPage: Int,
    count: Int,
): Int {
    if (count <= 1) return 0
    val start = startPage.coerceIn(0, count - 1)
    val lo = (start - 1).coerceAtLeast(0)
    val hi = (start + 1).coerceAtMost(count - 1)
    // 轻拂：速度说了算（与拖动方向无关 —— 明确的回甩也尊重它），最多翻一格。
    if (abs(velocityPx) >= VIEWER_FLICK_ADVANCE_PX_S) {
        return (if (velocityPx > 0f) start + 1 else start - 1).coerceIn(lo, hi)
    }
    // 慢放：拖动距离说了算，朝拖动方向把翻页线提前 0.15 页（0.5 → 0.35）。
    val offset = position - start
    val steps = if (offset >= 0f) (offset + 0.5f + VIEWER_ADVANCE_BIAS).toInt()
    else -((-offset + 0.5f + VIEWER_ADVANCE_BIAS).toInt())
    return (start + steps).coerceIn(lo, hi)
}
