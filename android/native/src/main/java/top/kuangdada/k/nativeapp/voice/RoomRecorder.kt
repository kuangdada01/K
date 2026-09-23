package top.kuangdada.k.nativeapp.voice

import android.content.Context
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaFormat
import android.media.MediaMuxer
import android.os.Environment
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.atomic.AtomicLong

/**
 * ============================================================
 * 全房间混音录制（RoomRecorder）
 * ============================================================
 * 录的是"**房间里的所有声音**"：远端各路 + 开麦时的自己。
 *
 * 两个音频源都来自 WebRTC 的 `JavaAudioDeviceModule`（见 VoiceSession 的装配）：
 *  · `setPlaybackSamplesReadyCallback` → **远端混音后的播放 PCM**（WebRTC 已经把多路远端
 *    解码、混音好了，我们不需要自己拼接每一路）；
 *  · `setSamplesReadyCallback` → **本地麦克风的采集 PCM**（已过 APM：回声消除/降噪/AGC）。
 *  两者相加再限幅，就得到与 Web 版语义一致的"全房间混音"。
 *
 * ### 关于格式（必须说清楚）
 * **Android 平台不提供 MP3 编码器** —— AOSP 只带 `audio/mpeg` 的**解码器**
 * （实测设备上只有 `OMX.google.mp3.decoder` / `c2.android.mp3.decoder`，没有任何 encoder）。
 * 所以本实现会在启动时**探测** `audio/mpeg` 编码器：
 *  · 有（某些 OEM/第三方 ROM 会带）→ 直接出 `.mp3`（raw MPEG 帧，可直接播放）；
 *  · 没有（绝大多数设备）→ 降级为 **AAC-LC 封装在 MP4 里（`.m4a`）**，用 `MediaMuxer` 写容器。
 * 想要真正的 MP3 必须引入 LAME（JPatch/lame 的 NDK 交叉编译），那是另一件事。
 *
 * ### 两条与 Web 版对齐的语义
 *  1. **静音门控**：自己闭麦时，自己的声音不进录制（否则会出现"闭麦了却录到自己"）；
 *  2. **录制中途进房的人也要录进去** —— 这一点在原生侧是**自动满足**的：
 *     我们录的是 WebRTC 的播放混音输出，新成员的声音一进来就会被混进去，
 *     不像 Web 版那样要显式 `attachPeerGain`。
 *
 * ### 线程模型
 * 两个回调分别跑在 WebRTC 的录音线程与播放线程上，而编码/写文件在录制线程上。
 * 用一把锁保护混音缓冲区：临界区只有一次数组拷贝（几百微秒），不会阻塞音频回调
 * 到丢帧的程度。
 */
