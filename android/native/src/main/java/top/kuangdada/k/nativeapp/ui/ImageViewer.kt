package top.kuangdada.k.nativeapp.ui

import android.content.Context
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.AnimationVector1D
import androidx.compose.animation.core.animate
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import coil3.SingletonImageLoader
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import top.kuangdada.k.core.designsystem.theme.KMotion
import top.kuangdada.k.core.designsystem.theme.KTheme
import top.kuangdada.k.core.designsystem.theme.KType
import top.kuangdada.k.core.designsystem.theme.LocalAnimationsEnabled
import top.kuangdada.k.nativeapp.ui.viewer.ZoomableImage
import top.kuangdada.k.nativeapp.ui.viewer.viewerImageRequest
import kotlin.math.roundToInt

/**
 * ============================================================
 * 图片查看器（M5：Shell 内的覆盖层；M5.2：飞行不再走共享元素）
 * ============================================================
 * 旧实现是独立 `ImageViewerActivity` + `overridePendingTransition(0, 0)`：跨 Activity 做不了
 * Compose 共享元素，所以"点缩略图 → 全屏"只能硬切（黑屏一闪）。M5 把它搬进 Shell 的覆盖层，
 * 并尝试用 `Modifier.sharedElement` 让两端对飞。
 *
 * **M5.2（本次）推翻的正是最后那一步** —— 真机 + 慢放截图（`animator_duration_scale` 3x/10x）
 * 实测：「详情格 ↔ 全屏」这条飞行**根本没有插值**：元素被画在来源格的矩形上一动不动两秒多，
 * 直到转场结束才跳到全屏；退出同理（看起来像"图片直接消失"）。
 * 而「卡片 ↔ 详情页」那条（两端都在 `AnimatedContent` 的内容里）是好的 —— 说明问题出在
 * "一端在覆盖层的 `AnimatedVisibility` 里"这种配对方式上，不是 key、不是 `boundsTransform`。
 *
 * 所以这里改成**查看器自己算几何**：
 *
 *   · 打开：进度 `0 → 1`，这一张图的矩形从**来源缩略格**插值到**全屏 Fit 矩形**，遮罩同步淡入；
 *   · 退出：进度 `1 → 0`，从**请求关闭那一刻屏幕上真实的矩形**（含捏合缩放、平移、下拉位移）
 *     缩回**当前这一张**的缩略格，飞完才通知 Shell 卸载。
 *
 * 两端取景方式一致：矩形内容固定用 `ContentScale.Crop` 填满，而**目标矩形的宽高比就是原图
 * 宽高比**（Fit 算出来的），此时 Crop 与 Fit 等价 —— 出发帧与缩略格逐像素一致、落位帧与全屏
 * `Fit` 逐像素一致，两头都不跳。
 *
 * **M5.4（宽高比是这条飞行的硬前提）**：宽高比拿不到时，落位矩形只能退回**整个容器**，
 * 而那个矩形飞出来的末帧是"铺满屏幕的裁剪"，交接给轮播的 `Fit` 时会缩一下 ——
 * 用户实测反馈的正是这个（"第一排三张 / 单图点开先铺满屏幕、再缩回全屏位置"）。
 * 所以宽高比不再"拿不到就算了"：
 *   · 登记表那边**按字段合并**、位置取最新（见 [ViewerOrigins] 的类注释，根因在那里）；
 *   · 这里**两条飞行都要求宽高比先就绪**（[ImageViewerOverlay] 里的 `awaitAspect`：
 *     等最多 [ASPECT_WAIT_MS]，等不到就不飞、直接落位），而且宽高比有两个上报来源
 *     （飞行层那一张 + 轮播那一页），任意一个到了就算就绪。
 *
 * @param request 打开请求（含每张图各自的来源矩形，见 [ViewerOrigins]）
 * @param closing Shell 请求关闭（返回键）：与"点画面 / 下拉过阈值"汇入同一条退场飞行
 */

/** 一条打开请求 */
data class ImageViewerRequest(
    val images: List<String>,
    val index: Int,
    val headers: Map<String, String> = emptyMap(),
    /** 帖子配图 id：只用于查来源（[ViewerOrigins]）；null = 不做飞行 */
    val postId: Long? = null,
    /** 关闭时回传"最后停在第几张"，调用方据此把列表滚到同一张 */
    val onClosed: ((Int) -> Unit)? = null,
    /**
     * 每张图各自的来源（与 images 同序）；空 = 量不到，退化为直接落位。
     *
     * ★ 这是**打开那一刻的快照**，只在 [resolveOrigin] 取不到值时兜底 —— 见那条注释。
     */
    val origins: List<ViewerOrigin?> = emptyList(),
    /**
     * 实时来源解析器（`第几张` → 那一格**此刻**在屏幕上的矩形）。
     *
     * ★★ 为什么不能只用 [origins] 那份快照：查看器打开期间，**来源那一格可能重排**。
     * 详情页单图最典型 —— 图片加载完成前它只有 4:3 的占位高，加载完才按真比例撑开
     * （[top.kuangdada.k.nativeapp.ui.rememberImageAspect] 只知道 4:3 兜底）。
     * 快照一旦作废，退场就会飞回一个"那个位置上现在并不是那张图"的矩形，落位拔掉覆盖层时
     * 真图出现在别处 —— 用户实测原话：**"退出到位置的时候又跳动一下才复位"**。
     * 而且只坏第一次：第二次比例已进 `ImageAspectCache`，容器一开始就是最终高度，不会重排。
     *
     * null = 没有实时来源（Preview / 单测 / 不在 Shell 里）：退回 [origins] 那份快照。
     */
    val resolveOrigin: ((page: Int) -> ViewerOrigin?)? = null,
    /**
     * **进/退飞行时要避让的顶栏底边**（窗口像素；0 = 不避让）。
     *
     * 要解决的问题（用户实测）：进出全屏时，飞行那一张会**压在顶栏上面** ——
     * 退出时"图片遮住顶栏、飞到位才跳回后面"，进场时"图片直接长到顶栏上"。
     * 根因是飞行层画在查看器覆盖层里，而覆盖层永远在页面（含顶栏）之上。
     *
     * 修法**不是**改透明度，而是把那一条**从绘制里裁掉**（见 [FlyingImage] 的 `topClipPx`）：
     * 顶栏区域于是露出底下的页面本身 —— 观感正是"图片钻到顶栏后面"，
     * 与页面内滚动时图片穿过顶栏的表现一致（进出两个方向因此也对称）。
     *
     * 不越过顶栏时等于不裁，所以**起飞帧与来源缩略格仍逐像素一致**。
     */
    val topInsetPx: Float = 0f,
)

