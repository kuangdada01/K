package top.kuangdada.k.nativeapp.ui

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.view.Window
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.AnimationVector1D
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsAnimationCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import coil3.SingletonImageLoader
import coil3.compose.rememberAsyncImagePainter
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import top.kuangdada.k.core.designsystem.theme.KMotion
import top.kuangdada.k.core.designsystem.theme.KTheme
import top.kuangdada.k.core.designsystem.theme.LocalAnimationsEnabled
import top.kuangdada.k.nativeapp.ui.viewer.ZoomableImage
import top.kuangdada.k.nativeapp.ui.viewer.viewerImageRequest
import kotlin.math.roundToInt

/**
 * ============================================================
 * 图片查看器（重写版）
 * ============================================================
 * 目标只有一个：**做成微信朋友圈那套**。旧版是 M5 → M5.10 十来轮补丁叠出来的，
 * 每一轮都在给上一轮的副作用打补丁（文件里留了大量"别再试某某方向"的注释）。
 * 这一版把那套状态机整个换掉，只保留被真机证明过的两样东西：
 *
 *  · [ViewerOrigins]（缩略格登记表）—— "这一张是从哪一格点开的"，含宽高比与圆角；
 *  · 飞行图**只布局一次、每帧只走绘制期**的做法（旧版 M5.7 的结论，是对的）。
 *
 * 下面每一条都对应一个**用户能看见的旧毛病**：
 *
 * 1. **转场只有一条时间轴**。旧版把几何挂在弹簧的**值**上、把遮罩又挂在另一个 Animatable 上，
 *    再加上容器/来源/宽高比三个"等待"分支，一共四种落位路径 —— 首次打开走哪条全看运气。
 *    现在：几何与遮罩**同一条 tween、同一个时长**（[HERO_MS]），进/退各一条，路径唯一。
 * 2. **不再阻塞等宽高比**。旧版进场前会**同步**把原图取一遍（`ImageLoader.execute`）来拿宽高比，
 *    首次打开必然先卡一下。宽高比在点下去那一刻其实已经在登记表里（缩略格的 painter 早就加载完了），
 *    这里先读表，读不到只给两帧机会，再没有就退化成淡入 —— **绝不在起飞前干等**。
 * 3. **关闭一定有动画**。旧版三条早退分支里任意一条命中就直接 `snapTo(0)` —— 图是"啪"一下消失的。
 *    现在只有两种收场：有料就飞回缩略格，没料就淡出，不存在硬切。
 * 4. **放大态不再禁止翻页**（旧版 `userScrollEnabled = !zoomed`）：横滑到图片边缘后多余位移
 *    **接力给翻页器**，一直滑就能从第 1 张翻到第 2 张，中间不用先缩回 1x。见 [ZoomableImage]。
 * 5. **页码改成微信那样的底部圆点**（旧版是顶部 `1 / 9` 文字）。
 * 6. **首次打开掉帧**：解码尺寸从 `Size.ORIGINAL` 改成屏幕分辨率（见 [viewerImageRequest]），
 *    12MP 原图从 48MB 位图降到约 18MB，纹理上传与 GC 都不再顶掉动画的头几帧。
 *
 * @param request 打开请求（含每张图各自的来源矩形，见 [ViewerOrigins]）
 * @param closing Shell 请求关闭（返回键）：与"点画面 / 下拉过阈值"汇入同一条退场飞行
 */

/**
 * 进/退飞行的时长与曲线：**几何与遮罩共用这一条**，所以两者天生同起同止。
 *
 * 时长取设计令牌 [KMotion.medium]（260ms），与用户录屏里量到的微信飞行（245~250ms）同量级；
 * 曲线取 [KMotion.standard]（`cubic-bezier(.2,.8,.2,1)`）—— 起步快、收尾缓，
 * 与录屏里"图片前 100ms 走完大半行程"的减速特征一致。
 *
 * ★ 为什么不用弹簧（旧版用的就是弹簧）：弹簧的**值**在时间上极不均匀（到 0.84 只用了一半时长），
 *   一旦有人拿这个值去驱动别的东西（旧版的遮罩就是这么坏的），节奏立刻错位。
 *   转场期间手势是被屏蔽的（不能翻页、点击不响应），所以"可打断"这个弹簧优势也用不上，
 *   换成定长 tween 反而**可预测、可测量、可单测**。
 */
private const val HERO_MS = KMotion.medium

/** 缺料时的退化淡入/淡出时长（没有来源格或没有宽高比，飞不起来） */
private const val FADE_MS = KMotion.quick

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
     * 详情页单图最典型 —— 图片加载完成前它只有 4:3 的占位高，加载完才按真比例撑开。
     * 快照一旦作废，退场就会飞回一个"那个位置上现在并不是那张图"的矩形，落位拔掉覆盖层时
     * 真图出现在别处 —— 用户实测原话：**"退出到位置的时候又跳动一下才复位"**。
     *
     * null = 没有实时来源（Preview / 单测 / 不在 Shell 里）：退回 [origins] 那份快照。
     */
    val resolveOrigin: ((page: Int) -> ViewerOrigin?)? = null,
    /**
     * **进/退飞行时要避让的顶栏底边**（窗口像素；0 = 不避让）。
     *
     * 要解决的问题（用户实测）：进出全屏时，飞行那一张会**压在顶栏上面**。
     * 修法不是改透明度，而是把那一条**从绘制里裁掉**（见 [FlyingLayer] 的 `topClipPx`）：
     * 顶栏区域于是露出底下的页面本身 —— 观感正是"图片钻到顶栏后面"。
     * 不越过顶栏时等于不裁，所以起飞帧与来源缩略格仍逐像素一致。
     */
    val topInsetPx: Float = 0f,
)

