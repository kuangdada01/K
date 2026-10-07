package top.kuangdada.k.nativeapp.ui

import android.content.Context
import android.os.Build
import android.util.Log
import android.view.WindowManager
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.*
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.dismiss
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import coil3.SingletonImageLoader
import coil3.compose.rememberAsyncImagePainter
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import top.kuangdada.k.core.designsystem.theme.KMotion
import top.kuangdada.k.core.designsystem.theme.KTheme
import top.kuangdada.k.core.designsystem.theme.LocalAnimationsEnabled
import top.kuangdada.k.nativeapp.ui.viewer.ZoomableImage
import top.kuangdada.k.nativeapp.ui.viewer.viewerImageRequest
import kotlin.math.abs

data class ImageViewerRequest(
    val images: List<String>,
    val index: Int,
    val headers: Map<String, String> = emptyMap(),
    val postId: Long? = null,
    val onClosed: ((Int) -> Unit)? = null,
    val origins: List<ViewerOrigin?> = emptyList(),
    val resolveOrigin: ((page: Int) -> ViewerOrigin?)? = null,
    val topInsetPx: Float = 0f,
)

val LocalImageViewerOpener = staticCompositionLocalOf<(ImageViewerRequest) -> Unit> { {} }

fun preloadViewerImage(context: Context, request: ImageViewerRequest) {
    val url = request.images.getOrNull(request.index) ?: return
    SingletonImageLoader.get(context).enqueue(viewerImageRequest(context, url, request.headers))
}

private enum class ViewerPhase { Opening, Ready, Closing }
private data class ImageTransform(val scale: Float = 1f, val offset: Offset = Offset.Zero)

/** A fresh clock per flight lets back interrupt an entrance from its actual visible frame. */
private class ViewerFlight(
    val from: Rect? = null,
    val to: Rect? = null,
    val fromRadius: Float = 0f,
    val toRadius: Float = 0f,
    val fromClipTop: Float = 0f,
    val toClipTop: Float = 0f,
    val fromAlpha: Float = 0f,
    val toAlpha: Float = 1f,
    val imageFromAlpha: Float = 0f,
) {
    val progress = Animatable(0f)
    val hasImage: Boolean get() = from != null && to != null
    fun eased(): Float = KMotion.standard.transform(progress.value.coerceIn(0f, 1f))
    fun rect(): Rect? = if (from != null && to != null) lerpRect(from, to, eased()) else null
    fun alpha(): Float = viewerTransitionAlpha(fromAlpha, toAlpha, progress.value)
}

/** The dialog owns immersive mode. Hiding the status bar here still resets the *activity's*
 *  statusBars inset system-wide, so the shell freezes that inset for as long as this overlay
 *  is up (LocalFrozenStatusBarInsets) — otherwise pages under the flight shift by a status
 *  bar height when the bars come back ("exit fullscreen, the feed jumps"). */
@Composable
fun ImageViewerOverlay(
    request: ImageViewerRequest,
    closing: Boolean,
    onRequestClose: () -> Unit,
    onClosed: (Int) -> Unit,
    onPageChanged: (Int) -> Unit = {},
) {
    if (request.images.isEmpty()) {
        LaunchedEffect(request) { onClosed(0) }
        return
    }
    Dialog(
        onDismissRequest = onRequestClose,
        properties = DialogProperties(
            dismissOnBackPress = true, dismissOnClickOutside = false,
            usePlatformDefaultWidth = false, decorFitsSystemWindows = false,
        ),
    ) {
        ViewerWindow()
        KTheme(darkTheme = true) {
            ViewerContent(request, closing, onRequestClose, onClosed, onPageChanged)
        }
    }
}

@Suppress("DEPRECATION")
@Composable
private fun ViewerWindow() {
    val view = LocalView.current
    DisposableEffect(view) {
        (view.parent as? DialogWindowProvider)?.window?.let { window ->
            window.setDimAmount(0f)
            window.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            window.setWindowAnimations(0)
            window.statusBarColor = android.graphics.Color.TRANSPARENT
            window.navigationBarColor = android.graphics.Color.TRANSPARENT
            if (Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = false
            WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightNavigationBars = false
                systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                hide(WindowInsetsCompat.Type.statusBars())
            }
        }
        onDispose { /* The activity keeps its own system-bar settings. */ }
    }
}