/**
 * 打开查看器。默认是**空实现**，所以调用方不需要判空 ——
 * 与 `Modifier.sharedElementIfAvailable` 同一思路：不在 Shell 里（Preview、单测、StyleGuide）时静默无效。
 */
val LocalImageViewerOpener = staticCompositionLocalOf<(ImageViewerRequest) -> Unit> { {} }

/**
 * 打开查看器**之前**先把这一张原图解码好（后台线程，不阻塞点击）。
 *
 * 飞行本身有几百毫秒，解码正好在飞行期间完成 —— 等查看器组合出来时它已经是内存命中，
 * 于是"点开卡一下"消失。只预解码**当前这一张**：预解码全部就是替用户决定他一定会翻页，
 * 白白吃内存（相邻页在翻过去时再解码，那时也有一次页面切换的时间可以掩盖）。
 */
fun preloadViewerImage(context: Context, request: ImageViewerRequest) {
    val url = request.images.getOrNull(request.index) ?: return
    runCatching {
        SingletonImageLoader.get(context).enqueue(viewerImageRequest(context, url, request.headers))
    }
}

/**
 * 覆盖层本体。
 *
 * Shell 只在 `viewer != null` 时组合它；退场飞行**由它自己播完**再回调 [onClosed]，
 * 所以 Shell 不需要（也不该）再包一层 `AnimatedVisibility` —— 那会在飞行途中把内容卸掉。
 */