/**
 * 打开查看器。默认是**空实现**，所以调用方不需要判空 ——
 * 不在 Shell 里（Preview、单测、StyleGuide）时静默无效。
 */
val LocalImageViewerOpener = staticCompositionLocalOf<(ImageViewerRequest) -> Unit> { {} }

/**
 * 打开查看器**之前**先把这一张原图解码好（后台线程，不阻塞点击）。
 *
 * 飞行本身有两百多毫秒，解码正好在飞行期间完成 —— 等查看器组合出来时它已经是内存命中。
 * 只预解码**当前这一张**：预解码全部就是替用户决定他一定会翻页，白白吃内存。
 *
 * 必须与查看器用**同一个** [viewerImageRequest]（尺寸/缓存键都要一致），否则等于没预解码。
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
 * Shell 只在 `viewer != null` 时组合它；退场由它自己播完再回调 [onClosed]，
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
    // 固定深色：看图场景不跟随浅色主题
    KTheme(darkTheme = true) {
        val animationsEnabled = LocalAnimationsEnabled.current
        val viewerContext = LocalContext.current
        val scope = rememberCoroutineScope()
        val pagerState = rememberPagerState(initialPage = request.index) { request.images.size }

        // 把当前页同步给 Shell：返回键关闭时也要知道"停在第几张"
        LaunchedEffect(pagerState.currentPage) { onPageChanged(pagerState.currentPage) }

        /** 覆盖层（= 全屏容器）在窗口里的矩形：飞行几何的参照系 */
        var container by remember { mutableStateOf(Rect.Zero) }
        /** 飞行进度：0 = 还停在来源那一格，1 = 全屏落位 */
        val flight = remember { Animatable(0f) }
        /**
         * 遮罩（背景黑幕）的进度：与 [flight] **同时长、同起止**，但走**时间线性**曲线。
         *
         * ★★ 为什么遮罩不复用 [flight] 的值：遮罩要的是"时间上的均匀推进"，
         * 而任何缓动（弹簧或 ease-out）都会把"值"在时间上压得前重后轻。
         * 用户第二份录屏（Record_2026-10-02-14-53-15）逐帧量出来的真相是：
         * 遮罩按时间近乎匀速地铺满**整段**飞行（τ=0.5 时进场 0.58、退场 0.49），
         * 所以这里必须拿一条独立的、线性的时间轴去喂 [flightMaskAlphaOf]。
         */
        val maskT = remember { Animatable(0f) }
        /** 转场进行中（飞行或退化淡入/淡出）：遮罩跟 [maskT]，页面手势全禁 */
        var transitioning by remember { mutableStateOf(true) }
        /** 飞行那一张是否参与绘制（退化淡入/淡出时为 false） */
        var heroVisible by remember { mutableStateOf(true) }
        /**
         * 轮播整体的不透明度。只在**退化路径**（没有来源格可落位，飞不起来）动用它：
         * 那种情况下画面与黑幕一起交叉溶解 —— 旧版是直接 `snapTo` 硬切，图"啪"一下就没了。
         * 正常飞行路径不碰它：飞行图与轮播在交接帧逐像素一致，靠 [heroVisible] 切换即可。
         */
        val pageAlpha = remember { Animatable(1f) }
        /** 退场已经开始 */
        var leaving by remember { mutableStateOf(false) }
        /** 退场起点：请求关闭那一刻这一张在屏幕上的真实矩形 */
        var leaveFrom by remember { mutableStateOf(Rect.Zero) }

        // —— 下拉关闭的实时状态（跟手 1:1；只在绘制期读，见 dismissScaleOf 的注释）——
        var dragOffset by remember { mutableStateOf(Offset.Zero) }
        var dragFraction by remember { mutableFloatStateOf(0f) }
        var dragPivot by remember { mutableStateOf<Offset?>(null) }

        // —— 缩放/平移的实时数值（退场起点要把它们算进去，画面才不会跳）——
        var zoomScale by remember { mutableFloatStateOf(1f) }
        var zoomOffset by remember { mutableStateOf(Offset.Zero) }
        var zoomed by remember { mutableStateOf(false) }

        val currentPage = pagerState.currentPage
        /**
         * 当前这一张的来源。
         *
         * ★ 用**状态对象**而不是 `val origin = remember { ... }`：协程 lambda 捕获的是
         *   局部变量的快照，那样在协程里永远只能读到首次组合的那一份值。
         *   `originState.value` 在任何 lambda 里读到的都是实时值。
         */
        val originState = remember {
            mutableStateOf(
                request.resolveOrigin?.invoke(request.index)
                    ?: request.origins.getOrNull(request.index),
            )
        }
        val origin = originState.value
        val sourceRect = origin?.rect
        /** 来源缩略格的圆角（px）：出发/落位帧要与格子严丝合缝，全屏那一端才是直角 */
        val sourceRadiusPx = origin?.cornerRadiusPx ?: 0f

        /**
         * 每一张自己的宽高比（由屏幕上真正显示的那张上报，作为登记表之外的兜底）。
         * 按**页号**存而不是只存当前页：相邻页是预加载的，可能在成为当前页之前就加载完了。
         */
        val pageAspects = remember { mutableStateMapOf<Int, Float>() }
        val aspect = origin?.aspect ?: pageAspects[currentPage]

        /**
         * 全屏落位矩形：按**原图宽高比**在容器里 Fit。
         *
         * 宽高比未知时退回容器矩形（明确的退化值）；真正的守卫在 [FlyingLayer]：
         * `targetRect` 没就绪就一个像素都不画，`flight` 也停在 0 ——
         * 于是"屏幕上第一张画出来的图"就是首帧飞行图，不会出现"先空一下"。
         */
        val targetRect = remember(container, aspect) {
            if (container.width <= 0f || container.height <= 0f) Rect.Zero
            else fitRectIn(container, aspect)
        }

        /**
         * 这一张现在在屏幕上的矩形 —— 退场飞行的起点。
         *
         * 三件变换按真实绘制顺序叠加（与轮播那边**同一套公式**，所以起点不会有任何"跳"）：
         *   1. 落位矩形（全屏 Fit）；
         *   2. 捏合/双击缩放：绕**容器中心**；
         *   3. 下拉：位移 + 绕**按下点**的缩放。
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
            transitioned@ run {
                val fresh = request.resolveOrigin?.invoke(pagerState.currentPage)
                    ?: request.origins.getOrNull(pagerState.currentPage)
                if (fresh != null) originState.value = fresh
            }
            // 起飞那一帧的"全屏矩形"也按**刚拿到的宽高比**重算：这一次解析可能刚刚才把
            // 宽高比带进来，用旧值会让退场从一个"铺满屏幕"的假起点开始
            val leaveTarget = fitRectIn(container, originState.value?.aspect ?: aspect)
            leaveFrom = from ?: visualRect(leaveTarget)
            transitioning = true
            heroVisible = true
            onRequestClose()
        }

        /**
         * 进场。
         *
         * 三个刻意的选择（每一条都对着旧版的一个真机问题）：
         *  · **容器没量出来就什么都不做**（不是落位）：`onGloballyPositioned` 要等布局阶段，
         *    首次组合时 `container` 还是零矩形，那时落位等于"进场飞行整个被跳过"；
         *  · **只给来源/宽高比两帧机会**：它们在点下去那一刻就该在登记表里了（缩略格早就排完版），
         *    真要等也只能是"页面刚落定"那一两帧。旧版这里会**同步取一次原图**去拿宽高比，
         *    首次打开必然卡一下 —— 已删除，宁可不飞（淡入）也不干等；
         *  · **不飞也要有动画**：缺料时走淡入，绝不硬切。
         */
        LaunchedEffect(Unit) {
            val measured = withTimeoutOrNull(CONTAINER_WAIT_MS) {
                snapshotFlow { container }.first { it.width > 0f }
                true
            } ?: false
            if (leaving || flight.value >= 1f) return@LaunchedEffect
            if (!measured || !animationsEnabled) {
                flight.snapTo(1f); maskT.snapTo(1f)
                transitioning = false; heroVisible = false
                return@LaunchedEffect
            }
            // 给轮播一帧把首帧成本消化掉（它的图与飞行图共用内存缓存，一帧足够）
            withFrameNanos { }
            if (leaving) return@LaunchedEffect
            if (originState.value?.rect == null || originState.value?.aspect == null) {
                withTimeoutOrNull(ORIGIN_WAIT_MS) {
                    snapshotFlow { originState.value?.let { it.rect != null && it.aspect != null } }
                        .first { it }
                }
            }
            if (leaving) return@LaunchedEffect
            val canFly = originState.value?.rect != null && aspect != null
            if (!canFly) {
                // 缺料：淡入（画面直接落位，黑幕从透明浮上来）。**不硬切、不空等**
                heroVisible = false
                scope.launch {
                    coroutineScope {
                        launch { maskT.animateTo(1f, tween(FADE_MS, easing = LinearEasing)) }
                        launch { flight.snapTo(1f) }
                    }
                    transitioning = false
                }
                return@LaunchedEffect
            }
            heroVisible = true
            coroutineScope {
                launch { flight.animateTo(1f, tween(HERO_MS, easing = KMotion.standard)) }
                launch { maskT.animateTo(1f, tween(HERO_MS, easing = LinearEasing)) }
            }
            transitioning = false
        }

        // 返回键：Shell 把 closing 置真（点画面那条也用它，两条路完全一致）
        LaunchedEffect(closing) { if (closing) beginLeave(null) }

        /**
         * 退场：缩回来源格 → 再通知 Shell 卸载。
         *
         * ★ 这里**没有**旧版那三条"缺料就 snapTo(0)"的分支 —— 缺料走淡出。
         *   旧版任意一条命中就是"图啪一下消失"，用户反馈的"关闭动画不好"里有一部分就是它。
         */
        LaunchedEffect(leaving) {
            if (!leaving) return@LaunchedEffect
            // 先空一帧：beginLeave 在同一次快照里翻了 leaving/transitioning（可能还有 Shell 的
            // viewerClosing），那一帧要重组 Shell + 覆盖层，这笔一次性成本不该压在动画头几帧上
            withFrameNanos { }
            val canFly = animationsEnabled &&
                originState.value?.rect != null &&
                (originState.value?.aspect ?: aspect) != null
            if (canFly) {
                coroutineScope {
                    launch { flight.animateTo(0f, tween(HERO_MS, easing = KMotion.standard)) }
                    launch { maskT.animateTo(0f, tween(HERO_MS, easing = LinearEasing)) }
                }
            } else {
                // 没有可落位的格子：把遮罩与飞行图一起淡掉（飞行图随 maskT 淡出，见下面的 alpha）
                heroVisible = true
                launchFadeOut(maskT)
                flight.snapTo(0f)
            }
            // 落位帧先画一帧再卸载：flight=0 的飞行图与缩略格逐像素一致，这一帧是白送的，
            // 把"卸载整个覆盖层"的成本从动画最后一帧挪出去
            withFrameNanos { }
            onClosed(pagerState.currentPage)
        }

        /**
         * 飞行期间**逐帧重取来源矩形**（代价：每帧一次查表，且只在值真的变了才写状态）。
         *
         * 少了这条，"查看器打开期间来源那一格才排完版"就只能靠运气：起飞那一刻读到什么就是什么。
         * 有它之后，起飞帧与落位帧始终贴在"那一格当下真实的位置"上。
         *
         * ★ 循环用 `while (true)` 而不是"读到结束标志就退出"：协程 lambda 捕获的是
         *   **首次组合的局部变量快照**，在这里读 `transitioning` 永远读到 true。
         *   退出交给外层的 `LaunchedEffect(transitioning)` —— 它一变，整个协程就被取消。
         */
        LaunchedEffect(transitioning) {
            if (!transitioning) return@LaunchedEffect
            while (true) {
                withFrameNanos { }
                val page = pagerState.currentPage
                val next = request.resolveOrigin?.invoke(page) ?: request.origins.getOrNull(page)
                if (next != null && next != originState.value) originState.value = next
            }
        }

        // 转场期间图片加载让路（见 AnimationGate）：查看器自己那张走 ImageLoading.immediate
        val gateToken = remember { Any() }
        DisposableEffect(transitioning) {
            if (transitioning) {
                AnimationGate.begin(gateToken)
                onDispose { AnimationGate.end(gateToken) }
            } else {
                onDispose { }
            }
        }

        /**
         * 全屏沉浸：看图期间**隐藏状态栏**（微信全屏看图就是藏的）。
         *
         * **关键：把页面拿到的 statusBars inset 冻结在打开那一刻的高度。**
         * 状态栏藏/还必然改 insets，底下的页面会整体回流一个状态栏高。解法与微信的独立窗口同语义：
         * 改写装饰视图的派发，让页面以为状态栏一直都在，**纹丝不动**。
         */
        val view = LocalView.current
        val frozenStatusBar = remember { mutableIntStateOf(0) }
        DisposableEffect(Unit) {
            val window = view.context.findWindow()
            val decor = window?.decorView
            if (decor != null) {
                ViewCompat.setOnApplyWindowInsetsListener(decor) { _, insets ->
                    val frozen = frozenStatusBar.intValue
                    if (frozen <= 0) {
                        insets
                    } else {
                        WindowInsetsCompat.Builder(insets)
                            .setInsets(
                                WindowInsetsCompat.Type.statusBars(),
                                androidx.core.graphics.Insets.of(0, frozen, 0, 0),
                            )
                            .build()
                    }
                }
                // 动画路径也要拦：状态栏藏/还是系统**动画**，动画期间每帧走
                // WindowInsetsAnimationCompat 回调派发，静态改写拦不住它
                ViewCompat.setWindowInsetsAnimationCallback(
                    decor,
                    object : WindowInsetsAnimationCompat.Callback(
                        WindowInsetsAnimationCompat.Callback.DISPATCH_MODE_STOP,
                    ) {
                        override fun onProgress(
                            insets: WindowInsetsCompat,
                            runningAnimations: List<WindowInsetsAnimationCompat>,
                        ): WindowInsetsCompat = insets
                    },
                )
            }
            onDispose {
                frozenStatusBar.intValue = 0
                if (decor != null) {
                    ViewCompat.setOnApplyWindowInsetsListener(decor, null)
                    ViewCompat.setWindowInsetsAnimationCallback(decor, null)
                }
                window?.let { w ->
                    WindowCompat.getInsetsController(w, view).show(WindowInsetsCompat.Type.statusBars())
                }
            }
        }
        LaunchedEffect(Unit) {
            val window = view.context.findWindow() ?: return@LaunchedEffect
            val controller = WindowCompat.getInsetsController(window, view)
            frozenStatusBar.intValue = ViewCompat.getRootWindowInsets(view)
                ?.getInsets(WindowInsetsCompat.Type.statusBars())?.top ?: 0
            controller.systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller.hide(WindowInsetsCompat.Type.statusBars())
        }
        LaunchedEffect(leaving) {
            if (!leaving) return@LaunchedEffect
            view.context.findWindow()?.let { window ->
                WindowCompat.getInsetsController(window, view).show(WindowInsetsCompat.Type.statusBars())
            }
        }

        Box(
            modifier = Modifier
                .fillMaxSize()
                .onGloballyPositioned { container = it.boundsInWindow() },
        ) {
            /**
             * 遮罩。alpha 在**绘制期**读（`graphicsLayer` 的 lambda 里）：进度每帧都变，
             * 在组合期读会把整棵覆盖层（**包括轮播**）每帧重组一次。
             *
             * 透明度 = 「下拉那一段」×「转场那一段」，两段**相乘**而不是二选一 ——
             * 松手那一刻（`transitioning` 翻真）才不会从"半透"瞬间跳成全黑。
             */
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .graphicsLayer {
                        alpha = viewerMaskAlpha(transitioning, maskT.value, dragFraction)
                    }
                    .background(Color.Black),
            )

            HorizontalPager(
                state = pagerState,
                /**
                 * ★ **翻页手势由我们自己的手势引擎驱动**（见 [ZoomableImage] 的"边缘接力"）。
                 * 交给 pager 自己处理的话，"放大态横滑到边缘继续翻页"做不到 ——
                 * 内置 scrollable 一旦在起手被消费过就整段手势不再介入。
                 */
                userScrollEnabled = false,
                modifier = Modifier
                    .fillMaxSize()
                    // 飞行期间它**保持组合但不可见**：首帧成本在飞行开始前就消化掉了，
                    // 交接时它的图也已经在内存里。同样在绘制期读，避免为一次显隐重组轮播。
                    .graphicsLayer { alpha = if (heroVisible) 0f else 1f }
                    /**
                     * 位移与缩放**都在绘制期**：下拉是每帧写状态的，布局期的 `.offset{}`
                     * 每帧都要让轮播重新放置一次 —— 那正是旧版"下滑不跟手"的成因。
                     *
                     * 映射与 `visualRect()` / [transformRect] 逐字一致：
                     * `screen(q) = pivot + (q - pivot) × scale + translation`，
                     * 所以退场飞行的起点与屏幕上看到的分毫不差。
                     */
                    .graphicsLayer {
                        val s = dismissScaleOf(dragFraction)
                        scaleX = s
                        scaleY = s
                        translationX = dragOffset.x
                        translationY = dragOffset.y
                        val pivot = dragPivot
                        if (pivot != null && size.width > 0f && size.height > 0f) {
                            transformOrigin = TransformOrigin(pivot.x / size.width, pivot.y / size.height)
                        }
                    },
            ) { pageIndex ->
                ZoomableImage(
                    url = request.images[pageIndex],
                    headers = request.headers,
                    contentDescription = "第 ${pageIndex + 1} 张图片",
                    active = pageIndex == currentPage && !transitioning,
                    onTap = { if (!transitioning && !leaving) beginLeave(null) },
                    onDismissDrag = { dx, dy, fraction, down ->
                        // 只有当前页参与下拉关闭（相邻页是预加载的，不该跟着动）
                        if (pageIndex == pagerState.currentPage) {
                            dragOffset = Offset(dx, dy)
                            dragFraction = fraction
                            // 锚点只记第一次：按下点在整个手势里不变
                            if (dragPivot == null) dragPivot = down
                        }
                    },
                    onDismissEnd = { commit ->
                        if (pageIndex == pagerState.currentPage) {
                            if (commit) {
                                // 起点 = 松手那一刻屏幕上的矩形（含位移与缩放），接着从这里飞回缩略格
                                beginLeave(visualRect())
                            } else {
                                // 未达阈值：**弹簧回弹**（不是瞬间归零）—— 瞬归零像"图片自己弹回去了"
                                val fromOffset = dragOffset
                                val fromFraction = dragFraction
                                scope.launch {
                                    animate(
                                        initialValue = 1f,
                                        targetValue = 0f,
                                        animationSpec = KMotion.spatial(),
                                    ) { t, _ ->
                                        dragOffset = fromOffset * t
                                        dragFraction = fromFraction * t
                                    }
                                    // 回弹结束才清锚点：清早了，回弹途中缩放会突然改回"绕中心缩"
                                    dragPivot = null
                                }
                            }
                        }
                    },
                    /**
                     * 横向位移交给翻页器（**边缘接力**）。
                     *
                     * 返回实际被吃掉的量：贴到第一张/最后一张时吃不下（返回 0），
                     * 于是那一轴退回"越界阻尼 + 回弹"，不会出现"手指在动、画面全死"。
                     */
                    onPageScroll = { delta ->
                        if (transitioning || request.images.size <= 1) 0f
                        else pagerState.dispatchRawDelta(delta)
                    },
                    onPageScrollEnd = { velocity ->
                        if (!transitioning && request.images.size > 1) {
                            val pageWidth = container.width.coerceAtLeast(1f)
                            // 速度是按 px/s 给的：乘以一个"投影时间"折成位移，再换成页数
                            val projected = velocity * PAGER_FLING_PROJECTION_S / pageWidth
                            val position = pagerState.currentPage + pagerState.currentPageOffsetFraction
                            val target = (position + projected)
                                .roundToInt()
                                .coerceIn(0, request.images.size - 1)
                            scope.launch {
                                pagerState.animateScrollToPage(target, animationSpec = KMotion.spatialBounded())
                            }
                        }
                    },
                    onZoomChanged = { zoomed = it },
                    onTransform = { s, o ->
                        zoomScale = s
                        zoomOffset = o
                    },
                    onImageAspect = { pageAspects[pageIndex] = it },
                    modifier = Modifier.fillMaxSize(),
                )
            }

            /**
             * 飞的那一张：在来源缩略格 ↔ 全屏落位矩形之间插值。
             * 进度只在绘制期读，所以飞行期间整棵覆盖层的组合与布局都是静止的。
             */
            FlyingLayer(
                flight = flight,
                maskT = maskT,
                heroVisible = heroVisible,
                leaving = leaving,
                sourceRect = sourceRect,
                sourceRadiusPx = sourceRadiusPx,
                targetRect = targetRect,
                leaveFrom = leaveFrom,
                container = container,
                url = request.images[currentPage],
                headers = request.headers,
                onAspect = { pageAspects[currentPage] = it },
                topClipPx = request.topInsetPx,
            )

            /**
             * 页码：微信那样的**底部圆点**（旧版是顶部 `1 / 9` 文字）。
             * 跟着遮罩同一条曲线淡入/淡出，避免"页码先于图片出现/迟到"。
             */
            if (request.images.size > 1) {
                ViewerDots(
                    count = request.images.size,
                    current = currentPage,
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .padding(bottom = DOTS_BOTTOM_PADDING)
                        .graphicsLayer { alpha = if (transitioning) flightMaskAlphaOf(maskT.value) else 1f },
                )
            }
        }
    }
}

