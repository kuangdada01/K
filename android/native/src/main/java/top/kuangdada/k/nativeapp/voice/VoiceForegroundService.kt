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
import android.util.Log
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
 * "界面还在、别人听不到你说话"，而且**不报任何错**。所以要在**界面可见、
 * 权限已满足**的阶段（用户刚点进房）就建立前台状态，再开始采集 ——
 * 等 `joined` 再起的话，弱网建连期间用户一旦切后台就再也起不来了。
 *
 * **服务类型 = Manifest 声明全集，运行时按实际能力请求子集**：
 * Manifest 保留 `mediaPlayback|microphone|mediaProjection`（支持的类型集合），
 * 每次启动/升级只传当前确实使用且满足前置条件的子集：
 *  · 普通语音进房：`mediaPlayback`（+ 已授权时的 `microphone`）；
 *  · 拒绝麦克风/只听模式：仅 `mediaPlayback`；
 *  · 开始屏幕共享：用户授权后升级加入 `mediaProjection`（共享流程固定为
 *    「用户授权 → 服务加类型并确认 → 启动采集」，见 VoiceRoomController.startShare）。
 * Android 官方明确允许运行时使用 Manifest 声明类型的子集，见
 * https://developer.android.com/develop/background-work/services/fgs/service-types
 *
 * **失败必须回传**：startForeground / startForegroundService 抛出的任何异常都经
 * [VoiceRoomSessionHub.onForegroundServiceError] 路由给控制器 —— 控制器停止已占用的
 * 资源并显示可重试的错误；吞掉异常继续跑会留下「界面显示已加入、系统却没给前台状态」
 * 的静默坏态。
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
    private var audioRouter: VoiceAudioRouter? = null

    /**
     * 当前所在房间 id。
     *
     * 为什么记在这里：通知被点击时要**跳回那个房间**（而不是只打开 App 首页）——
     * 用户从通知栏点进来，期望看到的是自己还在的这个语音房。
     * 跳转靠 [DeepLink] + MainActivity 的 `deep_link` extra 实现。
     */
    private var roomId: Long = 0L

    /** 当前会话标识：通知「退出房间」按钮带着它回来，经 hub 精确退房（旧通知关不掉新房间） */
    private var sessionId: String? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                // 通知栏「退出房间」：经会话持有者进入控制器**真实的退房链路**
                // （停录制/共享/信令/WebRTC → 服务退出），而不是只把通知收掉。
                val sid = intent?.getStringExtra(EXTRA_SESSION_ID)
                val hub = VoiceRoomSessionHub.get()
                if (sid != null) {
                    when {
                        // 常规路径：会话匹配 → 控制器退房并负责停止本服务
                        hub.requestLeave(sid, "通知栏退出") -> Unit
                        // 会话仍是当前活动会话但控制器没有处理（极端窗口）：安全收尾
                        hub.isActive(sid) -> stopSelfSafely()
                        // 旧通知（迟到的停止请求）：**不能关掉新房间**，忽略
                        else -> Unit
                    }
                } else {
                    // 无会话标识的旧版意图：退当前活动会话；没有会话则收掉孤儿通知
                    if (!hub.leaveActive("通知栏退出")) stopSelfSafely()
                }
                return START_NOT_STICKY
            }
            else -> {
                roomId = intent?.getLongExtra(EXTRA_ROOM_ID, roomId) ?: roomId
                sessionId = intent?.getStringExtra(EXTRA_SESSION_ID) ?: sessionId
                // 调用方声明的能力子集；microphone 类型再按运行时权限复核一次，
                // 未授权时降级为只听子集（API 34+ 会对无权限的 mic 类型直接抛异常）
                val mic = (intent?.getBooleanExtra(EXTRA_MIC, usingMic) ?: usingMic) &&
                    checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) ==
                    android.content.pm.PackageManager.PERMISSION_GRANTED
                val projection = intent?.getBooleanExtra(EXTRA_PROJECTION, usingProjection) ?: usingProjection
                usingMic = mic
                usingProjection = projection
                val ok = startForegroundSafely(
                    title = intent?.getStringExtra(EXTRA_TITLE) ?: "语音房",
                    text = intent?.getStringExtra(EXTRA_TEXT) ?: "正在语音通话",
                    mic = mic,
                    projection = projection,
                )
                if (ok) requestAudioFocus()
            }
        }
        // 被系统杀掉后不自动重启：语音房没有"自动重连进房"的语义，
        // 重启一个没有 WebRTC 会话的空服务只会留下一个假通知。
        return START_NOT_STICKY
    }

    /** 最近一次成功建立的前台能力（启动/升级失败时保持旧值，供下一次意图回退） */
    private var usingMic = false
    private var usingProjection = false

    override fun onDestroy() {
        audioRouter?.stop()
        audioRouter = null
        abandonAudioFocus()
        super.onDestroy()
    }

    private fun startForegroundSafely(title: String, text: String, mic: Boolean, projection: Boolean): Boolean {
        val notification = buildNotification(title, text)
        // 类型 = Manifest 全集的**当前子集**（见类注释）；类型必须被 Manifest 声明覆盖
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            var t = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
            if (mic) t = t or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            if (projection) t = t or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            t
        } else {
            0
        }
        // 用 ServiceCompat：Android 14+ 要求显式给类型，老版本忽略该参数。
        // 失败不能吞：回传控制器（停资源 + 可重试错误），未被路由时至少收掉自己。
        return try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type)
            true
        } catch (t: Throwable) {
            Log.e(TAG, "startForeground 失败 mic=$mic projection=$projection", t)
            val sid = sessionId
            val routed = sid != null &&
                VoiceRoomSessionHub.get().onForegroundServiceError(
                    sid,
                    "语音服务启动失败：${t.message ?: t.javaClass.simpleName}",
                )
            if (!routed) stopSelfSafely()
            false
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
        // 「退出房间」带上会话标识：停止请求只对当前会话生效，旧通知关不掉新房间
        val stop = PendingIntent.getService(
            this,
            1,
            Intent(this, VoiceForegroundService::class.java).setAction(ACTION_STOP).apply {
                sessionId?.let { putExtra(EXTRA_SESSION_ID, it) }
            },
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
        // 一次会话 onStartCommand 会触发多次，已持有焦点时复用音频路由和焦点请求
        // （进房、开始共享各一次），每次都 new AudioFocusRequest 申请的话旧请求对象堆积、
        // 直到 onDestroy 只 abandon 最后一个（2026-09-28 审查项）
        val alreadyHolding = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && focusRequest != null
        if (!alreadyHolding) {
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
        }
        // 耳机优先；开始共享/更新通知时 start() 幂等，不覆盖正在使用的设备。
        if (audioRouter == null) audioRouter = VoiceAudioRouter(this, manager)
        audioRouter?.start()
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
        private const val TAG = "KVoiceRoom"
        private const val CHANNEL_ID = "k_voice"
        private const val NOTIFICATION_ID = 4201
        const val ACTION_STOP = "top.kuangdada.k.nativeapp.voice.STOP"
        private const val EXTRA_TITLE = "title"
        private const val EXTRA_TEXT = "text"
        private const val EXTRA_ROOM_ID = "room_id"
        private const val EXTRA_SESSION_ID = "session_id"
        private const val EXTRA_MIC = "mic"
        private const val EXTRA_PROJECTION = "projection"

        /**
         * 建立/升级前台服务能力（**必须在 App 处于前台时调用**，Android 12+ 有后台启动限制）。
         * [mic]/[projection] 描述本次确实使用且满足前置条件的能力（projection 仅在
         * 用户完成屏幕捕获授权后传 true）。
         * @return 意图是否成功提交。startForegroundService 抛异常（后台启动限制等）时
         *         回传 [sessionId] 对应的控制器并返回 false —— 调用方不得继续采集。
         */
        fun start(
            context: Context,
            title: String,
            text: String,
            roomId: Long = 0L,
            sessionId: String? = null,
            mic: Boolean = false,
            projection: Boolean = false,
        ): Boolean {
            val intent = Intent(context, VoiceForegroundService::class.java).apply {
                putExtra(EXTRA_TITLE, title)
                putExtra(EXTRA_TEXT, text)
                // roomId 用于"点通知跳回这个房间"，不是可选的装饰
                putExtra(EXTRA_ROOM_ID, roomId)
                sessionId?.let { putExtra(EXTRA_SESSION_ID, it) }
                putExtra(EXTRA_MIC, mic)
                putExtra(EXTRA_PROJECTION, projection)
            }
            return try {
                context.startForegroundService(intent)
                true
            } catch (t: Throwable) {
                Log.e(TAG, "启动语音前台服务失败", t)
                if (sessionId != null) {
                    VoiceRoomSessionHub.get().onForegroundServiceError(
                        sessionId,
                        "语音服务启动失败：${t.message ?: t.javaClass.simpleName}",
                    )
                }
                false
            }
        }

        /**
         * 更新通知文案（如"3 人在房"）或能力子集（如开始/停止共享增删 mediaProjection）。
         * 与 [start] 同一入口：服务在 onStartCommand 默认分支按新子集重新 startForeground。
         */
        fun update(
            context: Context,
            title: String,
            text: String,
            roomId: Long = 0L,
            sessionId: String? = null,
            mic: Boolean = false,
            projection: Boolean = false,
        ): Boolean = start(context, title, text, roomId, sessionId, mic, projection)

        fun stop(context: Context) {
            runCatching { context.stopService(Intent(context, VoiceForegroundService::class.java)) }
        }
    }
}
