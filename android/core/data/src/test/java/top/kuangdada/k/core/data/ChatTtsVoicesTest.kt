package top.kuangdada.k.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ============================================================
 * 聊天朗读音色 · 纯逻辑单测（镜像 `useChatTTS.test.tsx` 的分段用例）
 * ============================================================
 * 这组用例的存在理由（对手工镜像而言，单测就是唯一的护栏）：
 *  · 分段写错**不会报任何错** —— 切太长：服务端回 400「单次最多 1000 字符」，
 *    用户听到的是"点了没反应"；切太碎：一段话被拆成几十次请求，白花额度、段间还卡顿。
 *  · 音色清单/上限是**跨端手工镜像**的（没有代码生成），值写错了编译器不会拦 ——
 *    所以这里把与 `shared/src/constants/tts.ts` 逐字相同的值钉死。
 */
class ChatTtsVoicesTest {

    @Test
    fun `镜像常量与 shared 逐字相同`() {
        // 改 shared/src/constants/tts.ts 时这几个断言会立刻红 —— 那正是提醒"安卓侧也要改"
        assertEquals("system", CHAT_TTS_SYSTEM_VOICE_KEY)
        assertEquals(1000, CHAT_TTS_MAX_CHARS)
        assertEquals(900, CHAT_TTS_CHUNK_CHARS)
        assertEquals(1, CHAT_TTS_CLOUD_VOICES.size)
        assertEquals("dengziqi", CHAT_TTS_CLOUD_VOICES[0].key)
        assertEquals("邓紫棋", CHAT_TTS_CLOUD_VOICES[0].label)
    }

    @Test
    fun `音色 key 白名单与显示名`() {
        assertTrue(isKnownChatTtsVoice(CHAT_TTS_SYSTEM_VOICE_KEY))
        assertTrue(isKnownChatTtsVoice("dengziqi"))
        assertFalse(isKnownChatTtsVoice("nope"))
        assertFalse(isKnownChatTtsVoice(""))
        assertEquals("系统语音", chatTtsVoiceLabel(CHAT_TTS_SYSTEM_VOICE_KEY))
        assertEquals("邓紫棋", chatTtsVoiceLabel("dengziqi"))
        // 未知 key 一律回落系统语音（与 Web 端解析失败即回落同口径，不让脏数据把朗读打哑）
        assertEquals("系统语音", chatTtsVoiceLabel("nope"))
    }

    @Test
    fun `短句合并成一段、空串返回空`() {
        // 短句不逐句请求（省额度也少一次 RTT）：合并到一段里
        assertEquals(listOf("你好。世界！"), splitSpeakText("你好。世界！"))
        assertEquals(emptyList<String>(), splitSpeakText(""))
        assertEquals(emptyList<String>(), splitSpeakText("   "))
    }

    @Test
    fun `超长按句切开，段长不超分段上限`() {
        val sentences = "甲".repeat(600) + "。" + "乙".repeat(600) + "。"
        assertEquals(
            listOf("甲".repeat(600) + "。", "乙".repeat(600) + "。"),
            splitSpeakText(sentences),
        )
    }

    @Test
    fun `整段无标点的长文硬切且拼回来与原文一致`() {
        val long = "甲".repeat(2500)
        val chunks = splitSpeakText(long)
        assertTrue("应切成多段", chunks.size > 1)
        assertTrue("每段不得超过服务端上限", chunks.all { it.length <= CHAT_TTS_MAX_CHARS })
        assertEquals(long, chunks.joinToString(""))
    }

    @Test
    fun `换行与连续空白先归一（不把空白算进长度，也不作为句子内容）`() {
        // 逐句 trim 后拼接：句子之间的空白被丢掉（与 Web 端 `cur += p` 完全同口径）
        assertEquals(listOf("第一句。第二句。"), splitSpeakText("第一句。\n\n第二句。"))
        assertEquals(listOf("a b"), splitSpeakText("  a   b  "))
    }

    @Test
    fun `只有标点的文本不丢内容`() {
        // Web 端同口径：正则匹配不到就整串当一段（`?? [normalized]`）
        assertEquals(listOf("。。。"), splitSpeakText("。。。"))
    }
}
