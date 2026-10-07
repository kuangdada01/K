package top.kuangdada.k.nativeapp.ui.viewer

import kotlin.math.max

internal const val MIN_SCALE = 1f
internal const val MAX_SCALE = 4f
internal const val ZOOMED_EPS = 1.01f
internal const val DOUBLE_TAP_FALLBACK_SCALE = 2.5f
internal const val OVERSCROLL_DAMP = 0.35f

internal data class ViewerSize(val width: Float, val height: Float)
internal data class ViewerOffset(val x: Float, val y: Float)
internal data class ViewerTransform(val scale: Float, val offset: ViewerOffset)

/** The actual image rectangle inside a centered ContentScale.Fit viewport. */
internal fun fittedImageSize(aspect: Float?, width: Float, height: Float): ViewerSize {
    if (width <= 0f || height <= 0f) return ViewerSize(0f, 0f)
    if (aspect == null || !aspect.isFinite() || aspect <= 0f) return ViewerSize(width, height)
    return if (aspect > width / height) ViewerSize(width, width / aspect)
    else ViewerSize(height * aspect, height)
}

internal fun imagePanBounds(aspect: Float?, width: Float, height: Float, scale: Float): ViewerOffset {
    val fitted = fittedImageSize(aspect, width, height)
    return ViewerOffset(
        max(0f, (fitted.width * scale - width) / 2f),
        max(0f, (fitted.height * scale - height) / 2f),
    )
}

internal fun clampImageOffset(offset: ViewerOffset, bounds: ViewerOffset): ViewerOffset = ViewerOffset(
    if (bounds.x == 0f) 0f else offset.x.coerceIn(-bounds.x, bounds.x),
    if (bounds.y == 0f) 0f else offset.y.coerceIn(-bounds.y, bounds.y),
)

/** Preserve the image point under the previous centroid, then translate with its movement. */
internal fun zoomAroundPoint(
    scale: Float,
    offset: ViewerOffset,
    targetScale: Float,
    focal: ViewerOffset,
    center: ViewerOffset,
    pan: ViewerOffset = ViewerOffset(0f, 0f),
): ViewerTransform {
    val next = targetScale.coerceIn(MIN_SCALE, MAX_SCALE)
    val ratio = next / scale.coerceAtLeast(MIN_SCALE)
    return ViewerTransform(
        next,
        ViewerOffset(
            (focal.x - center.x) * (1f - ratio) + offset.x * ratio + pan.x,
            (focal.y - center.y) * (1f - ratio) + offset.y * ratio + pan.y,
        ),
    )
}

internal fun coverScaleOf(imageAspect: Float, containerWidth: Float, containerHeight: Float): Float? {
    if (!imageAspect.isFinite() || imageAspect <= 0f) return null
    if (!containerWidth.isFinite() || !containerHeight.isFinite() || containerWidth <= 0f || containerHeight <= 0f) return null
    val screenAspect = containerWidth / containerHeight
    return if (imageAspect > screenAspect) imageAspect / screenAspect else screenAspect / imageAspect
}

internal fun doubleTapScaleOf(imageAspect: Float?, width: Float, height: Float): Float {
    val cover = imageAspect?.let { coverScaleOf(it, width, height) } ?: DOUBLE_TAP_FALLBACK_SCALE
    // A screen-shaped picture must still visibly enlarge on double tap.
    return (if (cover <= ZOOMED_EPS) DOUBLE_TAP_FALLBACK_SCALE else cover).coerceIn(MIN_SCALE, MAX_SCALE)
}