@Composable
fun ImageViewerOverlay(
    request: ImageViewerRequest,
    closing: Boolean,
    onRequestClose: () -> Unit,
    onClosed: (Int) -> Unit,
    onPageChanged: (Int) -> Unit = {},
) {
    // 固定深色：看图场景不跟随浅色主题（旧 Activity 同样处理）
    KTheme(darkTheme = true) {
        val animationsEnabled = LocalAnimationsEnabled.current
        /**
         * 解码用上下文：`awaitAspect` 要主动把这一张解出来（见那边的注释）。
         * 用 Application 上下文（`LocalContext` 已是 Activity，但解码器只需要它拿 ContentResolver）。
         */
        val viewerContext = LocalContext.current
        val pagerState = rememberPagerState(initialPage = request.index) { request.images.size }

        // 把当前页同步给 Shell：返回键关闭时也要知道"停在第几张"
        LaunchedEffect(pagerState.currentPage) { onPageChanged(pagerState.currentPage) }

        /** 覆盖层（= 全屏容器）在窗口里的矩形：飞行几何的参照系 */
        var container by remember { mutableStateOf(Rect.Zero) }
        /** 飞行进度：0 = 还停在来源那一格，1 = 全屏落位 */
        val progress = remember { Animatable(0f) }
        /** 正在飞那一张（此期间轮播不参与绘制，交接时两边画面逐像素一致） */
        var flying by remember { mutableStateOf(true) }
        /** 退场飞行已经开始 */
        var leaving by remember { mutableStateOf(false) }
        /** 退场起点：请求关闭那一刻这一张在屏幕上的真实矩形 */
        var leaveFrom by remember { mutableStateOf(Rect.Zero) }

        /**
         * 下拉关闭的实时状态（跟手，1:1）。
         *
         * 三个值都**只在绘制期读**（轮播那两个 `graphicsLayer` 的 lambda），所以下拉期间
         * **不触发任何重组/重排** —— 这是"跟手"的前提（M5.6）。
         */
        var dragOffset by remember { mutableStateOf(Offset.Zero) }
        /**
         * 下拉了**多少个屏幕高**（`dy ÷ 屏高`，向下为正、向上恒为 0）。
         *
         * 它是缩放与背景黑度的**唯一输入**（见 [dismissScaleOf] / [dragAlphaOf]），
         * 与"关不关"的阈值（屏高 1/6，在 `ZoomableImage` 里）刻意分开 ——
         * 早先两者绑在一起，轻轻一拖就缩掉三分之一（用户实测反馈"缩得太小、太快"）。
         */
        var dragFraction by remember { mutableFloatStateOf(0f) }
        /** 手指按下的那一点 —— 缩放的锚点（见 M5 v3 的注释） */
        var dragPivot by remember { mutableStateOf<Offset?>(null) }
        /** 放大态：放大时禁用翻页（否则横向拖动会一边平移一边翻页） */
        var zoomed by remember { mutableStateOf(false) }
        /** 缩放/平移的实际数值：退场起点要把它们算进去，画面才不会跳 */
        var zoomScale by remember { mutableFloatStateOf(1f) }
        var zoomOffset by remember { mutableStateOf(Offset.Zero) }

        val dismissScope = rememberCoroutineScope()

        /** 当前页：用户翻页后就是"新这一张"的来源，退场飞回它 */
        val currentPage = pagerState.currentPage
        /**
         * 当前这一张的来源。
         *
         * ★ 用**状态对象**而不是 `var x by remember { mutableStateOf(...) }`：协程 lambda 捕获的
         *   是局部变量的快照，那样在协程里永远只能读到首次组合的那份值（这一整套文件已经因为
         *   这个陷阱误判过一次取证结论）。`originState.value` 在任何 lambda 里读到的都是实时值。
         *
         * ★ 为什么要"活"的而不是打开那一刻的快照：**查看器打开之后来源那一格还会重排** ——
         *   详情单图在图片加载完之前只有 4:3 的占位高，加载完才按真比例撑开。快照作废的结果是
         *   起飞帧与来源格错位（观感"飞入飞出"）、退场末帧停在一个"那个位置上已经不是这张图"的
         *   矩形上（用户实测："退出到位置的时候又跳动一下才复位"），且**只坏第一次**——
         *   第二次比例已在 `ImageAspectCache` 里，容器一上来就是最终高度，不会重排。
         */
        val originState = remember {
            mutableStateOf<ViewerOrigin?>(
                request.resolveOrigin?.invoke(request.index)
                    ?: request.origins.getOrNull(request.index),
            )
        }
        val origin = originState.value
        val sourceRect = origin?.rect
        /**
         * 来源缩略格的圆角（px）。
         *
         * 飞行图必须从**格子的圆角**变到**全屏的直角**（见 [lerpCornerRadius]）：
         * 出发/落位帧要与格子严丝合缝，全屏那一端才是直角。量不到（不在 Shell 里、
         * 或者那一格没登记圆角）时按直角处理 —— 与旧行为一致，不会更糟。
         */
        val sourceRadiusPx = origin?.cornerRadiusPx ?: 0f
        /**
         * 「每一张图自己的宽高比」—— 由**画面上真正显示的那张图**上报，作为登记表之外的兜底。
         *
         * 正常情况下宽高比由缩略格登记（`ViewerOrigins`）；但那条登记可能读不到
         * （来源格还没加载出图、或那一格被两处来源先后写过 —— 见 `ViewerOrigins` 的类注释）。
         * 缺了它，落位矩形就只能退回**整个容器**：真机表现正是"先铺满屏幕、再缩回全屏位置"
         * （用户实测反馈：只有第一排三张与单图会出现，因为那几个 index 恰好也被信息流卡片登记过）。
         *
         * 两个上报来源，覆盖"飞行前"与"飞行后"两段时间：
         *  · 飞行层那一张（[FlyingImage] 的 `onAspect`）：它先组合出来，赶得上起飞前的判定；
         *  · 轮播那一页（[ZoomableImage] 的 `onImageAspect`）：它就是"屏幕上正在看的那一张"，
         *    进场飞行结束后它仍会加载完成 —— 退场时的落位矩形靠它，否则只能退回整屏。
         *
         * 按**页号**存而不是只存当前页：相邻页在轮播里是预加载的，它们的图可能在成为当前页
         * **之前**就加载完了（`onSuccess` 只报一次），只存当前页的话翻过去就再也拿不到。
         */
        val pageAspects = remember { mutableStateMapOf<Int, Float>() }
        val aspect = origin?.aspect ?: pageAspects[currentPage]
        /**
         * 全屏落位矩形：按**原图宽高比**在容器里 Fit。
         *
         * 宽高比未知时 [fitRectIn] 会退回整个容器矩形 —— 那个矩形**只用于"真的一点办法都没有"**
         * 的场合：进场与退场两条飞行都要求宽高比先就绪（[awaitAspect] 与下面的判空），
         * 所以飞行几何本身不会用到"整屏"这个退化值。
         *
         * ★★ 2026-09-20 修「打开有跳帧」：以前这里直接 `fitRectIn(container, aspect)`，
         *   而 **首次组合那一遍 `container` 还是 `Rect.Zero`** —— 虽然 `remember` 的读值发生在
         *   布局已完成的某一次组合里，但只要那一遍读到零，这一格 remember 就把
         *   `fitRectIn(Rect.Zero, aspect)` = **`Rect.Zero`** 缓存了下来。
         *   真机 logcat 铁证（修复前）：
         *   ```
         *   enter: FLY source=(56,773,1383,2542) target=Rect.fromLTRB(0,0,0,0)   ← 落位矩形是全零
         *   frame#1 … tgt=(0,624,1440,2544)                                       ← 下一帧才对
         *   ```
         *   也就是说 **`Frame0` 画在零矩形上、图片整个不画**（[FlyingImage] 里
         *   `rect.width <= 1f` 直接 return），屏幕上"先空一帧、再突然出现"。
         *   退场不受影响（那时容器早就量好了），所以只有进场坏。
         *
         *   修法：容器零尺寸时**不缓存 `Rect.Zero`**（退回整个容器这个"明确的退化值"），
         *   并把真正的守卫放在 [FlyingLayer]：`targetRect` 还没就绪就一个像素都不画，
         *   `progress` 也停在 0 —— 于是"屏幕上第一张画出来的图"就是首帧飞行图，
         *   永远不会出现"先空一下"。
         */
        val targetRect = remember(container, aspect) {
            if (container.width <= 0f || container.height <= 0f) Rect.Zero
            else fitRectIn(container, aspect)
        }

        /**
         * 等"这一张的宽高比"就绪（登记表里有，或飞行层/轮播已经上报），最多 [ASPECT_WAIT_MS]。
         *
         * 为什么要等：落位矩形 = "按宽高比 Fit 进容器"，缺了宽高比就是**整个容器** ——
         * 飞过去的末帧是"铺满屏幕的裁剪"，交接给轮播的 `Fit` 时再缩回去（用户实测反馈的正是这个）。
         * 与其飞一个错的矩形，宁可晚一两帧起飞：等待期间进度还是 0、飞行图就画在来源格上，
         * 屏幕上看不出任何变化。
         *
         * ★ 等待期间**主动把这一张解出来**（见 [ImageViewerOverlay] 的 `awaitAspect` 调用点）。
         *   早期的实现是"纯等"：等飞行层那一张的 `onSuccess` 把比例报上来。
         *   问题在于——**首次打开时原图往往还没解码完**（哪怕是同一次点击前刚预热过：
         *   预热是异步的，几十到上百毫秒），而一旦超时就**不起飞、直接落位**；
         *   第二次打开时图已经在内存缓存里，同一帧就有比例，于是正常起飞。
         *   这正是用户反馈的"**只有第一次**触发这个 bug"的成因：不是动画本身有状态，
         *   而是"首次 = 冷缓存"这一次走了退化分支。
         */
        suspend fun awaitAspect(): Boolean {
            // ★ 一律读 `originState.value` / `pagerState.currentPage`：它们是 **remember 出来的对象**
            //   （实时值）。同作用域里的 `origin` / `currentPage` 是局部变量，协程 lambda 只会
            //   捕获首次组合的那一份 —— 那会让"晚一步才到达的宽高比"永远看不见。
            if (originState.value?.aspect != null) return true
            val page = pagerState.currentPage
            if (pageAspects[page] != null) return true
            // 兜底：自己把这一张解出来（内存命中时是同步返回，未命中时才真的解码）。
            // `immediate` 调度器不参与动画让路，所以这条不会把自己等死。
            val url = request.images.getOrNull(page)
            if (url != null) {
                runCatching {
                    SingletonImageLoader.get(viewerContext)
                        .execute(viewerImageRequest(viewerContext, url, request.headers))
                }
                if (pageAspects[page] != null) return true
            }
            return withTimeoutOrNull(ASPECT_WAIT_MS) {
                snapshotFlow { originState.value?.aspect ?: pageAspects[pagerState.currentPage] }
                    .first { it != null }
            } != null
        }

        /**
         * 这一张现在在屏幕上的矩形 —— 退场飞行的起点。
         *
         * 三件变换按真实绘制顺序叠加（与轮播那边**同一套公式**，所以起点不会有任何"跳"）：
         *   1. 落位矩形（全屏 Fit）；
         *   2. 捏合/双击缩放：绕**容器中心**；
         *   3. 下拉：位移 + 绕**按下点**的缩放。
         *
         * 注意第 3 件在绘制那边现在是 `graphicsLayer` 的 `translation` + `scale`（M5.6 从布局偏移
         * 改过来的，见轮播那两个 graphicsLayer 的注释）—— 映射与这里**逐字一致**：
         * `screen(q) = pivot + (q - pivot) × scale + translation`，所以起点仍然严丝合缝。
         */
        fun visualRect(target: Rect = targetRect): Rect {
            var r = target
            if (zoomScale != 1f || zoomOffset != Offset.Zero) {
                r = transformRect(r, container.center, zoomScale, zoomOffset)
            }
            if (dragOffset != Offset.Zero || dragFraction != 0f) {
                r = transformRect(r, dragPivot ?: container.center, dismissScaleOf(dragFraction), dragOffset)
            }
            return r
        }

        /**
         * 开始退场。三条路（点画面 / 返回键 / 下拉过阈值）都走这里，
         * 保证"飞回缩略格"只有一份实现。
         */
        fun beginLeave(from: Rect?) {
            if (leaving) return
            leaving = true
            // ★ 关掉的这一刻**重新量一次来源**：那一格多半已经在查看器打开期间排完版了
            //   （详情单图 4:3 占位 → 真比例）。不量就是"飞回一个过期矩形"（见 originState 的注释）。
            val freshLeave = request.resolveOrigin?.invoke(pagerState.currentPage)
                ?: request.origins.getOrNull(pagerState.currentPage)
            if (freshLeave != null) originState.value = freshLeave
            // 起飞那一帧的"全屏矩形"也按**刚拿到的宽高比**重算一遍：`targetRect` 是上一次
            // 组合的产物，而这一次解析可能刚刚才把宽高比带进来（详情单图加载完的那一帧
            // 正好撞上点关闭 —— 用旧值会让退场从一个"铺满屏幕"的假起点开始）
            val leaveTarget = fitRectIn(container, originState.value?.aspect ?: aspect)
            leaveFrom = from ?: visualRect(leaveTarget)
            flying = true
            onRequestClose()
        }

        /**
         * 进场飞行。
         *
         * ★★ 这里踩过一个坑（真机反馈："不是从详情页位置飞入全屏，只是变大一下再回到全屏位置"）：
         *
         * 原来写成 `LaunchedEffect(container)`，而**首次组合时 `container` 还是 `Rect.Zero`**
         * （`onGloballyPositioned` 要等布局阶段才写进来）—— 那一版走到 `container.width <= 0`
         * 分支就把 `progress` 直接 `snapTo(1f)`，于是**进场飞行整个被跳过**，
         * 而且进度已经到 1，后续 `container` 更新时又被 `progress.value >= 1f` 挡掉，永不补飞。
         *
         * 现在：**容器没量出来时什么都不做**（不是落位），用一个 Unit 键的协程把容器等出来
         * （带超时兜底，绝不会把用户留在空白覆盖层），再决定是飞还是直接落位。
         */
        LaunchedEffect(Unit) {
            val measured = withTimeoutOrNull(CONTAINER_WAIT_MS) {
                snapshotFlow { container }.first { it.width > 0f }
                true
            } ?: false
            if (leaving || progress.value >= 1f) return@LaunchedEffect
            // 量不到容器（不该发生）→ 直接落位，绝不留白
            if (!measured || !animationsEnabled) {
                progress.snapTo(1f)
                flying = false
                return@LaunchedEffect
            }
            // 让轮播先组合两帧：它的首帧成本不该压在飞行动画上（"点开顿一下"的成因之一），
            // 顺带也给飞行层那一张两帧时间——它的占位图（缩略图，见 thumbMemoryCacheKey）命中时，
            // 宽高比在这两帧里就报上来了。
            withFrameNanos { }
            withFrameNanos { }
            if (leaving) return@LaunchedEffect
            /**
             * 来源矩形也**等实时值**：首次进入详情页那一帧，那一格可能还没经过布局阶段
             * （尤其是详情单图 —— 它可能还停在 4:3 的占位高度上，甚至还没登记）。
             * 早先这里直接把 `sourceRect == null` 当"不做飞行"，而协程里那个 `sourceRect`
             * 是**首次组合的快照**，于是"再等一帧就到"的来源被判成永远没有。
             */
            if (originState.value?.rect == null) {
                withTimeoutOrNull(ORIGIN_WAIT_MS) {
                    snapshotFlow { originState.value?.rect }.first { it != null }
                }
            }
            if (originState.value?.rect == null) {
                progress.snapTo(1f)
                flying = false
                return@LaunchedEffect
            }
            // 宽高比还没就绪就**先不飞**：缺它时落位矩形只能是"整个屏幕"，
            // 用户看到的就是"先铺满屏幕、再缩回全屏位置"。宁可没有飞行，也不飞一个错的矩形。
            if (!awaitAspect()) {
                progress.snapTo(1f)
                flying = false
                return@LaunchedEffect
            }
            progress.animateTo(1f, KMotion.spatialBounded())
            flying = false
        }

        // 返回键：Shell 把 closing 置真（点画面那条也用它，两条路完全一致）
        LaunchedEffect(closing) { if (closing) beginLeave(null) }

        // 退场飞行：缩回来源格 → 再通知 Shell 卸载
        LaunchedEffect(leaving) {
            if (!leaving) return@LaunchedEffect
            // 与进场同一条规则：宽高比未知时**不飞**。退场起点是按落位矩形算出来的
            // （见 visualRect），缺宽高比它就成了整个屏幕 —— 那会先"撑大一圈"再缩回格子。
            //
            // ★ 这里判的是 `originState.value` 而不是局部变量 `sourceRect`：那个局部变量是
            //   **首次组合的快照**，而来源有可能是在退场那一刻才被 [beginLeave] 重新量出来的
            //   （详见 [ImageViewerRequest.resolveOrigin]），读快照会把新的退场判成"没有来源"。
            if (animationsEnabled && originState.value?.rect != null && aspect != null) {
                progress.animateTo(0f, KMotion.spatialBounded())
            } else {
                progress.snapTo(0f)
            }
            onClosed(currentPage)
        }

        /**
         * 飞行期间**逐帧重取来源矩形**（代价：每帧一次查表，且只在值真的变了才写状态）。
         *
         * 少了这条，"查看器打开期间来源那一格才排完版"这件事就只能靠运气：
         * 起飞那一刻读到什么就是什么，之后的几百毫秒里页面继续变，而飞行用的是旧值。
         * 有它之后，起飞帧与落位帧始终贴在"那一格当下真实的位置"上 ——
         * 这也正是第一次与第二、三次表现一致的唯一办法（详情单图的 4:3 占位 → 真比例
         * 只在第一次发生，所以早先的 bug **只坏第一次**）。
         *
         * ★ 循环用 `while (true)` 而不是"读到 flying 变 false 就退出"：协程 lambda 捕获的
         *   是**首次组合的局部变量快照**，在这里读 `flying` 永远读到 true（这一整套文件里
         *   已经因为这个陷阱误判过一次）。退出交给外层的 `LaunchedEffect(flying)` ——
         *   `flying` 一变，整个协程就被取消重组。
         *
         * ★ 另一个必须绕开的陷阱：协程里**不能**读 `currentPage`（同样是快照）。
         *   `pagerState` 是 remember 出来的对象，读它的属性拿到的是实时值。
         */
        LaunchedEffect(flying) {
            if (!flying) return@LaunchedEffect
            while (true) {
                withFrameNanos { }
                val page = pagerState.currentPage
                val next = request.resolveOrigin?.invoke(page) ?: request.origins.getOrNull(page)
                if (next != null && next != originState.value) originState.value = next
            }
        }

        /**
         * 飞行期间**图片加载让路**（见 [AnimationGate]）：查看器自己这张走
         * `ImageLoading.immediate` 不受影响，被挡住的是"页面里还在加载的那批图"。
         */
        val gateToken = remember { Any() }
        DisposableEffect(flying) {
            if (flying) {
                AnimationGate.begin(gateToken)
                onDispose { AnimationGate.end(gateToken) }
            } else {
                onDispose { }
            }
        }

        Box(
            modifier = Modifier
                .fillMaxSize()
                .onGloballyPositioned { container = it.boundsInWindow() },
        ) {
            /**
             * 遮罩。
             *
             * ★ alpha 在**绘制期**读（`graphicsLayer` 的 lambda 里），不是组合期：
             *   进度每帧都变，在组合期读会把整棵覆盖层（**包括轮播**）每帧重组一次 ——
             *   那正是"打开图片时掉帧"的一部分。绘制期读只重绘这一层。
             *
             * ★★ M5.6：透明度 = **「下拉那一段」× 「飞行那一段」**，两段相乘而不是二选一。
             *   早先是 `if (flying) progress else dragAlpha` —— 松手那一刻（`flying` 从 false 变 true）
             *   透明度从"半透"**瞬间跳成全黑**再淡出，真机上就是"松手闪一下黑"（用户反馈）。
             *   相乘之后：进场（没下拉过，dragAlpha=1）与原来完全一样；退场则从"松手时那层透明度"
             *   平滑地淡到 0。
             */
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .graphicsLayer {
                        alpha = viewerMaskAlpha(flying, progress.value, dragFraction)
                    }
                    .background(Color.Black),
            )

            HorizontalPager(
                state = pagerState,
                userScrollEnabled = !zoomed && !flying,
                modifier = Modifier
                    .fillMaxSize()
                    // 飞行期间它**保持组合但不可见**：首帧成本在飞行开始前就消化掉了，
                    // 交接时它的图也已经在内存里；alpha=0 时 Compose 会跳过绘制。
                    // 同样在绘制期读 `flying`，避免为一次显隐重组整个轮播。
                    .graphicsLayer { alpha = if (flying) 0f else 1f }
                    /**
                     * 位移与缩放**都在绘制期**（M5.6）。
                     *
                     * 为什么从"布局偏移"改过来：下拉是**每帧写状态**的，布局期的 `.offset { }`
                     * 每帧都要让轮播（LazyLayout + 每一页的整棵内容）重新放置一次，叠加"每帧重组"
                     * （那时 `dismissScale` 还在组合期算）—— 一套下来 UI 线程每帧都在赶工，
                     * 真机上的体感就是"**下滑不跟手**"（用户反馈）。绘制期只重录这一层，稳 1:1。
                     *
                     * 映射与 `visualRect()` / `transformRect` **逐字一致**：
                     *     screen(q) = pivot + (q - pivot) × scale + translation
                     * 所以退场飞行的起点（按 visualRect 算）与屏幕上看到的分毫不差。
                     *
                     * ★ 锚点换算（这里踩过一次，写清楚）：按下时 offset=0、scale=1，局部坐标 == 屏幕坐标，
                     *   所以"手指抓住的那块"在局部坐标里就是 `pivot`；代入上式得
                     *   `screen(pivot) = pivot + translation` —— 正好跟着手指走 ✓。
                     *   也就是说 **pivot 就是这个比例本身，不能再减掉 translation**
                     *   （减了的话被抓的那块会停在按下位置、落在手指后面）。
                     *   `transformOrigin` 收的是**占节点尺寸的比例**，所以要除以 `size`。
                     */
                    .graphicsLayer {
                        val scale = dismissScaleOf(dragFraction)
                        scaleX = scale
                        scaleY = scale
                        translationX = dragOffset.x
                        translationY = dragOffset.y
                        val pivot = dragPivot
                        if (pivot != null && size.width > 0f && size.height > 0f) {
                            transformOrigin = TransformOrigin(
                                pivot.x / size.width,
                                pivot.y / size.height,
                            )
                        }
                    },
            ) { pageIndex ->
                /**
                 * ★ 这里**不声明** `sharedElementIfAvailable(postImageKey(...))`：查看器的飞行是
                 * 自己手算几何的（[FlyingLayer] 把那一张从来源格插值到全屏），再参与共享元素
                 * 只会多出一份"被框架插值边界"的画面。
                 *
                 * ⚠️ 2026-09-20 更正（上一版注释把这里说成"第一次打开跳变"的根因，**是错的**）：
                 * 这一行即使写回去也**什么都不会发生** —— [LocalSharedElementScopes] 只由
                 * `AppShell` 的 `AnimatedContent` 内容 lambda 提供（`AppShell.kt` 的
                 * `LocalSharedElementScopes provides …`），而 `ImageViewerOverlay` 组合在
                 * 那个 lambda **之外**（Shell 最外层 Box，与胶囊/弹层同层）→ 作用域为 null →
                 * `sharedElementIfAvailable` 直接 `return this`（见 `SharedElements.kt`）。
                 * 也就是说它一直是**死代码**，删掉它只是清理，不是修复。
                 *
                 * 真正的原因是**飞行起点取错了矩形**（转场中间态 / 下层卡片的矩形）——
                 * 证据与修法都在 [ViewerOrigins] 的类注释里（真机 logcat + 用户录屏里那条竖缝）。
                 * `postImageKey` 这一族本来就只有**两个**端点（卡片格 ↔ 详情格）。
                 */
                ZoomableImage(
                    url = request.images[pageIndex],
                    headers = request.headers,
                    contentDescription = "第 ${pageIndex + 1} 张图片",
                    onSingleTap = { beginLeave(null) },
                    onDragDismiss = { dx, dy, fraction, downPosition ->
                        // 只有当前页参与下拉关闭（相邻页是预加载的，不该跟着动）
                        if (pageIndex == pagerState.currentPage) {
                            dragOffset = Offset(dx, dy)
                            dragFraction = fraction
                            // 锚点只记第一次：按下点在整个手势里不变，
                            // 每帧跟着手指改的话缩放就会"追着手指跑"，反而更飘
                            if (dragPivot == null) dragPivot = downPosition
                        }
                    },
                    onDragDismissEnd = { commit ->
                        if (pageIndex == pagerState.currentPage) {
                            if (commit) {
                                // 起点 = 松手那一刻屏幕上的矩形（含位移与缩放），
                                // 接着从这里飞回缩略格，手感是连续的
                                beginLeave(visualRect())
                            } else {
                                // 未达阈值：**弹簧回弹**（不是瞬间归零）——
                                // 瞬归零在手感上像"图片自己弹回去了"，而弹簧是"你松手了，它收回去"
                                val fromOffset = dragOffset
                                val fromFraction = dragFraction
                                dismissScope.launch {
                                    animate(
                                        initialValue = 1f,
                                        targetValue = 0f,
                                        animationSpec = KMotion.spatial(),
                                    ) { t, _ ->
                                        dragOffset = fromOffset * t
                                        dragFraction = fromFraction * t
                                    }
                                    // 回弹结束才清锚点：清早了，回弹途中缩放会突然改回"绕中心缩"，能看出来
                                    dragPivot = null
                                }
                            }
                        }
                    },
                    onZoomChanged = { zoomed = it },
                    onTransform = { s, o ->
                        zoomScale = s
                        zoomOffset = o
                    },
                    // 这一页的图加载完成 → 记下它的宽高比（落位矩形与它对齐，交接时才不会缩一下）
                    onImageAspect = { pageAspects[pageIndex] = it },
                    // ★ 刻意不挂 sharedElement（上面那段注释：挂了也是死代码，作用域为 null）
                    modifier = Modifier.fillMaxSize(),
                )
            }

            /**
             * 飞的那一张：在来源缩略格 ↔ 全屏落位矩形之间插值。
             *
             * 单独抽成 [FlyingLayer] 是为了**把每帧重组关在这一层里**：进度每帧都变，
             * 而轮播、遮罩、计数都不该跟着重组（它们各自在绘制期读进度）。
             */
            FlyingLayer(
                progress = progress,
                flying = flying,
                leaving = leaving,
                sourceRect = sourceRect,
                sourceRadiusPx = sourceRadiusPx,
                targetRect = targetRect,
                leaveFrom = leaveFrom,
                container = container,
                url = request.images[currentPage],
                headers = request.headers,
                // 拿不到登记的宽高比时，从飞行层这一张自己身上学一个（用于算落位矩形）
                onAspect = { pageAspects[currentPage] = it },
                // 退场飞行要避开的顶栏底边（见 ImageViewerRequest.topInsetPx）
                topClipPx = request.topInsetPx,
            )

            // 顶部只留计数（关闭按钮已按用户要求去掉 —— 看图时不想有多余的按钮）。
            // 关闭仍有三条路：**点画面任意处**、**1x 下向下拖**、**系统返回键**。
            // 飞行期间跟着遮罩一起淡入/淡出（同样在绘制期读进度），避免"页码先于图片出现"。
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .graphicsLayer { alpha = if (flying) progress.value else 1f }
                    .padding(WindowInsets.safeDrawing.asPaddingValues())
                    .padding(horizontal = 12.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "${pagerState.currentPage + 1} / ${request.images.size}",
                    color = Color.White,
                    style = KType.body,
                )
            }
        }
    }
}