class RoomRecorder(
    private val context: Context,
    private val onStateChanged: (recording: Boolean, startedAt: Long?, file: File?, error: String?) -> Unit,
) {

    /** 输出格式（运行时探测决定） */
    enum class Format(val extension: String, val label: String, val mime: String) {
        Mp3("mp3", "MP3", "audio/mpeg"),
        Aac("m4a", "AAC (M4A)", "audio/mp4a-latm"),
    }

    data class Capabilities(val format: Format, val note: String)

    private var started = false
    private var startedAt = 0L
    private var outputFile: File? = null

    private var format: Format = Format.Aac

    // 混音缓冲（以 16bit 单声道样本为单位）
    private val lock = Object()
    /** 已写入播放 PCM 的总样本数（时间轴） */
    private val playWritten = AtomicLong(0)
    /** 已写入麦克风 PCM 的总样本数 */
    private val micWritten = AtomicLong(0)
    /** 已编码消费到的时间轴位置 */
    private var consumedSamples = 0L
    private var playBuffer = ShortArray(0)
    private var playEnd = 0 // 播放缓冲里有效样本的结束位置（相对 playStart）
    private var playStart = 0L // 播放缓冲第一个样本的时间轴位置
    private var micBuffer = ShortArray(0)
    private var micEnd = 0
    private var micStart = 0L

    private var sampleRate = 48_000
    private var channels = 1

    /** 自己是否在麦（闭麦时自己的声音不进录制 —— 与 Web 版 setMutedGate 对齐） */
    @Volatile
    private var selfMuted = false

    private var encoder: RoomEncoder? = null
    private var encodeThread: Thread? = null
    @Volatile private var stopRequested = false

    val isRecording: Boolean get() = started

    // ---------------------------------------------------------------
    // 能力探测
    // ---------------------------------------------------------------

    companion object {
        private const val TAG = "KRoomRecorder"
        private const val MAX_SECONDS = 60 * 60 // 单次录制上限 1 小时，防磁盘写满
        private const val BUFFER_SECONDS = 4  // 时间轴对齐窗（足够吸收两个回调的抖动）

        /**
         * 探测可用的录制格式。
         *
         * 结果要展示给用户 —— 不能默默录成 AAC 却告诉用户是 MP3。
         */
        fun capabilities(): Capabilities {
            val hasMp3Encoder = runCatching {
                MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.any { info ->
                    info.isEncoder && info.supportedTypes.any { it.equals("audio/mpeg", ignoreCase = true) }
                }
            }.getOrDefault(false)

            return if (hasMp3Encoder) {
                Capabilities(Format.Mp3, "本机支持 MP3 编码，录制将直接输出 .mp3")
            } else {
                Capabilities(
                    Format.Aac,
                    "Android 平台不提供 MP3 编码器（只有解码器），录制将输出 AAC 的 .m4a。" +
                        "要真正的 MP3 需要引入 LAME 原生库。",
                )
            }
        }

        /** 录音落点：`Music/K/` —— Android 10+ 写这里不需要存储权限 */
        fun outputDir(): File {
            val base = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC)
            return File(base, "K")
        }
    }

    // ---------------------------------------------------------------
    // 音频源写入（由 WebRTC 的音频回调线程调用，必须轻量）
    // ---------------------------------------------------------------

    /** 远端混音后的播放 PCM（WebRTC 已把多路远端混好） */
    fun onPlaybackSamples(data: ByteArray, rate: Int, channelCount: Int) {
        if (!started) return
        sampleRate = rate
        channels = channelCount
        appendPlayback(AudioMix.toShorts(data))
    }

    /** 本地麦克风 PCM（已过 APM） */
    fun onMicrophoneSamples(data: ByteArray, rate: Int, channelCount: Int) {
        if (!started) return
        sampleRate = rate
        appendMicrophone(AudioMix.toShorts(data))
    }

    fun setSelfMuted(muted: Boolean) {
        selfMuted = muted
    }

    private fun appendPlayback(samples: ShortArray) {
        synchronized(lock) {
            playBuffer = ensureCapacity(playBuffer, playEnd + samples.size)
            System.arraycopy(samples, 0, playBuffer, playEnd, samples.size)
            if (playEnd == 0) playStart = playWritten.get()
            playEnd += samples.size
            playWritten.addAndGet(samples.size.toLong())
            trimIfNeeded()
        }
    }

    private fun appendMicrophone(samples: ShortArray) {
        synchronized(lock) {
            micBuffer = ensureCapacity(micBuffer, micEnd + samples.size)
            System.arraycopy(samples, 0, micBuffer, micEnd, samples.size)
            if (micEnd == 0) micStart = micWritten.get()
            micEnd += samples.size
            micWritten.addAndGet(samples.size.toLong())
            trimIfNeeded()
        }
    }

    /** 丢掉落在外面的旧样本，避免缓冲区无限增长 */
    private fun trimIfNeeded() {
        val window = sampleRate.toLong() * BUFFER_SECONDS * channels
        // 播放侧
        val playKeepFrom = consumedSamples.coerceAtLeast(playWritten.get() - window)
        if (playKeepFrom > playStart) {
            val drop = (playKeepFrom - playStart).toInt().coerceAtMost(playEnd)
            if (drop > 0) {
                System.arraycopy(playBuffer, drop, playBuffer, 0, playEnd - drop)
                playEnd -= drop
                playStart += drop
            }
        }
        // 麦克风侧（对齐到同一个时间轴位置）
        val micKeepFrom = consumedSamples.coerceAtLeast(micWritten.get() - window)
        if (micKeepFrom > micStart) {
            val drop = (micKeepFrom - micStart).toInt().coerceAtMost(micEnd)
            if (drop > 0) {
                System.arraycopy(micBuffer, drop, micBuffer, 0, micEnd - drop)
                micEnd -= drop
                micStart += drop
            }
        }
    }

    /** 能编多少样本：两侧时间轴都到位了才算就绪 */
    private fun availableSamples(): Long = synchronized(lock) {
        val playReady = playStart + playEnd
        // 麦克风缺数据时（例如对方一直没人说话、回调不触发）用静音补齐：
        // 时间轴取"播放侧已到"的位置，麦克风缺失部分按静音混 —— 否则一旦某侧回调
        // 没来就会永久卡住，表现是"录了几秒就停住"
        val micReady = micStart + micEnd
        val end = playReady
        val start = consumedSamples
        val micOk = if (micReady >= end) end else micReady
        (end - start).coerceAtLeast(0) - (end - micOk).coerceAtMost(0)
    }

    /**
     * 取一段混音结果（消费推进时间轴）。
     *
     * 逐样本调用 [AudioMix.sampleAt] + `saturate` —— 这两个是纯函数、已由单测钉死；
     * 之前这里是内联实现，与 AudioMix 形成两份逻辑（改一处忘一处就出"能播放但声音不对"）。
     */
    private fun readMixed(count: Int): ShortArray = synchronized(lock) {
        val out = ShortArray(count)
        val from = consumedSamples
        for (i in 0 until count) {
            val pos = from + i
            val p = AudioMix.sampleAt(playBuffer, playStart, playEnd, pos)
            // 闭麦时自己的声音不进录制（与 Web 版的 setMutedGate 语义一致）
            val m = if (selfMuted) 0 else AudioMix.sampleAt(micBuffer, micStart, micEnd, pos)
            out[i] = AudioMix.saturate(p + m)
        }
        consumedSamples += count
        trimIfNeeded()
        out
    }

    private fun ensureCapacity(buffer: ShortArray, needed: Int): ShortArray =
        if (buffer.size >= needed) buffer else ShortArray(maxOf(needed, buffer.size * 2, 48_000))

    // ---------------------------------------------------------------
    // 开始 / 停止
    // ---------------------------------------------------------------

    /**
     * 开始录制。
     * @return 出错时返回错误文案，成功返回 null
     */
    fun start(): String? {
        if (started) return null
        val caps = capabilities()
        format = caps.format

        val dir = outputDir()
        if (!dir.exists() && !dir.mkdirs()) {
            return "无法创建录音目录：${dir.absolutePath}"
        }
        val stamp = java.text.SimpleDateFormat("yyyyMMdd-HHmmss", java.util.Locale.US)
            .format(java.util.Date())
        val file = File(dir, "K-${stamp}.${format.extension}")
        outputFile = file

        synchronized(lock) {
            playBuffer = ShortArray(48_000 * 4)
            micBuffer = ShortArray(48_000 * 4)
            playEnd = 0; micEnd = 0; playStart = 0; micStart = 0
            playWritten.set(0); micWritten.set(0); consumedSamples = 0
        }
        stopRequested = false
        started = true
        startedAt = System.currentTimeMillis()

        val enc = RoomEncoder(file, format)
        val openError = enc.open(sampleRate, channels)
        if (openError != null) {
            started = false
            return openError
        }
        encoder = enc

        encodeThread = Thread({ encodeLoop() }, "k-room-recorder").apply { start() }
        onStateChanged(true, startedAt, file, null)

        if (format == Format.Aac) {
            Log.i(TAG, "开始录制（AAC/M4A）：${file.absolutePath}")
        } else {
            Log.i(TAG, "开始录制（MP3）：${file.absolutePath}")
        }
        return null
    }

    /** 停止并结算文件；返回最终文件（失败为 null） */
    fun stop(): File? {
        if (!started) return null
        stopRequested = true
        encodeThread?.join(5_000)
        encodeThread = null
        started = false

        val enc = encoder
        encoder = null
        val file = outputFile
        val finalFile = enc?.finish(file)
        onStateChanged(false, null, finalFile, null)
        Log.i(TAG, "录制结束：${finalFile?.absolutePath} (${finalFile?.length() ?: 0} bytes)")
        return finalFile
    }

    private fun encodeLoop() {
        val enc = encoder ?: return
        val maxSecondsSamples = sampleRate.toLong() * MAX_SECONDS * channels
        try {
            while (!stopRequested) {
                val ready = availableSamples()
                if (ready < sampleRate / 50) { // 攒够 20ms 再编，减少编码器调用次数
                    Thread.sleep(10)
                    continue
                }
                if (consumedSamples > maxSecondsSamples) {
                    Log.w(TAG, "达到单次录制上限（${MAX_SECONDS}s），自动停止")
                    break
                }
                val chunk = minOf(ready, sampleRate.toLong() * channels / 5).toInt() // 每次最多 200ms
                val mixed = readMixed(chunk)
                enc.encode(mixed, channels)
            }
            // 收尾：把剩余不足 20ms 的样本也编出去
            val tail = availableSamples()
            if (tail > 0) {
                enc.encode(readMixed(tail.toInt()), channels)
            }
        } catch (t: Throwable) {
            Log.e(TAG, "录制编码失败", t)
        } finally {
            runCatching { enc.drain() }
        }
    }
}