/**
 * 翻页速度估算器：吃**分页器自己的 delta 流**（[ViewerContent] 里 onPageScroll 的入参），
 * 在滚动窗口内求平均，符号与 `position` 一致（正 = 向后翻/下一张）。
 *
 * 为什么不用 ZoomableImage 传来的 VelocityTracker 原始速度：那是手指速度，而**拇指抬起
 * 时的回卷**会在最后几十毫秒塞进一段反向位移 —— 慢速滑动时它足以把速度方向整个翻转。
 * 真机日志（16:46~16:48，1440px 屏）实测：**85% 的松手原始速度方向与拖动方向相反**、
 * 幅度 400~9000 px/s，任何基于它的方向判定都会"左滑回上一张、右滑去下一张"。
 * 分页器 delta 流由 dispatchRawDelta 逐帧喂入，符号按构造一致，不会被抬手回卷翻转。
 */
private class PagerFlingEstimator {
    private val samples = ArrayDeque<Pair<Long, Float>>()

    fun add(nanos: Long, delta: Float) {
        samples.addLast(nanos to delta)
        val cutoff = nanos - WINDOW_NS
        while (samples.isNotEmpty() && samples.first().first < cutoff) samples.removeFirst()
    }

    /** 窗口内的平均速度（px/s）；样本不足或时间跨度太小时返回 0（= 按拖动距离结算）。 */
    fun velocity(): Float {
        if (samples.size < 2) return 0f
        val dtSec = (samples.last().first - samples.first().first) / 1e9f
        if (dtSec <= 1e-3f) return 0f
        var sum = 0f
        for ((_, delta) in samples) sum += delta
        return sum / dtSec
    }

    fun reset() = samples.clear()

    private companion object { const val WINDOW_NS = 120_000_000L }
}

