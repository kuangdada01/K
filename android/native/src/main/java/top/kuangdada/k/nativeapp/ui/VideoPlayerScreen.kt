@file:OptIn(androidx.media3.common.util.UnstableApi::class)

package top.kuangdada.k.nativeapp.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.viewinterop.AndroidView
import android.view.ContextThemeWrapper
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import top.kuangdada.k.core.designsystem.theme.KSpacing
import top.kuangdada.k.nativeapp.R

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
 * 三个必须做的生命周期处理（不做就会在真机上出问题）：
 *  1. **`onDispose` 里 `player.release()`**：不释放就是泄漏一个解码器 + 音频焦点，
 *     连续看几个视频后新视频会黑屏（编解码器被占满）。
 *  2. **退到后台要暂停**：`ON_STOP` 暂停。不停的话锁屏/切后台声音继续放。
 *  3. **播放期间保持屏幕常亮**（`keepScreenOn`），看完自动恢复 —— 否则长视频看一半息屏。
 *
 * 注：`PlayerView.SHOW_BUFFERING_*` 是 Java 侧定义的 `@RequiresOptIn` 常量，
 * Kotlin 的 `@file:OptIn` 满足不了 lint，必须显式写 `androidx.annotation.OptIn`（与 KVideoSurface 同）。
 */
@Composable
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
fun VideoPlayerScreen(
    url: String,
    title: String? = null,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    val view = LocalView.current
    val lifecycleOwner = LocalLifecycleOwner.current

    val player = remember(url) {
        ExoPlayer.Builder(context).build().apply {
            setMediaItem(MediaItem.fromUri(url))
            prepare()
            playWhenReady = true
        }
    }

    // 释放（必须）
    DisposableEffect(player) {
        onDispose { player.release() }
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

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black),
    ) {
        AndroidView(
            factory = { ctx ->
                // 与 KVideoSurface 用同一个主题（TextureView）：全屏页这里其实可以用
                // SurfaceView（覆盖层只有返回按钮），但保持两条路径的表面类型一致，
                // 免得"全屏能播、卡片不能播"这类只在一种表面下出现的怪问题难定位
                PlayerView(ContextThemeWrapper(ctx, R.style.KVideoSurface)).apply {
                    this.player = player
                    useController = true
                    // 视频本身的宽高比由源决定，交给 PlayerView 处理（黑边留黑，不拉伸）
                    setShowBuffering(PlayerView.SHOW_BUFFERING_ALWAYS)
                }
            },
            modifier = Modifier.fillMaxSize(),
        )

        // 返回：覆盖在视频左上角（沉浸页，没有系统栏可点）
        Box(
            modifier = Modifier
                .align(Alignment.TopStart)
                .statusBarsPadding()
                .padding(KSpacing.md),
        ) {
            KIconButton(icon = GlyphKind.ChevronLeft, onClick = onBack)
        }

        /**
         * 保存：右上角（与返回钮同一套 36dp 圆钮形态），打开"保存视频到相册"弹层。
         *
         * **为什么这一页是按钮而不是长按**：画面是 ExoPlayer 的 `PlayerView`（AndroidView），
         * "点一下出控制条"由官方控件自己处理；在它上面再叠一层 Compose 手势检测器，
         * 按下事件会被那一层先消费掉，官方控制条就再也不出来了（退化成"点哪儿都没反应"）。
         * 长按保存放在**没有这层冲突**的地方：详情页的内联播放器与信息流的视频封面；
         * 全屏页给一个显式按钮，语义一样清楚。
         */
        val mediaOpener = LocalMediaSaveOpener.current
        Box(
            modifier = Modifier
                .align(Alignment.TopEnd)
                .statusBarsPadding()
                .padding(KSpacing.md),
        ) {
            KIconButton(
                icon = GlyphKind.More,
                onClick = {
                    mediaOpener?.invoke(
                        MediaSaveTarget(url = url, kind = MediaKind.Video, title = title),
                    )
                },
            )
        }
    }
}