/**
 * 退场时"没有可落位的格子"的退化路径：把遮罩与飞行图一起淡掉。
 *
 * 单独抽出来只为让 [ImageViewerOverlay] 的退场分支读起来是一条线（见那边的注释）。
 */
private suspend fun launchFadeOut(maskT: Animatable<Float, AnimationVector1D>) {
    maskT.animateTo(0f, tween(FADE_MS, easing = LinearEasing))
}

/** 底部圆点的下边距（safeDrawing 之上再加一点，避免贴到手势条） */
private val DOTS_BOTTOM_PADDING = 26.dp

/** 页码圆点（微信朋友圈样式：当前白色实心、其余半透明白；只有一张时不显示） */
@Composable
private fun ViewerDots(count: Int, current: Int, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier.padding(WindowInsets.navigationBars.asPaddingValues()),
        horizontalArrangement = Arrangement.spacedBy(7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        repeat(count) { i ->
            val active = i == current
            Box(
                modifier = Modifier
                    .size(if (active) 8.dp else 6.dp)
                    .clip(CircleShape)
                    .background(if (active) Color.White else Color.White.copy(alpha = 0.42f)),
            )
        }
    }
}

/**
 * 飞行层：把那一张在「来源缩略格 ↔ 全屏落位矩形」之间插值（退场终点是"请求关闭那一刻的
 * 真实矩形" [leaveFrom]）。
 *
 * **飞行全程零重组、零重排**（旧版 M5.7 的结论，保留）：
 *  · 飞行图按**落位矩形**（`targetRect`）只布局一次；
 *  · 每帧的变化全部走绘制：`graphicsLayer` 里按 [flight] 算**等比缩放 + 平移**，把
 *    "铺满落位矩形的内容"变换到当前矩形上 —— 覆盖系数取两轴较大者，与 `ContentScale.Crop`
 *    的取景规则逐像素等价（见 [cropOverScaleOf]）；
 *  · `drawWithContent` 里按 [flight] 裁出当前矩形（圆角 + 顶栏避让一起做）。
 *
 * **圆角在裁剪里做，不在层的 shape 上**：飞行图的层被缩放了，shape 圆角会跟着缩放
 * （半径单位变成"落位矩形的像素"）；裁剪发生在绘制坐标系，半径始终是**屏幕像素**。
 *
 * ★ **不飞的时候它也留在组合里**（`alpha = 0`），不能 `return` 掉：一旦离开组合，
 *   退场起飞那一瞬间 painter 要**重新建一次请求** —— 新 painter 的第一帧没有画面、
 *   接着先出缩略图占位再换成原图，而轮播此刻已经被藏起来了，屏幕上就是
 *   "图片先消失一两帧、再糊着回来"。
 */
