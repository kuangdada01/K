package top.kuangdada.k.nativeapp.ui

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
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
 * 位置由 UI 以 100ms 轮询 [refreshPosition]（只有一个播放器，没必要再开协程）。
 */
class VoicePlaybackController(
    private val context: Context,
    private val authHeaders: Map<String, String>,
) {

    private val audioManager: AudioManager? =
        context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager

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
            .build()
            .apply {
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
                            // 播完回到开头（再点一次 = 重播），与 QQ 一致
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

    /** 倍速：1.0 / 1.5 / 2.0（QQ 的三档） */
    var speed by mutableFloatStateOf(1f)
        private set

    /** 是否从扬声器出声（false = 听筒） */
    var speakerOn by mutableStateOf(true)
        private set

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
                player.play()
            }
            return
        }

        currentId = messageId
        positionMs = 0
        durationMs = messageDurationMs.coerceAtLeast(0)
        player.setMediaItem(MediaItem.fromUri(url))
        player.setPlaybackSpeed(speed)
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
    }

    /** UI 每 100ms 调一次：同步进度（只在有活动播放时读，避免无谓的跨线程调用） */
    fun refreshPosition() {
        if (currentId == null) return
        val total = player.duration
        if (total > 0 && total != C.TIME_UNSET) durationMs = total.toInt()
        positionMs = player.currentPosition.coerceAtLeast(0L)
    }

    /** 1x → 1.5x → 2x → 1x */
    fun cycleSpeed() {
        speed = when (speed) {
            1f -> 1.5f
            1.5f -> 2f
            else -> 1f
        }
        player.setPlaybackSpeed(speed)
    }

    /** 退到后台/离开页面时暂停（不释放，回来还能接着播） */
    fun pause() {
        if (player.isPlaying) player.pause()
    }

    /** 扬声器 / 听筒切换（立即生效） */
    fun toggleSpeaker() {
        speakerOn = !speakerOn
        if (isPlaying) applyRoute()
    }

    /** 页面销毁：停、释放、恢复音频模式 */
    fun release() {
        onError = null
        currentId = null
        isPlaying = false
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
    }

    /** 播放失败：收起当前条目的活动态 */
    private fun clearCurrent() {
        currentId = null
    }

    private fun applyRoute() {
        val am = audioManager ?: return
        runCatching {
            am.mode = AudioManager.MODE_IN_COMMUNICATION
            am.isSpeakerphoneOn = speakerOn
        }
    }

    private fun restoreRoute() {
        val am = audioManager ?: return
        runCatching {
            am.isSpeakerphoneOn = false
            am.mode = AudioManager.MODE_NORMAL
        }
    }
}
