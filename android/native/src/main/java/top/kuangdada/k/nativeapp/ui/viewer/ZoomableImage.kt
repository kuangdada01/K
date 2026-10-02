package top.kuangdada.k.nativeapp.ui.viewer

import android.content.Context
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.VectorConverter
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.exponentialDecay
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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
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
import kotlin.math.sqrt

/**
 * ============================================================
 * 可缩放图片（图片查看器的**唯一**手势入口）
 * ============================================================
 * 这是重写版（原实现见 git 历史）。旧版在同一个节点上挂了**四个互相独立的手势检测器**
 * —— `transformable`（捏合/平移）+ 一个 `awaitEachGesture`（下拉关闭）+ 另一个
 * `awaitEachGesture`（只为了测速度）+ `detectTapGestures`（单击/双击/长按）——
 * 靠"谁先消费"碰运气。真机上的三种表现都能直接归因到它：
 *
 *  · **打架**：放大后横向拖动，`transformable` 与下拉关闭那个检测器同时想接管；
 *    被 `requestDisallowIntercept` 式的消费规则一搅，横向甩动有时平移、有时翻页、
 *    有时什么都不动。
 *  · **磁铁感 / 阻尼怪**：平移用的是**硬钳制**（`clampOffset` 直接 `coerceIn`）——
 *    手指越过图片边缘后画面纹丝不动，松手却"啪"地弹一下；越界既没有阻尼过程，
 *    也没有回弹动画，读起来就是"磁铁吸住了"。
 *  · **惯性无级差**：松手惯性靠"被动记录的指针速度"，而 `Velocity` 的单位是 **px/s**，
 *    旧代码却按 px/ms 去比（`velocity > 1.2f`）——那个阈值实际上永远不会被触发，
 *    所以"甩一下"经常等于"慢慢挪"。
 *
 * 现在只有**两个** `pointerInput`，职责互不重叠：
 *
 *  1. 本函数里的 `awaitEachGesture`：**一切拖动**（捏合 / 平移 / 边缘接力翻页 / 下拉关闭）——
 *     一个状态机在第一次超过触摸阈值时**锁定模式**，之后整段手势只走这一条路；
 *  2. `detectTapGestures`：单击 / 双击 / 长按。它不消费移动事件，与 1 天然共存。
 *
 * ## 边缘接力（WeChat 的核心手感）
 *
 * 放大后横向拖动：**先平移图片**；图片贴到边缘还继续拖，多余的位移**原样交给翻页器**
 * （[onPageScroll]），于是"一直往左滑"能从第 1 张平滑过渡到第 2 张，中间不需要先缩回 1x。
 * 这正是微信/系统相册的手感；旧版用的是 `userScrollEnabled = !zoomed`——放大态直接
 * **不允许翻页**，用户必须先双击缩回，读起来就是"翻页和缩放打架"。
 *
 * ## 本文件的两个约定（改之前先读）
 *
 *  · **所有动画状态只写、不在组合期读**：`scale` / `offset` 只在 `graphicsLayer{}`
 *    的 lambda 里读，所以手势每帧写它们**不触发重组**，只重绘这一层（掉帧的结构性前提）。
 *  · **速度单位是 px/s**（Compose `Velocity` 的定义），别再按 px/ms 写阈值。
 *
 * @param onTap 单击（"点一下关闭"）。**双击判定窗口过后才回调** —— 见 [detectTapGestures] 的注释。
 * @param onDismissDrag 未放大时的**向下**拖动：位移、下拉比例（dy ÷ 屏高）与按下点。
 *   比例与"关不关"的阈值刻意分开：轻轻一拖只缩一点点、背景只透一点点。
 * @param onDismissEnd 松手：commit = 是否达到关闭阈值。
 * @param onPageScroll 把横向位移交给翻页器（**正数 = 往后翻一页的方向**）；
 *   返回实际被吃掉的量（贴到第一张/最后一张时吃不下，返回 0）。
 * @param onPageScrollEnd 松手时的甩动速度（同上，正数 = 往后翻）。
 * @param onZoomChanged 是否处于放大态（宿主据此决定要不要让翻页器参与）。
 * @param onTransform 缩放/平移的实时数值：宿主用它算"退场飞行从哪一刻的矩形起步"。
 *   **在手势回调里同步上报**，不放 `LaunchedEffect`：平移不触发重组，靠重组上报会漏掉最后一次。
 * @param onImageAspect 这一张加载完成时的原图宽高比（宿主的落位矩形靠它）。
 */