@Composable
private fun FlyingLayer(
    flight: Animatable<Float, AnimationVector1D>,
    maskT: Animatable<Float, AnimationVector1D>,
    heroVisible: Boolean,
    leaving: Boolean,
    sourceRect: Rect?,
    sourceRadiusPx: Float,
    targetRect: Rect,
    leaveFrom: Rect,
    container: Rect,
    url: String,
    headers: Map<String, String>,
    onAspect: (Float) -> Unit,
    topClipPx: Float,
) {
    if (sourceRect == null || container.width <= 0f) return
    // 进场时落位矩形必须先就绪：容器还没量出来 / 宽高比还没到 → `targetRect` 是零矩形，
    // 这时候**一个像素都不要画**（画了就是"首帧空一帧"）。
    // 退场不看这条：那时 `leaveFrom` 是请求关闭那一刻的真实矩形，与 target 无关。
    if (!leaving && targetRect.width <= 1f) return
    val density = LocalDensity.current
    val context = LocalContext.current
    val request = remember(context, url, headers) { viewerImageRequest(context, url, headers) }
    val painter = rememberAsyncImagePainter(model = request)
    val aspect = painter.aspectOrNull()
    LaunchedEffect(aspect) {
        if (aspect != null && aspect > 0f) onAspect(aspect)
    }
    /** 进度 t 对应的屏幕矩形（**只在绘制期被调用**） */
    fun rectAt(t: Float): Rect = lerpRect(sourceRect, if (leaving) leaveFrom else targetRect, t)

    Box(
        modifier = Modifier
            .fillMaxSize()
            .drawWithContent {
                if (!heroVisible) return@drawWithContent
                val t = flight.value.coerceIn(0f, 1f)
                val rect = rectAt(t)
                // 矩形是窗口坐标，换算成本 Box（= 容器）的局部坐标
                val local = Rect(
                    rect.left - container.left,
                    rect.top - container.top,
                    rect.right - container.left,
                    rect.bottom - container.top,
                )
                if (local.width < 1f || local.height < 1f) return@drawWithContent
                // 顶栏那一条不画（见 ImageViewerRequest.topInsetPx）：露出的是底下的页面本身，
                // 观感 = 图片钻到顶栏后面。图还没越过顶栏时等于不裁。
                val cut = (topClipPx - container.top).coerceAtLeast(local.top)
                fun drawAvoidingTopBar() {
                    if (cut > local.top) {
                        clipRect(left = local.left, top = cut, right = local.right, bottom = local.bottom) {
                            this@drawWithContent.drawContent()
                        }
                    } else {
                        this@drawWithContent.drawContent()
                    }
                }
                // 圆角随进度变化（屏幕像素）：接近直角的帧走免分配的 clipRect，
                // 真正有圆角的帧（进出两端的头几帧）才建 Path
                val radius = lerpCornerRadius(sourceRadiusPx, t)
                if (radius >= 0.5f) {
                    val path = Path()
                    path.addRoundRect(RoundRect(local, CornerRadius(radius)))
                    clipPath(path) { drawAvoidingTopBar() }
                } else {
                    clipRect(local.left, local.top, local.right, local.bottom) { drawAvoidingTopBar() }
                }
            },
    ) {
        androidx.compose.foundation.Image(
            painter = painter,
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = Modifier
                .offset {
                    IntOffset(
                        (targetRect.left - container.left).roundToInt(),
                        (targetRect.top - container.top).roundToInt(),
                    )
                }
                .size(
                    width = with(density) { targetRect.width.toDp() },
                    height = with(density) { targetRect.height.toDp() },
                )
                .graphicsLayer {
                    val t = flight.value.coerceIn(0f, 1f)
                    val rect = rectAt(t)
                    // "按落位矩形布局的 Crop 内容"等比缩放并平移到 rect(t)。
                    // 覆盖系数取两轴较大者 = ContentScale.Crop 的取景规则：
                    // 缩小方向覆盖来源格（中心裁剪），放大方向铺回全屏（完整显示）。
                    val over = cropOverScaleOf(targetRect, rect)
                    scaleX = over
                    scaleY = over
                    transformOrigin = TransformOrigin(0.5f, 0.5f)
                    translationX = rect.center.x - targetRect.center.x
                    translationY = rect.center.y - targetRect.center.y
                    // ★ 淡出路径（没有来源格可落位）下，飞行图跟着遮罩一起淡掉：
                    //   直接摘掉它就是"图啪一下消失"（旧版正是如此）
                    alpha = if (heroVisible) 1f else 0f
                },
        )
    }
}

