@file:OptIn(androidx.media3.common.util.UnstableApi::class)

package top.kuangdada.k.nativeapp.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.ExoPlayer
import top.kuangdada.k.core.designsystem.theme.KMotion
import top.kuangdada.k.core.designsystem.theme.KSpacing
import top.kuangdada.k.core.designsystem.theme.KTheme
import top.kuangdada.k.core.designsystem.theme.KType
import top.kuangdada.k.core.designsystem.theme.LocalAnimationsEnabled
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * ============================================================
 * 视频播放（沉浸全屏页）
 * ============================================================
 * 用 media3 的 ExoPlayer + 官方 `PlayerView`：进度条、暂停、拖动、缓冲圈都由它提供。
 * 自己用 `MediaPlayer + SurfaceView` 拼的话，这几件事都要手写，而且"能播"与"播得好"
 * （拖动 seek、缓冲、断流恢复）差别就在这些细节里。
 *
 * 与内联播放（[KVideoPlayer]）的分工：全屏页**保留官方控制器**（沉浸场景下它自带
 * 暂停/拖动/时间，够用且不必再画一套）；卡片与详情页的内联播放器用我们自己的
 * 进度条（要"剩余 mm:ss"的阅读器形态，官方 DefaultTimeBar 给不了）。
 *
 * ------------------------------------------------------------
 * 2026-10-14 三项用户反馈的修法（这一页的复杂度都在这里）
 * ------------------------------------------------------------
 * ① **续播**：内联播到一半点全屏，进来**从头开始**了。
 *    根因是详情页在这一跳里离开了组合、它的 ExoPlayer 被 `release()`，进度随之丢失
 *    （详见 [VideoHandoff] 的类注释）。修法是详情页点全屏时把进度写进交接单，
 *    这里建播放器时取出来 `seekTo`；退出时反向交回去，来回切不会回到开头。
 *
 * ② **进/退场动画**：原来全屏是硬切的，没有看图那种"从那一块长到全屏、再缩回去"。
 *    这里按 [ImageViewer] 的飞行做法补一条：详情页把视频块的位置登记进 [VideoHandoff]，
 *    本页用 `矩形插值 + 圆角插值 + 黑幕` 让画面从那一块长出来，退出反向播。
 *
 *    ★★ 2026-10-17 调优（三段，缺一段都还"差一点"）：
 *    · **画面本体一起飞**：飞行块里装的就是 `KVideoSurface`（TextureView 参与布局与变换），
 *      不是替身。尺寸钉死在终态、只走 `graphicsLayer` 的缩放/平移（改尺寸会重分配 Surface，
 *      画面会卡住 —— 见 `videoFlightTransform` 的注释）；
 *    · **同一个 PlayerView 上开关控制器**：以前落位那一刻会**再组合一个**带控制器的
 *      PlayerView，两个 View 抢同一个 ExoPlayer 的 Surface —— 落位闪黑、退场一路黑着缩小。
 *      现在只有一个，控制器用 `useController` 开关（见 [KVideoSurface]）；
 *    · **底页 + 黑幕**：**退场**时 Shell 把目标页画在本页**下面**，黑幕（`exitScrim`）
 *      真的淡出，视频才"落得回详情页那一块"。没有底页时黑幕恒不透明（防白屏）。
 *      进场不做底页：详情页刚离开组合、滚动状态还没存回去，底页会以"滚回顶部"
 *      的样子出现（时序原因见 AppShell 的 `videoUnderlay` 注释）。
 *
 *    曲线是一条**无过冲弹簧**（[KMotion.spatialBounded]）：比"固定 250ms + 线性"更跟手，
 *    而且中途被打断（入场中点返回）会从当前速度接着往回走，不会弹一下重来。
 *
 * ③ **全屏就该全屏**：进这一页隐藏状态栏，并且**不画**返回/更多那两个悬浮钮
 *    （用户明确要求"全屏了就不要显示状态栏和顶部返回按钮那两个"）。
 *    出口改成**双击画面**与**系统返回键**两条，画面上只留一行"双击退出全屏"的小字提示。
 *
 * 三个必须做的生命周期处理（不做就会在真机上出问题）：
 *  1. **`onDispose` 里 `player.release()`**：不释放就是泄漏一个解码器 + 音频焦点，
 *     连续看几个视频后新视频会黑屏（编解码器被占满）。
 *  2. **退到后台要暂停**：`ON_STOP` 暂停。不停的话锁屏/切后台声音继续放。
 *  3. **播放期间保持屏幕常亮**（`keepScreenOn`），看完自动恢复 —— 否则长视频看一半息屏。
 */