@Composable
private fun ViewerContent(
    request: ImageViewerRequest,
    closing: Boolean,
    onRequestClose: () -> Unit,
    onClosed: (Int) -> Unit,
    onPageChanged: (Int) -> Unit,
) {
    val animationsEnabled = LocalAnimationsEnabled.current
    val scope = rememberCoroutineScope()
    val flingEstimator = remember { PagerFlingEstimator() }
    val closeCallback = rememberUpdatedState(onClosed)
    val requestCloseCallback = rememberUpdatedState(onRequestClose)
    val pager = rememberPagerState(initialPage = request.index.coerceIn(request.images.indices)) { request.images.size }
    var phase by remember { mutableStateOf(ViewerPhase.Opening) }
    var flight by remember { mutableStateOf(ViewerFlight()) }
    var container by remember { mutableStateOf(Rect.Zero) }
    var closingPage by remember { mutableIntStateOf(pager.currentPage) }
    val aspects = remember { mutableStateMapOf<Int, Float>() }
    val ready = remember { mutableStateMapOf<Int, Boolean>() }
    val transforms = remember { mutableStateMapOf<Int, ImageTransform>() }
    var dragOffset by remember { mutableStateOf(Offset.Zero) }
    var dragFraction by remember { mutableFloatStateOf(0f) }
    var dragPivot by remember { mutableStateOf<Offset?>(null) }
    var dragJob by remember { mutableStateOf<Job?>(null) }
    var pagerJob by remember { mutableStateOf<Job?>(null) }
    var gestureStartPage by remember { mutableIntStateOf(pager.currentPage) }
    var dismissStartOffset by remember { mutableStateOf<Offset?>(null) }

    fun origin(page: Int) = request.resolveOrigin?.invoke(page) ?: request.origins.getOrNull(page)
    fun target(page: Int) = fitRectIn(container, aspects[page] ?: origin(page)?.aspect)
    fun visibleRect(page: Int): Rect {
        val zoom = transforms[page] ?: ImageTransform()
        var rect = transformRect(target(page), container.center, zoom.scale, zoom.offset)
        val pageX = (page - pager.currentPage - pager.currentPageOffsetFraction) * container.width
        rect = transformRect(rect, container.center, 1f, Offset(pageX, 0f))
        return transformRect(rect, dragPivot?.plus(container.topLeft) ?: container.center,
            dismissScaleOf(dragFraction), dragOffset)
    }
    fun beginClose() {
        if (phase == ViewerPhase.Closing) return
        pagerJob?.cancel()
        dragJob?.cancel()
        closingPage = pager.currentPage
        val previous = flight
        val opening = phase == ViewerPhase.Opening
        val from = if (opening) previous.rect() ?: visibleRect(closingPage) else visibleRect(closingPage)
        val source = origin(closingPage)
        val destination = source?.rect?.takeIf { it.usableIn(container) }
        // Mid-swipe both pages are visible. Keep that composition intact and fade it out.
        val canFly = animationsEnabled && abs(pager.currentPageOffsetFraction) < 0.001f &&
            destination != null && from.width > 0f &&
            (aspects[closingPage] ?: source?.aspect) != null
        flight = ViewerFlight(
            from = if (canFly) from else null, to = if (canFly) destination else null,
            fromRadius = if (opening) previous.fromRadius * (1f - previous.eased()) else 0f,
            toRadius = source?.cornerRadiusPx ?: 0f,
            fromClipTop = container.top, toClipTop = maxOf(container.top, request.topInsetPx),
            fromAlpha = if (opening) previous.alpha() else dragAlphaOf(dragFraction),
            toAlpha = 0f,
            imageFromAlpha = if (opening && !previous.hasImage) previous.alpha() else 1f,
        )
        phase = ViewerPhase.Closing
        requestCloseCallback.value()
    }

    LaunchedEffect(pager.currentPage) { onPageChanged(pager.currentPage) }
    LaunchedEffect(closing) { if (closing) beginClose() }
    LaunchedEffect(phase) {
        when (phase) {
            ViewerPhase.Opening -> {
                withTimeoutOrNull(250L) { snapshotFlow { container.width }.first { it > 0f } }
                if (phase != ViewerPhase.Opening) return@LaunchedEffect
                val source = origin(pager.currentPage)
                val aspect = aspects[pager.currentPage] ?: source?.aspect
                val canFly = animationsEnabled && source?.rect?.usableIn(container) == true && aspect != null
                val next = ViewerFlight(
                    from = if (canFly) source?.rect else null,
                    to = if (canFly) fitRectIn(container, aspect) else null,
                    fromRadius = source?.cornerRadiusPx ?: 0f,
                    fromClipTop = maxOf(container.top, request.topInsetPx), toClipTop = container.top,
                )
                flight = next
                next.progress.animateTo(1f, tween(if (animationsEnabled) VIEWER_FLIGHT_MS else 0, easing = LinearEasing))
                if (phase != ViewerPhase.Opening) return@LaunchedEffect
                if (canFly) withTimeoutOrNull(100L) {
                    snapshotFlow { ready[pager.currentPage] == true }.first { it }
                }
                if (phase != ViewerPhase.Opening) return@LaunchedEffect
                // Always remove the flight image: otherwise zooming happens behind a still image.
                phase = ViewerPhase.Ready
            }
            ViewerPhase.Closing -> {
                flight.progress.animateTo(1f, tween(if (animationsEnabled) VIEWER_FLIGHT_MS else 0, easing = LinearEasing))
                withFrameNanos { }
                closeCallback.value(closingPage)
            }
            ViewerPhase.Ready -> Unit
        }
    }
    val gateToken = remember { Any() }
    DisposableEffect(phase) {
        if (phase != ViewerPhase.Ready) AnimationGate.begin(gateToken)
        onDispose { AnimationGate.end(gateToken) }
    }
    DisposableEffect(Unit) { onDispose { dragJob?.cancel(); pagerJob?.cancel() } }

    val flying = phase != ViewerPhase.Ready && flight.hasImage
    val page = if (phase == ViewerPhase.Closing) closingPage else pager.currentPage
    val position = pager.currentPage + pager.currentPageOffsetFraction
    Box(Modifier.fillMaxSize().onGloballyPositioned { container = it.boundsInWindow() }
        .semantics { dismiss { beginClose(); true } }) {
        Box(Modifier.fillMaxSize().graphicsLayer {
            alpha = if (phase == ViewerPhase.Ready) dragAlphaOf(dragFraction) else flight.alpha()
        }.background(Color.Black))
        HorizontalPager(
            state = pager, userScrollEnabled = false, beyondViewportPageCount = 1,
            modifier = Modifier.fillMaxSize().graphicsLayer {
                clip = true
                alpha = when {
                    flying -> 0f
                    phase == ViewerPhase.Opening -> flight.alpha()
                    phase == ViewerPhase.Closing -> flight.imageFromAlpha * (1f - flightMaskAlphaOf(flight.progress.value))
                    else -> 1f
                }
            },
        ) { index ->
            ZoomableImage(
                url = request.images[index], headers = request.headers,
                contentDescription = "第 " + (index + 1) + " 张图片",
                active = abs(position - index) < 0.999f, enabled = phase == ViewerPhase.Ready,
                onTap = { if (phase == ViewerPhase.Ready) beginClose() },
                onGestureStart = {
                    gestureStartPage = pager.currentPage
                    dismissStartOffset = null
                    flingEstimator.reset()
                },
                onDismissDrag = { dx, dy, fraction, down ->
                    if (phase == ViewerPhase.Ready) {
                        // A tap during spring-back must not freeze it. Take over only on an actual drag.
                        if (dismissStartOffset == null) {
                            dragJob?.cancel()
                            dismissStartOffset = dragOffset
                        }
                        val start = dismissStartOffset ?: Offset.Zero
                        dragOffset = start + Offset(dx, dy)
                        dragFraction = (start.y / container.height.coerceAtLeast(1f) + fraction).coerceAtLeast(0f)
                        if (dragPivot == null) dragPivot = down
                    }
                },
                onDismissEnd = { commit ->
                    if (phase == ViewerPhase.Ready) {
                        if (commit) beginClose() else {
                            val startOffset = dragOffset
                            val startFraction = dragFraction
                            dragJob = scope.launch {
                                animate(1f, 0f, animationSpec = tween<Float>(200, easing = KMotion.standard)) { t, _ ->
                                    dragOffset = startOffset * t; dragFraction = startFraction * t
                                }
                                dragPivot = null
                            }
                        }
                    }
                },
                onPageScroll = { delta ->
                    if (phase == ViewerPhase.Ready && request.images.size > 1) {
                        pagerJob?.cancel()
                        flingEstimator.add(System.nanoTime(), delta)
                        pager.dispatchRawDelta(delta)
                    } else 0f
                },
                onPageScrollEnd = { rawVelocity ->
                    if (phase == ViewerPhase.Ready && request.images.size > 1) {
                        // 原始速度为 0 的回调来自捏合/取消路径（ZoomableImage 显式传 0），
                        // 此时估算器里的旧样本不可信，直接按无速度结算
                        val velocity = if (rawVelocity == 0f) 0f else flingEstimator.velocity()
                        val next = viewerPageTarget(pager.currentPage + pager.currentPageOffsetFraction,
                            velocity, container.width, gestureStartPage, request.images.size)
                        Log.d(VIEWER_LOG_TAG, "pageTarget pos=${pager.currentPage + pager.currentPageOffsetFraction}" +
                            " v=$velocity px (raw=$rawVelocity) w=${container.width}px start=$gestureStartPage -> $next")
                        pagerJob?.cancel()
                        pagerJob = scope.launch {
                            pager.animateScrollToPage(next, animationSpec = tween(VIEWER_PAGE_SETTLE_MS, easing = KMotion.standard))
                        }
                    }
                },
                onZoomChanged = {},
                onTransform = { scale, offset -> transforms[index] = ImageTransform(scale, offset) },
                onImageAspect = { aspects[index] = it },
                onImageReady = { ready[index] = true },
                dismissOffset = { dragOffset }, dismissScale = { dismissScaleOf(dragFraction) },
                dismissPivot = { dragPivot }, modifier = Modifier.fillMaxSize(),
            )
        }
        FlyingImage(flying, flight, container, target(page), request.images[page], request.headers)
        if (request.images.size > 1) {
            Row(
                Modifier.align(Alignment.BottomCenter).padding(WindowInsets.navigationBars.asPaddingValues())
                    .padding(bottom = 22.dp).graphicsLayer {
                        alpha = if (phase == ViewerPhase.Ready) dragAlphaOf(dragFraction) else flight.alpha()
                    },
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                repeat(request.images.size) { index ->
                    Box(Modifier.size(4.dp).clip(CircleShape)
                        .background(Color.White.copy(alpha = if (index == page) 0.95f else 0.35f)))
                }
            }
        }
        if (phase != ViewerPhase.Ready) {
            Box(Modifier.fillMaxSize().pointerInput(Unit) {
                awaitPointerEventScope {
                    while (true) awaitPointerEvent().changes.forEach { it.consume() }
                }
            })
        }
    }
}

