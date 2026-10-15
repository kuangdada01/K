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
 * 本文件是它在安卓侧的对应实现，档位键/码率/帧率逐条对齐，但**按手机的实际场景调整**：
 *
 *  · **降级策略统一用 `MAINTAIN_RESOLUTION`（关键的一条，与 Web 档位的差异点）**：
 *    全屏共享手机桌面/文档时，"文字看得清"远比"画面流畅"重要 —— 带宽不足时宁可掉帧，
 *    也不要把它缩成 480p。Web 端的「清晰文字」模式用的正是这一档；手机侧没有那个开关。
 *  · **三档可切换（[ShareQuality]，2026-10-15 用户要求"手机投屏要有画质帧率选择"）**：
 *    极清 1080p60 / 流畅 1080p30 / 省流 720p30，码率 30M/10M/6M
 *    （与 Web 端 `SHARE_QUALITY_PRESETS` 同值；mesh 上行 = 观看数 × 码率，人多建议降档）。
 *  · **采集分辨率封顶 [MAX_CAPTURE_LONG_EDGE]**：见 [captureSizeFor]。
 *
 * 做成纯函数（不依赖会话状态）是为了能被单测直接钉住 —— 与 Web 端把它从
 * VoiceSession 里摘出来单独成模块是同一个理由：这几个数是"画面糊不糊"的第一现场。
 */

/**
 * 屏幕共享质量档位（画质 + 帧率三档，键与取值对齐 Web 端 `SHARE_QUALITY_PRESETS`）。
 *
 * 用户需求（2026-10-15）："手机投屏没有选择画质帧率" —— 手机侧原来写死 1080p60，
 * 网络差/观看人数多时无法降档；现在共享面板里可直接切换，选择会记忆（[ShareQualityStore]）。
 *
 * @property id 持久化键（与 Web 的档位键同名，排查时两端能对上号）
 * @property label 面板里的中文名（与 Web 端 QUALITY_LABELS 同一套：极清/流畅/省流）
 * @property maxBitrateBps 编码码率上限；**上限而非固定值**，实际发送码率由拥塞控制自适应
 * @property maxFps 编码帧率上限（采集固定 60，见 [SHARE_CAPTURE_FPS]）
 * @property scale 编码器下采样倍率（省流档 1.5：长边 1920 → 1280）
 */
enum class ShareQuality(
    val id: String,
    val label: String,
    val maxBitrateBps: Int,
    val maxFps: Int,
    val scale: Double,
) {
    /** 极清：1080p60（30M 上限对齐 Web —— 用户要求"带宽一样给 30mbps"） */
    V1080P60("1080p60", "极清 1080p60", 30_000_000, 60, 1.0),

    /** 流畅：1080p30（10M —— Web 实测高动态内容 8M 仍偏紧，提到 10M 的同款取值） */
    V1080P30("1080p30", "流畅 1080p30", 10_000_000, 30, 1.0),

    /** 省流：720p30（6M + 1.5 倍下采样；弱网/观看人数多时用） */
    V720P30("720p30", "省流 720p30", 6_000_000, 30, 1.5),
    ;

    companion object {
        /** 默认档：1080p60（手机侧一直以来的默认，用户此前明确要求过 1080p60） */
        val DEFAULT = V1080P60

        /**
         * 从持久化键读回；非法/缺失回落 [DEFAULT]。
         * 与 Web 端 `setShareQuality` 的"非法档位忽略"同一口径（那边保留旧值，这里回落默认）。
         */
        fun fromId(id: String?): ShareQuality = entries.firstOrNull { it.id == id } ?: DEFAULT
    }
}

/**
 * 采集分辨率的长边上限（px）。
 *
 * 1920 = 1080p 的长边。档位里的"720p"是**编码侧**下采样（[ShareQuality.scale] = 1.5），
 * 采集仍按 1920 长边走 —— 屏幕采集器不支持共享中途改格式，编码侧下采样是三档
 * **共用同一路采集、随时可切换**的原因。
 */