@Composable
fun ZoomableImage(
    url: String,
    headers: Map<String, String>,
    contentDescription: String?,
    /** 这一页是不是用户当前正在看的那一页；变 false 时把缩放复位（微信：翻走再回来是 Fit） */
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
) {
    // —— 变换状态：只在绘制期读（见文件头第二条约定）——
    var scale by remember(url) { mutableFloatStateOf(1f) }
    var offset by remember(url) { mutableStateOf(Offset.Zero) }
    var containerSize by remember { mutableStateOf(IntSize.Zero) }
    /** 原图宽高比（加载完上报）：双击的"铺满"目标倍率靠它算 */
    var imageAspect by remember(url) { mutableStateOf<Float?>(null) }

    val scope = rememberCoroutineScope()
    /** 双击补间（新手指一落就取消） */
    var zoomJob by remember { mutableStateOf<Job?>(null) }
    /** 松手惯性 */
    var flingJob by remember { mutableStateOf<Job?>(null) }

    /** 长按保存的入口（Shell 提供；为 null 时静默无效） */
    val mediaOpener = rememberUpdatedState(LocalMediaSaveOpener.current)
    /** 回调都取最新一份：下面的 pointerInput 只在 url 变化时重启，捕获的是启动那一刻的 lambda */
    val tapCb = rememberUpdatedState(onTap)
    val dismissCb = rememberUpdatedState(onDismissDrag)
    val dismissEndCb = rememberUpdatedState(onDismissEnd)
    val pageCb = rememberUpdatedState(onPageScroll)
    val pageEndCb = rememberUpdatedState(onPageScrollEnd)
    val zoomCb = rememberUpdatedState(onZoomChanged)
    val transformCb = rememberUpdatedState(onTransform)
    val aspectCb = rememberUpdatedState(onImageAspect)

    val screenHeight = containerSize.height.toFloat().coerceAtLeast(1f)
    val dismissThreshold = screenHeight / DISMISS_COMMIT_FRACTION

    fun maxOffsetFor(s: Float): Offset {
        if (containerSize == IntSize.Zero) return Offset.Zero
        return Offset(
            (containerSize.width * (s - 1f)) / 2f,
            (containerSize.height * (s - 1f)) / 2f,
        ).let { Offset(it.x.coerceAtLeast(0f), it.y.coerceAtLeast(0f)) }
    }

    /** 硬钳制（**只用于落位**：惯性结束、双击落点、回弹目标） */
    fun clampHard(candidate: Offset, s: Float): Offset {
        val m = maxOffsetFor(s)
        return Offset(candidate.x.coerceIn(-m.x, m.x), candidate.y.coerceIn(-m.y, m.y))
    }

    /**
     * 拖动中的**越界阻尼**：越过边缘后每多拖 1px 只走 [OVERSCROLL_DAMP] px。
     *
     * 这是"磁铁感"的直接解药 —— 旧版用 [clampHard] 处理拖动，越过边缘后画面**完全不动**，
     * 手指和画面对不上，松手再"啪"地归位。有了阻尼，越界是"拉得动、但费劲"，
     * 松手由 [springBack] 弹回去 —— 与微信/系统相册一致。
     */
    fun dampBeyond(candidate: Offset, s: Float): Offset {
        val m = maxOffsetFor(s)
        fun axis(v: Float, limit: Float): Float = when {
            v > limit -> limit + (v - limit) * OVERSCROLL_DAMP
            v < -limit -> -limit + (v + limit) * OVERSCROLL_DAMP
            else -> v
        }
        return Offset(axis(candidate.x, m.x), axis(candidate.y, m.y))
    }

    fun report(s: Float, o: Offset) {
        zoomCb.value(s > ZOOMED_EPS)
        transformCb.value(s, o)
    }

    fun cancelAnims() {
        zoomJob?.cancel(); zoomJob = null
        flingJob?.cancel(); flingJob = null
    }

    /**
     * 翻走的那一页把缩放复位。
     *
     * 为什么需要：放大态可以靠**边缘接力**直接翻到下一张（见文件头），此时上一张还留在
     * 组合里、缩放也还在。不复位的话，用户滑回来看到的是一张**停在放大位置**的图 ——
     * 微信/系统相册都是"回来是 Fit"。复位发生在它已经滑出屏幕之后，看不见跳变。
     */
    LaunchedEffect(active) {
        if (!active && (scale > MIN_SCALE || offset != Offset.Zero)) {
            cancelAnims()
            scale = MIN_SCALE
            offset = Offset.Zero
            transformCb.value(scale, offset)
            zoomCb.value(false)
        }
    }

    /** 越界了才回弹（不越界就什么都不做，避免"松手又动一下"） */
    fun springBack() {
        val target = clampHard(offset, scale)
        if (target == offset) return
        val from = offset
        flingJob = scope.launch {
            try {
                animate(
                    initialValue = 0f,
                    targetValue = 1f,
                    animationSpec = KMotion.spatialBounded<Float>(),
                ) { t, _ ->
                    offset = Offset(
                        from.x + (target.x - from.x) * t,
                        from.y + (target.y - from.y) * t,
                    )
                    transformCb.value(scale, offset)
                }
            } finally {
                offset = target
                transformCb.value(scale, offset)
            }
        }
    }

    /**
     * 松手惯性（放大态、单指平移）：x / y 各自衰减、各自钳边。
     *
     * 单位是 **px/s**（Compose `Velocity` 的定义）—— 旧版按 px/ms 写阈值，
     * 于是"甩一下"的判定永远不成立。这里直接用真实速度驱动 `animateDecay`，
     * 快甩自然滑得远、慢放自然立刻停。
     */
    fun fling(velocity: Offset) {
        if (scale <= ZOOMED_EPS) return
        val m = maxOffsetFor(scale)
        if (m.x <= 0f && m.y <= 0f) return
        val start = offset
        flingJob = scope.launch {
            val x = Animatable(start.x, Float.VectorConverter)
            val y = Animatable(start.y, Float.VectorConverter)
            x.updateBounds(-m.x, m.x)
            y.updateBounds(-m.y, m.y)
            try {
                launch {
                    x.animateDecay(velocity.x, exponentialDecay()) {
                        offset = offset.copy(x = value)
                        transformCb.value(scale, offset)
                    }
                }
                launch {
                    y.animateDecay(velocity.y, exponentialDecay()) {
                        offset = offset.copy(y = value)
                        transformCb.value(scale, offset)
                    }
                }
            } finally {
                offset = clampHard(offset, scale)
                transformCb.value(scale, offset)
            }
        }
    }

    /**
     * 以 [focal] 为锚把倍率补间到 [targetScale]（双击）。
     *
     * **锚点保持不动**：`screen(q) = center + (q - center) × scale + offset`，
     * 要求放大后手指下那一点仍在原处，解出
     * `offset' = (focal - center) × (1 - target/current) + offset × (target/current)`，
     * 最后按边界硬钳制（落位必须合法）。
     *
     * 旧版是"把双击点**移到屏幕中心**"（`(center - position) * (target - 1)`）——
     * 手指下那一块会自己滑走，读起来就是"双击之后图跑偏了"。
     */
    fun animateZoomTo(targetScale: Float, focal: Offset, fromScale: Float, fromOffset: Offset) {
        val center = Offset(containerSize.width / 2f, containerSize.height / 2f)
        val ratio = if (fromScale <= 0f) 1f else targetScale / fromScale
        val targetOffset = clampHard(
            Offset(
                (focal.x - center.x) * (1f - ratio) + fromOffset.x * ratio,
                (focal.y - center.y) * (1f - ratio) + fromOffset.y * ratio,
            ),
            targetScale,
        )
        zoomCb.value(targetScale > ZOOMED_EPS)
        zoomJob = scope.launch {
            try {
                animate(
                    initialValue = 0f,
                    targetValue = 1f,
                    // 弹簧而不是固定曲线：双击途中再双击 / 捏合都能从当前帧接续（不用回到起点重播）
                    animationSpec = KMotion.spatialBounded<Float>(),
                ) { t, _ ->
                    scale = fromScale + (targetScale - fromScale) * t
                    offset = Offset(
                        fromOffset.x + (targetOffset.x - fromOffset.x) * t,
                        fromOffset.y + (targetOffset.y - fromOffset.y) * t,
                    )
                    transformCb.value(scale, offset)
                }
            } finally {
                scale = targetScale
                offset = targetOffset
                transformCb.value(scale, offset)
            }
        }
    }

    Box(
        modifier = modifier
            .fillMaxSize()
            .onSizeChanged { containerSize = it }
            .graphicsLayer {
                // ★ 只在绘制期读 scale/offset：手势每帧写它们不触发重组（见文件头约定）
                scaleX = scale
                scaleY = scale
                translationX = offset.x
                translationY = offset.y
            }
            /**
             * 单击 / 双击 / 长按。
             *
             * **单击要等双击窗口**：`detectTapGestures` 给的 `onTap` 本来就在
             * `doubleTapTimeout`（300ms）之后才回调 —— 这正是微信的行为（"点一下关闭"有
             * 一点点延迟，换来的是双击**零回弹**）。想"单击零延迟"就必须允许"关了再反悔"，
             * 那样双击必然先看到"图缩出去一截又弹回来"（这一条在旧版里被真机否掉过，
             * 别再试第二种）。[onDoubleTap] 因此不需要取消任何东西。
             */
            .pointerInput(url) {
                detectTapGestures(
                    onTap = { tapCb.value() },
                    onDoubleTap = { position ->
                        cancelAnims()
                        val fromScale = scale
                        val fromOffset = offset
                        if (fromScale > ZOOMED_EPS) {
                            animateZoomTo(MIN_SCALE, position, fromScale, fromOffset)
                        } else {
                            animateZoomTo(doubleTapTargetScale(imageAspect, containerSize), position, fromScale, fromOffset)
                        }
                    },
                    onLongPress = {
                        mediaOpener.value?.invoke(
                            MediaSaveTarget(url = url, kind = MediaKind.Image, headers = headers),
                        )
                    },
                )
            }
            /**
             * **一切拖动**：捏合 / 平移 / 边缘接力翻页 / 下拉关闭。
             *
             * 一个状态机，第一次超过触摸阈值时锁定模式，之后整段手势只走这一条路 ——
             * 不再有"两个检测器同时想接管"的打架。
             */
            .pointerInput(url) {
                val slop = TOUCH_SLOP_PX * density
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    cancelAnims()

                    var mode = DragMode.Undecided
                    var totalDx = 0f
                    var totalDy = 0f
                    /** 锁定模式之后已经消化掉的位移（判定阈值内的那一段不算，避免起手跳一下） */
                    var consumedDx = 0f
                    var consumedDy = 0f
                    var pagedOver = false
                    var multiTouch = false
                    val tracker = VelocityTracker()
                    tracker.addPosition(down.uptimeMillis, down.position)

                    while (true) {
                        val event = awaitPointerEvent()
                        val pressed = event.changes.filter { it.pressed }
                        if (pressed.isEmpty()) break

                        // —— 双指及以上：捏合（任何模式下都优先）——
                        if (pressed.size >= 2) {
                            multiTouch = true
                            if (mode != DragMode.Pinch) {
                                mode = DragMode.Pinch
                                cancelAnims()
                            }
                            val zoomChange = event.calculateZoom()
                            val panChange = event.calculatePan()
                            if (zoomChange != 1f || panChange != Offset.Zero) {
                                val next = (scale * zoomChange).coerceIn(MIN_SCALE, MAX_SCALE)
                                scale = next
                                // 捏合中允许轻微越界（松手回弹），不要硬钳制 —— 否则捏合边缘会"顶住"
                                offset = dampBeyond(offset + panChange, next)
                                transformCb.value(scale, offset)
                                zoomCb.value(next > ZOOMED_EPS)
                            }
                            event.changes.forEach { it.consume() }
                            continue
                        }

                        // —— 单指 ——
                        val change = event.changes.firstOrNull { it.id == down.id } ?: break
                        val delta = change.positionChange()
                        tracker.addPosition(change.uptimeMillis, change.position)
                        totalDx += delta.x
                        totalDy += delta.y

                        if (mode == DragMode.Undecided) {
                            if (sqrt(totalDx * totalDx + totalDy * totalDy) < slop) continue
                            mode = when {
                                // 放大态：任何方向都是平移
                                scale > ZOOMED_EPS -> DragMode.Pan
                                // 未放大：只认**向下**为下拉关闭（与微信/系统相册一致；上滑不动）
                                abs(totalDy) >= abs(totalDx) && totalDy > 0 -> DragMode.Dismiss
                                // 未放大：横向交给翻页器
                                abs(totalDx) > abs(totalDy) -> DragMode.Page
                                else -> DragMode.None
                            }
                            // 阈值内的位移不补给内容（否则起手会跳一下）
                            val skippedX = totalDx - delta.x
                            val skippedY = totalDy - delta.y
                            consumedDx = skippedX
                            consumedDy = skippedY
                        }

                        when (mode) {
                            DragMode.Pan -> {
                                val want = Offset(
                                    offset.x + (totalDx - consumedDx),
                                    offset.y + (totalDy - consumedDy),
                                )
                                consumedDx = totalDx
                                consumedDy = totalDy
                                val m = maxOffsetFor(scale)
                                // ★ 边缘接力：横向已经贴边、又继续往那边拖 → 多余的交翻页器
                                var nextX = want.x
                                if (want.x > m.x || want.x < -m.x) {
                                    val edge = if (want.x > m.x) m.x else -m.x
                                    val extra = want.x - edge
                                    nextX = edge
                                    // 手指往左（extra<0，即要往后翻）→ 翻页器的正向
                                    val consumedByPager = pageCb.value(-extra)
                                    if (consumedByPager != 0f) {
                                        pagedOver = true
                                    } else {
                                        nextX = want.x // 翻页器到顶了：这一轴仍按越界阻尼跟手
                                    }
                                } else if (pagedOver) {
                                    // 一旦交给过翻页器，这一轴在本段手势里就归它，避免来回抢
                                    nextX = clampHard(Offset(want.x, 0f), scale).x
                                }
                                offset = dampBeyond(Offset(nextX, want.y), scale)
                                transformCb.value(scale, offset)
                                change.consume()
                            }

                            DragMode.Dismiss -> {
                                val dy = totalDy - consumedDy
                                val dx = totalDx - consumedDx
                                consumedDy = totalDy
                                consumedDx = totalDx
                                dismissCb.value(dx, dy, (dy / screenHeight).coerceAtLeast(0f), down.position)
                                change.consume()
                            }

                            DragMode.Page -> {
                                val dx = totalDx - consumedDx
                                consumedDx = totalDx
                                pageCb.value(-dx) // 手指往左 = 往后翻
                                change.consume()
                            }

                            DragMode.Pinch, DragMode.None, DragMode.Undecided -> Unit
                        }
                    }

                    // —— 松手结算 ——
                    val velocity = tracker.calculateVelocity() // px/s
                    when (mode) {
                        DragMode.Pan -> {
                            val over = maxOffsetFor(scale)
                            val outOfBounds = abs(offset.x) > over.x + 0.5f || abs(offset.y) > over.y + 0.5f
                            if (outOfBounds) springBack() else fling(velocity)
                        }
                        DragMode.Dismiss -> {
                            val velocityY = if (multiTouch) 0f else velocity.y
                            val commit = totalDy > dismissThreshold || (totalDy > 0 && velocityY > FLING_VELOCITY_PX_S)
                            dismissEndCb.value(commit)
                        }
                        DragMode.Page -> {
                            if (pagedOver) {
                                pageCb.value(0f) // 收尾：没有位移，只用于让翻页器结算
                                pageEndCb.value(-velocity.x)
                            } else {
                                pageEndCb.value(-velocity.x)
                            }
                        }
                        else -> Unit
                    }
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        ViewerImage(
            url = url,
            headers = headers,
            contentDescription = contentDescription,
            onAspect = {
                imageAspect = it
                aspectCb.value(it)
            },
            modifier = Modifier.fillMaxSize(),
        )
    }
}

/** 单指拖动的落点模式：第一次超过触摸阈值时锁定，整段手势不再改（见 [ZoomableImage] 的注释） */
private enum class DragMode { Undecided, Pinch, Pan, Dismiss, Page, None }

/** 单张图片的加载（带鉴权头；`:core:data` 的私密图片/私信图片需要 JWT） */
@Composable
private fun ViewerImage(
    url: String,
    headers: Map<String, String>,
    contentDescription: String?,
    onAspect: (Float) -> Unit,
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
                // 用 painter 的口径上报宽高比（与缩略格登记那边同一份实现，不会出现第二套口径）
                state.painter.aspectOrNull()?.let(onAspect)
            },
            onError = { loading = false; failed = true },
        )
        if (loading) {
            CircularProgressIndicator(color = Color.White, modifier = Modifier.size(32.dp))
        }
        if (failed) {
            Text("图片加载失败", color = Color.White, style = KType.caption)
        }
    }
}

