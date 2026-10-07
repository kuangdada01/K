package top.kuangdada.k.nativeapp.voice

import kotlin.math.abs

/**
 * ============================================================
 * 混音与 PCM 处理（纯函数，可脱离真机单测）
 * ============================================================
 * 抽出来的理由：混音是录制里**最容易写错、而且错了最难发现**的一段 ——
 * 出错的典型表现是"文件时长正常、能播放，但声音不对"（音量忽大忽小、有爆音、
 * 只有一个人的声音），跟信令/媒体层的问题混在一起极难归因。所以这里的逻辑
 * 全部做成纯函数，由 `AudioMixTest` 钉死。
 */
internal object AudioMix {

    /**
     * 把两路 16bit PCM 相加并**限幅**。
     *
     * 为什么必须限幅：两路都是完整量程（-32768..32767），直接相加会溢出。
     * Kotlin 的 `Short` 溢出是回绕（wrap），不是饱和 —— 回绕会把一个响亮的峰值
     * 变成反相的暴音。Web 版用 `DynamicsCompressorNode` 压限，原生在样本级做饱和即可。
     *
     * @param selfMuted 自己闭麦时把麦克风那一路当静音（与 Web 版 setMutedGate 对齐）
     */
    fun mix(playback: ShortArray, microphone: ShortArray, selfMuted: Boolean): ShortArray {
        val size = maxOf(playback.size, microphone.size)
        val out = ShortArray(size)
        for (i in 0 until size) {
            val p = if (i < playback.size) playback[i].toInt() else 0
            val m = if (selfMuted || i >= microphone.size) 0 else microphone[i].toInt()
            out[i] = saturate(p + m)
        }
        return out
    }

    /** 饱和到 16bit 量程（不回绕） */
    fun saturate(value: Int): Short = when {
        value > Short.MAX_VALUE -> Short.MAX_VALUE
        value < Short.MIN_VALUE -> Short.MIN_VALUE
        else -> value.toShort()
    }

    /**
     * 小端 16bit 字节流 → ShortArray。
     *
     * `AudioRecord` / `AudioTrack` / WebRTC 的 AudioSamples 都是小端；
     * 按大端解会让声音变成刺耳的噪声（而不是"没声音"，所以更容易被当成"编码器坏了"）。
     */
    fun toShorts(data: ByteArray): ShortArray {
        val out = ShortArray(data.size / 2)
        var i = 0
        while (i < out.size) {
            out[i] = ((data[i * 2].toInt() and 0xFF) or (data[i * 2 + 1].toInt() shl 8)).toShort()
            i++
        }
        return out
    }

    /**
     * 从时间轴上取一段样本。
     *
     * @param startSample 缓冲里第一个样本对应的时间轴位置
     * @param end 缓冲里有效样本数
     * @return 越界（某一路还没到那段）时返回 0（静音）—— **不能返回上一段的值**，
     *         否则会把旧声音重复播出去（表现为"声音拖尾/卡带"）
     */
    fun sampleAt(buffer: ShortArray, startSample: Long, end: Int, pos: Long): Int {
        val idx = pos - startSample
        return if (idx >= 0 && idx < end) buffer[idx.toInt()].toInt() else 0
    }

    /**
     * 会不会削顶（供测试与将来的 UI 提示用）。
     * 两路都接近满量程时必然削顶 —— 这不是 bug，是"两个人同时大声说话"的正常结果，
     * 但值得能从数据上看到。
     */
    fun wouldClip(playback: ShortArray, microphone: ShortArray): Boolean {
        val size = minOf(playback.size, microphone.size)
        for (i in 0 until size) {
            if (abs(playback[i].toInt() + microphone[i].toInt()) > Short.MAX_VALUE) return true
        }
        return false
    }
}
