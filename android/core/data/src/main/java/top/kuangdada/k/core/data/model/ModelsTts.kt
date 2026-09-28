package top.kuangdada.k.core.data.model

import kotlinx.serialization.Serializable

/**
 * 云端朗读请求体（`POST /api/tts`，见 server/src/routes/tts.ts）。
 *
 * **只发 [voice] 这个音色 key，不发厂商音色 ID**：key → 真实音色 ID 的映射、
 * 以及 StepFun 的 API Key 全部只在服务端。客户端就算被抓包也拿不到密钥。
 *
 * [text] 单次上限 1000 字符（服务端硬校验）；长文由
 * `top.kuangdada.k.core.data.splitSpeakText` 先切段。
 */
@Serializable
data class TtsRequest(
    val text: String,
    /** 音色 key（共享清单里的值，见 `ChatTtsVoices.CHAT_TTS_CLOUD_VOICES`） */
    val voice: String,
)