/**
 * 查看器里那张图的加载请求（**唯一一份**：飞行图与轮播都用它，才能共用同一条内存缓存）。
 *
 * ★★ 尺寸**不再用 `Size.ORIGINAL`**（这是"第一次打开掉帧"的主因之一）：
 * 原图全尺寸解码意味着 4000×3000 的相机片要解出 48MB 的位图，再整块上传成 GPU 纹理 ——
 * 即便解码在后台线程，纹理上传与随之而来的 GC 仍会顶掉动画的好几帧，而"第一次打开"
 * 恰好是唯一一次必须真的解码（第二次就命中内存缓存了，所以**只坏第一次**）。
 * 现在按**屏幕尺寸**解：够清楚（全屏 1:1 显示绰绰有余），内存与上传都降一个数量级。
 *
 * 其余刻意的选择：
 *  1. **不加 `crossfade`**：预解码已经把图备好，再淡入一次等于"打开时先虚一下"；
 *     视觉连续性由飞行本身提供（飞过来的那份就是同一张图）；
 *  2. 鉴权头走 `NetworkHeaders`（Coil 3 只认它，塞 Map 会编译失败 —— 这个坑在别处踩过）；
 *  3. **取图/解码走 [ImageLoading.immediate]**：它**就是**正在播的那个动画，
 *     不能被"动画期间加载让路"的闸门扣住（扣住了飞行途中就是一片空白）；
 *  4. **`placeholderMemoryCacheKey` = 缩略图那一张的键**（见 `thumbMemoryCacheKey`）：
 *     屏幕尺寸解码也要几十毫秒，没有占位图的话飞行前半程是空白的 ——
 *     真机表现就是"图突然变大一下"而不是"从那一格飞出来"。
 */
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
                headers.forEach { entry -> builder.set(entry.key, entry.value) }
                httpHeaders(builder.build())
            }
        }
        .build()

