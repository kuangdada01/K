package top.kuangdada.k.nativeapp.ui

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.media3.common.AudioAttributes as Media3AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import kotlin.math.roundToLong

/**
 * ============================================================
 * 私信语音播放（单例控制器）
 * ============================================================
 * 一个聊天页只有一个控制器 → **同一时间只播一条**（QQ 的行为），换一条会自动
 * 停掉上一条并从 0 开始。
 *
 * ## 为什么用 ExoPlayer
 *  · 已带鉴权头的 `DefaultHttpDataSource`：语音存在 uploads_private，URL 本身不带
 *    token，必须把 `Authorization` 注入数据源（否则恒 403）；
 *  · 原生支持 Range/seek（拖动波形定位依赖它），也自带音频焦点处理。
 *
 * ## 听筒/扬声器
 * 语音默认**扬声器**播放（与 QQ 一致）；切到听筒时把 `AudioManager` 切到
 * `MODE_IN_COMMUNICATION` + `isSpeakerphoneOn=false`。暂停/释放时恢复 `MODE_NORMAL`，
 * 不能把这个模式留给后面的音乐/视频。
 *
 * ## ★ 接着耳机时：一律不碰 AudioManager（2026-10-22）
 * 用户反馈"语音播放没有接入耳机"。根因是上面那套无条件的通话模式：
 *  · `MODE_IN_COMMUNICATION` 把路由切到通话策略 → **蓝牙 A2DP 直接失效**（声音回到手机）；
 *  · `isSpeakerphoneOn = true`（默认扬声器档）在通话模式下会强行用**手机外放**，
 *    有线耳机也被压住。
 *
 * QQ/微信的做法：接了耳机就完全交给系统默认路由（我们的 `USAGE_MEDIA` 本来就会走耳机），
 * 并且**不再提供「听筒」开关**。所以这里维护 [headsetConnected]：
 *  · 有外部输出（有线/USB/蓝牙/HDMI…）→ [applyRoute] 什么都不做（只回收自己改过的模式）；
 *  · 播放中插/拔耳机 → `AudioDeviceCallback` 立刻重新决策；
 *  · 没有耳机 → 还是原来的听筒/扬声器切换。
 */
