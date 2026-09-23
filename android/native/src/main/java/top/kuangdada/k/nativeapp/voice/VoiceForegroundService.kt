package top.kuangdada.k.nativeapp.voice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import top.kuangdada.k.nativeapp.MainActivity
import top.kuangdada.k.nativeapp.R

/**
 * ============================================================
 * 语音房前台服务（VoiceForegroundService）
 * ============================================================
 * **为什么必须有它**：Android 14（API 34）起，**后台应用不能再采集麦克风** ——
 * 没有前台服务持有时，锁屏 / 切后台之后系统会把采集静音，表现是
 * "界面还在、别人听不到你说话"，而且**不报任何错**。所以要进房就起前台服务。
 *
 * 用到的前台服务类型：`mediaPlayback | microphone`（与 `:app` 的 `PlaybackService` 同一套）。
 * 类型必须在 Manifest 里用 `android:foregroundServiceType` 声明，
 * 对应的权限也要声明（见 AndroidManifest）。
 *
 * 音频焦点：语音房是"通话"语义，拿到焦点时请求 `AUDIOFOCUS_GAIN_TRANSIENT` +
 * `USAGE_VOICE_COMMUNICATION`，这样系统会：
 *  · 暂停正在放的音乐（而不是两个声音叠在一起）；
 *  · 走通话音量通道（听筒/免提按通话音量调，而不是媒体音量）。
 * 焦点丢掉时**不自动退出房间** —— 只是别人可能听不到你，UI 上给提示即可；
 * 直接退房会让用户觉得"被打了个电话就掉线了"。
 */
class VoiceForegroundService : Service() {

    private var audioManager: AudioManager? = null
    private var focusRequest: AudioFocusRequest? = null

    /**
     * 当前所在房间 id。
     *
     * 为什么记在这里：通知被点击时要**跳回那个房间**（而不是只打开 App 首页）——
     * 用户从通知栏点进来，期望看到的是自己还在的这个语音房。
     * 跳转靠 [DeepLink] + MainActivity 的 `deep_link` extra 实现。
     */
    private var roomId: Long = 0L

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                // 用户从通知栏点"退出房间"：把通知收掉并停服。
                // 真正的退房由控制器负责（它会关 WS 与 WebRTC）——这里只发广播/不处理业务，
                // 避免服务与控制器两边都改状态。
                stopSelfSafely()
                return START_NOT_STICKY
            }
            else -> {
                roomId = intent?.getLongExtra(EXTRA_ROOM_ID, 0L) ?: 0L
                startForegroundSafely(
                    title = intent?.getStringExtra(EXTRA_TITLE) ?: "语音房",
                    text = intent?.getStringExtra(EXTRA_TEXT) ?: "正在语音通话",
                )
                requestAudioFocus()
            }
        }
        // 被系统杀掉后不自动重启：语音房没有"自动重连进房"的语义，
        // 重启一个没有 WebRTC 会话的空服务只会留下一个假通知。
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        abandonAudioFocus()
        super.onDestroy()
    }

    private fun startForegroundSafely(title: String, text: String) {
        val notification = buildNotification(title, text)
        // ⚠️ 类型必须与 Manifest 的 foregroundServiceType **一致**（mediaPlayback|microphone|mediaProjection）。
        // Android 14+ 的规则是"启动时声明的类型要覆盖实际用的类型"：
        // 这里少写 mediaProjection 的话，等用户真去共享屏幕时系统会直接
        // 抛 SecurityException/杀服务 —— 表现为"点了共享就掉线"。
        // 代价只是多声明一个类型，没有任何运行时开销。
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK or
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
        } else {
            0
        }
        // 用 ServiceCompat：Android 14+ 要求显式给类型，老版本忽略该参数
        runCatching {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type)
        }
    }

    private fun stopSelfSafely() {
        runCatching {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        }
        stopSelf()
    }

    private fun ensureChannel() {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.voice_channel),
            // LOW：语音房的通知只是"保活凭据 + 退出入口"，不需要响铃打扰
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.voice_channel_desc)
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(title: String, text: String): Notification {
        // 点击通知 → 回到**这个语音房**（而不是只打开 App）。
        // 走 deep_link extra：MainActivity.onNewIntent 里统一用 DeepLink 解析，
        // 这样"通知跳转"和"站内链接跳转"共用同一条路径与同一套断言/单测。
        val openDeepLink = if (roomId > 0) "voice:$roomId" else null
        val openApp = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                if (openDeepLink != null) putExtra("deep_link", openDeepLink)
            },
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val stop = PendingIntent.getService(
            this,
            1,
            Intent(this, VoiceForegroundService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_voice_notification)
            .setOngoing(true)
            .setContentIntent(openApp)
            .addAction(0, getString(R.string.voice_stop), stop)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .build()
    }

    // ---------------------------------------------------------------
    // 音频焦点（通话语义）
    // ---------------------------------------------------------------

    private fun requestAudioFocus() {
        val manager = getSystemService(AudioManager::class.java) ?: return
        audioManager = manager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                )
                // 丢焦点时不暂停采集：语音房被电话打断时用户往往希望"对方等一下"，
                // 而不是直接掉线。真正的暂停交给系统（电话期间麦克风本来就拿不到）。
                .setWillPauseWhenDucked(false)
                .build()
            focusRequest = request
            runCatching { manager.requestAudioFocus(request) }
        } else {
            @Suppress("DEPRECATION")
            runCatching {
                manager.requestAudioFocus(
                    null,
                    AudioManager.STREAM_VOICE_CALL,
                    AudioManager.AUDIOFOCUS_GAIN_TRANSIENT,
                )
            }
        }
        // 语音房默认走扬声器（"免提"），与 Web 版行为一致；
        // 真正的听筒/免提切换由后续的扬声器按钮接入（M3 第 16 项）
        @Suppress("DEPRECATION")
        runCatching { manager.isSpeakerphoneOn = true }
    }

    private fun abandonAudioFocus() {
        val manager = audioManager ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            focusRequest?.let { runCatching { manager.abandonAudioFocusRequest(it) } }
        } else {
            @Suppress("DEPRECATION")
            runCatching { manager.abandonAudioFocus(null) }
        }
        focusRequest = null
        audioManager = null
    }

    companion object {
        private const val CHANNEL_ID = "k_voice"
        private const val NOTIFICATION_ID = 4201
        const val ACTION_STOP = "top.kuangdada.k.nativeapp.voice.STOP"
        private const val EXTRA_TITLE = "title"
        private const val EXTRA_TEXT = "text"
        private const val EXTRA_ROOM_ID = "room_id"

        /** 起前台服务（**必须在 App 处于前台时调用**，Android 12+ 有后台启动限制） */
        fun start(context: Context, title: String, text: String, roomId: Long = 0L) {
            val intent = Intent(context, VoiceForegroundService::class.java).apply {
                putExtra(EXTRA_TITLE, title)
                putExtra(EXTRA_TEXT, text)
                // roomId 用于"点通知跳回这个房间"，不是可选的装饰
                putExtra(EXTRA_ROOM_ID, roomId)
            }
            runCatching { context.startForegroundService(intent) }
        }

        /** 更新通知文案（如"3 人在房"） */
        fun update(context: Context, title: String, text: String, roomId: Long = 0L) {
            start(context, title, text, roomId)
        }

        fun stop(context: Context) {
            runCatching { context.stopService(Intent(context, VoiceForegroundService::class.java)) }
        }
    }
}