/**
 * 飞行层：**只有这一层会按帧重组**（它读 [progress] 的值算矩形与圆角）。
 *
 * 用**布局**的 `offset` + `size`（不是绘制期缩放）来落矩形，内容用 `ContentScale.Crop`
 * 填满它：出发帧与来源缩略格逐像素一致（缩略格也是 Crop），落位帧与轮播的 `Fit` 一致
 * （此时矩形宽高比 = 原图宽高比，Crop 与 Fit 等价）。
 *
 * **圆角也一起飞**（M5.5）：缩略格是圆角的、全屏是直角的，所以圆角随进度从
 * [sourceRadiusPx] 变到 0（退场反之）。不这么做的话，点下去第一帧缩略图的圆角就"变成直角"。
 *
 * ★★ M5.6：**不飞的时候它也留在组合里**（`alpha = 0`），不能 `return` 掉。
 * 原因是"闪屏"（用户反馈"下滑退出会闪屏"）：一旦它离开组合，退场起飞那一瞬间
 * `rememberAsyncImagePainter` 要**重新建一次请求** —— 新 painter 的第一帧没有画面、
 * 接着先出缩略图占位（`placeholderMemoryCacheKey`）再换成原图，而轮播此刻已经被 `alpha = 0`
 * 藏起来了，于是屏幕上就是"图片先消失一两帧、再糊着回来"。
 * 让它一直挂着：起飞第一帧画的就是**它已经加载好的那张原图**（与轮播同一份内存缓存，不多解一次码）。
 */