const val MAX_CAPTURE_LONG_EDGE = 1920

/**
 * 屏幕采集帧率（**固定** 60；编码帧率上限由档位决定，见 [ShareQuality.maxFps]）。
 *
 * 为什么采集不跟档位联动：`ScreenCapturerAndroid` 不支持共享中途改采集格式
 * （`changeCaptureFormat` 是基类空实现），编码侧的 `maxFramerate` 才是随时可控的旋钮；
 * 多采的帧在编码入口被丢掉，代价只是少量 CPU（换来"切档即时生效"）。
 */
const val SHARE_CAPTURE_FPS = 60

/**
 * 自动纠偏判据（对齐 Web 端 `shareStatsMonitor`）：
 * **实际编码帧率掉到 45 以下，且受限原因是 cpu/other** → 说明是编码器吞吐不够
 * （而不是带宽），这时降帧率才是对的解法。
 *
 * 为什么门槛是 45 而不是 60：编码器帧率天然有波动，按 60 判会一直误触发；
 * 45 是"明显没到 60"的分界，也是 Web 端用的值。
 *
 * 为什么要求 "cpu/other"：若受限原因是 `bandwidth`，降帧率并不能提高清晰度，
 * 该做的是让码率自适应（见 [ShareQuality] 的码率上限），不该动帧率。
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
 * 把**某一档位**的编码参数应用到某个发送器上。
 *
 * 四个参数各自的理由：
 *  1. `maxBitrateBps` —— 档位码率上限（见 [ShareQuality]）；
 *  2. `maxFramerate` —— 档位帧率上限；不设的话编码器不一定会按采集帧率编
 *     （默认可能被压到 30 以下）。切档时改的就是它（采集固定 60，见 [SHARE_CAPTURE_FPS]）；
 *  3. `scaleResolutionDownBy` —— 档位下采样倍率；
 *  4. `degradationPreference = MAINTAIN_RESOLUTION` —— **这是"变清晰"的主要一步**
 *     （三档统一取它，理由见文件头）。
 *
 * 失败一律 `runCatching` 忽略：这些是**优化参数**，某个机型/编码器不支持时应当退回
 * WebRTC 默认继续共享，而不是把共享整个搞挂。
 *
 * **回读校验 + 留痕**：设完立刻把 `getParameters()` 再读一遍并打日志。
 * 光看"我调了 setParameters"说明不了问题 —— 有的机型/编码器会拒绝或改写这些值，
 * 而拒绝是**静默**的。回读是唯一能区分"没设上"与"设上了但没效果"的证据。
 */
internal fun applyShareSenderTuning(
    sender: RtpSender,
    logTag: String? = null,
    quality: ShareQuality = ShareQuality.DEFAULT,
): Boolean {
    return runCatching {
        val params = sender.parameters ?: return false
        val encodings = params.encodings
        if (encodings.isNullOrEmpty()) return false
        encodings.forEach { enc ->
            enc.maxBitrateBps = quality.maxBitrateBps
            enc.scaleResolutionDownBy = quality.scale
            enc.maxFramerate = quality.maxFps
        }
        params.degradationPreference = RtpParameters.DegradationPreference.MAINTAIN_RESOLUTION
        val ok = sender.setParameters(params)
        if (logTag != null) {
            // 回读：确认这几个值真的被接受了（否则说明被底层改写/忽略）
            val back = runCatching { sender.parameters }.getOrNull()
            val e0 = back?.encodings?.firstOrNull()
            android.util.Log.i(
                logTag,
                "共享发送参数[${quality.id}] setParameters=$ok 回读：maxBitrate=${e0?.maxBitrateBps} " +
                    "maxFps=${e0?.maxFramerate} scale=${e0?.scaleResolutionDownBy} " +
                    "degradation=${back?.degradationPreference}"
            )
        }
        ok
    }.getOrDefault(false)
}
