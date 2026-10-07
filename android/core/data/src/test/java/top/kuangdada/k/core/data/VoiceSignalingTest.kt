package top.kuangdada.k.core.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import top.kuangdada.k.core.data.model.VoiceInbound
import top.kuangdada.k.core.data.model.VoiceOutbound
import top.kuangdada.k.core.data.model.VoiceOutboundType

/**
 * ============================================================
 * 语音信令负载的契约测试（M4）
 * ============================================================
 * 钉住与 Web 版 `client/src/voice/types.ts` 的形状约定。
 *
 * 这组测试的存在理由：**形状写错不会报任何错**。对端（Web 版 mesh）在
 * `data.type` 上做判别，取到 `undefined` 就静默丢弃，于是"发出去了但对方
 * 永远不回 answer"。本机看到的现象只是「ICE 一直不连通」，极易被误判成
 * 网络/NAT 问题（真实踩过：先怀疑了 UDP 被封、又怀疑 STUN/TURN 不可达，
 * 最后才发现是判别字段名从 `type` 写成了 `sdpType`）。
 */
class VoiceSignalingTest {

    private val json = Json

    /** Web 版实际发出的 offer：`{type:'offer', sdp}` */
    private val webOffer = """{"type":"offer","sdp":"v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n"}"""

    /** Web 版实际发出的候选：候选是**嵌套对象** */
    private val webCandidate = """
        {"type":"candidate","candidate":{"candidate":"candidate:1 1 udp 2122260223 192.168.5.4 50000 typ host",
        "sdpMid":"0","sdpMLineIndex":0}}
    """.trimIndent()

    // ---------------- 上行：我们发出去的形状 ----------------

    @Test
    fun `offer 的判别字段是 type 而不是 kind`() {
        val payload = VoiceSignaling.sdp("offer", "v=0")
        assertEquals("offer", (payload["type"] as kotlinx.serialization.json.JsonPrimitive).content)
        // 曾经写成 kind/sdpType，对端取 data.type 得到 undefined 就静默丢弃
        assertNull("不能再用 kind 作为判别字段", payload["kind"])
        assertNull("不能再用 sdpType 作为判别字段", payload["sdpType"])
    }

    @Test
    fun `answer 的判别字段同样只是 type`() {
        val payload = VoiceSignaling.sdp("answer", "v=0")
        assertEquals("answer", (payload["type"] as kotlinx.serialization.json.JsonPrimitive).content)
    }

    @Test
    fun `候选必须是嵌套对象而不是平铺字段`() {
        val payload = VoiceSignaling.candidate("candidate:1 1 udp 1 1.2.3.4 5 typ host", "0", 0)
        assertEquals("candidate", (payload["type"] as kotlinx.serialization.json.JsonPrimitive).content)
        // 平铺形态是错的：Web 版读的是 data.candidate.candidate
        assertNull("顶层不能直接放 candidate 字符串", payload["candidate"] as? kotlinx.serialization.json.JsonPrimitive)
        val nested = payload["candidate"] as? JsonObject
        assertTrue("候选必须是嵌套对象", nested != null)
        assertEquals(
            "candidate:1 1 udp 1 1.2.3.4 5 typ host",
            (nested!!["candidate"] as kotlinx.serialization.json.JsonPrimitive).content,
        )
        assertEquals("0", (nested["sdpMid"] as kotlinx.serialization.json.JsonPrimitive).content)
        assertEquals("0", (nested["sdpMLineIndex"] as kotlinx.serialization.json.JsonPrimitive).content)
    }

    // ---------------- 下行：解析对端发来的形状 ----------------

    @Test
    fun `能解析 Web 版的 offer`() {
        val decoded = VoiceSignaling.decode(json.parseToJsonElement(webOffer) as JsonObject)
        assertTrue(decoded is VoiceSignaling.Payload.Sdp)
        val sdp = decoded as VoiceSignaling.Payload.Sdp
        assertEquals("offer", sdp.type)
        assertTrue(sdp.sdp.startsWith("v=0"))
    }

    @Test
    fun `能解析 Web 版的嵌套候选`() {
        val decoded = VoiceSignaling.decode(json.parseToJsonElement(webCandidate) as JsonObject)
        assertTrue(decoded is VoiceSignaling.Payload.Candidate)
        val candidate = decoded as VoiceSignaling.Payload.Candidate
        assertTrue(candidate.candidate.contains("typ host"))
        assertEquals("0", candidate.sdpMid)
        assertEquals(0, candidate.sdpMLineIndex)
    }

    @Test
    fun `平铺候选也能解析（兼容老客户端）`() {
        val flat = """
            {"type":"candidate","candidate":"candidate:1 1 udp 1 1.2.3.4 5 typ host",
             "sdpMid":"audio","sdpMLineIndex":2}
        """.trimIndent()
        val decoded = VoiceSignaling.decode(json.parseToJsonElement(flat) as JsonObject)
        val candidate = decoded as VoiceSignaling.Payload.Candidate
        assertEquals("audio", candidate.sdpMid)
        assertEquals(2, candidate.sdpMLineIndex)
    }

