@file:OptIn(androidx.media3.common.util.UnstableApi::class)

package top.kuangdada.k.nativeapp.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import android.view.ContextThemeWrapper
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.delay
import top.kuangdada.k.core.designsystem.theme.KRadius
import top.kuangdada.k.core.designsystem.theme.KSpacing
import top.kuangdada.k.core.designsystem.theme.KTheme
import top.kuangdada.k.core.designsystem.theme.KType
import top.kuangdada.k.nativeapp.R

/**
 * ============================================================
 * 内联视频播放器（feed 静音自动播 / 详情页带声自动播共用）
 * ============================================================
 * 与 [VideoPlayerScreen]（沉浸全屏页）的分工：
 *  · 这里提供**画面 + 我们自己的进度条**，画在卡片/详情页的布局流里；
 *  · 全屏页仍走 PlayerView 自带的控制器（全屏场景下系统控件的暂停/拖动/全屏都好用）。
 *
 * 三个**必须**用 TextureView 而不是默认 SurfaceView 的理由（真机踩过才会知道）：
 *  `SurfaceView` 会在窗口上"挖洞"，它所在的区域由 SurfaceFlinger 直接合成、**绕开 Compose 的
 *  绘制顺序** —— 结果是盖在视频上面的 Compose 元素（我们的进度条、时间、暂停遮罩）
 *  全部看不见（不是被盖住，是根本没画上去）。所以内联播放一律 `surface_type = texture_view`。
 *  代价是多一次 GPU 拷贝（费一点电），换"进度条真的能看见"完全值得。
 *
 * 进度条形态沿用阅读器（`ReaderScreen`）：3dp 的细条 + accent 填充 + surfaceSunken 底槽，
 * 右侧给「剩余 mm:ss」——用户要求"跟图书打开一文章一样，能看到还有多少"。
 * 唯一增强：可拖动 seek（视频没有这个就等于开不了进度）。
 */