@Composable
private fun FlyingLayer(
    progress: Animatable<Float, AnimationVector1D>,
    flying: Boolean,
    leaving: Boolean,
    sourceRect: Rect?,
    sourceRadiusPx: Float,
    targetRect: Rect,
    leaveFrom: Rect,
    container: Rect,
    url: String,
    headers: Map<String, String>,
    onAspect: (Float) -> Unit,
    /** 飞行时要避让的顶栏底边（窗口像素，0 = 不避让）。见 [ImageViewerRequest.topInsetPx] */
    topClipPx: Float,
) {
    if (sourceRect == null || container.width <= 0f) return
    // ★ 进场时落位矩形必须先就绪（见上面 targetRect 那段注释）：
    //   容器还没量出来 / 宽高比还没到 → `targetRect` 是零矩形，这时候**一个像素都不要画**。
    //   画了就是"首帧空一帧"（rect.width <= 1f 被 FlyingImage 拦掉），
    //   观感正是用户报的「打开有跳帧」。
    //   退场不看这条：那时 `leaveFrom` 是请求关闭那一刻的真实矩形，与 target 无关。
    if (!leaving && targetRect.width <= 1f) return
    val t = progress.value
    val rect = if (leaving) {
        lerpRect(sourceRect, leaveFrom, t)
    } else {
        lerpRect(sourceRect, targetRect, t)
    }
    FlyingImage(
        url = url,
        headers = headers,
        rect = rect,
        container = container,
        cornerRadiusPx = lerpCornerRadius(sourceRadiusPx, t),
        // 不飞的时候留在组合里但完全透明（Compose 会跳过这一层的绘制）
        alpha = if (flying) 1f else 0f,
        onAspect = onAspect,
        // ★ 进、退两段飞行都避开顶栏那一条（见 ImageViewerRequest.topInsetPx）：
        //   进场时图片"长"到顶栏上面去是同一个毛病（用户实测："把打开全屏也一起修了"）。
        //   没越过顶栏时 `cut <= 0` 等于不裁，所以**起飞帧与来源缩略格仍严格一致**，
        //   不会被这次改动影响。
        clipTopPx = topClipPx,
    )
}