    @Test
    fun `缺 sdpMid 时退回默认值 0 而不是丢弃整条候选`() {
        val lean = """{"type":"candidate","candidate":{"candidate":"candidate:1 1 udp 1 1.2.3.4 5 typ host"}}"""
        val decoded = VoiceSignaling.decode(json.parseToJsonElement(lean) as JsonObject)
        val candidate = decoded as VoiceSignaling.Payload.Candidate
        assertEquals("0", candidate.sdpMid)
        assertEquals(0, candidate.sdpMLineIndex)
    }

    @Test
    fun `旧的 kind 形状解析不出来——这正是当初对端静默丢弃的原因`() {
        val legacy = """{"kind":"sdp","sdpType":"offer","sdp":"v=0"}"""
        assertNull(VoiceSignaling.decode(json.parseToJsonElement(legacy) as JsonObject))
    }

    @Test
    fun `未知类型返回 null 而不是抛异常`() {
        val unknown = """{"type":"something-else","data":123}"""
        assertNull(VoiceSignaling.decode(json.parseToJsonElement(unknown) as JsonObject))
        assertNull(VoiceSignaling.decode(JsonObject(emptyMap())))
    }

    @Test
    fun `候选缺 candidate 字段返回 null`() {
        val broken = """{"type":"candidate","candidate":{"sdpMid":"0"}}"""
        assertNull(VoiceSignaling.decode(json.parseToJsonElement(broken) as JsonObject))
    }

    // ---------------- 共享者声明的采集尺寸（方案 B：首帧之前就知道画面比例） ----------------

    /**
     * `share-changed` 里的 width/height 必须能解出来（服务端只在 active=true 时带）。
     * 字段语义见 `VoiceParticipantDto.width`（唯一事实来源：shared/src/types.ts）。
     */
    @Test
    fun `能解析 share-changed 里的采集尺寸`() {
        val raw = """{"type":"share-changed","userId":5,"active":true,"audio":false,
            "width":1920,"height":1200}"""
        val msg = KJson.decodeFromString(VoiceInbound.serializer(), raw)
        assertEquals("share-changed", msg.type)
        assertEquals(1920, msg.width)
        assertEquals(1200, msg.height)
    }

    /** 进房时的房间成员信息（joined.participants）同样带这个字段 —— 这是"进房即知比例"的来源 */
    @Test
    fun `能解析 joined 里参与者的采集尺寸`() {
        val raw = """{"type":"joined","participants":[
            {"userId":5,"username":"u5","muted":false,"listener":false,"sharing":true,
             "width":1920,"height":1200},
            {"userId":6,"username":"u6","muted":false,"listener":false,"sharing":false}],
            "self":{"userId":7,"username":"u7"}}"""
        val msg = KJson.decodeFromString(VoiceInbound.serializer(), raw)
        assertEquals(1920, msg.participants[0].width)
        assertEquals(1200, msg.participants[0].height)
        assertTrue(msg.participants[0].sharing)
    }

    /**
     * 老服务端不转这两个字段时必须是 null（而不是 0 或抛异常）：
     * 0 会被当成"声明了 0x0"，让画面框算成 0 —— 观看端只认 null 才回落接收探针。
     */
    @Test
    fun `缺 width height 时为 null（老服务端兼容）`() {
        val raw = """{"type":"share-changed","userId":5,"active":true,"audio":false}"""
        val msg = KJson.decodeFromString(VoiceInbound.serializer(), raw)
        assertNull(msg.width)
        assertNull(msg.height)
        val participantRaw = """{"type":"peer-joined","participant":{"userId":5,"sharing":true}}"""
        val joined = KJson.decodeFromString(VoiceInbound.serializer(), participantRaw)
        assertNull(joined.participant?.width)
        assertNull(joined.participant?.height)
    }

    /** 上行：`share-start` 要真的把采集尺寸发出去（explicitNulls=false，未声明时字段整个不出现） */
    @Test
    fun `share-start 上行带采集尺寸`() {
        val json = KJson.encodeToString(
            VoiceOutbound.serializer(),
            VoiceOutbound(type = VoiceOutboundType.ShareStart, audio = false, width = 1080, height = 2400),
        )
        assertTrue(json.contains("\"width\":1080"))
        assertTrue(json.contains("\"height\":2400"))
        val noSize = KJson.encodeToString(
            VoiceOutbound.serializer(),
            VoiceOutbound(type = VoiceOutboundType.ShareStart, audio = false),
        )
        assertTrue("未声明时不能出现 width 字段：$noSize", !noSize.contains("width"))
    }
}
