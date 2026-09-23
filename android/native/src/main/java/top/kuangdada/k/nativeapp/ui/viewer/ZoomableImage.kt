package top.kuangdada.k.nativeapp.ui.viewer

import android.content.Context
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
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
import top.kuangdada.k.core.designsystem.theme.KType
import top.kuangdada.k.nativeapp.ui.ImageLoading
import top.kuangdada.k.nativeapp.ui.LocalMediaSaveOpener
import top.kuangdada.k.nativeapp.ui.MediaKind
import top.kuangdada.k.nativeapp.ui.MediaSaveTarget
import top.kuangdada.k.nativeapp.ui.aspectOrNull
import top.kuangdada.k.nativeapp.ui.thumbMemoryCacheKey
import kotlin.math.abs

/**
 * ============================================================
 * 可缩放图片（图片查看器的手势核心）
 * ============================================================
 * 与旧 WebView 版的 `ZoomableImageView`（447 行原生 View）以及网页层
 * `useImagePinchZoom` 是**同一套语义**，换到 Compose：
 * - 双指捏合缩放 **1x–4x**，围绕捏合中点、跟手；
 * - 放大后单指拖动平移，**边缘钳制**（不露黑边）；
 * - 双击：以双击点为锚放大到 2.5x，已放大则缩回 1x（带缓动）；
 * - 单击退出（双击窗口内没有第二下）。
 *
 * @param onSingleTap 单击回调（"点一下退出"）
 * @param onDragDismiss 1x 下纵向下拉的位移、**下拉比例**与**按下点**（局部坐标）。
 *   · **dragFraction = dy ÷ 屏幕高**（向下为正，向上恒为 0）：宿主用它驱动"越拉越小"的缩放
 *     与背景变透（见 `dismissScaleOf` / `dragAlphaOf`）—— 比例与"关不关"的阈值**刻意分开**，
 *     这样轻轻一拖只缩一点点；也刻意不做 0..1 截断，拉过 1/6 之后仍然继续缩小。
 *   · **按下点**是缩放原点：宿主用它把"手指抓住的那块画面"钉在手指下，
 *     而不是绕屏幕中心缩（绕中心缩会有一点点"画面在指头底下溜走"的感觉）。
 * @param onDragDismissEnd 松手：commit = 是否达到关闭阈值（屏高 1/6 或向下快甩）
 * @param onZoomChanged 放大态变化（宿主据此决定要不要把横向手势让给翻页器）
 * @param onTransform 缩放/平移的实际数值（宿主用它算"退场飞行从哪儿起步"）。
 *   在**手势回调里同步上报**，不放在 `LaunchedEffect` 里：平移（pan）不触发重组，
 *   靠重组上报会漏掉最后一次，退场起点就会与屏幕上看到的不一致。
 * @param onImageAspect 这一张**加载完成**时的原图宽高比。
 *   宿主（全屏查看器）用它算"落位矩形"—— 那个矩形必须与这里 `ContentScale.Fit` 的取景一致，
 *   否则进场飞行的末帧与轮播会差一下（"图片缩了一下"）。它也是登记表之外唯一的兜底来源：
 *   这里报的是**屏幕上真正显示的那张图**的比例，与"从哪一格点开"无关。
 */