/**
 * 正在飞的那一张。矩形是**窗口坐标**，这里换算成相对容器的布局位置与尺寸。
 *
 * 内容固定 `ContentScale.Crop`：出发帧它与缩略格完全一致，落位帧的矩形宽高比等于原图宽高比，
 * 于是 Crop 与 Fit 等价 —— 两端都不用做"取景方式过渡"，也就不会看到构图跳变。
 *
 * 顺带上报**它自己**的宽高比（[onAspect]）：登记表那边万一没给出比例，
 * 落位矩形也不会退化成"整个屏幕"（那正是"先铺满、再缩回"的成因）。
 */
@Composable
private fun FlyingImage(
    url: String,
    headers: Map<String, String>,
    rect: Rect,
    container: Rect,
    cornerRadiusPx: Float,
    alpha: Float,
    onAspect: (Float) -> Unit = {},
    /**
     * 要**裁掉的上沿**（窗口像素；0 = 不裁）。
     *
     * 用途只有一处：进/出全屏的飞行要避开顶栏（见 [ImageViewerRequest.topInsetPx]）。
     * 飞行层画在覆盖层里、永远在页面之上，不裁的话这张图会压着顶栏飞完全程
     * （退出时"落位、覆盖层卸掉那一刻才跳回顶栏后面"，进场时"直接长到顶栏上"）。
     *
     * 裁掉之后顶栏那一条露出的是**底下的页面本身**（也就是真顶栏），
     * 于是观感 = 图片钻到顶栏后面，与页面内滚动时的表现一致。
     *
     * 图还没越过顶栏（`cut <= 0`）时不做任何处理 —— 起飞/落位两端因此不受影响。
     */
    clipTopPx: Float = 0f,
) {
    if (rect.width <= 1f || rect.height <= 1f) return
    val density = LocalDensity.current
    val context = LocalContext.current
    // 请求**remember 住**（而不是每帧重建）：一来省掉每帧一次 Builder 分配，
    // 二来 Coil 判断"换没换请求"靠的是 ImageRequest 的相等性 —— 稳定引用是最省事的保证。
    val request = remember(context, url, headers) { viewerImageRequest(context, url, headers) }
    // 用 painter 而不是 AsyncImage：要从它身上读**原图宽高比**（上报给落位矩形）
    val painter = coil3.compose.rememberAsyncImagePainter(model = request)
    val aspect = painter.aspectOrNull()
    LaunchedEffect(aspect) {
        if (aspect != null && aspect > 0f) onAspect(aspect)
    }
    Box(
        modifier = Modifier
            .offset {
                IntOffset(
                    (rect.left - container.left).roundToInt(),
                    (rect.top - container.top).roundToInt(),
                )
            }
            .size(
                width = with(density) { rect.width.toDp() },
                height = with(density) { rect.height.toDp() },
            )
            // 不飞时整层透明（留着组合只为保住 painter 里那张已加载的图，见 FlyingLayer 的注释）
            .alpha(alpha)
            // 圆角是**画法**，不参与布局：clip 走绘制期，不会影响上面量出来的矩形
            // （退场起点取的是布局坐标，与这里无关）
            .clip(RoundedCornerShape(with(density) { cornerRadiusPx.coerceAtLeast(0f).toDp() }))
            // 顶栏那一条不画（见 clipTopPx 的注释）。坐标换算：本 Box 的原点就在
            // 窗口坐标的 (rect.left, rect.top)，所以窗口 y 换成局部 y 只需减 rect.top。
            .drawWithContent {
                val cut = clipTopPx - rect.top
                if (cut > 0f) {
                    clipRect(top = cut) { this@drawWithContent.drawContent() }
                } else {
                    this@drawWithContent.drawContent()
                }
            },
    ) {
        Image(
            painter = painter,
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = Modifier.fillMaxSize(),
        )
    }
}