/** 逐层拆 ContextWrapper 找到 Activity 的 window（沉浸模式的入口；不在 Activity 里则 null） */
private tailrec fun Context.findWindow(): Window? = when (this) {
    is Activity -> window
    is ContextWrapper -> baseContext.findWindow()
    else -> null
}

/**
 * 圆角随飞行进度变化：t=0（停在来源缩略格上）是**格子的圆角**，t=1（全屏落位）是**直角**。
 *
 * 进场 t: 0→1、退场 t: 1→0，同一个公式两个方向都对 —— 两端因此与"缩略格 / 全屏"严丝合缝，
 * 中途也不会出现"缩略图的圆角突然变直角"（用户实测反馈过）。
 */
internal fun lerpCornerRadius(fromPx: Float, t: Float): Float =
    fromPx * (1f - t).coerceIn(0f, 1f)

/**
 * 「越拉越小」：下拉过程中图片**按屏幕高的比例**等比缩小。
 *
 * `dragFraction = dy ÷ 屏幕高`，所以拖到屏高 1/6（= 关闭阈值那一点）只缩到 **0.83**；
 * 拖到屏高 1/4 缩到 **0.75**，再往下不再缩（只是继续跟着手指走）。
 *
 * 比例与数值都取自参考实现（微信朋友圈那套 `FriendCircleView`）：
 * `scale = 1 - |movY| / screenHeight`，且 `|movY| < screenHeight / 4` 时才更新。
 * **下限 0.75 就是那个 `if`**：早先用的是 `1 - 0.36 × (dy / 80dp 阈值)` ——
 * 同样拖 80dp 会缩到 0.64，用户实测反馈"缩得太小、也太快"，根因就是**把缩放绑在了关闭阈值上**。
 */