/**
 * 查看器的解码尺寸 = **屏幕物理分辨率**。
 *
 * 为什么不是 `Size.ORIGINAL`：见 [viewerImageRequest] 的注释（首次打开掉帧的主因）。
 * 为什么不是写死的常量：写小了在大屏上会糊，写大了在小屏上白吃内存。
 *
 * 必须是**确定性**的：预解码（[top.kuangdada.k.nativeapp.ui.preloadViewerImage]）与查看器
 * 各自调一次 [viewerImageRequest]，尺寸只要不一致，内存缓存键就不同 —— 预解码等于没做。
 * 这里统一从 `resources.displayMetrics` 取，两处拿到的是同一个值。
 */
private fun viewerDecodeSize(context: Context): Size {
    val dm = context.resources.displayMetrics
    val w = if (dm.widthPixels > 0) dm.widthPixels else 1080
    val h = if (dm.heightPixels > 0) dm.heightPixels else 1920
    // 竖屏时 widthPixels/heightPixels 已经是自然方向；旋转不重解（同一条缓存，够用）
    return Size(maxOf(w, h), maxOf(w, h))
}

/** 倍率上下限 */
internal const val MIN_SCALE = 1f
internal const val MAX_SCALE = 4f

/**
 * 超过这个倍率就算"放大态"。
 *
 * 用 1.01 而不是 1.0：`scale` 是浮点累乘出来的，静止时也可能落在 1.0000001 上，
 * 拿 `> 1f` 判断会让"1x"被当成放大态 —— 表现是未放大时横向拖动不翻页、下拉也不关闭。
 */
