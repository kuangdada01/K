package top.kuangdada.k.nativeapp.voice

/**
 * ============================================================
 * 「谁在说话」的门限与迟滞（SpeakingGate）
 * ============================================================
 * 数据来源：WebRTC `getStats()` 里的 `inbound-rtp.audioLevel`（远端）与
 * `media-source.audioLevel`（自己），都是 0..1 的线性幅度。
 *
 * **为什么不用 `AudioTrackSink` 自己算 RMS**：那要往音轨上挂 sink，而"挂 sink 会不会
 * 接管播放"这件事在 WebRTC 的 Java 层没有可靠承诺 —— 一旦它的语义是"接管"，
 * 整房人会**听不到声音**（比"灯不亮"严重得多）。统计是只读的：最坏情况只是灯不亮。
 * （Web 端用的是 AnalyserNode 的 RMS，阈值 0.045、100ms 轮询，见
 * `client/src/voice/audio/audioGraph.ts`；这里同一套思路，只是数据换成统计里的幅度。）
 *
 * 两件事必须做对，否则灯会闪：
 *  1. **门限**：取 [DEFAULT_THRESHOLD]。太低会把底噪当真（灯一直亮、看着像坏了），
 *     太高则小声说话不亮；
 *  2. **松手保持**：统计是每 [POLL_MS] 一轮的离散采样，说话时字与字之间完全可能落到门限以下，
 *     所以判"停"要等 [releaseMs] 内都没有超过门限的采样 —— 这就是迟滞。
 *
 * 纯逻辑（不碰任何 WebRTC 类型，时钟由调用方给），所以可以直接单测：见 `SpeakingGateTest`。
 */
class SpeakingGate(
    private val threshold: Float = DEFAULT_THRESHOLD,
    private val releaseMs: Long = DEFAULT_RELEASE_MS,
) {

    private var speaking = false

    /** 最近一次"够大声"的时刻（0 = 还没有过）。用 0 而不是 `Long.MIN_VALUE`：后者会在做差时溢出 */
    private var lastLoudAt = 0L

    /** 当前状态（UI 只读它） */
    val isSpeaking: Boolean get() = speaking

    /**
     * 喂一个采样。
     *
     * @param level 0..1 的幅度；**null = 这一轮没拿到统计**（既不算"安静"、也不打断保持期 ——
     *   网络抖动导致的单轮缺失不该把灯掐掉；真的没了会在 [releaseMs] 之后自然熄灭）
     * @return true = 状态**翻转**了（调用方据此上报，避免每轮都推一次状态）
     */
    fun update(level: Float?, nowMs: Long): Boolean {
        if (level != null && level >= threshold) lastLoudAt = nowMs
        val next = lastLoudAt > 0L && nowMs - lastLoudAt <= releaseMs
        if (next == speaking) return false
        speaking = next
        return true
    }

    /** 立刻判定为"没在说话"（自己闭麦 / 对端离开 / 退房）。@return true = 状态翻转了 */
    fun reset(): Boolean {
        lastLoudAt = 0L
        if (!speaking) return false
        speaking = false
        return true
    }

    companion object {
        /** 说话门限（0..1 幅度）：与 Web 端 0.045 同量级，略低一点（统计里的幅度比 AnalyserNode 的 RMS 保守） */
        const val DEFAULT_THRESHOLD = 0.03f

        /** 松手保持：最后一声之后还亮多久 */
        const val DEFAULT_RELEASE_MS = 450L

        /** 统计轮询间隔（与 Web 端的 100ms 同量级；统计本身比本地分析贵，取 150ms） */
        const val POLL_MS = 150L
    }
}