internal fun dismissScaleOf(dragFraction: Float): Float =
    (1f - dragFraction).coerceAtLeast(MIN_DRAG_SCALE)

/**
 * 拖拽期间遮罩的黑度：`1 - 2 × dragFraction`（即 `1 - dy ÷ (屏高/2)`），下限 [MIN_DRAG_ALPHA]。
 * 同样取自参考实现；下限 0.5 对应参考里那句 `|movY| < screenHeight / 4` 的守卫。
 */
internal fun dragAlphaOf(dragFraction: Float): Float =
    (1f - 2f * dragFraction).coerceIn(MIN_DRAG_ALPHA, 1f)

/**
 * 转场段遮罩的透明度曲线：**整段飞行上铺满一条 smoothstep**。
 *
 * 输入是 [ImageViewerOverlay] 里那个**按时间线性推进**的 `maskT`（0↔1 恰好等于
 * 转场的开始与结束），**不是**几何缓动后的值 —— 这个区别就是"像不像微信"的根因。
 *
 * 依据（用户录屏 Record_2026-10-02-14-53-15，85fps VFR，逐帧实测；测量方法：黑遮罩是
 * "整页乘以 (1-a)"，取全屏照片上下两条**静态背景带**算逐像素比值，中位数即 1-a；
 * 两条带独立测出的曲线逐帧相差 ≤0.003，比值 std ≤0.06 —— 排除了页面位移/内容变化）：
 *
 * ```
 * 转场进度 τ   0.10  0.20  0.30  0.40  0.50  0.60  0.70  0.80  0.90
 * 进场遮罩     0.01  0.09  0.20  0.44  0.58  0.79  0.91  0.97  0.99
 * 退场遮罩     0.96  0.87  0.77  0.63  0.49  0.36  0.21  0.11  0.03
 * ```
 *
 * 也就是"按时间近乎匀速地压黑/放亮"，两端斜率为 0（与静止状态衔接不跳）。
 * 顺带纠正一条被推翻的旧结论：旧版认为遮罩"只在大图占屏的头尾两端存在"、
 * 中段背景全亮 —— 那是把**弹簧的值**当成了时间轴（弹簧到 0.84 只用一半时长），
 * 于是整条遮罩被压进前 30% 的时长里，退场头 28% 就全亮、之后一直晾着信息流。
 */