/** Draw-only geometry: the image is never measured again on each animation frame. */
@Composable
private fun FlyingImage(
    visible: Boolean, flight: ViewerFlight, container: Rect, imageRect: Rect,
    url: String, headers: Map<String, String>,
) {
    val context = LocalContext.current
    val request = remember(context, url, headers) { viewerImageRequest(context, url, headers) }
    // Kept alive in Ready phase, so exiting cannot introduce an empty first decode frame.
    val painter = rememberAsyncImagePainter(request)
    Canvas(Modifier.fillMaxSize()) {
        if (!visible || imageRect.width <= 0f || imageRect.height <= 0f) return@Canvas
        val rect = flight.rect()?.translate(-container.topLeft) ?: return@Canvas
        val t = flight.eased()
        val radius = flight.fromRadius + (flight.toRadius - flight.fromRadius) * t
        val cut = flight.fromClipTop + (flight.toClipTop - flight.fromClipTop) * t - container.top
        val top = maxOf(rect.top, cut)
        if (rect.width <= 0f || top >= rect.bottom) return@Canvas
        val scale = cropOverScaleOf(imageRect, rect)
        val w = imageRect.width * scale
        val h = imageRect.height * scale
        fun drawPhoto() {
            withTransform({ translate(rect.center.x - w / 2f, rect.center.y - h / 2f) }) {
                with(painter) { draw(Size(w, h)) }
            }
        }
        clipRect(rect.left, top, rect.right, rect.bottom) {
            if (radius > 0.5f) {
                val path = Path().apply { addRoundRect(RoundRect(rect, CornerRadius(radius))) }
                clipPath(path) { drawPhoto() }
            } else drawPhoto()
        }
    }
}