/**
 * 圆角随飞行进度变化：t=0（停在来源缩略格上）是**格子的圆角**，t=1（全屏落位）是**直角**。
 *
 * 进场 t: 0→1、退场 t: 1→0，同一个公式两个方向都对 —— 两端因此与"缩略格 / 全屏"严丝合缝，
 * 中途也不会出现"缩略图的圆角突然变直角"（用户实测反馈："有圆角变直角，退回的时候也有直角边"）。
 *
 * t 越界（弹簧过冲）夹到 `[0,1]`：圆角既不会变成负半径，也不会比格子本身更圆。
 */
internal fun lerpCornerRadius(fromPx: Float, t: Float): Float =
    fromPx * (1f - t).coerceIn(0f, 1f)

/**
 * 「越拉越小」：下拉过程中图片**按屏幕高的比例**等比缩小。
 *
 * `dragFraction = dy ÷ 屏幕高`，所以：
 *   · 拖到屏高 1/6（= 关闭阈值那一点）只缩到 **0.83**；
 *   · 拖到屏高 1/4 缩到 **0.75**，再往下不再缩（只是继续跟着手指走）。
 *
 * 比例与数值都取自参考实现（微信朋友圈那套 `FriendCircleView`）：
 * `scale = 1 - |movY| / screenHeight`，且 `|movY| < screenHeight / 4` 时才更新。
 * **下限 0.75 就是那个 `if`**：早先我们用的是 `1 - 0.36 × (dy / 80dp 阈值)` ——
 * 同样拖 80dp 会缩到 0.64，用户实测反馈"缩得太小、也太快"，根因就是**把缩放绑在了关闭阈值上**。
 */
