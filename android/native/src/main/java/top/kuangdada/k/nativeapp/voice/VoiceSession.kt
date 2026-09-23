package top.kuangdada.k.nativeapp.voice

import android.content.Context
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SoftwareVideoDecoderFactory
import org.webrtc.SoftwareVideoEncoderFactory
import org.webrtc.SurfaceTextureHelper
import org.webrtc.audio.JavaAudioDeviceModule
import top.kuangdada.k.core.data.VoiceSignaling

/**
 * ============================================================
 * WebRTC 语音会话（VoiceSession）
 * ============================================================
 * 职责：**网格（mesh）音频**。每个参与者与房间内其他人各建一条 PeerConnection，
 * 音频由 WebRTC 自己采集（`AudioSource`）并播放（`AudioTrackSink`）。
 *
 * 使用的库：`io.github.webrtc-sdk:android`（官方 `org.webrtc:google-webrtc` 停在 2021 年）。
 *
 * 三条必须遵守的规则：
 *
 * 1. **协商的确定性**（服务端设计）：`join` 返回的既有成员由**新加入者主动发 offer**。
 *    这样不会出现双方同时 offer 的冲突（glare）。本地对既有成员是发起方，
 *    对后来者（`peer-joined`）是接收方。
 *
 * 2. **必须显式加一条 sendrecv transceiver**。看起来 `addTrack` 就够了，但 WebRTC 的
 *    `addTrack` 用的是"先到先得"的复用逻辑：如果远端先发了 offer 并且已经有一条
 *    只收的 audio m-line，本地的 `addTrack` 会**复用它**而不产生新的 m-line，
 *    结果本地的麦克风根本发不出去（表现：别人听不到你说话，而信令看起来完全正常）。
 *    显式加 transceiver 后，一旦轨道被挂上会自动重新协商 —— 这才是语音房的正确形态。
 *
 * 3. **远端音轨只注册一次 sink**。`onAddTrack` 可能对同一路远端音频被调用多次
 *    （多个 peer 各自带 track），重复注册会让声音叠加、听起来像回声。
 *    这里用 `remoteTrackIds` 去重。
 *
 * 音频处理（回声消除/降噪/自动增益）刻意走 **WebRTC 内建的 APM**，而不是在采集侧
 * 用 `AudioRecord` 手搓 —— 这也是原生相对 Web 版的一个简化：Web 版要靠 RNNoise 的
 * AudioWorklet + WASM，原生直接用 WebRTC 的音频处理链即可（M3 第 16 项的"降噪"因此
 * 几乎是免费得到的）。
 */