internal const val ZOOMED_EPS = 1.01f

/**
 * 越界拖动的阻尼系数（见 [ZoomableImage.dampBeyond]）：
 * 越过边缘后每多拖 1px，画面只走这么多。0.35 ≈ 拖三寸走一寸 ——
 * "拉得动，但明显费劲"，松手弹回。旧版这里是**硬钳制**（系数 0），
 * 也就是用户说的"磁铁感"。
 */
internal const val OVERSCROLL_DAMP = 0.35f

/**
 * 「双击铺满全屏」的 target 倍率（cover）。
 *
 * 图片比屏幕**相对更宽**（宽高比 > 屏幕宽高比）：Fit 时按宽贴边 → cover 要按高铺满，
 * 之后只有左右需要滑；相对更窄则上下滑。与屏幕同比例 → 1（本就全屏，双击不缩放）。
 * 宽高比还没量到时退回 [DOUBLE_TAP_FALLBACK_SCALE]。
 */
internal fun doubleTapTargetScale(imageAspect: Float?, containerSize: IntSize): Float {
    if (containerSize.width <= 0 || containerSize.height <= 0) return DOUBLE_TAP_FALLBACK_SCALE
    val cover = coverScaleOf(
        imageAspect ?: return DOUBLE_TAP_FALLBACK_SCALE,
        containerSize.width.toFloat(),
        containerSize.height.toFloat(),
    ) ?: return DOUBLE_TAP_FALLBACK_SCALE
    return cover.coerceIn(MIN_SCALE, MAX_SCALE)
}