@Composable
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
fun VideoPlayerScreen(
    url: String,
    title: String? = null,
    /** 这条视频属于哪条帖子 —— 续播交接单与来源几何都按它配对（<= 0 时两条都自动降级） */
    postId: Long = 0L,
    /**
     * 本页背后**有没有目标页**（Shell 在退场时画在下面的那一页，见 AppShell 的 `videoUnderlay`）。
     *
     * 它只影响一件事：**退场黑幕能不能让开**。
     *  · `true`：缩小的同时黑幕淡出，视频落回详情页那一块，落点有真实参照；
     *  · `false`（深链直接进、进程回收恢复、返回栈空）：黑幕**恒不透明**，
     *    这一页背后是窗口底色，任何时刻让它露出来都是白屏。
     *
     * ★ 进场**不靠它**：详情页刚离开组合，它的滚动状态还没存回 `SaveableStateHolder`
     * （存在 apply 阶段），此刻用同一把 key 组合出来的底页会"滚回顶部"——闪错位的内容，
     * 比干脆的黑场更糟。所以进场的黑幕恒为不透明，退场才有底页可让。
     */
    hasUnderlay: Boolean = false,
    /**
     * 请求退出：**先亮出目标页**（由 Shell 把返回栈顶那一页画到本页下面），
     * 但**还不要 pop** —— 本页要在这 250ms 里把画面缩回去。
     *
     * 为什么分成 [onBack] / [onExitFinished] 两步（用户实测"退出没有动画"的根因）：
     * 本页是重页面，Shell 在两条渲染分支间瞬间切换 —— pop 之前详情页整个不在组合里，
     * 于是缩小的画面背后是**纯黑**，用户读不出"缩回详情页那一块"。
     * 先让 Shell 把目标页亮出来，画面才有地方可退。
     */
    onBack: () -> Unit,
    /**
     * 退场飞行**播完之后**才调用 —— 真正 pop（见 [onBack]）。
     *
     * 默认值退回 [onBack]（一步到位）：这样单独预览/测试这一页时仍然可用，
     * 不会因为少传一个 lambda 就退不出去。
     */
    onExitFinished: () -> Unit = onBack,
) {
    val context = LocalContext.current
    val view = LocalView.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val animationsEnabled = LocalAnimationsEnabled.current
    val density = LocalDensity.current

    /**
     * 交接单：**一次取走**进度与飞行来源。
     *
     * 为什么要一次取：单子是"读并清"的（见 [VideoHandoff]），分两次取会让第二次拿到 null ——
     * 表现是"能续播但没动画"或反过来，取决于调用顺序。
     *
     * `remember(postId)`：只在**这一页第一次组合**时取一次。写成每次重组都取的话，
     * 任何一次重组回来都只会拿到空单子（已经被第一次消费掉了），倒也无害，
     * 但明确"只取一次"更能表达"这是进场时的一次性交接"。
     */
    val handoff = remember(postId) { videoFullscreenHandoff(postId) }
    val origin = handoff.origin

    /**
     * 「这一次进场要不要飞」：只看来源 + 动效开关，**首帧就能定**（不必等容器）。
     *
     * 与 [phase] 的初值同源；挑出来单独命名是为了让读代码的人一眼看到
     * "飞不飞"与"相位怎么初始化"是同一个判断，不靠两处各写一遍。
     */
    val plannedEnterFlight = origin != null && animationsEnabled

    /**
     * 飞行进度：0 = 完全在来源块上，1 = 全屏落位。
     *
     * 它**只表达几何**，不兼职"播放器在不在场"（那是 [phase] 的职责）。
     * 初值 0：因为初值只在 `Entering` 相位才被画出来，而 `Entering` 只在
     * "有来源 + 动效开着"时成立 —— 那时从 0 起飞正是要的效果。
     */
    val flight = remember { Animatable(0f) }

    /**
     * **退场黑幕**的透明度：恒从 1 出发、随退场收敛到 0。
     *
     * 为什么不直接用 `flight` 反推：退场可能**打断进场**（飞了一半点返回），
     * 那时 `flight` 还停在 0.4 之类的位置 —— 直接读它会让黑幕**一帧内从全黑掉到半透明**，
     * 背后还没画稳的目标页"啪"地亮一下。用一条独立的、只属于退场的进度就没有这个窗口：
     * 它总是从"全黑"开始让开。进场则始终读 1（全黑），见 `scrimAlpha`。
     */
    val exitScrim = remember { Animatable(1f) }

    /** 全屏容器的窗口矩形（`onGloballyPositioned` 每帧写；只在进场时 await 一次） */
    var container by remember { mutableStateOf(Rect.Zero) }

    /**
     * 退场是否已经开始（幂等闸）。
     *
     * 退场那 200 多毫秒里系统返回键与双击可能各来一次，不守的话第二趟会把
     * `onBack()` 再调一次（连退两层）。
     *
     * ★ 必须声明在**两条飞行 effect 之前**：进场那条要在收尾时读它
     * （入场中途按返回时，不能再把 `flight` 拽回全屏，见下面的注释）。
     */
    var closing by remember { mutableStateOf(false) }
    val currentOnBack by rememberUpdatedState(onBack)
    val currentOnExitFinished by rememberUpdatedState(onExitFinished)

    /**
     * ============================================================
     * 进场相位（**必须与"播放器在不在场"分开表达**）
     * ============================================================
     * ★★ 2026-10-13 真机第二次修复：动画「跑了但看不见」。
     *
     * ## 上一个版本的错误（别重犯）
     *
     * 为了修白屏，我把 `flight` 的初值改成 **1（落位）**，并用
     * `playerVisible = flight.value >= 1f` 判断播放器在场。结果是：
     *   · 第一帧 `flight == 1` → **播放器立刻组合出来**、黑幕 alpha 也是 1（全黑）；
     *   · `LaunchedEffect` 里的 `snapTo(0f)` 要等到**下一帧**才把它拉回起点；
     *   · 而那之后播放器已经盖在上面了 —— 飞行块在它下面飞，用户**什么都看不到**。
     *
     * 真机日志取证（KVideoFlight）：
     * ```
     * enter … usable=true anim=true initialFlight=1.0
     * flight start -> animate to 1        ← 动画确实启动了
     * flight done value=1.0               ← 也确实跑完了（284ms）
     * ```
     * 动画数据全对，**只是被播放器挡在后面**。这说明把"要不要飞"和"播放器在不在"
     * 挤在同一个 `flight.value` 上是错的 —— 它们是两个独立的问题：
     *
     *   · **要不要飞**：只看 `origin` + 动效开关，**首帧就能定**（不必等容器）；
     *   · **控制器在不在**：飞完了才在（`phase == Ready`，见 [VideoFlightPhase]）。
     *
     * 所以引入显式的 [VideoFlightPhase]。初值用 [plannedEnterFlight]
     * —— 这个判断**不需要容器**，因此首帧就是对的，不存在"第一帧先落位、
     * 第二帧才回来"的空窗（那正是动画被吞掉的原因）。
     *
     * ## 白屏为什么不会再回来
     *
     * 白屏的根因是"进场动画没能跑完 → 玩家永远等不到 `Ready`"。
     * 现在给它上**双保险**：
     *   1. 动画那一段用 `withTimeoutOrNull` 兜住，超时也一定进 `Ready`；
     *   2. 动画抛异常也进 `Ready`（`runCatching`）。
     * 也就是说 **`Ready` 是必然到达的**，播放器一定会出来。
     */
    var phase by remember {
        mutableStateOf(
            if (plannedEnterFlight) VideoFlightPhase.Entering else VideoFlightPhase.Ready,
        )
    }

    /**
     * 进场飞行：容器量到之后，从来源块长到全屏。
     *
     * **无论走哪条路，最后一定进 [VideoFlightPhase.Ready]**（超时兜底 + `runCatching`）：
     * 这是"播放器必然出现"的保证，也就是白屏不可能再回来的保证。
     *
     * 曲线是一条**无过冲弹簧**（[KMotion.spatialBounded]）：几何只做纯插值、缓动全交给它
     * （见 [videoFlightRect] 的注释）。弹簧的另一个好处是**被打断也不回弹重来** ——
     * 入场途中按返回，退场那条 effect 从"当前进度 + 当前速度"接着往回走。
     *
     * `container` 只在这里被 await、**不作为 effect 的 key** —— 它是布局期反复写入的状态，
     * 当 key 会让协程每帧被取消重启（上一个白屏 bug 的根因，见 [phase] 的注释）。
     */
    LaunchedEffect(origin) {
        if (phase != VideoFlightPhase.Entering) return@LaunchedEffect
        // 等容器量到；500ms 量不到就按"不能飞"处理（不能把用户永远晾在飞行块上）
        val measured = withTimeoutOrNull(500L) {
            snapshotFlow { container }.first { it.width > 0f }
        }
        val containerNow = measured ?: container
        val usable = videoFlightUsable(origin?.rect, containerNow, animationsEnabled)
        if (usable && !closing) {
            flight.snapTo(0f)
            // 超时 + 异常双兜底：**必须离开 Entering**，否则控制器永远不出现
            runCatching {
                withTimeoutOrNull(VIDEO_FLIGHT_MS + 400L) {
                    flight.animateTo(1f, KMotion.spatialBounded<Float>())
                }
            }
        }
        // ★ 退场已经接管时**不要再写 flight / phase**：那两条（进场/退场）都以
        // `flight` 为写入目标，这里补一个 `snapTo(1f)` 会把正在缩小的画面拽回全屏
        // —— 表现就是"入场中途点返回，视频先弹成全屏再缩回去"。
        if (!closing) {
            // 收尾：几何落到全屏位（即便上面超时了也只差最后一点），相位进 Ready
            flight.snapTo(1f)
            phase = VideoFlightPhase.Ready
        }
    }

    /**
     * 播放器**全程在场**。
     *
     * ★ 与上一版的关键区别：它不再"飞行期间不存在、落地才出现"。
     * `TextureView`（本工程 `KVideoSurface` 用的表面类型）是一张**参与视图层级与变换**
     * 的普通纹理（不像 `SurfaceView` 那样独立合成、在窗口上挖洞），
     * 所以它能被正常布局 —— 于是"位移视频窗口"这件事成立：
     * 播放器就住在那个飞行 Box 里，跟着矩形一起长大。
     */
    val player = remember(url) {
        ExoPlayer.Builder(context).build().apply {
            setMediaItem(MediaItem.fromUri(url))
            prepare()
            playWhenReady = true
            // ★ 续播：内联播到哪就从哪继续（用户反馈"点全屏不能续播"）。
            // 交接单是"读并清"的一次性便签：取到就 seek；取不到（深链直接进全屏页、
            // 或从探索页视频封面进来）就从 0 开始，与从前一致。
            handoff.positionMs?.let { seekTo(it) }
        }
    }

    /** 首帧是否已经画出来（决定"盖在上面的封面能不能撤掉"，避免黑帧闪一下） */
    var firstFrame by remember(url) { mutableStateOf(false) }

    /** 官方控制器只在**落位**这一个相位打开（飞行期间跟着缩放会很怪，退场一开始就收） */
    val playerVisible = phase == VideoFlightPhase.Ready

    // 释放（必须）：不释放就是泄漏一个解码器 + 音频焦点
    DisposableEffect(player) {
        onDispose { player.release() }
    }

    // 首帧监听：画出来了就撤掉封面层
    DisposableEffect(player) {
        val listener = object : androidx.media3.common.Player.Listener {
            override fun onRenderedFirstFrame() {
                firstFrame = true
            }
        }
        player.addListener(listener)
        onDispose { player.removeListener(listener) }
    }

    // 后台暂停 + 屏幕常亮
    DisposableEffect(lifecycleOwner, player) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_STOP -> player.pause()
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        view.keepScreenOn = true
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
            view.keepScreenOn = false
        }
    }

    /**
     * 退场：**先把进度交回内联播放器，再反向播一次飞行，最后才离开**。
     *
     * 进度必须在离开之前读：一旦 pop，本页就离开组合了，`player.currentPosition` 没了。
     *
     * 幂等由 [closing] 守（声明在上面，进场那条 effect 也要读它）。
     */
    fun beginClose() {
        if (closing) return
        closing = true
        // 续播的另一半：把现在的进度交回详情页那条内联播放器（必须在离开之前读）
        val position = player.currentPosition
        if (position > 0L) VideoHandoff.offer(postId, position, player.duration)
        // 第一步：请 Shell 把目标页亮到本页下面（**先不 pop**，见 [onBack] 的注释）
        currentOnBack()
    }

    /**
     * 退场飞行的收尾（`closing` 由 [beginClose] 置位）。
     *
     * `beginClose` 只负责"请 Shell 亮出目标页"，这里负责**等飞行播完再真正离开**
     * （`onExitFinished`）。两步分开就是为了让"露出目标页"与"切页"之间隔着这一趟飞行。
     *
     * ★ 无论哪条路径，**`onExitFinished` 一定会被调用** —— 少了它用户会卡在全屏页出不去。
     * 所以动画全程裹在 `runCatching` + `withTimeoutOrNull` 里。
     */
    LaunchedEffect(closing) {
        if (!closing) return@LaunchedEffect
        // 退场期间控制器**不再画**（跟着缩放会很怪）
        phase = VideoFlightPhase.Leaving
        // ★ 先等一帧：目标页是这一帧才被 Shell 塞进底层的。等它**画出来**再开始缩/让黑幕，
        // 否则黑幕淡到一半时背后还是没画过的空白（一帧的代价，换"背后永远有东西"）。
        withFrameNanos { }
        val canFly = videoFlightUsable(origin?.rect, container, animationsEnabled)
        if (canFly) {
            // 反向播：1 → 0（缩回详情页那一块）。此刻目标页已经在下面了，
            // 所以这一趟"缩回去"落点是有真实参照的。
            //
            // ★ 这里**只写 `flight` / `exitScrim`**（绘制期缩放与黑幕的唯一输入）——
            // 不要在这几百毫秒里改任何布局尺寸：`AndroidView`/`TextureView` 一改尺寸
            // 就要重分配 Surface，画面会卡在旧尺寸上（"退出没有动画"就是这么做出来的，
            // 详见 `videoFlightTransform` 的注释）。
            //
            // 两条一起跑：画布缩小与黑幕让开必须是同一段时间里的事，
            // 先亮后缩（或先缩后亮）都会读成"卡了一下"。
            runCatching {
                withTimeoutOrNull(VIDEO_FLIGHT_MS + 400L) {
                    coroutineScope {
                        launch { flight.animateTo(0f, KMotion.spatialBounded<Float>()) }
                        launch { exitScrim.animateTo(0f, KMotion.spatialBounded<Float>()) }
                    }
                }
            }
        }
        currentOnExitFinished()
    }

    /**
     * 沉浸系统栏：**隐藏状态栏**（用户要求"全屏了就不要显示状态栏"）。
     *
     * 用 `BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE`（与图片查看器 / 语音房全屏共享同一档）：
     * 从边缘划一下还能临时唤出来，不是"藏死"。
     * 只藏 `statusBars`、**不藏导航栏**：底部手势条留着不影响画面，
     * 藏掉反而会让"退出全屏"的手势没有反馈（与图片查看器同一取舍）。
     *
     * `onDispose` 里必须把状态栏还回去 —— 系统栏可见性是**窗口级**的，不随页面组合消失
     * 而自动恢复；少了这一步，返回详情页后整站都没有状态栏。
     */
    DisposableEffect(view) {
        val controller = findActivity(view.context)?.window
            ?.let { WindowCompat.getInsetsController(it, view) }
        controller?.apply {
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsetsCompat.Type.statusBars())
        }
        onDispose {
            controller?.show(WindowInsetsCompat.Type.statusBars())
        }
    }

    // 系统返回键 = 退出全屏（两个悬浮钮已按用户要求去掉，返回键是主要出口之一）
    BackHandler { beginClose() }

    /**
     * ============================================================
     * 根容器黑幕：**画在背景色上，不是 graphicsLayer**
     * ============================================================
     * 只有**退场、且背后真有底页**时它才让开（由 [exitScrim] 驱动 1 → 0）；
     * 其余一切情况（进场、稳态、深链直接进）**恒为 1（不透明）**。
     *
     * ★★ 2026-10-17 修掉的一处"看似有、其实没有"（改前务必读完）：
     *
     * 改前根容器是 `background(Color.Black)`（**恒不透明**），上面再叠一层
     * `graphicsLayer { alpha = 1 - flight.value }` 的黑。黑色叠黑色，透明与否都看不出来 ——
     * 于是退场时底页**一直被那层恒黑挡住**，用户看到的就是"视频在黑洞里缩小一下"。
     * 而且那个 `1 - flight.value` 还是反的：退场从 flight=1 出发 ⇒ alpha 0（最透），
     * 缩到底 ⇒ alpha 1（全黑），正是"越缩越黑、最后硬切回详情页"。
     *
     * 现在只有**一层**黑、alpha 挂在**背景色**上（不能挂 `graphicsLayer`，那会把画面
     * 一起淡掉 —— 2026-10-13 白屏事故），并且由**退场专用的** [exitScrim] 驱动：
     * 不从 `flight` 反推，是为了"入场中途被返回打断"时黑幕也不会一帧掉到半透明。
     */
    val scrimAlpha = if (hasUnderlay) exitScrim.value.coerceIn(0f, 1f) else 1f
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black.copy(alpha = scrimAlpha))
            .onGloballyPositioned { container = it.boundsInWindow() },
    ) {
        val from = origin?.rect
        /**
         * 落位矩形 = 按**视频宽高比**在容器里 Fit 出来的那条横带（与查看器同一个 [fitRectIn]）。
         *
         * ★ 不能用容器本身：视频是 16:9、屏幕是 9:19.5，让画面去铺满竖屏容器
         * 会在飞行途中把它**拉成竖条**。详见 [videoFullscreenRect] 的注释。
         */
        val to = videoFullscreenRect(container, origin?.aspect)
        val flyRect = videoFlightRect(from, to, flight.value)

        /**
         * ============================================================
         * ① 画面本体（**播放器就在这里面**，随飞行矩形一起走）
         * ============================================================
         * ★★ 2026-10-13 第三次修正：**位移的应该是视频窗口，不是替身**。
         *
         * ## 前面两版错在哪（用户一句话点破："你位移视频内容干嘛"）
         * 我一直在飞一个**替身**（先是纯色块，后是封面图），落地后再把播放器"啪"地
         * 换成全屏 —— 而图片查看器飞的是**图片自己**（`FlyingImage` 把 painter 画进
         * 插值矩形里）。两者观感完全不同：替身版看起来就是"一张图放大、然后视频突然出现"。
         *
         * ## 为什么这里可以把播放器放进飞行矩形
         * 内联播放器必须用 `TextureView`（`SurfaceView` 会在窗口上挖洞、绕过 Compose 绘制，
         * 见 `KVideoPlayer` 的注释）—— 而这正好也是**它能被正常布局**的原因：
         * `TextureView` 是一张普通的、参与视图层级与变换的纹理，不像 `SurfaceView` 那样
         * 独立合成。所以只要把它放进这个 Box，**用布局定尺寸、用 graphicsLayer 定位**，
         * 画面就会跟着矩形一起长大 —— 位移的是视频窗口本身。
         *
         * ## 与查看器的结构对照
         * | | 查看器 | 这里 |
         * |---|---|---|
         * | 飞行内容 | `FlyingImage` 的 painter | `KVideoSurface`（TextureView）|
         * | 落位矩形 | `fitRectIn(container, aspect)` | `videoFullscreenRect(…)`（同一个函数）|
         * | 定位方式 | Canvas 里 translate 绘制 | 布局尺寸 + graphicsLayer 平移 |
         *
         * 落地后这个 Box 正好等于那条 16:9 横带 —— 与 `PlayerView` 自己的
         * `RESIZE_MODE_FIT` 结果一致，所以"飞行结束"与"正常播放"之间没有跳变。
         */
        val cornerPx = videoFlightCorner(origin?.cornerRadiusPx ?: 0f, 0f, flight.value)
        if (flyRect != null) {
            /**
             * 飞行块：**尺寸固定在全屏位，只做绘制期缩放/平移**。
             *
             * ============================================================
             * ★★ 2026-10-13 第四次修正：**不能改 size()**（"退出没有动画"的真根因）
             * ============================================================
             * 上一版用 `.size(flyRect.width, flyRect.height)` 逐帧改布局尺寸。
             * 动画数据完全正确（逐帧日志：1.0 → 0.669 → 0.537 → … → 0.0，250ms 走完），
             * 但用户**完全看不到位移** —— 因为这一块里装的是 `AndroidView`
             * （`PlayerView` + `TextureView`）：
             *
             *   · 每帧改布局尺寸 ⇒ 每帧触发 **measure + layout**；
             *   · `TextureView` 的尺寸一变就要**重新分配 Surface / 纹理**，
             *     这是几十毫秒级的重活，还会把上一帧的内容丢掉；
             *   · 结果：几何在动、**Surface 里的画面卡在旧尺寸**上 ——
             *     观感就是"根本没有动画"。
             *
             * 修法：**把布局尺寸钉死在终态，动画只走 `graphicsLayer` 的
             * `scaleX/scaleY/translationX/translationY`**。
             * 这三个都是**绘制期属性**：不触发 measure/layout、不动 Surface、
             * 不重新解码 —— 只是把已经合成好的那一层**缩放着画**。
             * 这也正是图片查看器 `FlyingImage` 的做法（它在 Canvas 里 translate+scale 绘制，
             * 全程不重新测量），以及直播类 App 做"视频缩小回原位"的通行写法。
             *
             * 缩放/平移全部相对**终态矩形**算，所以 flight=1 时正好是恒等变换
             * （scale=1、translation=0）—— 落地那一刻不需要任何"切回去"的动作。
             */
            val toW = to.width.coerceAtLeast(1f)
            val toH = to.height.coerceAtLeast(1f)
            // 当前帧相对终态的绘制期变换（纯函数，有单测钉住）
            val xf = videoFlightTransform(flyRect, to)

            Box(
                modifier = Modifier
                    // 布局尺寸 = 终态（**恒定**，不随动画变）。位置也钉在终态上，
                    // 再用 translation 把它挪到当前帧的位置。
                    .graphicsLayer {
                        translationX = (to.left - container.left) + xf.dx
                        translationY = (to.top - container.top) + xf.dy
                        scaleX = xf.scale
                        scaleY = xf.scale
                        // 绕自身中心缩放：与"矩形从中心插值"是同一个几何
                        transformOrigin = TransformOrigin.Center
                    }
                    .size(
                        width = with(density) { toW.toDp() },
                        height = with(density) { toH.toDp() },
                    )
                    // 圆角：**除以 scale 补偿**。graphicsLayer 的缩放会把圆角一起缩，
                    // 不补偿的话视觉半径只有 cornerPx * scale（越缩越方），
                    // 看起来就不像"从详情页那一块的圆角变到全屏的直角"
                    .clip(
                        RoundedCornerShape(
                            with(density) { (cornerPx / xf.scale).toDp() },
                        ),
                    ),
            ) {
                /**
                 * 播放器**全程在场**（不再有"飞行期间不存在"那一套）：
                 * 它就是画面本体，飞行期间要它一起动。
                 *
                 * 用 `PlayerView` + 本工程既有的 `KVideoSurface` 主题
                 * （`surface_type = texture_view`）—— 与内联播放器同一个表面类型，
                 * 才不会出现"全屏能播、这里不能播"这种只在一种表面下发生的怪问题。
                 *
                 * ★ 控制器在**这同一个 PlayerView 上开关**（`useController`），
                 * 不要像 2026-10-13 那样再叠一个带控制器的 PlayerView：
                 * 两个 PlayerView 共用一个 ExoPlayer 会互相抢 Surface，落位那一帧闪黑、
                 * 退场时则是一路黑着缩小（见 [KVideoSurface] 的参数注释）。
                 */
                KVideoSurface(
                    player = player,
                    modifier = Modifier.fillMaxSize(),
                    // 飞行期间关掉（跟着画面缩放会很怪），落位后打开 —— 用户要的暂停/拖动/时间
                    useController = playerVisible,
                    showBuffering = true,
                )

                /**
                 * 首帧之前盖一层封面：避免"黑帧 → 视频"闪一下。
                 *
                 * 只在**还没有画面**时盖（`!firstFrame`），有画面了立刻撤掉 ——
                 * 这一层是"遮黑"用的，不是飞行内容本身。
                 */
                val cover = origin?.coverUrl
                if (cover != null && !firstFrame) {
                    androidx.compose.foundation.Image(
                        painter = coil3.compose.rememberAsyncImagePainter(
                            model = rememberVideoCoverRequest(cover),
                        ),
                        contentDescription = null,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier.fillMaxSize(),
                    )
                }
            }
        }


        /**
         * ② 双击 / 长按手势层（**画在播放器之上**，否则收不到事件）。
         *
         * **双击 = 退出全屏**。为什么不做单击退出：单击要留给官方控制器
         * （呼出/收起进度条），在它上面再叠一层单击检测器会把按下事件先吃掉，
         * 官方控制条就再也不出来了（这个坑在 [KVideoPlayer] 的注释里记过一次）；
         * 而且用户只是想呼出进度条时会误退，而退出是全屏页代价最大的动作。
         * 双击与单击在 `detectTapGestures` 里可以共存（单击会等一个双击超时再派发，
         * 代价是控制条"慢半拍"，比"点哪儿都没反应"好得多）。
         *
         * **长按 = 保存到相册**（用户要求"视频也要能长按存"）。
         * 右上角那个「…」钮已经按用户要求去掉了（"全屏了就不要显示…顶部那两个"），
         * 但保存能力不能跟着丢 —— 长按是这一页唯一不占画面的入口
         * （详情页的内联播放器与信息流的视频封面也是长按保存，全站手势保持一致）。
         */
        val mediaOpener = LocalMediaSaveOpener.current
        val currentMediaOpener = rememberUpdatedState(mediaOpener)
        Box(
            modifier = Modifier
                .fillMaxSize()
                .pointerInput(Unit) {
                    detectTapGestures(
                        onDoubleTap = { beginClose() },
                        onLongPress = {
                            currentMediaOpener.value?.invoke(
                                MediaSaveTarget(url = url, kind = MediaKind.Video, title = title),
                            )
                        },
                    )
                },
        )

        /**
         * ③ 底部提示：**只有一行小字**，不再有返回/更多两个悬浮钮（用户要求）。
         *
         * 沉浸页最容易的抱怨是"不知道怎么退"，所以把出口写出来；
         * 长按保存也一并说了 —— 那个钮被去掉之后，用户不会自己发现长按有东西。
         * 不挂 `statusBarsPadding()` —— 这一页的状态栏已经被上面的 DisposableEffect 藏掉了，
         * 还按状态栏避让会平白多出一条空白。
         *
         * 位置：**底部**（2026-10-15 用户要求"提示词放底下"，原在顶部压着画面主体）；
         * 这一页是沉浸式（系统栏已藏），`KSpacing.lg` 离屏幕下缘留出手势区余量即可。
         *
         * 透明度**跟着黑幕走**：进场时底页还亮着，这行白字如果一上来就满不透明，
         * 会像"详情页上突然飘出一行提示"；跟着黑幕一起淡入才是同一件事的一部分。
         */
        Text(
            text = "双击退出 · 长按保存",
            style = KType.caption,
            color = Color.White.copy(alpha = 0.72f * scrimAlpha),
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = KSpacing.lg),
        )
    }
}