class VoicePlaybackController(
    private val context: Context,
    private val authHeaders: Map<String, String>,
) {

    private val audioManager: AudioManager? =
        context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager

    private val mainHandler = Handler(Looper.getMainLooper())

    private val player: ExoPlayer = run {
        val http = DefaultHttpDataSource.Factory()
            .setDefaultRequestProperties(authHeaders)
            .setConnectTimeoutMs(8_000)
            .setReadTimeoutMs(15_000)
            // 跟随重定向（服务端目前不跳，但 CDN/反代以后可能加）
            .setAllowCrossProtocolRedirects(true)
        val dataSource = DefaultDataSource.Factory(context, http)
        ExoPlayer.Builder(context)
            .setMediaSourceFactory(DefaultMediaSourceFactory(dataSource))
            // 拔耳机（ACTION_AUDIO_BECOMING_NOISY）自动暂停：否则声音会突然从手机外放
            // 炸出来，也符合"耳机拔了就不该继续放"的直觉（QQ/微信一致）
            .setHandleAudioBecomingNoisy(true)
            .build()
            .apply {
                // 单条语音永远不循环；播完停在开头（再点一次才重播）
                repeatMode = Player.REPEAT_MODE_OFF
                setAudioAttributes(
                    Media3AudioAttributes.Builder()
                        .setUsage(C.USAGE_MEDIA)
                        .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
                        .build(),
                    /* handleAudioFocus = */ true,
                )
                addListener(object : Player.Listener {
                    override fun onIsPlayingChanged(playing: Boolean) {
                        updatePlaying(playing)
                        if (!playing && playbackState == Player.STATE_ENDED) {
                            // ★ 必须先把 playWhenReady 置 false 再 seek：
                            //   ExoPlayer 在 ENDED 时 playWhenReady 仍为 true，直接 seekTo(0)
                            //   会重新进入 READY 并**自动续播**——用户听到的就是"循环播放"。
                            player.pause()
                            seekTo(0)
                            resetPosition()
                        }
                        if (playing) applyRoute() else restoreRoute()
                    }

                    override fun onPlaybackStateChanged(state: Int) {
                        if (state == Player.STATE_READY && durationMs <= 0) {
                            val d = this@VoicePlaybackController.player.duration
                            if (d > 0 && d != C.TIME_UNSET) updateDuration(d.toInt())
                        }
                    }

                    override fun onPlayerError(error: PlaybackException) {
                        updatePlaying(false)
                        clearCurrent()
                        restoreRoute()
                        onError?.invoke("语音播放失败，请检查网络")
                    }
                })
            }
    }

    /** 当前正在播/加载的消息 id；null = 没有活动播放 */
    var currentId by mutableStateOf<Long?>(null)
        private set

    var isPlaying by mutableStateOf(false)
        private set

    /** 当前进度（ms） */
    var positionMs by mutableLongStateOf(0L)
        private set

    /** 本条语音总时长（ms）；优先用消息里带的时长，READY 后再校正 */
    var durationMs by mutableIntStateOf(0)
        private set

    /** 是否从扬声器出声（false = 听筒）。接着耳机时这个开关不参与路由（见类注释） */
    var speakerOn by mutableStateOf(true)
        private set

    /**
     * 现在接着**外部输出**（有线耳机 / USB 声卡 / 蓝牙耳机 / HDMI / 扩展坞…）。
     *
     * 为 true 时：不切通话模式、不改 speakerphone、不显示「听筒/扬声器」菜单项 ——
     * 声音完全交给系统走耳机（QQ/微信的行为）。插拔耳机由 [deviceCallback] 实时刷新。
     */
    var headsetConnected by mutableStateOf(false)
        private set

    /** 通话模式是不是**我们自己**切的：只回收自己的，别去动语音房正在用的通话模式 */
    private var ownsCommMode = false

    private val deviceCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) = refreshHeadset()

        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) =
            refreshHeadset()
    }

    init {
        // 先取一次当前设备（可能进来时耳机就插着），再订阅插拔
        refreshHeadset()
        runCatching {
            audioManager?.registerAudioDeviceCallback(deviceCallback, mainHandler)
        }
    }

    /**
     * 平滑进度：以**帧时间**推进，而不是每帧读 `player.currentPosition`。
     *
     * 设备的音频位置更新并不保证逐帧（可能 50–250ms 一次），直接读会让进度线
     * "一格一格扫"。这里只在开始/seek/暂停时与播放器对齐，中间按帧间隔累加，
     * 声音本身是 1x，几十秒的累计误差可以忽略。
     */
    private var smoothPositionMs = 0.0
    private var lastFrameNanos = 0L

    /** 播放失败回调（由页面弹 toast） */
    var onError: ((String) -> Unit)? = null

    /**
     * 点一条语音气泡：同一条 → 播放/暂停；换一条 → 切源并从 0 播。
     */
    fun toggle(messageId: Long, url: String, messageDurationMs: Int) {
        if (currentId == messageId) {
            if (player.isPlaying) {
                player.pause()
            } else {
                if (player.playbackState == Player.STATE_ENDED) player.seekTo(0)
                smoothPositionMs = player.currentPosition.coerceAtLeast(0L).toDouble()
                lastFrameNanos = 0L
                player.play()
            }
            return
        }

        currentId = messageId
        positionMs = 0
        smoothPositionMs = 0.0
        lastFrameNanos = 0L
        durationMs = messageDurationMs.coerceAtLeast(0)
        player.setMediaItem(MediaItem.fromUri(url))
        player.prepare()
        player.play()
    }

    /** 拖动波形：按比例定位（0f..1f）。播放中拖动会立刻从新位置继续 */
    fun seekToFraction(fraction: Float) {
        if (currentId == null) return
        val total = if (durationMs > 0) durationMs else player.duration.takeIf { it > 0 }?.toInt() ?: 0
        if (total <= 0) return
        val target = (fraction.coerceIn(0f, 1f) * total).toLong()
        player.seekTo(target)
        positionMs = target
        smoothPositionMs = target.toDouble()
        lastFrameNanos = 0L
    }

    /**
     * UI 每帧调一次（`withFrameNanos`）：用帧间隔推进平滑进度。
     *
     * @param frameNanos 当前帧的 `System.nanoTime` 时间戳
     */
    fun refreshPosition(frameNanos: Long) {
        if (currentId == null) return
        val total = player.duration
        if (total > 0 && total != C.TIME_UNSET) durationMs = total.toInt()

        if (!player.isPlaying) {
            smoothPositionMs = player.currentPosition.coerceAtLeast(0L).toDouble()
            lastFrameNanos = 0L
            positionMs = smoothPositionMs.roundToLong()
            return
        }

        if (lastFrameNanos == 0L) {
            // 起播/seek 后第一帧：以播放器位置为准
            smoothPositionMs = player.currentPosition.coerceAtLeast(0L).toDouble()
        } else {
            smoothPositionMs += (frameNanos - lastFrameNanos) / 1_000_000.0
        }
        lastFrameNanos = frameNanos

        if (durationMs > 0) smoothPositionMs = smoothPositionMs.coerceIn(0.0, durationMs.toDouble())
        positionMs = smoothPositionMs.roundToLong()
    }

    /** 退到后台/离开页面时暂停（不释放，回来还能接着播） */
    fun pause() {
        if (player.isPlaying) player.pause()
    }

    /** 扬声器 / 听筒切换（立即生效）；接着耳机时没有这一档（声音必须留在耳机里） */
    fun toggleSpeaker() {
        if (headsetConnected) return
        speakerOn = !speakerOn
        if (isPlaying) applyRoute()
    }

    /** 页面销毁：停、释放、恢复音频模式 */
    fun release() {
        onError = null
        currentId = null
        isPlaying = false
        runCatching { audioManager?.unregisterAudioDeviceCallback(deviceCallback) }
        runCatching { player.stop() }
        runCatching { player.release() }
        restoreRoute()
    }

    /** listener 是独立类作用域，写 private-set 属性要经过成员方法 */
    private fun updatePlaying(value: Boolean) {
        isPlaying = value
    }

    private fun updateDuration(value: Int) {
        durationMs = value
    }

    /** 播完回到开头（listener 里不能直接写 private-set 属性） */
    private fun resetPosition() {
        positionMs = 0
        smoothPositionMs = 0.0
        lastFrameNanos = 0L
    }

    /** 播放失败：收起当前条目的活动态 */
    private fun clearCurrent() {
        currentId = null
    }

    /**
     * 插拔耳机后立刻重新决策。
     *
     * "外部输出"的判据是**设备类型**而不是 `isSpeakerphoneOn`：手机自带扬声器/听筒以外的
     * 输出（有线、USB、蓝牙 A2DP/LE、HDMI、扩展坞、助听器…）都算 —— 这些设备接着的时候
     * 绝不能把声音抢回手机。
     */
    private fun refreshHeadset() {
        val am = audioManager ?: return
        val external = runCatching {
            am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any { it.isExternalOutput() }
        }.getOrDefault(false)
        if (external == headsetConnected) return
        headsetConnected = external
        // 播着的时候拔耳机：回到听筒/外放；插上耳机：立刻交给耳机
        if (isPlaying) applyRoute()
    }

    /** 手机自带扬声器 / 听筒以外的输出设备（`TYPE_UNKNOWN` 不算，免得误判成耳机） */
    private fun AudioDeviceInfo.isExternalOutput(): Boolean =
        type != AudioDeviceInfo.TYPE_UNKNOWN &&
            type != AudioDeviceInfo.TYPE_BUILTIN_SPEAKER &&
            type != AudioDeviceInfo.TYPE_BUILTIN_EARPIECE

    private fun applyRoute() {
        val am = audioManager ?: return
        // ★ 接着耳机：什么都不做，交给系统默认路由（USAGE_MEDIA 会自动走耳机）。
        //   切 MODE_IN_COMMUNICATION 会让蓝牙 A2DP 失效、并把有线耳机压成外放。
        if (headsetConnected) {
            restoreRoute()
            return
        }
        runCatching {
            am.mode = AudioManager.MODE_IN_COMMUNICATION
            ownsCommMode = true
            am.isSpeakerphoneOn = speakerOn
        }
    }

    private fun restoreRoute() {
        val am = audioManager ?: return
        runCatching {
            if (am.isSpeakerphoneOn) am.isSpeakerphoneOn = false
            // 只回收自己切的模式：语音房/系统通话正在用 MODE_IN_COMMUNICATION 时
            // 这里写 NORMAL 会把对方的声音也一起断掉
            if (ownsCommMode) {
                am.mode = AudioManager.MODE_NORMAL
                ownsCommMode = false
            }
        }
    }
}
