package top.kuangdada.k.nativeapp.voice

import org.webrtc.RtpParameters
import org.webrtc.RtpSender

/**
 * ============================================================
 * 屏幕共享 · 发送端参数调优（对齐 Web 端 voice/share/senderTuning.ts）
 * ============================================================
 * **为什么需要这个文件**：安卓端共享原来**完全没设**任何编码参数，于是全用 WebRTC 默认值，
 * 而默认的 `degradationPreference` 是 `BALANCED` —— 带宽一紧就**降分辨率保帧率**，
 * 屏幕上的文字/代码立刻糊成一团。用户实测反馈：「投屏接收的画面很糊，看看能不能提高」。
 *
 * Web 端一直有一套明确的调优（`SHARE_QUALITY_PRESETS` + `applyShareQualityToSender`），
 * 本文件是它在安卓侧的对应实现，取值与理由逐条对齐，但**按手机的实际场景调整**：
 *
 *  · **降级策略用 `MAINTAIN_RESOLUTION`（关键的一条）**：全屏共享手机桌面/文档时，
 *    "文字看得清"远比"画面流畅"重要 —— 带宽不足时宁可掉到 10fps，也不要把它缩成 480p。
 *    Web 端的「清晰文字」模式用的正是这一档。
 *  · **码率上限 [SHARE_MAX_BITRATE_BPS]**：默认上限下 1080p+ 的屏幕内容严重不够用，
 *    编码器只能缩分辨率。Web 端 1080p30 给 10Mbps、720p30 给 6Mbps；
 *    手机这一侧取 6Mbps（手机共享以文字/UI 为主，且 mesh 上行要按观看人数翻倍）。
 *  · **采集分辨率封顶 [MAX_CAPTURE_LONG_EDGE]**：见 [captureSizeFor]。
 *
 * 做成纯函数（不依赖会话状态）是为了能被单测直接钉住 —— 与 Web 端把它从
 * VoiceSession 里摘出来单独成模块是同一个理由：这几个数是"画面糊不糊"的第一现场。
 */

/**
 * 共享视频的码率上限（bps）。
 *
 * **30M，与 Web 端 `SHARE_QUALITY_PRESETS['1080p60'].maxBitrate` 完全对齐**
 * （用户要求"带宽一样给 30mbps"）。此前的 6M 是按 720p30 档取的，配不上 1080p60 ——
 * 码率不够时编码器只能靠降分辨率糊过去，等于白提帧率。
 *
 * 这是**上限**而非固定值：实际发送码率由拥塞控制按可用带宽自适应（0 ~ 上限），
 * 所以给足上限不会浪费带宽，只是"带宽够时能到多少"的天花板。
 * mesh 拓扑下共享者上行 = 观看人数 × 实际码率，人多时拥塞控制会自动压低。
 */
const val SHARE_MAX_BITRATE_BPS = 30_000_000

/**
 * 采集分辨率的长边上限（px）。
 *
 * 1920 = 1080p 的长边（配合 [SHARE_CAPTURE_FPS] 的 60fps，即 1080p60）。
 * 手机屏幕的长边（竖屏时是高）超过 1920 时按比例压到这个值。
 */
const val MAX_CAPTURE_LONG_EDGE = 1920

/**
 * 屏幕采集帧率（首选值）。
 *
 * 60 = 用户明确要求（1080p60）。**但 60fps 是"尽力而为"**：
 * 手机编码器吞吐不够时（尤其屏幕内容变化剧烈时）实际只有 30 上下，
 * 那种情况下会由 [shouldDowngradeTo30] 判定并**自动退到 30**，
 * 而不是硬撑着掉帧 —— 与 Web 端 `shareStatsMonitor` 的自动纠偏同一套规则。
 */
const val SHARE_CAPTURE_FPS = 60

/** 自动纠偏后的帧率：60 达不到时退到这一档（仍是流畅的观感） */
const val SHARE_FALLBACK_FPS = 30

/**
 * 自动纠偏判据（对齐 Web 端 `shareStatsMonitor`）：
 * **实际编码帧率掉到 45 以下，且受限原因是 cpu/other** → 说明是编码器吞吐不够
 * （而不是带宽），这时降帧率才是对的解法。
 *
 * 为什么门槛是 45 而不是 60：编码器帧率天然有波动，按 60 判会一直误触发；
 * 45 是"明显没到 60"的分界，也是 Web 端用的值。
 *
 * 为什么要求 "cpu/other"：若受限原因是 `bandwidth`，降帧率并不能提高清晰度，
 * 该做的是让码率自适应（见 [SHARE_MAX_BITRATE_BPS]），不该动帧率。
 */
