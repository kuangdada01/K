package top.kuangdada.k.nativeapp.ui.viewer

import android.content.Context
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.exponentialDecay
import androidx.compose.animation.core.tween
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer

import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import coil3.network.NetworkHeaders
import coil3.network.httpHeaders
import coil3.request.ImageRequest
import coil3.size.Size
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import top.kuangdada.k.core.designsystem.theme.KMotion
import top.kuangdada.k.core.designsystem.theme.KType
import top.kuangdada.k.nativeapp.ui.ImageLoading
import top.kuangdada.k.nativeapp.ui.LocalMediaSaveOpener
import top.kuangdada.k.nativeapp.ui.MediaKind
import top.kuangdada.k.nativeapp.ui.MediaSaveTarget
import top.kuangdada.k.nativeapp.ui.aspectOrNull
import top.kuangdada.k.nativeapp.ui.thumbMemoryCacheKey
import kotlin.math.abs

/** Fullscreen input stays fixed while only the image beneath it is transformed. */
@Composable
fun ZoomableImage(
    url: String,
    headers: Map<String, String>,
    contentDescription: String?,
    active: Boolean,
    onTap: () -> Unit,
    onDismissDrag: (dx: Float, dy: Float, dragFraction: Float, downPosition: Offset) -> Unit,
    onDismissEnd: (commit: Boolean) -> Unit,
    onPageScroll: (scrollDelta: Float) -> Float,
    onPageScrollEnd: (velocityX: Float) -> Unit,
    onZoomChanged: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    onTransform: (scale: Float, offset: Offset) -> Unit = { _, _ -> },
    onImageAspect: (Float) -> Unit = {},
    enabled: Boolean = true,
    onGestureStart: () -> Unit = {},
    onImageReady: () -> Unit = {},
    dismissOffset: () -> Offset = { Offset.Zero },
    dismissScale: () -> Float = { 1f },
    dismissPivot: () -> Offset? = { null },
) {
    var scale by remember(url) { mutableFloatStateOf(MIN_SCALE) }
    var offset by remember(url) { mutableStateOf(Offset.Zero) }
    var containerSize by remember { mutableStateOf(IntSize.Zero) }
    var imageAspect by remember(url) { mutableStateOf<Float?>(null) }
    var motionJob by remember { mutableStateOf<Job?>(null) }
    var longPressHandled by remember(url) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val mediaOpener = rememberUpdatedState(LocalMediaSaveOpener.current)
    val tapCb = rememberUpdatedState(onTap)
    val dismissCb = rememberUpdatedState(onDismissDrag)
    val dismissEndCb = rememberUpdatedState(onDismissEnd)
    val pageCb = rememberUpdatedState(onPageScroll)
    val pageEndCb = rememberUpdatedState(onPageScrollEnd)
    val zoomCb = rememberUpdatedState(onZoomChanged)
    val transformCb = rememberUpdatedState(onTransform)
    val aspectCb = rememberUpdatedState(onImageAspect)
    val gestureStartCb = rememberUpdatedState(onGestureStart)
    val imageReadyCb = rememberUpdatedState(onImageReady)
    val latestHeaders = rememberUpdatedState(headers)

    fun bounds(s: Float): Offset = imagePanBounds(
        imageAspect, containerSize.width.toFloat(), containerSize.height.toFloat(), s,
    ).asOffset()

    fun clamp(candidate: Offset, s: Float): Offset {
        val limit = bounds(s)
        return clampImageOffset(candidate.asViewerOffset(), limit.asViewerOffset()).asOffset()
    }

    fun damp(candidate: Offset, s: Float): Offset {
        val limit = bounds(s)
        fun axis(value: Float, edge: Float): Float = when {
            value > edge -> edge + (value - edge) * OVERSCROLL_DAMP
            value < -edge -> -edge + (value + edge) * OVERSCROLL_DAMP
            else -> value
        }
        return Offset(axis(candidate.x, limit.x), axis(candidate.y, limit.y))
    }

    fun report() {
        transformCb.value(scale, offset)
        zoomCb.value(scale > ZOOMED_EPS)
    }

    fun stopMotion() {
        motionJob?.cancel()
        motionJob = null
    }

    fun animateTransform(targetScale: Float, targetOffset: Offset) {
        stopMotion()
        val fromScale = scale
        val fromOffset = offset
        motionJob = scope.launch {
            animate(0f, 1f, animationSpec = tween(KMotion.medium, easing = KMotion.standard)) { progress, _ ->
                scale = fromScale + (targetScale - fromScale) * progress
                offset = fromOffset + (targetOffset - fromOffset) * progress
                report()
            }
            // Cancellation keeps the last drawn frame, so a new gesture never jumps.
            scale = targetScale
            offset = targetOffset
            report()
        }
    }

    fun settleImage(velocity: Offset = Offset.Zero) {
        val target = clamp(offset, scale)
        if ((target - offset).getDistance() > 0.5f) {
            animateTransform(scale, target)
        } else if (scale > ZOOMED_EPS && velocity.getDistance() > 50f) {
            stopMotion()
            val limit = bounds(scale)
            val start = target
            motionJob = scope.launch {
                val x = Animatable(start.x)
                val y = Animatable(start.y)
                x.updateBounds(-limit.x, limit.x)
                y.updateBounds(-limit.y, limit.y)
                launch {
                    x.animateDecay(velocity.x, exponentialDecay()) {
                        offset = offset.copy(x = value)
                        report()
                    }
                }
                launch {
                    y.animateDecay(velocity.y, exponentialDecay()) {
                        offset = offset.copy(y = value)
                        report()
                    }
                }
            }
        } else {
            offset = target
            report()
        }
    }

    LaunchedEffect(active) {
        if (!active) {
            stopMotion()
            scale = MIN_SCALE
            offset = Offset.Zero
            report()
        }
    }
    LaunchedEffect(enabled) {
        if (!enabled) stopMotion()
    }

    Box(
        modifier = modifier
            .fillMaxSize()
            .clipToBounds()
            .onSizeChanged { containerSize = it }
            .pointerInput(url, enabled) {
                if (!enabled) return@pointerInput
                detectTapGestures(
                    onTap = { tapCb.value() },
                    onDoubleTap = { focal ->
                        stopMotion()
                        val target = if (scale > ZOOMED_EPS) MIN_SCALE
                        else doubleTapTargetScale(imageAspect, containerSize)
                        val next = zoomAroundPoint(
                            scale, offset.asViewerOffset(), target, focal.asViewerOffset(),
                            ViewerOffset(size.width / 2f, size.height / 2f),
                        )
                        animateTransform(next.scale, clamp(next.offset.asOffset(), next.scale))
                    },
                    onLongPress = {
                        longPressHandled = true
                        mediaOpener.value?.invoke(MediaSaveTarget(url, MediaKind.Image, latestHeaders.value))
                    },
                )
            }
            .pointerInput(url, enabled) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    if (!enabled) {
                        down.consume()
                        do {
                            val event = awaitPointerEvent()
                            event.changes.forEach { it.consume() }
                        } while (event.changes.any { it.pressed })
                        return@awaitEachGesture
                    }
                    stopMotion()
                    longPressHandled = false
                    gestureStartCb.value()
                    val slop = viewConfiguration.touchSlop
                    var mode = DragMode.Undecided
                    var primaryId = down.id
                    var total = Offset.Zero
                    var dismissOrigin = Offset.Zero
                    var hadPinch = false
                    var pagerMoved = false
                    var tracker = VelocityTracker().apply { addPosition(down.uptimeMillis, down.position) }

                    try {
                        while (true) {
                            val event = awaitPointerEvent()
                            val pressed = event.changes.filter { it.pressed }
                            if (pressed.isEmpty()) break
                            if (longPressHandled) {
                                event.changes.forEach { it.consume() }
                                continue
                            }

                            if (pressed.size >= 2) {
                                // Finish an existing pager/dismiss gesture before changing ownership.
                                if (mode == DragMode.Dismiss) dismissEndCb.value(false)
                                if (mode == DragMode.Page || pagerMoved) {
                                    pageEndCb.value(0f)
                                    pagerMoved = false
                                }
                                mode = DragMode.Pinch
                                hadPinch = true
                                val next = zoomAroundPoint(
                                    scale, offset.asViewerOffset(), scale * event.calculateZoom(),
                                    event.calculateCentroid(useCurrent = false).asViewerOffset(),
                                    ViewerOffset(size.width / 2f, size.height / 2f),
                                    event.calculatePan().asViewerOffset(),
                                )
                                scale = next.scale
                                offset = clamp(next.offset.asOffset(), scale)
                                report()
                                event.changes.forEach { it.consume() }
                                continue
                            }

                            val change = pressed.firstOrNull { it.id == primaryId } ?: pressed.first().also {
                                primaryId = it.id
                                tracker = VelocityTracker()
                            }
                            val delta = change.positionChange()
                            tracker.addPosition(change.uptimeMillis, change.position)
                            total += delta
                            if (mode == DragMode.Pinch) mode = DragMode.Pan
                            var movement = delta
                            if (mode == DragMode.Undecided) {
                                val distance = total.getDistance()
                                if (distance < slop) continue
                                mode = when {
                                    scale > ZOOMED_EPS -> DragMode.Pan
                                    abs(total.x) > abs(total.y) -> DragMode.Page
                                    total.y > 0f -> DragMode.Dismiss
                                    else -> DragMode.None
                                }
                                // Start at the slop boundary, preserving only excess movement.
                                val slopOffset = total * (slop / distance)
                                movement = total - slopOffset
                                dismissOrigin = slopOffset
                            }

                            when (mode) {
                                DragMode.Pan -> {
                                    val wanted = offset + movement
                                    val limit = bounds(scale)
                                    val horizontal = abs(total.x) > abs(total.y)
                                    val extra = wanted.x - wanted.x.coerceIn(-limit.x, limit.x)
                                    val consumed = if (horizontal && !hadPinch && extra != 0f) pageCb.value(-extra) else 0f
                                    if (consumed != 0f) {
                                        offset = clamp(wanted, scale)
                                        pagerMoved = true
                                        mode = DragMode.Page
                                    } else {
                                        offset = damp(wanted, scale)
                                    }
                                    report()
                                    change.consume()
                                }
                                DragMode.Page -> {
                                    if (pageCb.value(-movement.x) != 0f) pagerMoved = true
                                    change.consume()
                                }
                                DragMode.Dismiss -> {
                                    val drag = total - dismissOrigin
                                    dismissCb.value(drag.x, drag.y.coerceAtLeast(0f), (drag.y / size.height.coerceAtLeast(1)).coerceAtLeast(0f), down.position)
                                    change.consume()
                                }
                                DragMode.None -> change.consume()
                                else -> Unit
                            }
                        }

                        val velocity = tracker.calculateVelocity()
                        when (mode) {
                            DragMode.Page -> {
                                pageEndCb.value(-velocity.x)
                                pagerMoved = false
                            }
                            DragMode.Dismiss -> {
                                val distance = (total - dismissOrigin).y
                                dismissEndCb.value(distance > size.height / 6f || (distance > slop && velocity.y > 1200f))
                            }
                            DragMode.Pan -> settleImage(if (hadPinch) Offset.Zero else Offset(velocity.x, velocity.y))
                            DragMode.Pinch -> settleImage()
                            else -> Unit
                        }
                    } finally {
                        // Even pointer cancellation must settle a partially moved pager.
                        if (pagerMoved) pageEndCb.value(0f)
                    }
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.fillMaxSize().graphicsLayer {
            val dismiss = dismissOffset()
            val shrink = dismissScale()
            val pivot = dismissPivot()
            scaleX = shrink
            scaleY = shrink
            translationX = dismiss.x
            translationY = dismiss.y
            transformOrigin = if (pivot != null && size.width > 0f && size.height > 0f) {
                TransformOrigin(pivot.x / size.width, pivot.y / size.height)
            } else TransformOrigin.Center
        }) {
            ViewerImage(
                url = url,
                headers = headers,
                contentDescription = contentDescription,
                onAspect = {
                    imageAspect = it
                    aspectCb.value(it)
                },
                onReady = { imageReadyCb.value() },
                modifier = Modifier.fillMaxSize().graphicsLayer {
                    scaleX = scale
                    scaleY = scale
                    translationX = offset.x
                    translationY = offset.y
                },
            )
        }
    }
}

