package top.kuangdada.k.nativeapp.voice

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 说话检测的门限与迟滞（M6 语音房"说话点亮边框"）。
 *
 * 这几条对应的都是**真机上会被一眼看出来的坏观感**：
 *  · 门限太低 → 底噪也让灯常亮（看起来像坏了）；
 *  · 没有迟滞 → 说话中间换气时灯一闪一闪；
 *  · 闭麦/对端离开不立刻收 → 一个已经走了的人还亮着。
 */
class SpeakingGateTest {

    private val gate = SpeakingGate(threshold = 0.03f, releaseMs = 450L)

    @Test
    fun loud_sample_turns_it_on() {
        assertFalse(gate.isSpeaking)
        assertTrue(gate.update(0.5f, 1_000L))
        assertTrue(gate.isSpeaking)
    }

    /** 底噪（低于门限）永远不亮 */
    @Test
    fun quiet_noise_never_turns_it_on() {
        repeat(20) { i ->
            assertFalse(gate.update(0.02f, 1_000L + i * 150L))
        }
        assertFalse(gate.isSpeaking)
    }

    /** 说话中的短暂换气（一次采样落到门限以下）不该把灯掐掉 —— 这就是迟滞 */
    @Test
    fun short_gap_in_speech_keeps_it_on() {
        gate.update(0.4f, 1_000L)
        assertFalse(gate.update(0.0f, 1_150L))
        assertTrue(gate.isSpeaking)
        assertFalse(gate.update(0.0f, 1_300L))
        assertTrue(gate.isSpeaking)
    }

    /** 超过保持时长没再大声 → 熄灭，而且只翻转一次 */
    @Test
    fun long_silence_turns_it_off_once() {
        gate.update(0.4f, 1_000L)
        assertTrue(gate.isSpeaking)
        assertFalse(gate.update(0.0f, 1_300L))
        assertTrue(gate.update(0.0f, 1_500L))
        assertFalse(gate.isSpeaking)
        // 已经灭了就不再重复上报
        assertFalse(gate.update(0.0f, 2_000L))
    }

    /** 统计缺一轮（null）不该打断保持期，也不该被当成"安静"立刻掐掉 */
    @Test
    fun missing_sample_does_not_break_the_hold() {
        gate.update(0.4f, 1_000L)
        assertFalse(gate.update(null, 1_150L))
        assertTrue(gate.isSpeaking)
        // 但再往后（超过保持期）自然会灭
        assertTrue(gate.update(null, 1_600L))
        assertFalse(gate.isSpeaking)
    }

    /** 闭麦 / 对端离开：立刻收，不等保持期 */
    @Test
    fun reset_turns_it_off_immediately() {
        gate.update(0.4f, 1_000L)
        assertTrue(gate.reset())
        assertFalse(gate.isSpeaking)
        // 已经灭了就不再重复上报
        assertFalse(gate.reset())
        // 复位之后再次大声说话还能亮（不能把 lastLoud 留在未来）
        assertTrue(gate.update(0.4f, 1_050L))
    }
}
