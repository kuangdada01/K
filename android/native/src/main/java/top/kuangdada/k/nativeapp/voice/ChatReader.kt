package top.kuangdada.k.nativeapp.voice

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import java.io.File
import java.util.Locale
import kotlin.coroutines.resume
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import top.kuangdada.k.core.data.ApiResult
import top.kuangdada.k.core.data.CHAT_TTS_SYSTEM_VOICE_KEY
import top.kuangdada.k.core.data.VoiceRepository
import top.kuangdada.k.core.data.chatTtsVoiceLabel
import top.kuangdada.k.core.data.displayMessage
import top.kuangdada.k.core.data.isKnownChatTtsVoice
import top.kuangdada.k.core.data.splitSpeakText

/**
 * ============================================================
 * 房间聊天「朗读」（设计稿：文字聊天右上角的朗读开关 + 音色下拉）
 * ============================================================
 * **镜像 Web 端 `client/src/hooks/useChatTTS.ts`**（事实来源；改一边必须同步另一边）。
 *
 * 两种音色通道，由标题行的下拉选择（选择结果持久化）：
 *  1. **system**（默认）—— 设备自带 `TextToSpeech` 引擎，零成本、无需联网；
 *  2. **cloud** —— 服务端代理 `POST /api/tts`（StepFun StepAudio 2.5 TTS），
 *     音色为已复刻的「邓紫棋」。**API Key 与厂商音色 ID 都只在服务端**：
 *     客户端只发共享清单里的 key（`dengziqi`），抓包也拿不到密钥。
 *
 * 语义与 Web 端逐条对齐：
 *  · 念新**收到**的消息（自己的不念），开着开关才自动念；
 *  · **点某一条 = 手动念这一条，不受开关限制**（Web 端 `handleSpeakMessage` 同口径）；
 *  · **最新优先**：新的一条打断正在念的旧一条；
 *  · 文案格式「某某 说 内容」（Web 端是「某某说内容」，无空格 —— 这里保留原生既有格式，
 *    刻意不改：中文 TTS 对空格的处理两端不同，改它等于换一次发音，与本次改动无关）；
 *  · 长文按 900 字切段（`splitSpeakText`），段间预取下一段；服务端单次上限 1000 字；
 *  · 退出页面/关闭开关立刻停（Web 端也是"退房/切后台立即停"）。
 *
 * ★ 与 Web 端一起做的两处**刻意对齐**（原来两端不一致）：
 *  1. 新消息打断旧的（原实现是 `QUEUE_ADD`，连点几条会排队念完 —— Web 端是最新优先）；
 *  2. 「点一条消息」不再被朗读开关拦住（原来 `speak()` 里判了 `enabled`，
 *     而文档注释却写着"即使开关关着也能手动念" —— 注释与实践不符，本次按 Web 端语义修正）。
 *
 * 三个必须处理对的点（错一个就是"点了没反应"或"退出房间还在念"）：
 *
 *  1. **Android 11+ 的包可见性**：要绑定系统 TTS 引擎，清单里必须有
 *     `<queries><intent><action android:name="android.intent.action.TTS_SERVICE"/></intent></queries>`
 *     （见 `AndroidManifest.xml`）。漏了不会报错，`TextToSpeech` 只是**静默初始化失败** ——
 *     这正是"朗读点了没反应"最常见的原因。这里的 [systemSupported] 就是用它兜底告诉用户。
 *     ★ 云端音色**不受此限制**：系统引擎不可用时切到「邓紫棋」照样能念（Web 端同口径）——
 *       所以下拉框在 [systemSupported] 为 false 时**不能**置灰，否则用户切不过去。
 *  2. **生命周期**：TTS 引擎与 MediaPlayer 都必须在离开页面时释放，
 *     否则退出房间后它还在念（而且引擎连接一直挂着）——[release] 里一并处理。
 *  3. **自己发的消息不念**：念自己刚打完的字很怪；Web 端也只念"收到的"。
 *
 * 注：Android 没有"朗读是否开启"的持久化要求 —— 与 Web 端一样，**一次进房一次选择**，
 * 默认关闭（默认开会让每个进房的人突然听到机器音）。但**音色选择是持久化的**
 * （Web 端存在 localStorage 的 `voice:chatTTSVoice`，这里存 SharedPreferences）。
 */