/**
 * 「双击铺满全屏」的 cover 倍率（M5.9，用户实测微信的行为：双击后只有溢出的那个
 * 方向需要滑 —— 通常就是左右滑，不会上下滑）。
 *
 * 图片比屏幕**相对更宽**（宽高比 > 屏幕宽高比）：Fit 时按宽贴边 → cover 按高铺满，
 * 放大后左右滑；相对更窄：按宽铺满，上下滑。与屏幕同比例 → 1（本就全屏，双击不缩放）。
 * 返回 null = 比例/容器还没量到（调用方退回 [DOUBLE_TAP_FALLBACK_SCALE]）。
 */
internal fun coverScaleOf(imageAspect: Float, containerWidth: Float, containerHeight: Float): Float? {
    if (imageAspect <= 0f || !imageAspect.isFinite()) return null
    if (containerWidth <= 0f || containerHeight <= 0f) return null
    val screenAspect = containerWidth / containerHeight
    return if (imageAspect > screenAspect) imageAspect / screenAspect else screenAspect / imageAspect
}

/**
 * 双击的**兜底**目标倍率：只在原图宽高比还没量到（图未加载完）时用 ——
 * 正常情况双击目标 = 刚好铺满全屏的 cover 倍率（见 [doubleTapTargetScale]）。
 */