@Composable
fun KVideoPlayer(
    url: String,
    modifier: Modifier = Modifier,
    /** 进入组合就自动播放（详情页 = true；feed 由"聚焦 3 秒"决定，见 FeedScreen） */
    autoPlay: Boolean = true,
    /** 静音播放（信息流自动播放必须静音；用户主动进详情页才出声 —— 直接开声会炸一屋子人） */
    muted: Boolean = false,
    /** 循环播放（短视频信息流的标准行为；由调用方决定，两个场景目前都开） */
    loop: Boolean = true,
    /**
     * 是否显示底部进度条。
     *  · 详情页 true：用户是"在看这个视频"，需要知道播到哪了（用户要求）；
     *  · 信息流 false：那里只管"滑到就播"，多一条线是干扰。
     */
    showProgressBar: Boolean = true,
    /**
     * 点画面是否切换播放/暂停。
     *
     * **信息流必须传 false**：那里点视频要**进详情页**（用户明确要求
     * "主页自动播放的视频点了也是进去详情页而不是暂停"）。若在这里吃掉点击，
     * 用户的直觉动作（点画面）就变成了暂停，而不是进详情。
     */
    tapToToggle: Boolean = true,
    /**
     * 点"全屏"按钮 → 进沉浸全屏播放器（传 null = 不画这个按钮）。
     *
     * 为什么要有它：详情页的视频是**内联自动播**的（点画面 = 暂停/继续），
     * 于是"想放大看"这件事没有任何入口 —— 只能点画面暂停，用户实测反馈
     * 「进入详情页点击视频是暂停没有全屏按钮」。
     * 内联播放器的进度条也不可拖动（见 [showProgressBar]），要精确拖时间同样得进全屏页。
     */
    onFullscreen: (() -> Unit)? = null,
    /** 顶部标题（卡片场景通常 null，详情页传帖子正文摘要） */
    title: String? = null,
    /**
     * **首帧已经画出来**时回调一次（M3 真机反馈新增）。
     *
     * 给谁用：详情页的共享元素转场。视频封面会从信息流卡片飞到详情页的视频位，
     * 但播放器本身是 `AndroidView`（不参与 Compose 变换），所以只能在"封面落位之后"
     * 才把它组合出来。而它刚组合出来的那一小段是**纯黑**的（ExoPlayer 还在准备），
     * 于是需要这个信号来决定"什么时候可以把盖在上面的封面淡掉" ——
     * 否则会看到"封面 → 黑 → 视频"闪一下。
     *
     * 用 `onRenderedFirstFrame` 而不是 `onPlaybackStateChanged(STATE_READY)`：
     * READY 只代表缓冲好了，**画面还不一定画出来**，用它仍然会闪黑。
     */
    onFirstFrame: () -> Unit = {},
) {
    val context = LocalContext.current
    val view = LocalView.current
    val lifecycleOwner = LocalLifecycleOwner.current

    // 每个播放器实例一个 ExoPlayer。**必须 release**：不释放就是泄漏一个视频解码器 +
    // 音频焦点，连续看几个视频后新视频黑屏（解码器被占满）。
    val player = remember(url) {
        ExoPlayer.Builder(context).build().apply {
            setMediaItem(MediaItem.fromUri(url))
            repeatMode = if (loop) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
            // 静音用**播放器音量**而不是系统音量：后者会影响用户其它 App 的声音
            volume = if (muted) 0f else 1f
            playWhenReady = autoPlay
            prepare()
        }
    }

    DisposableEffect(player) {
        onDispose { player.release() }
    }

    // 静音/循环可能在播放器建好之后才变（feed 里"聚焦 3 秒"生效那一刻），必须跟随
    LaunchedEffect(player, muted, loop) {
        player.volume = if (muted) 0f else 1f
        player.repeatMode = if (loop) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
    }

    LaunchedEffect(player, autoPlay) {
        if (autoPlay) player.play() else player.pause()
    }

    // 退到后台暂停（否则锁屏/切后台声音继续放）+ 前台时保持屏幕常亮
    DisposableEffect(lifecycleOwner, player) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) player.pause()
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        view.keepScreenOn = true
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
            view.keepScreenOn = false
        }
    }

    /**
     * 「保存视频到相册」的入口（Shell 的弹层宿主提供）；为 null 时长按静默忽略。
     * 存 State 而不是存值：下面那个 `pointerInput` 协程捕获的是启动那一刻的 lambda，
     * 而 Shell 每次重组都给一个新的 opener 实例（同 ZoomableImage 的处理）。
     */
    val mediaOpener = rememberUpdatedState(LocalMediaSaveOpener.current)

    // ---- 播放状态（进度条要的两个数 + 缓冲圈）----
    var playing by remember(player) { mutableStateOf(false) }
    var buffering by remember(player) { mutableStateOf(true) }
    var positionMs by remember(player) { mutableLongStateOf(0L) }
    var durationMs by remember(player) { mutableLongStateOf(0L) }

    // 监听器建在 DisposableEffect 里（只随 player 重建），所以回调要用 rememberUpdatedState
    // 兜住最新引用 —— 否则调用方换 lambda 之后，播放器还在调旧的。
    val currentOnFirstFrame by rememberUpdatedState(onFirstFrame)

    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                buffering = state == Player.STATE_BUFFERING
                if (state == Player.STATE_READY) {
                    val d = player.duration
                    if (d > 0) durationMs = d
                }
            }

            override fun onIsPlayingChanged(isPlaying: Boolean) {
                playing = isPlaying
            }

            /** 首帧真正画出来的时刻（见 [onFirstFrame] 的说明） */
            override fun onRenderedFirstFrame() {
                currentOnFirstFrame()
            }
        }
        player.addListener(listener)
        onDispose { player.removeListener(listener) }
    }

    // 位置/时长轮询：media3 没有"每秒回调一次"的监听（onEvents 只在事件发生时来），
    // 进度条要动就得自己按播放间隔取。250ms 是"看起来连续"与"别太费"的折中。
    LaunchedEffect(player) {
        while (true) {
            positionMs = player.currentPosition.coerceAtLeast(0L)
            // 时长在 READY 之前是未知的（HLS/未转码完的 mp4 都可能后到）
            val d = player.duration
            if (d > 0) durationMs = d
            delay(250)
        }
    }

    Box(modifier = modifier.background(Color.Black)) {
        KVideoSurface(
            player = player,
            modifier = Modifier
                .fillMaxSize()
                .then(
                    if (tapToToggle) {
                        // 点一下暂停/继续（详情页最常用的动作）。
                        // ⚠️ 必须用 detectTapGestures 而不是 Modifier.clickable：
                        // clickable 只认"按下即触发"，在可滚动容器（feed / 详情页的 LazyColumn）里
                        // 手指一滑动就会先触发一次点击 —— 表现为"滑一下列表视频就暂停了"。
                        Modifier.pointerInput(player) {
                            detectTapGestures(
                                onTap = {
                                    if (player.isPlaying) player.pause() else player.play()
                                },
                                /**
                                 * 长按 → 「保存视频到相册」弹层（用户要求"视频也要能长按存"）。
                                 *
                                 * 只挂在 `tapToToggle = true` 的这一支：那一支本来就在吃点击
                                 * （详情页），长按与点击在同一个手势检测器里不会互相打架。
                                 * 信息流那支**刻意不吃点击**（点视频要进详情页），
                                 * 在那里加任何手势检测器都会把点击吞掉 —— 那边的保存入口是
                                 * 封面的长按（见 PostCard 的 VideoCover）与详情页/全屏页。
                                 */
                                onLongPress = {
                                    mediaOpener.value?.invoke(
                                        MediaSaveTarget(
                                            url = url,
                                            kind = MediaKind.Video,
                                            title = title,
                                        ),
                                    )
                                },
                            )
                        }
                    } else {
                        // 不吃点击：让上层（信息流卡片的点击）收到，点视频 = 进详情页
                        Modifier
                    }
                ),
        )

        if (buffering) {
            CircularProgressIndicator(
                color = Color.White,
                modifier = Modifier.align(Alignment.Center).padding(KSpacing.lg),
            )
        }

        if (!playing && !buffering) {
            // 暂停遮罩：明确告诉用户"它停着，点一下继续"（不然静止画面像卡死了）
            Box(
                modifier = Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.35f)),
                contentAlignment = Alignment.Center,
            ) {
                Text("▶", style = KType.title, color = Color.White)
            }
        }

        if (title != null) {
            Text(
                text = title,
                style = KType.caption,
                color = Color.White,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .fillMaxWidth()
                    // 半透明底衬：浅色封面下白字会糊掉
                    .background(Color.Black.copy(alpha = 0.35f))
                    .padding(horizontal = KSpacing.sm, vertical = KSpacing.xxs),
            )
        }

        if (showProgressBar) {
            // 只画绿色细线，不做拖动（用户要求"只显示主题色绿色条"）：
            // 位置直接来自播放器轮询，没有"拖动中的临时位置"这种中间态
            VideoProgressBar(
                positionMs = positionMs,
                durationMs = durationMs,
                modifier = Modifier.align(Alignment.BottomCenter),
            )
        }

        if (onFullscreen != null) {
            // 全屏入口：右下角半透明圆钮，**压在进度条之上**（进度条只有 3dp 细线，
            // 圆钮抬到它上面 10dp，两者不抢位置）。
            // 用 Glyph 自绘的 maximize-2，不用文字，保证与全站图标同一套几何。
            Box(
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .padding(end = KSpacing.xs, bottom = 10.dp)
                    .size(32.dp)
                    .clip(CircleShape)
                    .background(Color.Black.copy(alpha = 0.45f))
                    .clickable(onClick = onFullscreen)
                    // 无障碍：没有文字，必须给 contentDescription，否则读屏只说"按钮"
                    .semantics { contentDescription = "全屏播放" },
                contentAlignment = Alignment.Center,
            ) {
                Glyph(tint = Color.White, kind = GlyphKind.Maximize, size = 18.dp)
            }
        }
    }
}

