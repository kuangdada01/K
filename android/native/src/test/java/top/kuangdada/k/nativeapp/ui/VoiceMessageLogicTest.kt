package top.kuangdada.k.nativeapp.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ============================================================
 * 语音消息的纯逻辑（波形 / 时长 / 倍速文案）
 * ============================================================
 * 这些计算错了不会崩，只会在真机上表现为"波形全平/全满""时长显示成 0:00"，
 * 很难从日志看出来，所以钉成单测。
 */
class VoiceMessageLogicTest {

    @Test
    fun `波形固定 32 根且都在 12 到 100 之间`() {
        val samples = List(1000) { (it % 32768) }
        val bars = VoiceRecorder.buildWaveform(samples)
        assertEquals(32, bars.size)
        assertTrue(bars.all { it in 12..100 })
    }

    @Test
    fun `静音段也会画出最低柱而不是 0 高`() {
        val bars = VoiceRecorder.buildWaveform(List(500) { 0 })
        assertEquals(32, bars.size)
        assertTrue("静音也应有可见柱子", bars.all { it == 12 })
    }

    @Test
    fun `没有采样时返回等高柱`() {
        val bars = VoiceRecorder.buildWaveform(emptyList())
        assertEquals(List(32) { 12 }, bars)
    }

    @Test
    fun `峰值越大柱子越高`() {
        val quiet = VoiceRecorder.buildWaveform(List(320) { 1_000 })
        val loud = VoiceRecorder.buildWaveform(List(320) { 30_000 })
        assertTrue(loud.max() > quiet.max())
        assertTrue(loud.all { it in 12..100 })
    }

    @Test
    fun `气泡秒数用双撇号`() {
        assertEquals("2″", formatVoiceDurationShort(2_000))
        assertEquals("1″", formatVoiceDurationShort(500))
        assertEquals("60″", formatVoiceDurationShort(60_000))
    }

    @Test
    fun `时长格式为分冒号两位秒`() {
        assertEquals("0:00", formatVoiceDuration(0))
        assertEquals("0:07", formatVoiceDuration(7_000))
        assertEquals("1:05", formatVoiceDuration(65_000))
        assertEquals("0:59", formatVoiceDuration(59_999))
        // 负数（异常输入）也按 0 处理，不出现 "-1:-1"
        assertEquals("0:00", formatVoiceDuration(-500))
    }
}