/**
 * 沉浸视频播放页的**进场相位**。
 *
 * ============================================================
 * 为什么需要它（两次真机事故的共同教训）
 * ============================================================
 * 这一页曾经有两件互相拉扯的事被挤进同一个判据：
 *   · **要不要飞** —— 只看 `origin != null && animationsEnabled`，首帧就能定；
 *   · **播放器/控制器在不在** —— 飞完了才在。
 *
 * 第一版把两者写成 `flight.value >= 1f`，于是：
 *  · 初次给 0 → 动画一旦没跑完，就**永远等不到播放器**（真机白屏，第一次事故）；
 *  · 改成初值 1 → 第一帧播放器就出现了，`snapTo(0f)` 要下一帧才生效，
 *    飞行块在播放器**下面**飞 —— 动画数据全对（日志：start→end 284ms），
 *    但用户**什么都看不到**（真机"根本没有位移到全屏的动画"，第二次事故）。
 *
 * 现在拆成显式相位，且播放器**全程在场**（TextureView 能被正常布局/变换，
 * 飞行时它就是画面本体）。相位只剩两个职责：
 *  · **控制器**：只有 [Ready] 才亮出来（飞行中跟着缩放会很怪）；
 *  · **黑幕**：只有 [Leaving] 才让开，[Entering] 才淡入（见 `scrimAlpha`）。
 *
 * 而 [Ready] 由 `withTimeoutOrNull` + `runCatching` **双重保证必然到达** ——
 * 白屏在结构上不可能再发生。
 */