/**
 * 底层画面。单独抽出来是为了把"必须用 TextureView"这条硬要求集中在一处
 * （原因见 [KVideoPlayer] 的注释：SurfaceView 会挖洞，Compose 覆盖层会消失）。
 *
 * 实现方式：用 [ContextThemeWrapper] 套一层只改了 `surface_type` 的主题
 * （`values/styles.xml` 的 `KVideoSurface`），再让 PlayerView 自己去 inflate 默认布局。
 * 这比手写一份 `exo_player_view.xml` 更稳：控制器按钮的 id、顺序、无障碍属性
 * 全部跟官方布局保持一致，media3 升级也不用手工同步。
 *
 * 注：`PlayerView.SHOW_BUFFERING_*` / `AspectRatioFrameLayout.RESIZE_MODE_*` 是 Java 侧定义的
 * `@RequiresOptIn` 常量，**Kotlin 的 `@file:OptIn` 满足不了 lint**（它认 Java 形式），
 * 所以这里显式写 `androidx.annotation.OptIn` —— 少这一行 `lintDebug` 会直接失败。
 */
@Composable
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
fun KVideoSurface(player: Player, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    AndroidView(
        factory = { ctx ->
            // 注意用传进来的 ctx（AndroidView 的组合上下文）包主题，继承它的 density/字号
            val themed = ContextThemeWrapper(ctx, R.style.KVideoSurface)
            PlayerView(themed).apply {
                this.player = player
                // 控制器关掉：进度条我们自己画（要"剩余时间"那种阅读器形态），
                // 系统的 DefaultTimeBar 只给"已播/总长"，且会和我们的条叠成两条
                useController = false
                // 缓冲转圈也由 Compose 侧画，避免两套
                setShowBuffering(PlayerView.SHOW_BUFFERING_NEVER)
                // 视频原始比例交给 PlayerView（FIT = 不拉伸，多出来的部分留黑边）
                resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
            }
        },
        modifier = modifier,
    )
}