private enum class DragMode { Undecided, Pinch, Pan, Dismiss, Page, None }
private fun Offset.asViewerOffset() = ViewerOffset(x, y)
private fun ViewerOffset.asOffset() = Offset(x, y)

@Composable
private fun ViewerImage(
    url: String,
    headers: Map<String, String>,
    contentDescription: String?,
    onAspect: (Float) -> Unit,
    onReady: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    var loading by remember(url) { mutableStateOf(true) }
    var failed by remember(url) { mutableStateOf(false) }
    val request = remember(context, url, headers) { viewerImageRequest(context, url, headers) }
    Box(modifier = modifier, contentAlignment = Alignment.Center) {
        AsyncImage(
            model = request,
            contentDescription = contentDescription,
            contentScale = ContentScale.Fit,
            modifier = Modifier.fillMaxSize(),
            onSuccess = { state ->
                loading = false
                failed = false
                state.painter.aspectOrNull()?.let(onAspect)
                onReady()
            },
            onError = {
                loading = false
                failed = true
                onReady()
            },
        )
        if (loading) CircularProgressIndicator(color = Color.White, modifier = Modifier.size(32.dp))
        if (failed) Text("图片加载失败", color = Color.White, style = KType.caption)
    }
}

fun viewerImageRequest(context: Context, url: String, headers: Map<String, String>): ImageRequest =
    ImageRequest.Builder(context)
        .data(url)
        .size(viewerDecodeSize(context))
        .fetcherCoroutineContext(ImageLoading.immediate)
        .decoderCoroutineContext(ImageLoading.immediate)
        .placeholderMemoryCacheKey(thumbMemoryCacheKey(url))
        .apply {
            if (headers.isNotEmpty()) {
                val builder = NetworkHeaders.Builder()
                headers.forEach { (name, value) -> builder.set(name, value) }
                httpHeaders(builder.build())
            }
        }
        .build()

private fun viewerDecodeSize(context: Context): Size {
    val metrics = context.resources.displayMetrics
    val width = metrics.widthPixels.takeIf { it > 0 } ?: 1080
    val height = metrics.heightPixels.takeIf { it > 0 } ?: 1920
    return Size(maxOf(width, height), maxOf(width, height))
}

internal fun doubleTapTargetScale(imageAspect: Float?, containerSize: IntSize): Float =
    doubleTapScaleOf(imageAspect, containerSize.width.toFloat(), containerSize.height.toFloat())
