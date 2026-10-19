package top.kuangdada.k.nativeapp.ui

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import android.os.SystemClock
import java.io.File
import kotlin.math.roundToInt
import kotlin.math.sqrt
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * ============================================================
 * 私信语音录制（MediaRecorder / AAC / m4a）
 * ============================================================
 * 与语音房的 WebRTC 采集**完全分开**：那边要的是实时 RTP 帧，这里要的是一个
 * 能上传、能重复播放的文件。用 `MediaRecorder` 是最短路径（系统编码器直接出 mp4 容器）。
 *
 * ## 波形从哪来
 * `MediaRecorder` 不提供 PCM，只有 [MediaRecorder.getMaxAmplitude]（当前窗口的峰值）。
 * 每 60ms 采一次，停止后压成 32 根柱（0–100）随消息一起上传；接收端不需要解码音频
 * 就能画波形。这个精度对"看着像语音"完全够用，也是很多 IM 的实际做法。
 *
 * ## 时长上限
 * [MAX_RECORD_MS]（60s）到点由 UI 主动 [stop]（见 [start] 的 `onMaxReached`）——
 * 录音器本身没有"最长时长"参数。服务端还会按同一常量二次校验。
 *
 * 所有失败路径都返回 null / false，并且**删掉半截文件**：缓存目录不能留垃圾。
 */
class VoiceRecorder(private val context: Context) {

    /** 一次成功录制的结果 */
    data class VoiceRecording(
        val file: File,
        val durationMs: Int,
        /** 0–100，长度固定 [WAVEFORM_BARS] */
        val waveform: List<Int>,
    )

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private var recorder: MediaRecorder? = null
    private var output: File? = null
    private var startedAt = 0L
    private var pollJob: Job? = null
    private val samples = mutableListOf<Int>()

    /** 当前振幅（0..32767）——录音悬浮条的气泡/波形实时用 */
    var level: Int = 0
        private set

    /** 已录时长（ms）——悬浮条计时用（每 60ms 更新一次） */
    var elapsedMs: Long = 0L
        private set

    val isRecording: Boolean get() = recorder != null

    /**
     * 开始录音。
     *
     * @param onMaxReached 到达 [MAX_VOICE_MS] 时回调（UI 应立即走"松手发送"的同一路径，
     *                     这里**不自动 stop** —— 停止动作由持有录音器的一方统一做，
     *                     避免录音器内部与 UI 同时 stop 造成状态打架）
     * @return false = 启动失败（权限/设备占用/编码器不可用），调用方提示后不再继续
     */
    fun start(onMaxReached: () -> Unit): Boolean {
        if (recorder != null) return true
        val dir = File(context.cacheDir, "voice").apply { mkdirs() }
        val file = File(dir, "voice-${System.currentTimeMillis()}.m4a")

        val rec = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                MediaRecorder(context)
            } else {
                @Suppress("DEPRECATION")
                MediaRecorder()
            }
        } catch (t: Throwable) {
            file.delete()
            return false
        }

        val ok = runCatching {
            rec.setAudioSource(MediaRecorder.AudioSource.MIC)
            rec.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            rec.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            // 44.1kHz / 单声道 / 64kbps：60 秒约 480KB，人声足够清楚
            rec.setAudioSamplingRate(44_100)
            rec.setAudioChannels(1)
            rec.setAudioEncodingBitRate(64_000)
            rec.setOutputFile(file.absolutePath)
            rec.prepare()
            rec.start()
        }.isSuccess

        if (!ok) {
            runCatching { rec.release() }
            file.delete()
            return false
        }

        recorder = rec
        output = file
        samples.clear()
        level = 0
        elapsedMs = 0
        startedAt = SystemClock.elapsedRealtime()

        pollJob = scope.launch {
            while (isActive) {
                val amp = runCatching { recorder?.maxAmplitude ?: 0 }.getOrDefault(0)
                level = amp
                samples += amp
                elapsedMs = SystemClock.elapsedRealtime() - startedAt
                if (elapsedMs >= MAX_RECORD_MS) {
                    onMaxReached()
                    break
                }
                delay(AMPLITUDE_INTERVAL_MS)
            }
        }
        return true
    }

    /**
     * 停止并返回结果；**不足 1 秒 / 编码失败返回 null**（文件已删除）。
     *
     * 不足 1 秒在这一层就丢掉，UI 只需要判 null 并提示"说话时间太短"，
     * 不必再各自算一遍时长。
     */
    fun stop(): VoiceRecording? {
        val rec = recorder ?: return null
        pollJob?.cancel()
        pollJob = null
        val duration = (SystemClock.elapsedRealtime() - startedAt).coerceAtLeast(0L)
        recorder = null

        val stopped = runCatching { rec.stop() }.isSuccess
        runCatching { rec.release() }

        val file = output
        output = null
        if (!stopped || file == null || !file.exists() || duration < MIN_RECORD_MS) {
            file?.delete()
            return null
        }
        return VoiceRecording(
            file = file,
            durationMs = duration.toInt().coerceAtMost(MAX_RECORD_MS.toInt()),
            waveform = buildWaveform(samples),
        )
    }

    /** 取消（上滑取消/页面销毁）：立刻停并删文件，不产出结果 */
    fun cancel() {
        pollJob?.cancel()
        pollJob = null
        val rec = recorder
        recorder = null
        if (rec != null) {
            runCatching { rec.stop() }
            runCatching { rec.release() }
        }
        output?.delete()
        output = null
        samples.clear()
        level = 0
        elapsedMs = 0
    }

    companion object {
        /** 柱数：与 Web 端渲染保持同一档（服务端最多存 64 根） */
        const val WAVEFORM_BARS = 32

        private const val AMPLITUDE_INTERVAL_MS = 60L

        /** 与 shared 的 MIN_VOICE_MS 对齐（1 秒） */
        private const val MIN_RECORD_MS = 1_000L

        /** 与 shared 的 MAX_VOICE_MS 对齐（60 秒）；到点 UI 自动结束并发送 */
        const val MAX_RECORD_MS = 60_000L

        /**
         * 原始振幅（约 1000 个采样）→ 32 根柱（0–100）。
         *
         * 取每段**峰值**而不是平均：语音的能量集中在短瞬间，平均会把整条压成一条平线。
         * 再开方压缩动态范围（小声也有起伏），下限 12 保证静音段也看得到柱子。
         */
        fun buildWaveform(samples: List<Int>, bars: Int = WAVEFORM_BARS): List<Int> {
            if (samples.isEmpty()) return List(bars) { 12 }
            val out = ArrayList<Int>(bars)
            for (i in 0 until bars) {
                val from = (i * samples.size / bars).coerceIn(0, samples.size - 1)
                val to = (((i + 1) * samples.size) / bars).coerceIn(from + 1, samples.size)
                val peak = samples.subList(from, to).maxOrNull() ?: 0
                val norm = sqrt((peak / 32_767f).coerceIn(0f, 1f))
                out += (12f + norm * 88f).roundToInt().coerceIn(12, 100)
            }
            return out
        }
    }
}