private fun Rect.usableIn(container: Rect): Boolean =
    left.isFinite() && top.isFinite() && right.isFinite() && bottom.isFinite() &&
        width > 1f && height > 1f && overlaps(container)

/** 按原图宽高比在 [container] 里 Fit 出来的矩形；宽高比未知时退回容器本身 */
internal fun fitRectIn(container: Rect, aspect: Float?): Rect {
    if (container.width <= 0f || container.height <= 0f) return container
    if (aspect == null || aspect <= 0f || !aspect.isFinite()) return container
    val containerAspect = container.width / container.height
    val w = if (aspect > containerAspect) container.width else container.height * aspect
    val h = if (aspect > containerAspect) container.width / aspect else container.height
    val left = container.left + (container.width - w) / 2f
    val top = container.top + (container.height - h) / 2f
    return Rect(left, top, left + w, top + h)
}

/** 矩形线性插值（t=0 → [a]，t=1 → [b]） */
internal fun lerpRect(a: Rect, b: Rect, t: Float): Rect {
    val f = t.coerceIn(0f, 1f)
    return Rect(
        a.left + (b.left - a.left) * f,
        a.top + (b.top - a.top) * f,
        a.right + (b.right - a.right) * f,
        a.bottom + (b.bottom - a.bottom) * f,
    )
}

/**
 * 「把按 [base] 布局的内容铺满 [rect]」的等比覆盖系数 —— 与 `ContentScale.Crop` 同一条规则：
 * 两轴各算放大倍数、取较大者（小了露边，大了才叫"裁着填满"）。
 *
 * 飞行图的绘制变换靠它把"按落位矩形布局、Crop 取景的内容"逐像素等价地变换到任意中间矩形上。
 * 这条规则只能有一份，单测（ViewerFlightGeometryTest）钉住它。
 */
internal fun cropOverScaleOf(base: Rect, rect: Rect): Float =
    maxOf(rect.width / base.width, rect.height / base.height)

/**
 * 把 [r] 按"绕 [pivot] 缩放 [scale] 倍、再位移 [translation]"变换。
 *
 * 与 `Modifier.graphicsLayer { scaleX/scaleY = scale; transformOrigin = pivot; translationX/Y = translation }`
 * 是同一个映射（`screen(q) = pivot + (q - pivot) × scale + translation`），
 * 退场起点靠它做到"与屏幕上看到的一模一样"。
 */
internal fun transformRect(r: Rect, pivot: Offset, scale: Float, translation: Offset): Rect {
    fun mapX(x: Float) = pivot.x + (x - pivot.x) * scale + translation.x
    fun mapY(y: Float) = pivot.y + (y - pivot.y) * scale + translation.y
    return Rect(mapX(r.left), mapY(r.top), mapX(r.right), mapY(r.bottom))
}