private enum class VideoFlightPhase {
    /** 进场飞行中：画面/圆角/黑幕一起走，控制器关着 */
    Entering,

    /** 到位（或本来就不飞）：控制器可开，正常播放 */
    Ready,

    /** 退场飞行中：控制器关掉，画面缩回详情页那一块，黑幕让开 */
    Leaving,
}

/**
 * 从（可能是包装过的）Context 里找出宿主 Activity。
 *
 * 为什么要循环解包：`LocalView.current` 是 Compose 的 `AndroidComposeView`，
 * 它的 `context` 在不同宿主下可能是 `Activity`、也可能是**套了几层的 ContextWrapper**
 * （主题包装等）。直接 `as? Activity` 在真机上会静默拿到 null ——
 * 表现就是"状态栏没藏掉"，而代码看起来完全正确。
 *
 * 找不到时返回 null，调用方按"没有系统栏可管"处理（不崩、也不影响播放）。
 */
private fun findActivity(context: android.content.Context?): android.app.Activity? {
    var current = context
    // 上限 10 层：正常最多两三层，硬上限只是防某种病态包装把自己绕死
    var guard = 0
    while (current != null && guard++ < 10) {
        if (current is android.app.Activity) return current
        current = (current as? android.content.ContextWrapper)?.baseContext
    }
    return null
}