internal fun flightMaskAlphaOf(t: Float): Float {
    val f = t.coerceIn(0f, 1f)
    return f * f * (3f - 2f * f)
}

/**
 * 遮罩透明度 = **「下拉那一段」× 「转场那一段」**。
 *
 *  · 下拉时按 [dragAlphaOf] 变透（露出下面的页面，"缩小回卡片"的前半程）；
 *  · 转场时按 [flightMaskAlphaOf]（输入是**时间线性**的遮罩进度）。
 *
 * 两段**相乘**而不是二选一：早先写成 `if (flying) progress else dragAlpha`，
 * 松手那一刻透明度会从"半透"**瞬间跳成全黑**再淡出 —— 真机上就是"松手闪一下"。
 * 相乘之后仍然成立：[flightMaskAlphaOf] 在 t=1 处为 1，所以接缝两侧相等（单测钉住）。
 */
internal fun viewerMaskAlpha(transitioning: Boolean, maskT: Float, dragFraction: Float): Float {
    val dragAlpha = dragAlphaOf(dragFraction)
    return if (transitioning) flightMaskAlphaOf(maskT) * dragAlpha else dragAlpha
}

/** 下拉缩放的**下限**（参考实现里"拖到屏高 1/4 就不再缩"那条守卫） */
internal const val MIN_DRAG_SCALE = 0.75f