internal const val DOUBLE_TAP_FALLBACK_SCALE = 2.5f

/**
 * 下拉"要关闭"的阈值：**屏幕高的 1/6**（微信朋友圈那套 `movY > screenHeight / 6`）。
 *
 * ⚠️ 它**只决定"松手后关不关"**，不参与"拖的时候缩多少、背景多透" ——
 * 后两件事按屏高的**比例**算（见宿主里的 `dismissScaleOf` / `dragAlphaOf`）。
 * 早先两者绑在一起（阈值 80dp + `1 - 0.36 × (dy/阈值)`）：轻轻拖 80dp 图就缩到 0.64、
 * 背景只剩 20% 黑 —— 用户实测反馈"缩得太小、也太快"。
 */
private const val DISMISS_COMMIT_FRACTION = 6f

/**
 * 向下**快甩**也直接关闭的速度阈值，单位 **px/s**（Compose `Velocity` 的定义）。
 *
 * 旧版写的是 `1.2f` 并按 px/ms 理解 —— 实际单位是 px/s，这个阈值永远不可能达到，
 * 于是"快速下滑关闭"这条路径一直是死的（只有拖过 1/6 屏高才会关）。
 */
private const val FLING_VELOCITY_PX_S = 1200f

/** 锁定拖动模式前需要的位移（dp→px 在运行时乘 density） */
private const val TOUCH_SLOP_PX = 8f