internal fun dismissScaleOf(dragFraction: Float): Float =
    (1f - dragFraction).coerceAtLeast(MIN_DRAG_SCALE)

/**
 * 拖拽期间遮罩的黑度：`1 - 2 × dragFraction`（即 `1 - dy ÷ (屏高/2)`），下限 [MIN_DRAG_ALPHA]。
 *
 * 同样取自参考实现。下限 0.5 对应参考里那句 `|movY| < screenHeight / 4` 的守卫：
 * 拖到屏高 1/4 时背景正好半透，再往下不再继续变透（画面还看得清，不会"飘在白底上"）。
 */
internal fun dragAlphaOf(dragFraction: Float): Float =
    (1f - 2f * dragFraction).coerceIn(MIN_DRAG_ALPHA, 1f)

/**
 * 遮罩透明度 = **「下拉那一段」× 「飞行那一段」**（M5.6）。
 *
 *  · 下拉时按 [dragAlphaOf] 变透（露出下面的页面，"缩小回卡片"的前半程）；
 *  · 飞行时按进度淡出（进场 0→1 淡入，退场 1→0 淡出）。
 *
 * 两段**相乘**而不是二选一：早先写成 `if (flying) progress else dragAlpha`，
 * 松手那一刻（`flying` 由 false 变 true）透明度会从"半透"**瞬间跳成全黑**再淡出 ——
 * 真机上就是"松手闪一下"（用户反馈"下滑退出会闪屏"）。
 *
 * 写成一个纯函数是为了能钉住这条"**接缝处不跳**"的约定（见 ViewerFlightGeometryTest）：
 * 拖到任意深度松手，`flying=false` 与 `flying=true` 两侧的值必须相等。
 */
internal fun viewerMaskAlpha(flying: Boolean, progress: Float, dragFraction: Float): Float {
    val dragAlpha = dragAlphaOf(dragFraction)
    return if (flying) progress.coerceIn(0f, 1f) * dragAlpha else dragAlpha
}

/** 下拉缩放的**下限**（参考实现里"拖到屏高 1/4 就不再缩"那条守卫） */
internal const val MIN_DRAG_SCALE = 0.75f

/** 下拉期间背景黑度的**下限**（拖到屏高 1/4 时正好半透） */
internal const val MIN_DRAG_ALPHA = 0.5f

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

/**
 * 等"来源那一格登记好"的上限（ms）。
 *
 * 正常情况下那一格早就登记过了（进详情页的地方一定能用鼠标点到它，它必然已经排过版）。
 * 等待期间进度为 0、飞行图画在来源格上（或直接不画），屏幕上没有变化，代价可以忽略。
 *
 * ★★ 2026-09-20：**从 120ms 提到 400ms**，为的是"点得比页面转场还快"这一种点法
 * （用户录屏里的第一次打开）。来源表现在只认**已落定**的矩形（见 [ViewerOrigins] 的类注释），
 * 而用户点图时那一页可能还在滑入 —— 那一小段时间里查不到来源，这里多等一会儿，
 * 页面落定后立刻就能拿到正确矩形、正常起飞。
 *
 * 为什么"多等"看不出延迟：这段等待正好与**页面自己的转场**重叠 —— 用户看到的是
 * "页面滑进来、图接着从那一格飞出去"，而不是"点了没反应"。等不到（页面一直没落定）
 * 才退化成直接落位（没有飞行，但**不会从一个错位的矩形飞出来**）。
 */
private const val ORIGIN_WAIT_MS = 400L

/** 等"全屏容器量出来"的上限（ms）。
 *
 * 只用于**兜底**：正常情况下容器在第一帧的布局阶段就有值（约 8ms 内）。
 * 超过这个时间还量不到，就按"直接落位"处理 —— 宁可没有飞行，也不能把用户留在空白覆盖层。
 */
private const val CONTAINER_WAIT_MS = 120L

/**
 * 等"这一张的宽高比就绪"的上限（ms）。
 *
 * 为什么允许等：缺宽高比时落位矩形只能退回**整个容器**，飞过去就是"铺满屏幕再缩回去"
 * （用户实测反馈的那个 bug）。而宽高比到达得很快 —— 飞行层那张图的请求带
 * `placeholderMemoryCacheKey`（缩略图，格子刚显示过，通常已在内存缓存里），
 * 第一两帧就能上报；原图解码也就几十毫秒（打开前还会 `preloadViewerImage` 预热）。
 *
 * 与 [CONTAINER_WAIT_MS] 同一个量级：等待期间进度是 0、飞行图画在来源格上，屏幕上没有变化，
 * 所以"多等一会儿"的代价远小于"飞一个错的矩形"。等不到就**不起飞**（直接落位）。
 */
private const val ASPECT_WAIT_MS = 120L