class ChatReader internal constructor(
    private val context: Context,
    /** 云端通道用：`POST /api/tts`（与 Web 端同一接口，Key 只在服务端） */
    private val voice: VoiceRepository,
) {

    private var tts: TextToSpeech? = null
    private var player: MediaPlayer? = null

    /**
     * 云端通道**这一次**分段播放的 Job。
     *
     * 为什么必须留一个引用：[stop] 时只 release 播放器是不够的 ——
     * 协程此刻正挂在 `suspendCancellableCoroutine`（等 `onCompletion`）上，
     * 播放器被释放后那个回调**永远不会再来** → 协程永远挂着，`finally` 里的
     * 临时文件也删不掉（用户每点一条消息就留一个几百 KB 的 mp3 在 cacheDir）。
     * 取消 Job 才会走到 `invokeOnCancellation` → 释放播放器 → `finally` 收尾。
     */
    private var cloudJob: Job? = null

    /**
     * 云端分段播放的协程作用域：与朗读器同生命周期（[release] 里 cancel）。
     * `Dispatchers.Main.immediate` —— `MediaPlayer` 必须在带 Looper 的线程上创建；
     * 网络请求在仓库层内部 `withContext(IO)`，不会阻塞主线程。
     */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    /** 音色选择的持久化（Web 端对应 localStorage 的 `voice:chatTTSVoice`） */
    private val prefs = context.getSharedPreferences("chat_tts", Context.MODE_PRIVATE)

    /**
     * 朗读会话令牌：每次派发 +1。云端分段循环每一步都比对令牌，
     * 不是当前会话就立刻退出（对齐 Web 端 `sessionRef` 的作用：
     * 停止/打断后，在途的请求与迟到的回调都不得再改状态、更不得出声）。
     */
    private var session = 0

    /** 云端通道失败时给 UI 的一句话（宿主接到页内提示；对齐 Web 端 `showToast`） */
    @Volatile
    var onMessage: ((String) -> Unit)? = null

    /** 系统 TTS 引擎是否可用（初始化成功且语言数据就绪）。false 时下拉里标「不支持」 */
    var systemSupported by mutableStateOf(false)
        private set

    /** 朗读开关（用户点右上角那个按钮切） */
    var enabled by mutableStateOf(false)
        private set

    /**
     * 正在朗读的消息 id（**合成中与播放中都算**）—— UI 据此高亮那一行。
     *
     * 对齐 Web 端 `speakingMsgId`，并且与它共用同一个语义：**同一条消息再点一次 = 停止**
     * （用户想"别念了"时的自然手势就是再点它一下）。
     *
     * ★ 为什么必须有：云端首段有 2~5 秒的静默期，这期间界面若毫无变化，用户会以为
     * "点了没反应"而反复点击 —— 2026-09-28 的真实事故就是这么来的
     * （11 秒发出 20+ 次请求，把上游并发槽打满，之后所有人都看到"云端朗读暂时不可用"）。
     */
    var speakingMsgId by mutableStateOf<Long?>(null)
        private set

    /**
     * 是否仍停在"等云端返回"的阶段（还没出声）—— UI 据此显示「合成中…」。
     * 系统语音通道几乎是即时的，恒为 false。
     */
    var synthesizing by mutableStateOf(false)
        private set

    /** 当前音色 key（系统语音 / 云端音色 key；非法存量值回落系统语音） */
    var voiceKey by mutableStateOf(
        prefs.getString(KEY_VOICE, null)?.takeIf { isKnownChatTtsVoice(it) } ?: CHAT_TTS_SYSTEM_VOICE_KEY
    )
        private set

    /**
     * 当前所选音色**是否可用**：系统通道看引擎能力，云端通道恒可用
     * （HTTP + MediaPlayer 是所有目标机型的基线能力）。
     * UI 据此决定朗读按钮/消息行能不能点（对齐 Web 端 `ttsSupported`）。
     */
    val ttsSupported: Boolean
        get() = if (isSystemVoice()) systemSupported else true

    /** 下拉按钮上显示的名字（「系统语音」/「邓紫棋」） */
    val voiceLabel: String get() = chatTtsVoiceLabel(voiceKey)

    private fun isSystemVoice(): Boolean = voiceKey == CHAT_TTS_SYSTEM_VOICE_KEY

    internal fun init() {
        if (tts != null) return
        tts = TextToSpeech(context.applicationContext) { status ->
            val engine = tts
            if (status == TextToSpeech.SUCCESS && engine != null) {
                // 中文优先；没有中文数据就退回系统默认语言（英文消息也能念）
                val zh = runCatching { engine.setLanguage(Locale.CHINESE) }.getOrDefault(-1)
                if (zh == TextToSpeech.LANG_MISSING_DATA || zh == TextToSpeech.LANG_NOT_SUPPORTED) {
                    runCatching { engine.setLanguage(Locale.getDefault()) }
                }
                // 系统通道**念完了也要复位高亮**：漏了它，那一行会一直亮着（用户以为还在念）。
                // 回调跑在 TTS 自己的线程上，所以切回 [scope]（Main.immediate）再改 Compose 状态。
                engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                    override fun onStart(utteranceId: String?) = Unit
                    override fun onDone(utteranceId: String?) {
                        scope.launch { clearSpeaking() }
                    }

                    // 基类仍要求实现这个旧签名（新的是 onError(id, errorCode)，它默认转发到这里）
                    @Suppress("OVERRIDE_DEPRECATION")
                    override fun onError(utteranceId: String?) {
                        scope.launch { clearSpeaking() }
                    }
                })
                systemSupported = true
            } else {
                systemSupported = false
            }
        }
    }

    fun toggle() {
        if (!ttsSupported) return
        enabled = !enabled
        if (!enabled) stop()
    }

    /**
     * 换音色：立刻打断当前朗读（对齐 Web 端 —— 避免一句话里换声），并把选择落盘。
     * 非法 key 一律忽略（防脏数据把朗读打哑，与 Web 端 `isKnownVoice` 同口径）。
     *
     * 方法名不叫 `setVoiceKey`：那会与 [voiceKey] 属性生成的私有 setter **JVM 签名撞车**
     * （Platform declaration clash），编译期直接失败。
     */
    fun chooseVoice(key: String) {
        if (!isKnownChatTtsVoice(key) || key == voiceKey) return
        stop()
        voiceKey = key
        prefs.edit().putString(KEY_VOICE, key).apply()
    }

    /**
     * 自动朗读**新收到**的一条（宿主在"最新消息变化且是自己之外的人发的"时调用）。
     * 开关关着就什么都不做 —— 手动点消息不受此限制，见 [speak]。
     */
    fun speakIncoming(id: Long, username: String, content: String) {
        if (!enabled) return
        speak(id, username, content)
    }

    /**
     * 念一条消息（格式与 Web 端一致：「用户名 说 内容」）。
     *
     * **不看 [enabled]**：点某一条 = 用户明确要听这一条（Web 端 `handleSpeakMessage` 同口径）。
     * **再点正在处理的那一条 = 停止**（同样是 Web 端口径：`if (speakingMsgId === m.id) stopTTS()`）。
     */
    fun speak(id: Long, username: String, content: String) {
        if (!ttsSupported) return
        if (id == speakingMsgId) {
            stop()
            return
        }
        val text = "$username 说 $content"
        stop() // 最新优先：新的一条打断旧的（对齐 Web 端）
        speakingMsgId = id
        val token = session
        if (isSystemVoice()) {
            // QUEUE_FLUSH（不是 QUEUE_ADD）：与上面的"最新优先"同义
            runCatching { tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "k-chat-${text.hashCode()}") }
        } else {
            // 云端要先等首段（2~5s）：这段静默必须让界面看得见，见 [synthesizing]
            synthesizing = true
            speakCloud(token, text, voiceKey)
        }
    }

    /** 停止朗读：打断系统引擎与云端播放器，并作废（取消）在途的云端分段播放 */
    fun stop() {
        session++
        cloudJob?.cancel()
        cloudJob = null
        runCatching { tts?.stop() }
        // 立刻停声：取消是异步的，等协程自己收尾会有肉眼可见的延迟
        releasePlayer()
        clearSpeaking()
    }

    /**
     * 复位"正在朗读"的状态（高亮 + 合成中）。
     *
     * ⚠️ [speakCloud] 调它之前必须**先比会话令牌**：被打断的旧协程会在自己的 finally 里走到
     * 这里，而它收尾的时刻**晚于**新会话点亮新一行 —— 不复位判断就会把新会话刚点亮的那行灭掉。
     * [stop] 则不需要比：它是同步复位，此刻还没有新会话。
     */
    private fun clearSpeaking() {
        speakingMsgId = null
        synthesizing = false
    }

    /**
     * 云端通道：长文分段、边下边播、**预取下一段**。
     *
     * 非流式接口首段要等 2~5 秒，段与段之间若不预取就会明显卡顿 —— 这一点与 Web 端
     * `playCloud` 的预取是同一个理由（那边预取两段，这里一段足矣：一段音频要播几十秒）。
     * 任何一段失败都终止本次朗读并把服务端给的原因提示给用户（429 限流文案也在这里透出）。
     */
    private fun speakCloud(token: Int, text: String, key: String) {
        cloudJob = scope.launch {
            val chunks = splitSpeakText(text)
            // 切不出段（内容只有标点/空白）：直接收尾，别让那一行一直停在「合成中…」
            if (chunks.isEmpty()) {
                clearSpeaking()
                return@launch
            }
            var next: Deferred<ApiResult<ByteArray>>? = null
            try {
                for (i in chunks.indices) {
                    if (token != session) return@launch
                    val result = next?.await() ?: voice.speakCloud(chunks[i], key)
                    if (token != session) return@launch
                    next = if (i + 1 < chunks.size) async { voice.speakCloud(chunks[i + 1], key) } else null
                    when (result) {
                        is ApiResult.Success -> {
                            // 首段到手 = 马上要出声了，不再是"合成中"
                            synthesizing = false
                            if (!playMp3(result.data)) return@launch
                        }
                        is ApiResult.Failure -> {
                            onMessage?.invoke(result.error.displayMessage)
                            return@launch
                        }
                    }
                }
            } finally {
                // 提前退出（被停止/打断/出错）时，预取的那一段不再继续下载
                next?.cancel()
                // 只有"当前会话"才复位高亮：被打断的旧会话收尾**晚于**新会话点亮新一行，
                // 不判断就会把新的那行灭掉（详见 clearSpeaking 的说明）
                if (token == session) clearSpeaking()
            }
        }
    }

    /**
     * 播放一段 mp3：落临时文件 → `MediaPlayer`（异步 prepare）→ **播完才返回**。
     *
     * 为什么必须落盘：`MediaPlayer` 只认 URI/FileDescriptor，不认内存字节。
     * 文件名带纳秒时间戳（不做内容哈希缓存 —— 哈希碰撞会让"这段文字"播出"那段音频"，
     * 而重复朗读同一段文字本来就不是高频操作）。播完/失败/被取消一律删临时文件。
     *
     * 返回 false = 这一段播不出来（调用方终止本次朗读）。
     */
    private suspend fun playMp3(bytes: ByteArray): Boolean {
        if (bytes.isEmpty()) return false
        val file = File(context.cacheDir, "chat-tts-${System.nanoTime()}.mp3")
        return try {
            withContext(Dispatchers.IO) { file.writeBytes(bytes) }
            suspendCancellableCoroutine { cont ->
                val mp = MediaPlayer()
                player = mp
                mp.setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                )
                mp.setOnCompletionListener {
                    releasePlayer(mp)
                    if (cont.isActive) cont.resume(true)
                }
                mp.setOnErrorListener { _, _, _ ->
                    releasePlayer(mp)
                    if (cont.isActive) cont.resume(false)
                    true
                }
                // prepareAsync 完成后**必须显式 start()**：MediaPlayer 不会自动开播，
                // 漏了就是"已就绪但永不发声"—— 不是错误（onError 不回调）、也没播完
                // （onCompletion 不回调），协程就永远挂在下面等 onCompletion。
                mp.setOnPreparedListener { prepared ->
                    try {
                        prepared.start()
                    } catch (t: Throwable) {
                        releasePlayer(mp)
                        if (cont.isActive) cont.resume(false)
                    }
                }
                cont.invokeOnCancellation { releasePlayer(mp) }
                try {
                    mp.setDataSource(file.absolutePath)
                    mp.prepareAsync()
                } catch (t: Throwable) {
                    releasePlayer(mp)
                    if (cont.isActive) cont.resume(false)
                }
            }
        } finally {
            file.delete()
        }
    }

    /**
     * 释放播放器（重复调用安全；[MediaPlayer] 在已释放状态下再 stop 会抛 IllegalArgumentException）。
     *
     * 不在这里摘 listener：`release()` 本身就会作废未回调的消息，而卸载后我的那两个回调
     * 也是幂等的（`releasePlayer` 空判 + `cont.isActive` 守卫），摘了反而多一处状态。
     */
    private fun releasePlayer(mp: MediaPlayer? = player) {
        if (mp == null) return
        runCatching { mp.stop() }
        runCatching { mp.release() }
        if (player === mp) player = null
    }

    internal fun release() {
        stop()
        scope.cancel()
        runCatching { tts?.shutdown() }
        tts = null
        systemSupported = false
        enabled = false
    }

    private companion object {
        /** 音色选择的存储键（Web 端是 localStorage 的 `voice:chatTTSVoice`，同一语义） */
        const val KEY_VOICE = "chat_tts_voice"
    }
}

/**
 * 取得（并托管）当前页面的朗读器：进页面时初始化，离开页面时关掉引擎。
 *
 * 不在 Composable 里直接 new：TTS 的初始化是**异步**的（回调里才知道能不能用），
 * 所以 [systemSupported] 是状态，UI 会跟着它把开关从置灰变成可点。
 *
 * [voice] 传进来是为了云端通道（`POST /api/tts`）—— 朗读器自己不持有网络层。
 */
@Composable
fun rememberChatReader(voice: VoiceRepository): ChatReader {
    val context = LocalContext.current
    val reader = remember(context, voice) { ChatReader(context, voice) }
    DisposableEffect(reader) {
        reader.init()
        onDispose { reader.release() }
    }
    return reader
}