internal fun shouldDowngradeTo30(fps: Double, limitationReason: String?): Boolean {
    if (fps <= 0.0 || fps >= 45.0) return false
    val reason = limitationReason?.lowercase()
    return reason == "cpu" || reason == "other"
}

/**
 * 计算屏幕采集的分辨率：**保持宽高比**，把长边压到不超过 [maxLongEdge]。
 *
 * 抽成纯函数是因为这段换算有坑：竖屏手机的物理分辨率是 1440×3168（长边是**高**），
 * 只压宽或只压高都会把画面压变形。竖屏要保持竖屏比例。
 *
 * 输入非法（0 或负数）时回落到 [fallback] —— 采集尺寸为 0 会让 `startCapture` 静默失败
 * （表现为对方黑屏，且没有任何异常）。
 */
internal fun captureSizeFor(
    widthPx: Int,
    heightPx: Int,
    maxLongEdge: Int = MAX_CAPTURE_LONG_EDGE,
    fallback: Pair<Int, Int> = 1280 to 720,
): Pair<Int, Int> {
    if (widthPx <= 0 || heightPx <= 0) return fallback
    val longest = maxOf(widthPx, heightPx)
    if (longest <= maxLongEdge) return widthPx to heightPx
    val ratio = maxLongEdge.toDouble() / longest
    // 至少 1px：极端比例也不能算出 0（0 会被 startCapture 当成非法尺寸）
    val w = maxOf(1, Math.round(widthPx * ratio).toInt())
    val h = maxOf(1, Math.round(heightPx * ratio).toInt())
    return w to h
}

/**
 * 把共享画面的编码参数应用到某个发送器上。
 *
 * 三个参数各自的理由：
 *  1. `maxBitrateBps` —— 见 [SHARE_MAX_BITRATE_BPS]；
 *  2. `degradationPreference = MAINTAIN_RESOLUTION` —— **这是"变清晰"的主要一步**；
 *  3. `scaleResolutionDownBy = 1.0` —— 显式声明"按采集分辨率编"，不额外下采样。
 *
 * 失败一律 `runCatching` 忽略：这些是**优化参数**，某个机型/编码器不支持时应当退回
 * WebRTC 默认继续共享，而不是把共享整个搞挂。
 *
 * **回读校验 + 留痕**：设完立刻把 `getParameters()` 再读一遍并打日志。
 * 光看"我调了 setParameters"说明不了问题 —— 有的机型/编码器会拒绝或改写这些值，
 * 而拒绝是**静默**的。回读是唯一能区分"没设上"与"设上了但没效果"的证据。
 */
internal fun applyShareSenderTuning(sender: RtpSender, logTag: String? = null, maxFps: Int? = null): Boolean {
    return runCatching {
        val params = sender.parameters ?: return false
        val encodings = params.encodings
        if (encodings.isNullOrEmpty()) return false
        encodings.forEach { enc ->
            enc.maxBitrateBps = SHARE_MAX_BITRATE_BPS
            enc.scaleResolutionDownBy = 1.0
            // 帧率上限：不设的话编码器不一定会按采集帧率编（默认可能被压到 30 以下）。
            // 自动纠偏时用 [SHARE_FALLBACK_FPS] 再调一次即可改小。
            if (maxFps != null) enc.maxFramerate = maxFps
        }
        params.degradationPreference = RtpParameters.DegradationPreference.MAINTAIN_RESOLUTION
        val ok = sender.setParameters(params)
        if (logTag != null) {
            // 回读：确认这几个值真的被接受了（否则说明被底层改写/忽略）
            val back = runCatching { sender.parameters }.getOrNull()
            val e0 = back?.encodings?.firstOrNull()
            android.util.Log.i(
                logTag,
                "共享发送参数 setParameters=$ok 回读：maxBitrate=${e0?.maxBitrateBps} " +
                    "maxFps=${e0?.maxFramerate} scale=${e0?.scaleResolutionDownBy} " +
                    "degradation=${back?.degradationPreference}"
            )
        }
        ok
    }.getOrDefault(false)
}