/** 下拉期间背景黑度的**下限**（拖到屏高 1/4 时正好半透） */
internal const val MIN_DRAG_ALPHA = 0.5f

/**
 * 松手甩动速度折算成位移的"投影时间"（秒）。
 *
 * `Velocity` 的单位是 px/s；乘一个时间常数得到"如果让它自然减速，还会走多远"。
 * 0.25s 是经验值：一次正常快滑（约 2000~4000 px/s）投影出 500~1000px，
 * 在 1440px 宽的页面上正好是"越过半页就翻过去"，与系统相册的手感一致。
 */
private const val PAGER_FLING_PROJECTION_S = 0.25f

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

/**
 * 等"来源那一格登记好"的上限（ms）。
 *
 * ★ 只给**两帧**（旧版是 400ms）。为什么敢这么短：来源矩形与宽高比在**点下去那一刻**
 *   就该在登记表里了 —— 用户能点到那一格，说明它早就排完版、图也早就加载完
 *   （`registerViewerOrigin` 在 painter 加载完时就把宽高比写进去了）。
 *   这里留两帧只是兜住"页面刚落定"那一帧。旧版为了等它，首次打开会先干等 100~400ms，
 *   观感就是"点下去没反应"。
 */
private const val ORIGIN_WAIT_MS = 32L

/**
 * 等"全屏容器量出来"的上限（ms）。只用于**兜底**：正常情况下容器在第一帧的布局阶段就有值。
 * 超过这个时间还量不到，就按"直接落位 + 淡入"处理 —— 宁可没有飞行，也不能把用户留在空白覆盖层。
 */
private const val CONTAINER_WAIT_MS = 120L