@Composable
fun ZoomableImage(
    url: String,
    headers: Map<String, String>,
    contentDescription: String?,
    onSingleTap: () -> Unit,
    onDragDismiss: (dx: Float, dy: Float, dragFraction: Float, downPosition: Offset) -> Unit,
    onDragDismissEnd: (commit: Boolean) -> Unit,
    onZoomChanged: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    onTransform: (scale: Float, offset: Offset) -> Unit = { _, _ -> },
    onImageAspect: (Float) -> Unit = {},
) {
    var scale by remember(url) { mutableFloatStateOf(1f) }
    var offset by remember(url) { mutableStateOf(Offset.Zero) }
    var containerSize by remember { mutableStateOf(IntSize.Zero) }
    /**
     * 「保存到相册」的入口（Shell 提供）；为 null 时长按照旧无效，不报错。
     *
     * 用 [rememberUpdatedState] 包一层：下面那个 `pointerInput` 的协程只在 `(url, scale)`
     * 变化时才重启，捕获的是**启动那一刻**的 lambda；而 Shell 每次重组都给一个新的
     * opener 实例。存 State 而不是存值，长按时才读到最新的那一个。
     */
    val mediaOpener = rememberUpdatedState(LocalMediaSaveOpener.current)

    /**
     * 屏幕高度（px）—— 下拉相关的**两套比例都按它算**（见 [DISMISS_COMMIT_FRACTION] 与 `dragFraction`）。
     */
    val screenHeight = containerSize.height.toFloat().coerceAtLeast(1f)

    /**
     * 下拉关闭的**提交阈值**：屏幕高的 1/6（参考微信那套 `FriendCircleView`：`movY > screenHeight / 6`），
     * 或者向下快速甩（[FLING_VELOCITY]）。两者满足其一即关闭。
     *
     * ⚠️ 这个阈值**只决定"松手后关不关"**，不参与"拖的时候缩多少、背景多透" ——
     * 那两件事按 [screenHeight] 的**比例**算（见 `dragFraction` 与宿主的 `dismissScaleOf`）。
     * 早先两者是绑在一起的（阈值 80dp + `1 - 0.36 × (dy/阈值)`）：轻轻拖 80dp 图片就缩到 0.64、
     * 背景只剩 20% 黑 —— 用户实测反馈"缩得太小、也太快"，就是这么来的。
     */
    val dismissThreshold = screenHeight / DISMISS_COMMIT_FRACTION

    /** 把平移限制在图片范围内（放大后不露黑边） */
    fun clampOffset(candidate: Offset, currentScale: Float): Offset {
        if (currentScale <= 1f || containerSize == IntSize.Zero) return Offset.Zero
        val maxX = (containerSize.width * (currentScale - 1f)) / 2f
        val maxY = (containerSize.height * (currentScale - 1f)) / 2f
        return Offset(
            x = candidate.x.coerceIn(-maxX, maxX),
            y = candidate.y.coerceIn(-maxY, maxY),
        )
    }

    val transformable = rememberTransformableState { zoomChange, panChange, _ ->
        val next = (scale * zoomChange).coerceIn(MIN_SCALE, MAX_SCALE)
        scale = next
        offset = clampOffset(offset + panChange, next)
        onZoomChanged(next > ZOOMED_EPS)
        onTransform(next, offset)
    }

    // 下拉关闭只在 1x 生效；放大态下纵向拖动属于"看图片的上/下部分"
    val canDismiss = scale <= ZOOMED_EPS

    Box(
        modifier = modifier
            .fillMaxSize()
            .onSizeChanged { containerSize = it }
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
                translationX = offset.x
                translationY = offset.y
            }
            .then(
                if (canDismiss) {
                    Modifier.pointerInput(url) {
                        awaitEachGesture {
                            val down = awaitFirstDown(requireUnconsumed = false)
                            var dy = 0f
                            var dx = 0f
                            var locked: Boolean? = null
                            val tracker = VelocityTracker()
                            tracker.addPosition(down.uptimeMillis, down.position)

                            while (true) {
                                val event = awaitPointerEvent()
                                val change = event.changes.firstOrNull { it.id == down.id } ?: break
                                if (!change.pressed) break
                                tracker.addPosition(change.uptimeMillis, change.position)
                                val delta = change.positionChange()
                                dx += delta.x
                                dy += delta.y
                                // 首次超过触摸阈值时锁定轴向：竖直 = 下拉关闭，
                                // 水平 = 让给翻页器（不消费、不拦截）
                                if (locked == null && (abs(dx) > TOUCH_SLOP || abs(dy) > TOUCH_SLOP)) {
                                    locked = if (abs(dy) >= abs(dx)) true else false
                                    if (locked == false) return@awaitEachGesture
                                }
                                if (locked == true) {
                                    change.consume()
                                    /**
                                     * 上报**下拉了多少个屏幕高**（`dy / 屏幕高`，向下为正，向上恒为 0）。
                                     *
                                     * 缩放与背景透明度都由宿主按这**一个比例**算（参考微信那套
                                     * `FriendCircleView` 的比例）：
                                     *   · 图片缩放 `1 - fraction`，下限 0.75（= 拖到屏高 1/4 就不再缩）
                                     *   · 背景黑度 `1 - 2 × fraction`，下限 0.5
                                     * 也就是说"轻轻一拖只缩一点点"，缩小的快慢与阈值无关。
                                     *
                                     * 只算向下的位移：向上拖仍然**跟手**（图片跟着手指走），
                                     * 但不缩小、不淡背景、也不参与阈值判断，松手回弹 ——
                                     * 与参考实现"只有下滑才退出、其他方向复位"一致。
                                     *
                                     * 刻意**不做 0..1 截断**：拉过 1/6 之后仍要继续缩小/变透
                                     * （各自的下限会兜住）。
                                     */
                                    val dragFraction = (dy / screenHeight).coerceAtLeast(0f)
                                    // 一起上报**按下的那一点**：宿主要拿它当缩放原点，
                                    // 这样"手指抓住的那块画面"在下拉过程中始终贴在手指下（朋友圈那种贴手感）
                                    onDragDismiss(dx, dy, dragFraction, down.position)
                                }
                            }
                            if (locked == true) {
                                val velocity = tracker.calculateVelocity().y
                                // 下拉过半，或**向下**快速甩（>1.2 px/ms）即关闭；向上拖一律回弹
                                val commit = dy > dismissThreshold || (dy > 0 && velocity > FLING_VELOCITY)
                                onDragDismissEnd(commit)
                            }
                        }
                    }
                } else Modifier
            )
            .transformable(
                state = transformable,
                /**
                 * **1x 时禁止接管拖动**。
                 *
                 * `transformable` 会把单指拖动当成 pan 消费掉，而它在外层（HorizontalPager）里面：
                 * 一旦消费，翻页器就永远收不到横向手势 —— 表现就是"多图不能左右滑动"。
                 * `canPan` 返回 false 时它既不消费也不回调，横向拖动就能正常冒泡给翻页器；
                 * 捏合缩放（双指）不受影响，放大后的单指平移照旧。
                 */
                canPan = { scale > ZOOMED_EPS },
            )
            .pointerInput(url, scale) {
                detectTapGestures(
                    onTap = { onSingleTap() },
                    /**
                     * 长按 → 「保存到相册」弹层。
                     *
                     * 为什么放在**查看器内部**而不是各调用方：全屏看图的入口有四五个
                     * （帖子九宫格、详情页、聊天、私密文件夹…），逐个接线必漏；
                     * 而"用户按住的是这一张图"这件事只有这里知道（`url` + 鉴权头都在手边）。
                     * 弹层宿主在 Shell，[LocalMediaSaveOpener] 为 null（预览/单测）时静默忽略。
                     */
                    onLongPress = {
                        mediaOpener.value?.invoke(
                            MediaSaveTarget(
                                url = url,
                                kind = MediaKind.Image,
                                headers = headers,
                            ),
                        )
                    },
                    onDoubleTap = { position ->
                        if (scale > ZOOMED_EPS) {
                            scale = 1f
                            offset = Offset.Zero
                            onZoomChanged(false)
                        } else {
                            scale = DOUBLE_TAP_SCALE
                            // 以双击点为锚：把该点移到视口中心
                            val center = Offset(size.width / 2f, size.height / 2f)
                            val delta = (center - position) * (DOUBLE_TAP_SCALE - 1f)
                            offset = clampOffset(delta, DOUBLE_TAP_SCALE)
                            onZoomChanged(true)
                        }
                        // 双击同样改变缩放/平移：同步上报，退场起点才不会跳
                        onTransform(scale, offset)
                    },
                )
            },
        contentAlignment = Alignment.Center,
    ) {
        // 双击/捏合后的平滑归位由 graphicsLayer 直接跟手，不再额外做动画 ——
        // 归位是一次状态跳变（1x），跟手的捏合本来就不该有延迟。
        ViewerImage(
            url = url,
            headers = headers,
            contentDescription = contentDescription,
            onAspect = onImageAspect,
            modifier = Modifier.fillMaxSize(),
        )
    }
}

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
    // 请求 remember 住：这条 composable 在下拉时会随宿主重组，每帧重建一个请求没必要
    // （Coil 判断"换没换请求"靠 ImageRequest 的相等性，稳定引用最省事）
    val request = remember(context, url, headers) { viewerImageRequest(context, url, headers) }

    Box(modifier = modifier, contentAlignment = Alignment.Center) {
        AsyncImage(
            // 与"打开前预解码"（`preloadViewerImage`）**必须同一个请求参数**，否则内存缓存键不同、
            // 等于没预解码。这也是"点开卡一下"的根因之一：查看器要全屏尺寸、列表只有一格缩略图，
            // 两个尺寸各自解码一次。固定 Size.ORIGINAL 后两边共用一条缓存。
            model = request,
            contentDescription = contentDescription,
            contentScale = ContentScale.Fit,
            modifier = Modifier.fillMaxSize(),
            onSuccess = { state ->
                loading = false
                failed = false
                // 上报实际这张图的宽高比（占位图命中时第一帧就有；原图解码完再报一次，值相同）。
                // 用 `state.painter.aspectOrNull()` 而不是自己去读 `result.image`：
                // 与缩略格登记那边**同一份实现**，两边算出来的比例不会出现第二套口径。
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
 * 查看器里那张图的加载请求（**唯一一份**：飞行图与轮播都用它）。
 *
 * 四个刻意的选择：
 *  1. `Size.ORIGINAL`：内存缓存键含尺寸，固定成"原图"才能让预解码与查看器命中同一条缓存；
 *  2. **不加 `crossfade`**：预解码已经把图备好了，再淡入一次等于"打开时先虚一下"；
 *     视觉连续性由飞行本身提供（飞过来的那份就是同一张图）；
 *  3. 鉴权头走 `NetworkHeaders`（Coil 3 只认它，塞 Map 会编译失败 —— 这个坑在别处踩过）；
 *  4. **取图/解码走 [ImageLoading.immediate]**：它**就是**正在播的那个动画，
 *     不能被"动画期间加载让路"的闸门扣住（扣住了飞行途中就是一片空白）。
 *     其余请求走默认的 [ImageLoading.gated]（见 KApp.newImageLoader）；
 *  5. **`placeholderMemoryCacheKey` = 缩略图那一张的键**（见 `thumbMemoryCacheKey`）：
 *     原图解码要几十到上百毫秒，没有占位图的话飞行前半程是空白的 ——
 *     真机表现就是"图突然变大一下"而不是"从详情页那一格飞出来"。
 *     有占位图时第一帧就是用户刚看到的缩略图，原图解码完再无缝替换。
 */
fun viewerImageRequest(context: Context, url: String, headers: Map<String, String>): ImageRequest =
    ImageRequest.Builder(context)
        .data(url)
        .size(Size.ORIGINAL)
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

internal const val MIN_SCALE = 1f
internal const val MAX_SCALE = 4f
internal const val DOUBLE_TAP_SCALE = 2.5f
internal const val ZOOMED_EPS = 1.01f

/**
 * 下拉多少（屏高的几分之一）算"要关闭"。取 6 = **屏高的 1/6**，
 * 与参考实现（微信朋友圈那套 `FriendCircleView`）的 `movY > screenHeight / 6` 一致。
 */
private const val DISMISS_COMMIT_FRACTION = 6f
private const val FLING_VELOCITY = 1.2f
private const val TOUCH_SLOP = 12f
