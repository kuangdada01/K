package top.kuangdada.k.core.data

/**
 * ============================================================
 * 聊天朗读音色（**镜像 `shared/src/constants/tts.ts`**）
 * ============================================================
 * 事实来源是 shared 那份，这里逐字镜像。为什么不能直接引：`@k/shared` 是 TypeScript
 * npm 包，安卓侧是 Gradle/Kotlin 模块，工程里**没有** TS→Kotlin 的代码生成步骤
 * （同样的先例：`VOICE_MAX_ROOM_SIZE`、`CHAT_MAX_CHARS`）。
 *
 * ★ **改 shared/src/constants/tts.ts 必须同步改这里**，数值/字符串逐字相同：
 *   · 新增云端音色 → [CHAT_TTS_CLOUD_VOICES] 加一项（服务端会按 key 白名单映射到厂商音色 ID，
 *     前端只发 key，**厂商音色 ID 与 API Key 都不在客户端**）
 *   · 上限变了 → [CHAT_TTS_MAX_CHARS] / [CHAT_TTS_CHUNK_CHARS] 跟着改
 *   单测 `ChatTtsVoicesTest` 钉住了这几个值与分段算法的口径。
 */

/** 系统语音（设备自带 TTS 引擎）的固定 key：零成本、无需联网 */
const val CHAT_TTS_SYSTEM_VOICE_KEY = "system"

/**
 * 单次请求文本上限（字符）。服务端硬校验（`server/src/routes/tts.ts`）：
 * 上游 StepFun 单次上限 1000 字符，超了回 400。
 */
const val CHAT_TTS_MAX_CHARS = 1000

/** 前端分段上限：低于服务端上限，给分段拼接处的标点留余量（对齐 Web 端 TTS_CHUNK_CHARS） */
const val CHAT_TTS_CHUNK_CHARS = 900

/** 一个云端音色：[key] 是前后端约定的标识，[label] 是下拉里显示的名字 */
data class ChatTtsVoice(val key: String, val label: String)

/** 云端音色清单（下拉顺序即此顺序；与 shared 的 `TTS_CLOUD_VOICES` 一一对应） */
val CHAT_TTS_CLOUD_VOICES: List<ChatTtsVoice> = listOf(
    ChatTtsVoice(key = "dengziqi", label = "邓紫棋"),
)

/** key 是否在允许清单内（系统 + 云端），与 Web 端 `isKnownVoice` 同口径 */
fun isKnownChatTtsVoice(key: String): Boolean =
    key == CHAT_TTS_SYSTEM_VOICE_KEY || CHAT_TTS_CLOUD_VOICES.any { it.key == key }

/** 音色 key → 下拉里显示的名字（未知 key 回落为系统语音名，与 Web 端解析失败一律回落同口径） */
fun chatTtsVoiceLabel(key: String): String = when {
    key == CHAT_TTS_SYSTEM_VOICE_KEY -> "系统语音"
    else -> CHAT_TTS_CLOUD_VOICES.firstOrNull { it.key == key }?.label ?: "系统语音"
}

/** 空白归一（`\s+` → 单个空格）—— 分段前先做，避免把换行/连续空格算进长度 */
private val CHAT_TTS_BLANK_RE = Regex("\\s+")

/**
 * 句子切分：`正文 + 跟随的终止标点`。
 *
 * ⚠️ 与 Web 端 `splitSpeakText` 用**同一个正则** —— 那边写的是
 * `[^。！？!?；;.换行]+` 后面跟 `[。！？!?；;.]` 的零次或多次（全局匹配），
 * 见 `shared` 那份的 `CHAT_TTS_SENTENCE_RE`。Web 端刻意**不用后行断言**
 * （`(?<=[。！？])` 要 Safari 16.4+，老 iOS 微信 WebView 会解析期崩）；
 * 这里照抄同一写法，保证两端切段结果逐字一致。
 */
private val CHAT_TTS_SENTENCE_RE = Regex("[^。！？!?；;.\\n]+[。！？!?；;.]*")

/**
 * 长文切段（镜像 Web 端 `splitSpeakText`，逐句对齐）：
 *  1. 空白归一 + trim；空串 → 空列表（调用方据此直接返回，不发请求）
 *  2. 按句切开，**短句合并**到一段（省额度也少一次 RTT），每段不超过 [CHAT_TTS_CHUNK_CHARS]
 *  3. 单句本身就超限（整段无标点的长文）→ 硬切，保证单次请求不超过 [CHAT_TTS_MAX_CHARS]
 */
fun splitSpeakText(text: String): List<String> {
    val normalized = text.replace(CHAT_TTS_BLANK_RE, " ").trim()
    if (normalized.isEmpty()) return emptyList()

    val parts = CHAT_TTS_SENTENCE_RE.findAll(normalized)
        .map { it.value.trim() }
        .filter { it.isNotEmpty() }
        .toList()
        .ifEmpty { listOf(normalized) }

    val chunks = mutableListOf<String>()
    var cur = ""
    for (p in parts) {
        if (cur.isNotEmpty() && cur.length + p.length > CHAT_TTS_CHUNK_CHARS) {
            chunks += cur
            cur = p
        } else {
            cur += p
        }
    }
    if (cur.isNotEmpty()) chunks += cur

    return chunks.flatMap { c ->
        if (c.length > CHAT_TTS_MAX_CHARS) {
            c.chunked(CHAT_TTS_CHUNK_CHARS)
        } else {
            listOf(c)
        }
    }
}
