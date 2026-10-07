package top.kuangdada.k.core.data

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * ============================================================
 * 语音信令负载的编解码（与 Web 版 `client/src/voice/types.ts` 逐字段对齐）
 * ============================================================
 * Web 版的 `VoiceSignalPayload`：
 * ```ts
 * | { type: 'offer';     sdp: string }
 * | { type: 'answer';    sdp: string }
 * | { type: 'candidate'; candidate: RTCIceCandidateInit }
 * ```
 * 其中 `RTCIceCandidateInit` 就是 `{ candidate, sdpMid, sdpMLineIndex }`。
 *
 * **为什么单独抽出来并有单测**：这里的形状约定错一个字都不会报错 ——
 * 对端在 `data.type` 上做判别，取到 `undefined` 就**静默丢弃**。曾因为这个
 * 用 `{kind:'sdp', sdpType:'offer'}` 发 offer，结果对端永不回 answer，
 * 本机表现为「本地候选收集齐全、远端候选 0 条、ICE 一直不连通」，
 * 从本端日志完全看不出是格式问题（M4 真机排查，靠抓包级日志才定位到）。
 * 所以这条契约必须由测试钉住，不能只写在注释里。
 */
object VoiceSignaling {

    /** 解码后的信令 */
    sealed interface Payload {
        data class Sdp(val type: String, val sdp: String) : Payload
        data class Candidate(val candidate: String, val sdpMid: String, val sdpMLineIndex: Int) : Payload
    }

    /**
     * 解析对端发来的信令负载。
     *
     * 候选同时接受**嵌套**（Web 版）与**平铺**两种形态：服务端对 `data` 原样转发、
     * 不作校验，宽松一点不会让自己这边因为对端版本差异而连不上。
     */
    fun decode(data: JsonObject): Payload? {
        val type = (data["type"] as? JsonPrimitive)?.contentOrNull ?: return null
        return when (type) {
            "offer", "answer" -> {
                val sdp = (data["sdp"] as? JsonPrimitive)?.contentOrNull ?: return null
                Payload.Sdp(type, sdp)
            }
            "candidate" -> {
                val nested = data["candidate"] as? JsonObject
                val candidate = (nested?.get("candidate") as? JsonPrimitive)?.contentOrNull
                    ?: (data["candidate"] as? JsonPrimitive)?.contentOrNull
                    ?: return null
                val mid = ((nested?.get("sdpMid") ?: data["sdpMid"]) as? JsonPrimitive)?.contentOrNull ?: "0"
                val index = ((nested?.get("sdpMLineIndex") ?: data["sdpMLineIndex"]) as? JsonPrimitive)
                    ?.contentOrNull?.toIntOrNull() ?: 0
                Payload.Candidate(candidate, mid, index)
            }
            else -> null
        }
    }

    /** offer / answer 的上行负载 */
    fun sdp(type: String, sdp: String): JsonObject = JsonObject(
        mapOf(
            "type" to JsonPrimitive(type),
            "sdp" to JsonPrimitive(sdp),
        )
    )

    /** ICE 候选的上行负载（嵌套形态，与 Web 版一致） */
    fun candidate(candidate: String, sdpMid: String, sdpMLineIndex: Int): JsonObject = JsonObject(
        mapOf(
            "type" to JsonPrimitive("candidate"),
            "candidate" to JsonObject(
                mapOf(
                    "candidate" to JsonPrimitive(candidate),
                    "sdpMid" to JsonPrimitive(sdpMid),
                    "sdpMLineIndex" to JsonPrimitive(sdpMLineIndex),
                )
            ),
        )
    )
}
