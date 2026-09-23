package top.kuangdada.k.nativeapp.voice

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * ============================================================
 * 录制编码器（RoomEncoder）
 * ============================================================
 * 两种输出，取决于设备是否真的提供 MP3 编码器（见 [RoomRecorder.capabilities]）：
 *
 *  · **[RoomRecorder.Format.Mp3]** —— `MediaCodec("audio/mpeg")` 输出的就是**裸 MPEG 帧**，
 *    直接顺序写文件即可（MP3 帧自带同步头，不需要容器）。所以不用 MediaMuxer。
 *  · **[RoomRecorder.Format.Aac]** —— AAC 需要容器，用 `MediaMuxer` 写 MP4（即 `.m4a`）。
 *    必须等 `INFO_OUTPUT_FORMAT_CHANGED` 才能 `start()`，且 `csd-0` 要在 start 前交给 muxer
 *    （muxer 自己会从 format 里取）—— 顺序错了会得到"能播放但没声音"或直接抛异常。
 *
 * 编码器是**同步模式**（`dequeueInputBuffer(timeout)`），在一个专用线程上跑：
 * 音频编码量很小（48kHz 单声道 ≈ 768kbps 原始数据），同步模式的简单性远比异步回调的
 * 那一丁点吞吐收益重要。
 */
internal class RoomEncoder(
    private val file: File,
    private val format: RoomRecorder.Format,
) {

    private var codec: MediaCodec? = null
    private var muxer: MediaMuxer? = null
    private var out: FileOutputStream? = null
    private var trackIndex = -1
    private var muxerStarted = false
    private var totalSamples = 0L

    /**
     * 打开编码器。
     * @return 错误文案；成功返回 null
     */
    fun open(sampleRate: Int, channels: Int): String? = try {
        val mime = format.mime
        val mediaFormat = MediaFormat.createAudioFormat(mime, sampleRate, channels).apply {
            setInteger(MediaFormat.KEY_BIT_RATE, BIT_RATE)
            if (format == RoomRecorder.Format.Aac) {
                // AAC-LC：兼容性最好的一档（Android 全平台支持，绝大多数播放器都认）
                setInteger(
                    MediaFormat.KEY_AAC_PROFILE,
                    MediaCodecInfo.CodecProfileLevel.AACObjectLC,
                )
            }
            setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, sampleRate * channels * 2 / 5)
        }

        val created = MediaCodec.createEncoderByType(mime)
        created.configure(mediaFormat, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        created.start()
        codec = created

        totalSamples = 0
        when (format) {
            RoomRecorder.Format.Mp3 -> {
                out = FileOutputStream(file)
            }
            RoomRecorder.Format.Aac -> {
                muxer = MediaMuxer(file.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
            }
        }
        null
    } catch (t: Throwable) {
        Log.e(TAG, "打开编码器失败 (${format.mime})", t)
        // 探测说能用但实际打不开（OEM 差异）——如实报错，别默默录出个空文件
        runCatching { codec?.release() }
        codec = null
        "无法启动 ${format.label} 编码器：${t.message}"
    }

    /** 编码一段 PCM（16bit 交错） */
    fun encode(samples: ShortArray, channels: Int) {
        val c = codec ?: return
        if (samples.isEmpty()) return

        val bytes = ByteBuffer.allocate(samples.size * 2).order(ByteOrder.LITTLE_ENDIAN)
        samples.forEach { bytes.putShort(it) }
        bytes.flip()

        var offset = 0
        while (bytes.hasRemaining()) {
            val inputIndex = c.dequeueInputBuffer(TIMEOUT_US)
            if (inputIndex < 0) {
                // 输入缓冲暂时没有：先把输出抽干再试（不抽会死锁 —— 编码器输出队列满了
                // 就不再给输入缓冲）
                drainOutput()
                continue
            }
            val input = c.getInputBuffer(inputIndex) ?: continue
            input.clear()
            val chunk = minOf(input.remaining(), bytes.remaining())
            val slice = ByteArray(chunk)
            bytes.get(slice)
            input.put(slice)
            c.queueInputBuffer(inputIndex, 0, chunk, presentationTimeUs(), 0)
            offset += chunk
            drainOutput()
        }
    }

    /** 把编码器里剩下的输出全部取出（停止时调用） */
    fun drain() {
        val c = codec ?: return
        runCatching {
            val inputIndex = c.dequeueInputBuffer(TIMEOUT_US)
            if (inputIndex >= 0) {
                c.queueInputBuffer(
                    inputIndex, 0, 0, presentationTimeUs(),
                    MediaCodec.BUFFER_FLAG_END_OF_STREAM,
                )
            }
        }
        // 取到 EOS 为止
        repeat(20) { drainOutput(force = true) }
    }

    /** 关闭并结算文件 */
    fun finish(fallbackFile: File?): File? {
        val c = codec
        runCatching { drain() }
        runCatching { c?.stop() }
        runCatching { c?.release() }
        codec = null

        when (format) {
            RoomRecorder.Format.Mp3 -> {
                runCatching { out?.flush() }
                runCatching { out?.close() }
                out = null
            }
            RoomRecorder.Format.Aac -> {
                runCatching { if (muxerStarted) muxer?.stop() }
                runCatching { muxer?.release() }
                muxer = null
            }
        }
        return if (file.exists() && file.length() > 0) file else fallbackFile?.takeIf { it.exists() }
    }

    // ---------------------------------------------------------------

    private fun drainOutput(force: Boolean = false) {
        val c = codec ?: return
        val info = MediaCodec.BufferInfo()
        while (true) {
            val index = c.dequeueOutputBuffer(info, if (force) TIMEOUT_US else 0)
            when {
                index == MediaCodec.INFO_TRY_AGAIN_LATER -> return

                index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                    // AAC 必须在这里才拿到 csd-0，并在此刻启动 muxer
                    if (muxer != null && !muxerStarted) {
                        trackIndex = muxer!!.addTrack(c.outputFormat)
                        muxer!!.start()
                        muxerStarted = true
                    }
                }

                index >= 0 -> {
                    val buffer = c.getOutputBuffer(index) ?: continue
                    if (info.size > 0) {
                        when (format) {
                            RoomRecorder.Format.Mp3 -> {
                                // 裸 MPEG 帧直接写文件（跳过 CodecConfig 类型：MP3 没有 csd）
                                if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
                                    val data = ByteArray(info.size)
                                    buffer.position(info.offset)
                                    buffer.limit(info.offset + info.size)
                                    buffer.get(data)
                                    out?.write(data)
                                }
                            }
                            RoomRecorder.Format.Aac -> {
                                if (muxerStarted) {
                                    buffer.position(info.offset)
                                    buffer.limit(info.offset + info.size)
                                    muxer?.writeSampleData(trackIndex, buffer, info)
                                }
                            }
                        }
                    }
                    c.releaseOutputBuffer(index, false)
                    if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return
                }

                else -> return
            }
        }
    }

    private fun presentationTimeUs(): Long =
        totalSamples.let { samples ->
            val us = samples * 1_000_000L / SAMPLE_RATE_ASSUMED
            us
        }.also { totalSamples += CHUNK_SAMPLES }

    private companion object {
        const val TAG = "KRoomEncoder"
        const val TIMEOUT_US = 10_000L
        const val BIT_RATE = 128_000
        const val CHUNK_SAMPLES = 960L
        const val SAMPLE_RATE_ASSUMED = 48_000L
    }
}