class VoiceSession(
    context: Context,
    private val iceServers: List<PeerConnection.IceServer>,
) {

    /** 一条远端流的状态（UI 用它画麦位与说话状态） */
    data class RemotePeer(
        val userId: Long,
        val username: String,
        val muted: Boolean,
        val listener: Boolean,
        val sharing: Boolean,
    )

    interface Listener {
        /** 需要把 SDP / ICE 发给对端（由信令层发送） */
        fun onSendSignal(targetUserId: Long, data: JsonObject)

        /** 远端音频轨已挂上（第一个人说话时触发一次），UI 可据此停止"正在连接音频" */
        fun onRemoteAudioAttached(userId: Long)

        /** 远端的**屏幕共享**视频轨已挂上（UI 据此切到共享画面） */
        fun onRemoteVideoAttached(userId: Long, track: org.webrtc.VideoTrack) = Unit

        /**
         * 远端共享画面的**真实宽高比**（收到帧之后才知道，所以是独立回调）。
         *
         * 为什么不能只靠 `remoteVideoAspect` 这个 `@Volatile` 字段：UI 是在组合期读它的，
         * 而 volatile **不会触发重组** —— 首帧到达时容器尺寸不会被重算（用户实测
         * 「全屏打开没有改善」就有这一条）。所以这里推给控制器，进 Compose 状态。
         */
        fun onRemoteVideoAspect(aspect: Float) = Unit

        /** 需要重新协商（收到带新 m-line 的 offer 时） */
        fun onNegotiationRequested(userId: Long)

        /**
         * 某个远端成员**开始/停止说话**（M6：麦位边框点亮）。
         *
         * 只在**翻转**时回调一次（不是每轮统计都推），UI 直接照着画即可。
         * 判据是 WebRTC 统计里的 `inbound-rtp.audioLevel`，门限与迟滞见 [SpeakingGate]。
         */
        fun onSpeaking(userId: Long, speaking: Boolean) = Unit

        /** 自己开始/停止说话（同上；自己那格的边框也要亮） */
        fun onSelfSpeaking(speaking: Boolean) = Unit

        fun onError(message: String)
    }

    private val appContext = context.applicationContext
    private var factory: PeerConnectionFactory? = null
    private var audioSource: AudioSource? = null
    private var localAudioTrack: AudioTrack? = null
    private var eglBase: EglBase? = null
    private var audioModule: JavaAudioDeviceModule? = null

    // ---- 屏幕共享（视频）----
    private var surfaceTextureHelper: SurfaceTextureHelper? = null
    private var screenCapturer: org.webrtc.ScreenCapturerAndroid? = null
    private var videoSource: org.webrtc.VideoSource? = null
    private var localVideoTrack: org.webrtc.VideoTrack? = null

    /** 采集观测 sink（只用于记录真实帧数；停止共享时摘掉） */
    private var frameProbe: org.webrtc.VideoSink? = null

    /** 共享出站统计轮询（只在共享期间活着，用于定位"糊"是发送端还是接收端） */
    private var shareStatsJob: Job? = null

    /** 接收侧视频探针（轨道 -> sink）：removePeer/stop 时要摘掉，否则留下指向已释放轨道的回调 */
    private val receiveProbes = mutableListOf<Pair<org.webrtc.VideoTrack, org.webrtc.VideoSink>>()

    /** 接收侧统计轮询（每次共享只跑一个） */
    private var receiveStatsJob: Job? = null

    /**
     * 说话检测轮询（M6）。
     *
     * **只用 `getStats()` 的只读幅度**（`inbound-rtp.audioLevel` / `media-source.audioLevel`），
     * 不往音轨上挂 `AudioTrackSink`：挂 sink 的语义（旁路监听 vs 接管播放）在 Java 层没有
     * 可靠承诺，猜错的代价是**整房人听不到声音**；统计最坏只是"灯不亮"。理由写在 [SpeakingGate]。
     */
    private var speakingJob: Job? = null

    /** 每个远端的说话门限状态机（对端离开时移除） */
    private val speakingGates = mutableMapOf<Long, SpeakingGate>()

    /** 自己那一路的说话状态机 */
    private val selfSpeakingGate = SpeakingGate()

    /** 自己的麦克风是否开着（闭麦时不该点亮自己那格） */
    @Volatile
    private var selfMicEnabled: Boolean = true

    /** 已连接的远端音频轨（含共享系统声音）：接收侧静音开关要逐个 setEnabled */
    private val remoteAudioTracks = mutableListOf<org.webrtc.AudioTrack>()

    /** 接收音频是否开启（观看端的声音图标）；默认开 */
    @Volatile
    private var receiveAudioEnabled: Boolean = true

    /**
     * 远端共享画面的最新宽高比（0 = 还没收到帧）。
     *
     * 供 UI 让**容器**跟随画面比例：手机屏幕是竖屏（9:19.5），
     * 若容器固定 16:9，画面只能 letterbox 留黑或裁切 —— 用户实测反馈
     * 「点屏幕共享是不按比例放大的显示不全」。
     */
    @Volatile
    var remoteVideoAspect: Float = 0f
        private set

    /**
     * EGL 上下文提供者（要传给 `SurfaceTextureHelper.create`）。
     *
     * 为什么用可变 lambda 而不是构造器参数：`EglBase.Context` 是**原生句柄**，
     * 而 `EglBase.create()` 必须在 WebRTC 初始化之后才能调 —— 构造 VoiceSession 时
     * 还没初始化，拿不到。所以这里留一个可替换的取值器，`start()` 里赋值。
     */
    private var eglContextProvider: () -> EglBase.Context? = { null }

    /** 每个远端一条连接 */
    private val peers = mutableMapOf<Long, PeerConnection>()

    /** 已挂 sink 的远端音轨 id（去重，避免叠加播放导致回声） */
    private val remoteTrackIds = mutableSetOf<String>()

    /** 远端音轨的持有者（用于把"有声音了"映射回 userId，UI 好画说话态） */
    private val trackOwner = mutableMapOf<String, Long>()

    private var listener: Listener? = null
    private var started = false

    /**
     * 全房间混音录制器（由控制器挂进来）。
     *
     * 为什么挂在会话上而不是独立存在：录制的两个音频源都来自 WebRTC 的
     * `JavaAudioDeviceModule` 回调，生命周期必须与 PeerConnectionFactory 一致
     * （工厂销毁后回调就不再触发，录制会静默变成空文件）。
     */
    var recorder: RoomRecorder? = null

    /** 本端是否已加入（未加入时不接受远端信令，避免建出"幽灵连接"） */
    private var joined = false

    fun setListener(l: Listener) {
        listener = l
    }

    val isStarted: Boolean get() = started

    // ---------------------------------------------------------------
    // 启动 / 停止
    // ---------------------------------------------------------------

    /**
     * 初始化 WebRTC 与本地麦克风。
     *
     * **必须在拿到 RECORD_AUDIO 权限之后调用** —— 没有权限时 `JavaAudioDeviceModule`
     * 建出来的 AudioRecord 是无效的，WebRTC 不会报错，只会"本地静音"，极难定位。
     */
    fun start() {
        if (started) return
        try {
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(appContext)
                    // 打开 WebRTC 内部日志，排查真机上的建连问题（只在 debug 包建议开）
                    .setInjectableLogger({ message, severity, label ->
                        Log.d(TAG, "[$severity][$label] $message")
                    }, org.webrtc.Logging.Severity.LS_WARNING)
                    .createInitializationOptions()
            )

            // 音频设备模块：回声消除/降噪/自动增益都打开（原生版的"降噪"来自这里）。
            // 注意 setUseHardware* 只在设备支持时才生效（isBuiltIn*Supported），
            // 不支持时 WebRTC 会走内建软件 APM —— 两者都是可用的，不需要额外兜底。
            val moduleBuilder = JavaAudioDeviceModule.builder(appContext)
            if (JavaAudioDeviceModule.isBuiltInAcousticEchoCancelerSupported()) {
                moduleBuilder.setUseHardwareAcousticEchoCanceler(true)
            }
            if (JavaAudioDeviceModule.isBuiltInNoiseSuppressorSupported()) {
                moduleBuilder.setUseHardwareNoiseSuppressor(true)
            }
            // 全房间混音录制要用的两个音频源（M3 第 16 项）：
            //  · SamplesReady         = 本地麦克风采集（已过 APM）
            //  · PlaybackSamplesReady = 远端混音后的播放 PCM（WebRTC 已把多路远端混好）
            // 两个回调分别在录音线程与播放线程上触发，回调体必须极轻（见 RoomRecorder 的说明）
            moduleBuilder.setSamplesReadyCallback { samples ->
                recorder?.onMicrophoneSamples(
                    samples.data,
                    samples.sampleRate,
                    samples.channelCount,
                )
            }
            moduleBuilder.setPlaybackSamplesReadyCallback { samples ->
                recorder?.onPlaybackSamples(
                    samples.data,
                    samples.sampleRate,
                    samples.channelCount,
                )
            }
            val module = moduleBuilder.createAudioDeviceModule()
            audioModule = module

            val egl = EglBase.create()
            eglBase = egl
            // 屏幕共享要把 SurfaceTextureHelper 建在这个 EGL 上下文上，
            // 而它是在 start() 之后才可能被调用（共享随时开始），所以这里赋值给取值器
            eglContextProvider = { egl.eglBaseContext }

            // 视频编解码：**必须用硬件编解码器**来跑屏幕共享 —— 屏幕内容通常是
            // 1080p 以上的静态/半静态画面，软件编码在真机上会直接吃满 CPU 并掉帧。
            // eglBaseContext 也是 ScreenCapturer 的必需参数。
            val encoder = DefaultVideoEncoderFactory(egl.eglBaseContext, true, true)
            val decoder = DefaultVideoDecoderFactory(egl.eglBaseContext)

            factory = PeerConnectionFactory.builder()
                .setOptions(
                    PeerConnectionFactory.Options().apply {
                        // Android 16（targetSdk 36）上必须关掉 WebRTC 的 AndroidNetworkMonitor：
                        // 它会在 native 侧经 JNI 调 `Network.getNetworkHandle()`，而这个
                        // 隐藏 API 在新系统上被拦截，异常逃到 native 变成 CHECK 失败 →
                        // **整个进程 SIGABRT**（栈全在 libjingle_peerconnection_so.so，
                        // tid=network_thread），一进房就闪退。
                        // 关掉后 ICE 仍可用 host + STUN/TURN（srflx/relay）候选，
                        // 语音房有 TURN 兜底，不依赖系统网络监控。
                        disableNetworkMonitor = true
                    }
                )
                .setAudioDeviceModule(module)
                .setVideoEncoderFactory(encoder)
                .setVideoDecoderFactory(decoder)
                .createPeerConnectionFactory()

            // 麦克风采集源。WebRTC 的 APM（回声消除/降噪/AGC）就在这条链上
            val constraints = MediaConstraints().apply {
                mandatory.add(MediaConstraints.KeyValuePair("googEchoCancellation", "true"))
                mandatory.add(MediaConstraints.KeyValuePair("googNoiseSuppression", "true"))
                mandatory.add(MediaConstraints.KeyValuePair("googAutoGainControl", "true"))
                mandatory.add(MediaConstraints.KeyValuePair("googHighpassFilter", "true"))
            }
            audioSource = factory?.createAudioSource(constraints)
            localAudioTrack = factory?.createAudioTrack(AUDIO_TRACK_ID, audioSource)

            started = true
        } catch (t: Throwable) {
            listener?.onError("音频初始化失败：${t.message}")
        }
    }

    fun stop() {
        joined = false
        stopScreenShare()
        // 先摘接收探针再关连接（顺序反了会留下指向已释放轨道的回调）
        receiveStatsJob?.cancel()
        receiveStatsJob = null
        speakingJob?.cancel()
        speakingJob = null
        speakingGates.clear()
        selfSpeakingGate.reset()
        receiveProbes.forEach { (track, sink) -> runCatching { track.removeSink(sink) } }
        receiveProbes.clear()
        remoteAudioTracks.clear()
        peers.values.forEach { runCatching { it.close() } }
        peers.clear()
        remoteTrackIds.clear()
        trackOwner.clear()
        runCatching { localAudioTrack?.dispose() }
        runCatching { audioSource?.dispose() }
        runCatching { audioModule?.release() }
        runCatching { factory?.dispose() }
        runCatching { eglBase?.release() }
        localAudioTrack = null
        audioSource = null
        audioModule = null
        factory = null
        eglBase = null
        started = false
    }

    fun setJoined(value: Boolean) {
        joined = value
    }

    /** 本端静音：只关麦克风采集，不断连接（服务端另有 mute 广播用于 UI 状态） */
    fun setMicEnabled(enabled: Boolean) {
        localAudioTrack?.setEnabled(enabled)
        selfMicEnabled = enabled
        // 闭麦时立刻收掉自己那格的说话状态（不等保持期）—— 否则"已闭麦还在亮"很怪
        if (!enabled && selfSpeakingGate.reset()) listener?.onSelfSpeaking(false)
    }

    // ---------------------------------------------------------------
    // 屏幕共享（M3 第 16 项）
    // ---------------------------------------------------------------

    /**
     * 开始屏幕共享。
     *
     * @param permissionData `MediaProjectionManager.createScreenCaptureIntent()` 返回的 Intent
     * @param projectionCallback 系统侧回调。**Android 14（API 34）起必须注册** ——
     *        用户在系统弹窗里点"停止共享"时要跟着停；不注册会直接抛异常。
     */
    fun startScreenShare(
        permissionData: android.content.Intent,
        projectionCallback: android.media.projection.MediaProjection.Callback,
    ): Boolean {
        val f = factory ?: return false
        val eglContext = eglContextProvider() ?: return false
        if (localVideoTrack != null) return true // 已在共享

        return try {
            val helper = SurfaceTextureHelper.create("KShareCapture", eglContext)
            surfaceTextureHelper = helper

            // 采集分辨率与帧率：**长边封顶 1920（1080p）、60fps**（用户明确要求 1080p60，
            // 与 Web 端档位一致）。物理分辨率（例如 1440×3168）不是屏幕共享需要的清晰度 ——
            // 编码器最终按码率把画面缩下来，多出来的像素只是白烧 CPU/带宽。
            val capturer = org.webrtc.ScreenCapturerAndroid(permissionData, projectionCallback)
            screenCapturer = capturer

            val source = f.createVideoSource(false)
            videoSource = source
            capturer.initialize(helper, appContext, source.capturerObserver)
            // 采集分辨率：**长边封顶 1920**（原来直接用物理分辨率，例如 1440×3168）。
            // 物理像素不是屏幕共享需要的清晰度 —— 编码器最终按码率把画面缩下来，
            // 多出来的像素只是白烧 CPU/带宽，还让分辨率自适应更难收敛。
            // 保持宽高比（竖屏仍是竖屏），换算里"0 尺寸"会让 startCapture 静默失败 → 对方黑屏。
            val metrics = appContext.resources.displayMetrics
            val (captureWidth, captureHeight) =
                captureSizeFor(metrics.widthPixels, metrics.heightPixels)
            capturer.startCapture(captureWidth, captureHeight, SHARE_CAPTURE_FPS)
            localShareCaptureSize = captureWidth to captureHeight
            Log.i(TAG, "屏幕共享采集启动：${captureWidth}x${captureHeight}@${SHARE_CAPTURE_FPS}fps")

            /**
             * **本端共享时不要把采集比例写进 `remoteVideoAspect`**（M6.8 真机定位到的 bug）。
             *
             * 这个字段的名字与用途都是"**远端那一路共享画面**的比例"——
             * UI 用它算全屏/内联的 letterbox 框。原来的注释以为"自共享的画面不经过接收探针、
             * 推一次互不冲突"，但真机日志证明了相反：自己一开共享，这个字段就变成**本机屏幕**的比例
             * （竖屏 ≈ 0.45），于是**远端**那块共享画面被按 0.45 的框去排版 ——
             * 表现为"画面一直裁切、跳动"。
             *
             * 远端比例只有一个来源：接收探针按**收到的帧**算（见 [attachReceiveVideoProbe]）。
             * 本端共享的画面**本来就不在这个字段的服务范围里**（App 不预览自己的共享）。
             */
            Log.i(TAG, "本端共享采集尺寸 ${captureWidth}x$captureHeight（不写 remoteVideoAspect，见注释）")

            val track = f.createVideoTrack(VIDEO_TRACK_ID, source)
            localVideoTrack = track

            // 采集真实性观测：WebRTC 采集失败是**静默**的（不抛异常、不报错），
            // 表现就是对方黑屏。这里数一下真实收到的帧数，排查时一眼能看出
            // "是我们没采到" 还是 "采到了但没送到"。
            val probe = object : org.webrtc.VideoSink {
                private var frames = 0
                override fun onFrame(frame: org.webrtc.VideoFrame) {
                    frames++
                    // 第 1 帧与之后每 150 帧（约 10 秒）各记一条，避免刷屏
                    if (frames == 1 || frames % 150 == 0) {
                        Log.i(TAG, "屏幕共享本地采集帧数=$frames（${frame.rotatedWidth}x${frame.rotatedHeight}）")
                    }
                }
            }
            frameProbe = probe
            track.addSink(probe)

            // 给所有既有连接补一条视频 m-line 并把轨道挂上。
            //
            // **必须用 `addTransceiver(track, init)` 一次完成**，不要"先 addTransceiver(空) 再 addTrack"：
            // 后者的 `addTrack` 会在已存在的 transceiver 上做配对，配对结果不确定
            // （可能挂到方向不匹配的那条上），而失败是**静默的** —— SDP 里 m-line 在、
            // 方向也对，但发送端不推流，对方看到的就是纯黑。
            val videoInit = org.webrtc.RtpTransceiver.RtpTransceiverInit(
                org.webrtc.RtpTransceiver.RtpTransceiverDirection.SEND_ONLY,
                listOf(LOCAL_STREAM_ID),
            )
            peers.values.forEach { pc ->
                runCatching {
                    pc.addTransceiver(track, videoInit)
                }.onSuccess { transceiver ->
                    // 留痕：确认发送器真的建出来了（排查黑屏时这是第一手证据）
                    Log.i(
                        TAG,
                        "屏幕共享：已挂载视频 m-line dir=${transceiver.direction} " +
                            "senderTrack=${transceiver.sender.track()?.id() ?: "null"}"
                    )
                    // 应用发送端调优（1080p60：码率 12M + 帧率 60 + 保分辨率降级）——
                    // 不设的话走 WebRTC 默认（BALANCED = 带宽紧就降分辨率 + 帧率不保证），文字会糊、帧率会掉
                    applyShareSenderTuning(transceiver.sender, TAG, maxFps = SHARE_CAPTURE_FPS)
                }.onFailure { t ->
                    Log.e(TAG, "屏幕共享：挂载视频轨失败：${t.message}")
                }
            }
            // 触发重新协商：对每个既有成员重发 offer（屏幕共享是"新加一条 m-line"，
            // 不加这一步对方收不到画面 —— 与音频那种双向对称的场景不同）
            peers.keys.toList().forEach { userId -> offerTo(userId) }
            startShareStatsProbe()
            true
        } catch (t: Throwable) {
            listener?.onError("屏幕共享启动失败：${t.message}")
            stopScreenShare()
            false
        }
    }

    /**
     * 打印**真实**的出站视频统计（每 3 秒一条）。
     *
     * 为什么必须有：用户反馈"投屏糊、参数改了没生效"，而"糊"只有两个可能，**必须区分开**：
     *
     *  · `frameWidth/Height` 明显小于采集分辨率（例如 480×1067）→ **编码器在降分辨率**：
     *    说明 `MAINTAIN_RESOLUTION` 没被采纳，或带宽被压得极低（BWE 判定的可用带宽不足）；
     *  · `frameWidth/Height` 就是采集分辨率、`actualBitrate` 也接近 6M → 发出去的画面是清晰的，
     *    **问题在接收端**（Web 的播放/缩放），安卓侧再调也没用。
     *
     * 没这条日志，两边都只能猜 —— 这正是这一轮反复"改了没效果"的原因。
     */
    private fun startShareStatsProbe() {
        val pcs = peers.values.toList()
        if (pcs.isEmpty()) {
            Log.w(TAG, "共享统计：还没有任何连接")
            return
        }
        var lastBytes = 0L
        var lastAt = 0L
        var dumpedKeys = false
        /** 自动纠偏状态：连续 2 次"帧率 < 45 且受限原因是 cpu/other"才降，且一次会话只降一次 */
        var cpuStrike = 0
        var downgraded = false
        shareStatsJob = CoroutineScope(Dispatchers.IO).launch {
            while (localVideoTrack != null) {
                delay(3000)
                // 异步收集：回调是主线程/信令线程来的，用 CompletableDeferred 等一次。
                // **只取第一条连接**做"共同判据"：mesh 下每条成员一条 sender，
                // 分辨率/帧率同源（同一路采集轨），逐条打印只会刷屏。
                val report = runCatching {
                    val d = kotlinx.coroutines.CompletableDeferred<org.webrtc.RTCStatsReport?>()
                    val pc = pcs.first()
                    val sender = runCatching { pc.senders.firstOrNull { it.track()?.kind() == "video" } }
                        .getOrNull()
                    if (sender == null) {
                        null
                    } else {
                        pc.getStats(sender) { r -> d.complete(r) }
                        kotlinx.coroutines.withTimeoutOrNull(2000) { d.await() }
                    }
                }.getOrNull()
                if (report == null) {
                    Log.w(TAG, "共享出站统计：拿不到 report（sender 可能已释放）")
                    continue
                }
                val outbound = report.statsMap.values.firstOrNull { it.type == "outbound-rtp" }
                if (outbound == null) {
                    Log.w(TAG, "共享出站统计：report 里没有 outbound-rtp（keys=${report.statsMap.keys}）")
                    continue
                }
                val m = outbound.members
                if (!dumpedKeys) {
                    // 只打一次字段清单：字段名是 native 侧决定的，写错会静默取到 null，
                    // 所以先把真实 key 打出来（排查时一眼可见）
                    dumpedKeys = true
                    Log.i(TAG, "共享出站统计字段：${m.keys.sorted()}")
                }
                fun num(vararg names: String): Double {
                    names.forEach { k -> (m[k] as? Number)?.let { return it.toDouble() } }
                    return 0.0
                }
                val bytes = num("bytesSent", "bytes_sent").toLong()
                val w = num("frameWidth", "frame_width").toInt()
                val h = num("frameHeight", "frame_height").toInt()
                val fps = num("framesPerSecond", "frames_per_second")
                val qlr = m["qualityLimitationReason"] ?: m["quality_limitation_reason"] ?: "-"
                val now = System.currentTimeMillis()
                val bps = if (lastAt > 0 && now > lastAt) (bytes - lastBytes) * 8.0 * 1000 / (now - lastAt) else 0.0
                lastBytes = bytes
                lastAt = now
                Log.i(
                    TAG,
                    "共享出站统计：编码分辨率=${w}x$h fps=${"%.1f".format(fps)} " +
                        "实际码率=${"%.2f".format(bps / 1_000_000)}Mbps 受限原因=$qlr"
                )

                /**
                 * 自动纠偏（对齐 Web 端 `shareStatsMonitor`）：
                 * 60fps 被**编码器吞吐**卡住时（不是带宽），硬撑只会让画面更抖。
                 * 连续 2 次命中才降、一次会话只降一次（避免与"用户手动设的 60"反复拉锯）。
                 */
                if (!downgraded && shouldDowngradeTo30(fps, qlr.toString())) {
                    cpuStrike++
                    if (cpuStrike >= 2) {
                        downgraded = true
                        Log.w(
                            TAG,
                            "共享帧率未达 60（实测 ${"%.1f".format(fps)}fps，受限原因=$qlr）→ 自动退回 ${SHARE_FALLBACK_FPS}fps"
                        )
                        // 只改编码帧率上限，其他参数不动
                        pcs.forEach { pc ->
                            runCatching {
                                pc.senders.firstOrNull { it.track()?.kind() == "video" }
                            }.getOrNull()?.let { s ->
                                applyShareSenderTuning(s, TAG, maxFps = SHARE_FALLBACK_FPS)
                            }
                        }
                    }
                } else if (fps >= 45.0) {
                    cpuStrike = 0
                }
            }
        }
    }

    fun stopScreenShare() {
        // 先停统计轮询，再摘观测 sink（顺序反了会读到已释放的 sender）
        shareStatsJob?.cancel()
        shareStatsJob = null
        // 先摘掉观测 sink 再销毁轨道（顺序反了会留下一个指向已释放轨道的回调）
        frameProbe?.let { probe -> runCatching { localVideoTrack?.removeSink(probe) } }
        frameProbe = null
        runCatching { screenCapturer?.stopCapture() }
        runCatching { screenCapturer?.dispose() }
        runCatching { localVideoTrack?.dispose() }
        runCatching { videoSource?.dispose() }
        runCatching { surfaceTextureHelper?.dispose() }
        screenCapturer = null
        localVideoTrack = null
        videoSource = null
        surfaceTextureHelper = null
        // 采集尺寸随共享一起失效：控制器用它填 share-start 的 width/height，
        // 留着旧值会让下一次共享先按上一次的分辨率排版
        localShareCaptureSize = null
    }

    val isSharing: Boolean get() = localVideoTrack != null

    /**
     * 本端共享的**采集像素尺寸**（未共享时为 null）。
     *
     * 控制器用它填 `share-start` 的 width/height —— 观看端（含之后进房的人）在首帧到达之前
     * 就能把画面框按正确比例摆好。字段语义与缺省行为见 `VoiceParticipantDto.width`
     * （唯一事实来源：shared/src/types.ts 的 `VoiceParticipant.width`）。
     */
    var localShareCaptureSize: Pair<Int, Int>? = null
        private set

    /**
     * 本端正在共享的**本地视频轨**（未共享时为 null）。
     *
     * 控制器需要它来做"共享者自己也能看到画面"：共享时把本端预览直接喂给渲染器，
     * 而不是等自己发出去的流绕一圈回来（mesh 里根本没有回路，永远等不到）。
     */
    val localShareTrack: org.webrtc.VideoTrack? get() = localVideoTrack

    /**
     * 本端共享用的 EGL 上下文（由 `startScreenShare` 建立）。
     *
     * 接收端渲染复用它，而不是每个 `SharedScreen` 各 `EglBase.create()` 一个 ——
     * 每个 EglBase 都是一个独立的 GL 上下文与线程，反复进入/退出共享会把它们堆起来
     * （WebRTC 不回收、我们也没 release），最终表现为渲染黑屏。
     */
    val shareEglContext: EglBase.Context? get() = eglContextProvider()

    // ---------------------------------------------------------------
    // 与信令对接
    // ---------------------------------------------------------------

    /** 作为**发起方**连接某个既有成员（join 之后对 participants 逐个调用） */
    fun offerTo(userId: Long) {
        val pc = peerFor(userId) ?: return
        Log.i(TAG, "offerTo($userId): 开始 createOffer")
        ShareFlow.mark("createOffer($userId)")
        val constraints = MediaConstraints()
        pc.createOffer(object : SimpleSdpObserver() {
            override fun onCreateSuccess(desc: SessionDescription) {
                ShareFlow.mark("offer 已生成($userId)")
                pc.setLocalDescription(object : SimpleSdpObserver() {
                    override fun onSetSuccess() {
                        // 失败时绝不能继续发 SDP —— 发出去的是无效描述，
                        // 对端会静默地建不出连接（M4 真机排查时补的可观测性）
                        Log.i(TAG, "offerTo($userId): setLocalDescription 成功，发 offer")
                        ShareFlow.mark("发出 offer($userId)")
                        listener?.onSendSignal(userId, VoiceSignaling.sdp("offer", desc.description))
                    }

                    override fun onSetFailure(error: String) {
                        Log.e(TAG, "offerTo($userId): setLocalDescription **失败**：$error")
                        listener?.onError("设置本地描述失败：$error")
                    }
                }, desc)
            }

            override fun onCreateFailure(error: String) {
                Log.e(TAG, "offerTo($userId): createOffer 失败：$error")
                listener?.onError("创建 offer 失败：$error")
            }
        }, constraints)
    }

        /**
     * 处理来自某个用户的信令（SDP 或 ICE）
     *
     * 负载形状的契约在 `VoiceSignaling`（`:core:data`，有单测钉住）——**必须**走它，
     * 不要在本地手写 map：判别字段写错（`kind`/`sdpType` vs `type`）或候选写成平铺，
     * 对端都会**静默丢弃**，本端只会看到"ICE 一直不连通"，极难定位。
     */
    fun handleSignal(fromUserId: Long, data: JsonObject) {
        if (!joined) return
        when (val payload = VoiceSignaling.decode(data)) {
            is VoiceSignaling.Payload.Sdp -> handleSdp(fromUserId, payload.type, payload.sdp)
            is VoiceSignaling.Payload.Candidate ->
                handleCandidate(fromUserId, payload.candidate, payload.sdpMid, payload.sdpMLineIndex)
            null -> Unit
        }
    }

    private fun handleSdp(fromUserId: Long, type: String, sdp: String) {
        val pc = peerFor(fromUserId) ?: return
        val description = SessionDescription(
            if (type == "offer") SessionDescription.Type.OFFER else SessionDescription.Type.ANSWER,
            sdp,
        )
        Log.i(TAG, "handleSdp($fromUserId): 收到 $type，${sdp.length} 字节")
        ShareFlow.mark("收到 $type($fromUserId)")

        pc.setRemoteDescription(object : SimpleSdpObserver() {
            override fun onSetSuccess() {
                Log.i(TAG, "handleSdp($fromUserId): setRemoteDescription 成功")
                ShareFlow.mark("setRemoteDescription 成功($fromUserId)")
                /**
                 * 远端 offer 落地后把**视频 m-line** 打一行（M6.7）。
                 *
                 * 为什么非打不可：用户反馈"手机看共享很糊、电脑上很清楚"，而日志里
                 * 解码分辨率只有 640x400@0.1Mbps —— 那是**发送端主动降的**。
                 * 发送端降分辨率的依据只有两类：① 我们 SDP 里声明了 `b=AS` 上限；
                 * ② 它自己按带宽估计（我们回给它的 REMB/TWCC）降。这一行就是用来区分这两者的：
                 * 视频段里**没有** b=AS = 不是我方声明的小上限，那就只能去查带宽估计/对端档位。
                 */
                logVideoMLine(fromUserId, sdp)
                if (type == "offer") {
                    // 收到 offer → 发 answer（服务端设计：新加入者向既有成员发起，所以这里只可能是 answer 的回程）
                    pc.createAnswer(object : SimpleSdpObserver() {
                        override fun onCreateSuccess(desc: SessionDescription) {
                            pc.setLocalDescription(object : SimpleSdpObserver() {
                                override fun onSetSuccess() {
                                    Log.i(TAG, "handleSdp($fromUserId): 发 answer")
                                    listener?.onSendSignal(fromUserId, VoiceSignaling.sdp("answer", desc.description))
                                }

                                override fun onSetFailure(error: String) {
                                    Log.e(TAG, "handleSdp($fromUserId): setLocalDescription **失败**：$error")
                                }
                            }, desc)
                        }

                        override fun onCreateFailure(error: String) {
                            Log.e(TAG, "handleSdp($fromUserId): createAnswer 失败：$error")
                            listener?.onError("创建 answer 失败：$error")
                        }
                    }, MediaConstraints())
                } else {
                    // 收到 answer → 协商完成
                    listener?.onNegotiationRequested(fromUserId)
                }
            }

            override fun onSetFailure(error: String) {
                Log.e(TAG, "handleSdp($fromUserId): setRemoteDescription **失败**：$error")
                listener?.onError("设置远端描述失败：$error")
            }
        }, description)
    }

    /** 把 SDP 里 `m=video` 那一段（到下一个 m= 为止）打出来：方向 / `b=AS` / 编解码器 */
    private fun logVideoMLine(userId: Long, sdp: String) {
        val lines = sdp.lineSequence().toList()
        val start = lines.indexOfFirst { it.startsWith("m=video") }
        if (start < 0) {
            Log.i(TAG, "远端 SDP[$userId]：没有 m=video（对端这次没共享屏幕）")
            return
        }
        val end = lines.drop(start + 1).indexOfFirst { it.startsWith("m=") }
            .let { if (it < 0) lines.size else start + 1 + it }
        // 只留"决定画质"的那几类行，避免整段刷屏：方向、带宽上限、编解码/参数
        val keep = listOf(
            "m=video", "b=AS", "b=TIAS", "a=sendrecv", "a=recvonly", "a=sendonly",
            "a=rtpmap", "a=fmtp", "a=max-fs", "a=framerate",
        )
        val brief = lines.subList(start, end).filter { line -> keep.any { line.startsWith(it.trim()) } }
        Log.i(TAG, "远端 SDP[$userId] 视频段：\n${brief.joinToString("\n")}")
    }

    private fun handleCandidate(fromUserId: Long, candidate: String, sdpMid: String, sdpMLineIndex: Int) {
        val pc = peers[fromUserId]
        if (pc == null) {
            // 候选早于 PeerConnection 到达时会被丢掉。正常情况下不会发生
            // （offer 先于候选），但一旦发生连接就永远建不起来，所以必须留痕。
            Log.w(TAG, "收到[$fromUserId]的候选但本地还没有 PeerConnection，已丢弃：$candidate")
            return
        }
        Log.i(TAG, "远端候选[$fromUserId] ${candidate.substringBefore(" typ ")}")
        ShareFlow.mark("远端候选[$fromUserId] ${candidate.substringBefore(" typ ")}")
        pc.addIceCandidate(IceCandidate(sdpMid, sdpMLineIndex, candidate))
    }

    /**
     * 接收侧视频探针：打印对端发来的**真实分辨率与帧率**（每 3 秒一条，随轨道存活）。
     *
     * 为什么需要：用户反馈「电脑共享、手机看糊」。糊的成因只有两类，而它们方向相反：
     *  · 对端发来的就是低分辨率（例如 480×270）→ 要去调 **Web 的档位/带宽**，安卓侧改了没用；
     *  · 对端发的是 1080p，但本端渲染放大糊 → **安卓渲染器**的问题。
     *
     * 没有这条日志，两边都只能猜 —— 这一轮我已经因为"猜方向"白改过一次
     * （把发送端参数改了，而问题在接收端）。
     */
    private fun attachReceiveVideoProbe(userId: Long, track: org.webrtc.VideoTrack) {
        var frames = 0L
        var lastW = 0
        var lastH = 0
        val sink = object : org.webrtc.VideoSink {
            override fun onFrame(frame: org.webrtc.VideoFrame) {
                frames++
                val w = frame.rotatedWidth
                val h = frame.rotatedHeight
                // 宽高比同步给 UI（容器要按它撑开，见 remoteVideoAspect 的注释）。
                // 只在**真的变了**的时候推：这个回调在解码线程上，每帧都推等于每帧一次状态更新。
                if (w > 0 && h > 0) {
                    val a = w.toFloat() / h
                    /**
                     * 只有比例**真的变了**才推给 UI，而且要求变化超过 5%（M6.8）。
                     *
                     * 为什么要有这个宽容度：发送端在带宽自适应时会**来回切分辨率**
                     * （真机日志里 1920x1200 ↔ 16:9 反复出现），每次都重排的话，
                     * UI 上的框就跟着一跳一跳（用户反馈"一直有裁切跳动"）。
                     * 5% 以内的差异交给渲染器的 FIT 在框内留边，观感稳定得多；
                     * 真正换了形态（16:10 → 16:9 是 11%）仍然会更新。
                     */
                    val changed = remoteVideoAspect <= 0f ||
                        kotlin.math.abs(a - remoteVideoAspect) / remoteVideoAspect > 0.05f
                    if (changed) {
                        remoteVideoAspect = a
                        listener?.onRemoteVideoAspect(a)
                    }
                }
                val changed = w != lastW || h != lastH
                // 首帧、每次分辨率变化、之后每 90 帧（约 3 秒 @30fps）各记一条
                if (frames == 1L || changed || frames % 90 == 0L) {
                    lastW = w
                    lastH = h
                    Log.i(TAG, "接收共享画面[$userId]：${w}x$h 第 $frames 帧")
                }
            }
        }
        runCatching { track.addSink(sink) }
        receiveProbes += track to sink
        startReceiveStatsProbe()
    }

    /**
     * 接收侧统计轮询：**每 5 秒**打印这一路共享的「解码分辨率 / 帧率 / 实际收到码率 / 受限原因」。
     *
     * 为什么非要连**码率**一起打：用户反馈「电脑共享、手机看糊」，而"糊"至少有两种完全不同的成因，
     * 只看分辨率分不出来：
     *  · 分辨率低（例如 640×360）→ 画面被放大 → 糊，根因在**链路/带宽估计**（TURN 中继、丢包）；
     *  · 分辨率够但码率低（例如 1080p 只有 0.5Mbps）→ 画面是**块状**的，主观上一样是"糊"，
     *    根因在**发送侧的码率/拥塞控制**。
     *
     * 对端（Web）的档位是 1080p60 / 上限 30Mbps，所以这里打出来的就是"实际到手多少"，
     * 与 `共享出站统计`（发送端）对照就能定位是哪一段链路掉下来的。
     *
     * 生命周期：随**共享轨道**存活；没有共享接收轨时自己退出，下一路共享再起一个。
     */
    private fun startReceiveStatsProbe() {
        if (receiveStatsJob?.isActive == true) return
        var lastBytes = 0L
        var lastAt = 0L
        var dumpedKeys = false
        receiveStatsJob = CoroutineScope(Dispatchers.IO).launch {
            while (true) {
                delay(5000)
                val pcs = peers.values.toList()
                if (pcs.isEmpty()) break
                // 只看**当前这一路**共享（服务端保证同时最多一人共享）
                var logged = false
                for (pc in pcs) {
                    val report = runCatching {
                        val receiver = pc.receivers
                            .firstOrNull { it.track()?.kind() == "video" }
                        if (receiver == null) {
                            null
                        } else {
                            val d = kotlinx.coroutines.CompletableDeferred<org.webrtc.RTCStatsReport?>()
                            pc.getStats(receiver) { r -> d.complete(r) }
                            kotlinx.coroutines.withTimeoutOrNull(2000) { d.await() }
                        }
                    }.getOrNull() ?: continue
                    val inbound = report.statsMap.values
                        .firstOrNull { it.type == "inbound-rtp" && it.members["kind"] == "video" }
                        ?: report.statsMap.values.firstOrNull { it.type == "inbound-rtp" }
                        ?: continue
                    val m = inbound.members
                    if (!dumpedKeys) {
                        dumpedKeys = true
                        Log.i(TAG, "接收共享统计字段：${m.keys.sorted()}")
                    }
                    fun num(vararg names: String): Double {
                        names.forEach { k -> (m[k] as? Number)?.let { return it.toDouble() } }
                        return 0.0
                    }
                    val bytes = num("bytesReceived", "bytes_received").toLong()
                    val w = num("frameWidth", "frame_width").toInt()
                    val h = num("frameHeight", "frame_height").toInt()
                    val fps = num("framesPerSecond", "frames_per_second")
                    val qlr = m["qualityLimitationReason"] ?: m["quality_limitation_reason"] ?: "-"
                    val now = System.currentTimeMillis()
                    val bps =
                        if (lastAt > 0 && now > lastAt) (bytes - lastBytes) * 8.0 * 1000 / (now - lastAt) else 0.0
                    lastBytes = bytes
                    lastAt = now
                    logged = true
                    Log.i(
                        TAG,
                        "接收共享统计：解码分辨率=${w}x$h fps=${"%.1f".format(fps)} " +
                            "实际码率=${"%.2f".format(bps / 1_000_000)}Mbps 受限原因=$qlr"
                    )
                    /**
                     * **链路证据**（M6.12）：选中候选对的类型。
                     *
                     * 这是"为什么安卓糊、浏览器清楚"的分水岭：浏览器与共享端常在同一台机器/同一局域网
                     * （host-host 直连，RTT 极小、初始带宽估计高），安卓走公网 —— 一旦落到
                     * **relay（TURN 中继）**，RTT 与中继带宽直接把 WebRTC 的初始带宽估计压到很低，
                     * 发送端就从 640x400 起步再往上爬：观感正是"要等 3~4 秒才清楚、中间跳几次"。
                     * 这一行打出来，就不用再猜是布局问题还是链路问题了。
                     */
                    runCatching {
                        val full = kotlinx.coroutines.CompletableDeferred<org.webrtc.RTCStatsReport?>()
                        pc.getStats { r -> full.complete(r) }
                        val report2 = kotlinx.coroutines.withTimeoutOrNull(2000) { full.await() }
                        val byId = report2?.statsMap.orEmpty()
                        val pair = byId.values.firstOrNull {
                            it.type == "candidate-pair" &&
                                (it.members["nominated"] == true || it.members["state"] == "succeeded")
                        }
                        if (pair != null) {
                            val localType = pair.members["localCandidateId"]
                                ?.let { byId[it as? String]?.members?.get("candidateType") } ?: "?"
                            val remoteType = pair.members["remoteCandidateId"]
                                ?.let { byId[it as? String]?.members?.get("candidateType") } ?: "?"
                            val rtt = (pair.members["currentRoundTripTime"] as? Number)?.toDouble() ?: 0.0
                            val avail = (pair.members["availableIncomingBitrate"] as? Number)?.toDouble() ?: 0.0
                            Log.i(
                                TAG,
                                "共享链路：本地候选=$localType 远端候选=$remoteType " +
                                    "RTT=${"%.0f".format(rtt * 1000)}ms " +
                                    "可用入向带宽=${"%.2f".format(avail / 1_000_000)}Mbps" +
                                    if (localType == "relay" || remoteType == "relay") "（走 TURN 中继）" else "（直连）",
                            )
                            ShareFlow.mark("链路 本地=$localType 远端=$remoteType RTT=${"%.0f".format(rtt * 1000)}ms")
                        }
                    }
                }
                // 一路视频接收轨都没有了 → 这次共享结束，退出（下次共享重新起）
                if (!logged && pcs.none { pc ->
                        runCatching { pc.receivers.any { it.track()?.kind() == "video" } }.getOrDefault(false)
                    }
                ) {
                    break
                }
            }
            receiveStatsJob = null
        }
    }

    private fun handleNewRemoteTrack(userId: Long, track: MediaStreamTrack) {
        // 视频轨（屏幕共享）：交给 UI 渲染，不注册音频 sink
        if (track is org.webrtc.VideoTrack) {
            // 接收侧证据：对端**实际发来多少像素**。用户反馈"电脑共享、手机看糊"时，
            // 这条日志是唯一能区分"对端就发的低分辨率"与"本端渲染放大糊"的依据 ——
            // 前者要去调 Web 的档位，后者是安卓渲染问题，修法完全不同。
            attachReceiveVideoProbe(userId, track)
            // 时间线：从这一刻起算"渲染器挂载 → 首帧 → 分辨率收敛"这一段（M6.12）
            ShareFlow.trackArrived(track.id())
            listener?.onRemoteVideoAttached(userId, track)
            return
        }
        // 去重：同一路远端音频被多次回调时重复注册 sink 会让声音叠加（听起来像回声）
        if (!remoteTrackIds.add(track.id())) return
        trackOwner[track.id()] = userId
        // 应用当前的接收开关（用户可能先点了静音，之后才有人共享声音）
        track.setEnabled(receiveAudioEnabled)
        (track as? org.webrtc.AudioTrack)?.let { remoteAudioTracks.add(it) }
        listener?.onRemoteAudioAttached(userId)
        // 有远端音频了 = 有连接可查统计 → 起说话检测（房里只剩自己时它自己会退出）
        startSpeakingProbe()
    }

    // ---------------------------------------------------------------
    // 说话检测（M6）：只读统计，不碰音轨
    // ---------------------------------------------------------------

    /**
     * 起一个轮询：从**只读统计**里取每一路音频的幅度，喂给 [SpeakingGate]，翻转时上报。
     *
     * 两条取数路径：
     *  · **远端**：该成员的 `inbound-rtp`（`members["audioLevel"]`，0..1）；
     *  · **自己**：任意一条连接里的 `media-source`（`members["audioLevel"]`）——
     *    这是本端麦克风在 WebRTC 里的采集幅度。
     *
     * 为什么不挂 `AudioTrackSink` 自己算 RMS：见 [SpeakingGate] 的注释（风险不对称）。
     *
     * 字段名由 native 侧决定，写错是**静默取到 null**（灯不亮但不报错），所以每个报告
     * 第一次拿到时把字段清单打一行日志 —— 与接收共享统计那边同一套可观测性做法。
     */
    private fun startSpeakingProbe() {
        if (speakingJob?.isActive == true) return
        var dumpedInboundKeys = false
        var dumpedSourceKeys = false
        speakingJob = CoroutineScope(Dispatchers.IO).launch {
            while (true) {
                delay(SpeakingGate.POLL_MS)
                val now = android.os.SystemClock.uptimeMillis()
                // 连接表在信令线程上增删，这里是 IO 线程：拷贝时可能撞上并发修改（CME），
                // 撞上就跳过这一轮（150ms 后还有下一轮），不能让它把轮询协程打死
                val snapshot = runCatching { peers.toMap() }.getOrDefault(emptyMap())
                if (snapshot.isEmpty()) {
                    // 房里没人了：把所有灯收掉（连接都关了，也就没统计可查）
                    speakingGates.keys.toList().forEach { userId ->
                        val gate = speakingGates.remove(userId) ?: return@forEach
                        if (gate.reset()) listener?.onSpeaking(userId, false)
                    }
                    if (selfSpeakingGate.reset()) listener?.onSelfSpeaking(false)
                    continue
                }
                snapshot.forEach { (userId, pc) ->
                    val level = runCatching { remoteAudioLevel(pc, dumpKeys = !dumpedInboundKeys) }
                        .getOrNull()
                    if (level != null && !dumpedInboundKeys) {
                        dumpedInboundKeys = true
                        Log.i(TAG, "说话检测：远端幅度已取到（inbound-rtp.audioLevel）")
                    }
                    val gate = speakingGates.getOrPut(userId) { SpeakingGate() }
                    if (gate.update(level, now)) listener?.onSpeaking(userId, gate.isSpeaking)
                }
                // 自己：闭麦时直接判定"没说"，连统计都不用查
                if (selfMicEnabled) {
                    val selfLevel = runCatching {
                        selfAudioLevel(snapshot.values.first(), dumpKeys = !dumpedSourceKeys)
                    }.getOrNull()
                    if (selfLevel != null && !dumpedSourceKeys) {
                        dumpedSourceKeys = true
                        Log.i(TAG, "说话检测：本端幅度已取到（media-source.audioLevel）")
                    }
                    if (selfSpeakingGate.update(selfLevel, now)) {
                        listener?.onSelfSpeaking(selfSpeakingGate.isSpeaking)
                    }
                } else if (selfSpeakingGate.reset()) {
                    listener?.onSelfSpeaking(false)
                }
            }
        }
    }

    /** 某个远端这一轮的说话幅度（`inbound-rtp.audioLevel`）；拿不到返回 null */
    private suspend fun remoteAudioLevel(pc: PeerConnection, dumpKeys: Boolean): Float? {
        val receiver = runCatching {
            pc.receivers.firstOrNull { it.track()?.kind() == "audio" }
        }.getOrNull() ?: return null
        val d = kotlinx.coroutines.CompletableDeferred<org.webrtc.RTCStatsReport?>()
        runCatching { pc.getStats(receiver) { r -> d.complete(r) } }
        val report = kotlinx.coroutines.withTimeoutOrNull(1_500) { d.await() } ?: return null
        val inbound = report.statsMap.values.firstOrNull {
            it.type == "inbound-rtp" && it.members["kind"] == "audio"
        } ?: report.statsMap.values.firstOrNull { it.type == "inbound-rtp" } ?: return null
        if (dumpKeys) Log.i(TAG, "说话检测字段（inbound-rtp）：${inbound.members.keys.sorted()}")
        return (inbound.members["audioLevel"] as? Number)?.toFloat()
    }

    /** 本端麦克风这一轮的幅度（`media-source.audioLevel`）；拿不到返回 null */
    private suspend fun selfAudioLevel(pc: PeerConnection, dumpKeys: Boolean): Float? {
        val d = kotlinx.coroutines.CompletableDeferred<org.webrtc.RTCStatsReport?>()
        runCatching { pc.getStats { r -> d.complete(r) } }
        val report = kotlinx.coroutines.withTimeoutOrNull(1_500) { d.await() } ?: return null
        val source = report.statsMap.values.firstOrNull {
            it.type == "media-source" && it.members["kind"] == "audio"
        } ?: report.statsMap.values.firstOrNull { it.type == "media-source" } ?: return null
        if (dumpKeys) Log.i(TAG, "说话检测字段（media-source）：${source.members.keys.sorted()}")
        return (source.members["audioLevel"] as? Number)?.toFloat()
    }

    // ---------------------------------------------------------------
    // 内部：建立/复用一条 PeerConnection
    // ---------------------------------------------------------------

    private fun peerFor(userId: Long): PeerConnection? {
        peers[userId]?.let { return it }
        val f = factory ?: run {
            listener?.onError("WebRTC 尚未初始化（是否缺少录音权限？）")
            return null
        }

        val config = PeerConnection.RTCConfiguration(iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            // 网格拓扑下最多十几条连接，先走直连、失败再走 TURN
            iceTransportsType = PeerConnection.IceTransportsType.ALL
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        }

        val pc = f.createPeerConnection(config, object : PeerConnection.Observer {
            override fun onIceCandidate(candidate: IceCandidate) {
                // 候选类型是判断"能不能连通"的第一手证据：只有 host = 拿不到公网地址；
                // 有 srflx/relay = STUN/TURN 正常（M4 真机排查时补的可观测性）
                Log.i(TAG, "本地候选[$userId] ${candidate.sdp.substringBefore(" typ ")}")
                ShareFlow.mark("本地候选[$userId] ${candidate.sdp.substringBefore(" typ ")}")
                listener?.onSendSignal(
                    userId,
                    VoiceSignaling.candidate(
                        candidate = candidate.sdp,
                        sdpMid = candidate.sdpMid ?: "0",
                        sdpMLineIndex = candidate.sdpMLineIndex,
                    )
                )
            }

            override fun onAddTrack(receiver: RtpReceiver?, streams: Array<out MediaStream>?) {
                val track = receiver?.track() ?: return
                handleNewRemoteTrack(userId, track)
            }

            override fun onTrack(transceiver: org.webrtc.RtpTransceiver?) {
                val track = transceiver?.receiver?.track() ?: return
                handleNewRemoteTrack(userId, track)
            }

            override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
                // 必须记日志：UI 上的「已连接」只是**信令**连上了，媒体是否真的通了
                // 只有这里的状态能回答。没有这条日志时，"信令已连、ICE 没连"会被
                // 误判成一切正常（M4 排查真机音频时踩过）。
                Log.i(TAG, "peer $userId connectionState=$newState")
                ShareFlow.mark("peer $userId connectionState=$newState")
                if (newState == PeerConnection.PeerConnectionState.FAILED) {
                    listener?.onError("与用户 $userId 的连接失败")
                }
            }

            override fun onIceConnectionChange(newState: PeerConnection.IceConnectionState) {
                Log.i(TAG, "peer $userId iceState=$newState")
                ShareFlow.mark("peer $userId iceState=$newState")
            }
            override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
            override fun onIceGatheringChange(newState: PeerConnection.IceGatheringState) {
                ShareFlow.mark("peer $userId iceGathering=$newState")
            }
            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) = Unit
            override fun onSignalingChange(newState: PeerConnection.SignalingState) = Unit
            override fun onAddStream(stream: MediaStream?) = Unit
            override fun onRemoveStream(stream: MediaStream?) = Unit
            override fun onDataChannel(channel: org.webrtc.DataChannel?) = Unit
            override fun onRenegotiationNeeded() = Unit
        }) ?: return null

        // 开一条双向音频 m-line（见类注释第 2 条：只 addTrack 会踩"先到先得"的复用坑）
        runCatching {
            pc.addTransceiver(
                MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO,
                org.webrtc.RtpTransceiver.RtpTransceiverInit(
                    org.webrtc.RtpTransceiver.RtpTransceiverDirection.SEND_RECV
                )
            )
        }

        // 本地麦克风轨：挂到每条连接上（WebRTC 自己采集，不需要手写 AudioRecord）
        localAudioTrack?.let { track ->
            runCatching { pc.addTrack(track, listOf(LOCAL_STREAM_ID)) }
        }

        /**
         * **预置一条"只收"的视频 m-line**（M6.12，修"进房要等 3~4 秒才出画面"）。
         *
         * 老流程：我们的 offer 里只有音频 → 共享方**不能在 answer 里凭空加 m-line** →
         * 只能等第一次协商完成后补挂视频轨、再发第二次 offer → 首帧要等**两个**
         * offer/answer 往返（跨公网 + TURN 时就是那 3~4 秒的黑框）。浏览器端因为和共享端
         * 在同一台机器上、往返≈0，所以感觉不到。
         *
         * offer 里先带上 recvonly 的视频 m-line 后，共享方（Web 端）可以直接把视频挂到
         * 这条 m-line 上、在**同一个 answer** 里协商完（见 client/src/voice/VoiceSession.ts
         * 的 `maybeAttachShareTracks`）——省掉一整轮往返。
         *
         * 本端**已在共享**时不加（[localVideoTrack] 分支会挂 sendonly 的视频轨），
         * 避免同一台设备上有两条视频 m-line 语义重叠。
         */
        if (localVideoTrack == null) {
            runCatching {
                pc.addTransceiver(
                    MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO,
                    org.webrtc.RtpTransceiver.RtpTransceiverInit(
                        org.webrtc.RtpTransceiver.RtpTransceiverDirection.RECV_ONLY
                    )
                )
            }.onFailure { e -> Log.w(TAG, "预置接收视频 m-line 失败：${e.message}") }
        }

        // 本端**已在共享**时，新连接也要挂上共享轨 —— 否则"开始共享之后才进房的人"
        // 永远看不到画面（他进来时 offer 里根本没有视频 m-line）。
        localVideoTrack?.let { track ->
            runCatching {
                val t = pc.addTransceiver(
                    track,
                    org.webrtc.RtpTransceiver.RtpTransceiverInit(
                        org.webrtc.RtpTransceiver.RtpTransceiverDirection.SEND_ONLY,
                        listOf(LOCAL_STREAM_ID),
                    )
                )
                // 与 startScreenShare 里同一套调优（码率上限 + 保分辨率降级 + 帧率上限）
                applyShareSenderTuning(t.sender, TAG, maxFps = SHARE_CAPTURE_FPS)
            }.onFailure { e ->
                Log.e(TAG, "后进成员挂载共享轨失败：${e.message}")
            }
        }

        peers[userId] = pc
        return pc
    }

    /**
     * 开关**接收到的共享声音**（观看端）。
     *
     * 接收侧音量控制挂在"已连接音频"的开关上（见 [setMicEnabled] 附近的 receiveAudioEnabled）：
     * 这里只翻转那一个布尔并把它应用到所有远端音轨。
     *
     * 注意：当前安卓端还**没有采集系统声音**（MediaProjection 的 playback capture 未接线，
     * 见 `startShare` 里 `audio = false` 的说明），所以这个开关在**手机当观看端、
     * 对端是 Web 且共享了系统声音**时才有实际效果。
     */
    fun setReceiveAudioEnabled(enabled: Boolean) {
        receiveAudioEnabled = enabled
        applyReceiveAudioEnabled()
    }

    /** 远端音频轨（含共享系统声音）逐个应用当前开关 */
    private fun applyReceiveAudioEnabled() {
        remoteAudioTracks.forEach { runCatching { it.setEnabled(receiveAudioEnabled) } }
    }

    fun removePeer(userId: Long) {
        peers.remove(userId)?.let { pc ->
            runCatching { pc.close() }
            val owned = trackOwner.filterValues { it == userId }.keys
            owned.forEach { id -> remoteTrackIds.remove(id); trackOwner.remove(id) }
            // 摘掉该成员的接收探针：留着会持续对一个已释放的轨道回调
            receiveProbes.removeAll { (track, sink) ->
                val mine = owned.any { it == track.id() }
                if (mine) runCatching { track.removeSink(sink) }
                mine
            }
            // 说话状态也要立刻收：人已经走了，灯不能还亮着
            speakingGates.remove(userId)?.let { gate ->
                if (gate.reset()) listener?.onSpeaking(userId, false)
            }
        }
    }

    private fun JsonPrimitive.contentOrNullSafe(): String? = runCatching { content }.getOrNull()

    /** 简化的 SdpObserver：只覆写关心的回调，其余空实现 */
    private open class SimpleSdpObserver : SdpObserver {
        override fun onCreateSuccess(desc: SessionDescription) = Unit
        override fun onSetSuccess() = Unit
        override fun onCreateFailure(error: String) = Unit
        override fun onSetFailure(error: String) = Unit
    }

    companion object {
        private const val TAG = "KVoiceSession"
        private const val AUDIO_TRACK_ID = "k-audio-0"
        private const val VIDEO_TRACK_ID = "k-video-0"
        private const val LOCAL_STREAM_ID = "k-stream-0"

        /** 把服务端下发的 ICE 配置翻译成 WebRTC 的 IceServer 列表 */
        fun toIceServers(config: top.kuangdada.k.core.data.VoiceRepository.IceConfig): List<PeerConnection.IceServer> =
            config.servers.flatMap { entry ->
                entry.urls.map { url ->
                    PeerConnection.IceServer.builder(url)
                        .setUsername(entry.username ?: "")
                        .setPassword(entry.credential ?: "")
                        .createIceServer()
                }
            }
    }
}