/**
 * 视频进度条：只有一条**主题色（accent）的细线**贴在画面下边，无底槽、无时间文字。
 *
 * 形态对齐小红书那种短视频播放器 —— 用户明确要求："进度条只显示主题色绿色条在下边就行了，
 * 不需要剩余时间"。所以这里刻意**不做**底槽、不做 `0:05 / 剩余 0:14`、不做拖动：
 *  · 底槽（灰底）在亮画面上会被看成"两条线"，去掉后只剩绿线在走；
 *  · 时间文字与拖动会让"刷信息流/看短视频"变成"操作播放器"，不是这个场景要的。
 * 需要精确控制时用沉浸全屏播放器（`VideoPlayerScreen`，官方控制器带拖动与时间）。
 *
 * 绿线用 `fillMaxWidth(progress)` 从左边长出来，圆角天然保持，不需要额外裁剪。
 */
@Composable
fun VideoProgressBar(
    positionMs: Long,
    durationMs: Long,
    modifier: Modifier = Modifier,
) {
    val c = KTheme.colors
    val progress = if (durationMs > 0) {
        (positionMs.toFloat() / durationMs.toFloat()).coerceIn(0f, 1f)
    } else {
        0f
    }
    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(3.dp)
            // 只画绿色填充；底槽不画（用户要求"只显示主题色绿色条"）
            .clip(RoundedCornerShape(KRadius.pill))
            .background(Color.Transparent),
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth(progress)
                .height(3.dp)
                .clip(RoundedCornerShape(KRadius.pill))
                .background(c.accent),
        )
    }
}

/**
 * 毫秒 → `m:ss` / `h:mm:ss`（负数与未知按 0 处理，不显示 `-1:-1`）。
 * 当前 UI 里没用到（进度条改成纯绿线了），但沉浸全屏页与后续"精确时间"场景会需要，
 * 留着它并带单测成本极低；`formatClock` 也是这类工具最容易被各处重复实现的一个。
 */
fun formatClock(ms: Long): String {
    val total = (ms.coerceAtLeast(0L)) / 1000
    val h = total / 3600
    val m = (total % 3600) / 60
    val s = total % 60
    return if (h > 0) {
        "%d:%02d:%02d".format(h, m, s)
    } else {
        "%d:%02d".format(m, s)
    }
}
