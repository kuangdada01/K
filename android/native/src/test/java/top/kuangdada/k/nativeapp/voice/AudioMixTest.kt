package top.kuangdada.k.nativeapp.voice

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ============================================================
 * 混音 / PCM 处理单测
 * ============================================================
 * 录制里最容易出错的就是这几步，而且错了**不会崩、不会报错** ——
 * 只会得到"能播放但声音不对"的文件。所以每条都钉死。
 */
class AudioMixTest {

    // ---------------------------------------------------------------
    // 小端解析（按大端解会得到刺耳噪声，而不是静音，所以更该钉死）
    // ---------------------------------------------------------------

    @Test
    fun `小端 16bit 字节流解析`() {
        // 0x0100 小端 = 字节 [0x00, 0x01] -> 值 256
        val data = byteArrayOf(0x00, 0x01)
        assertArrayEquals(shortArrayOf(256), AudioMix.toShorts(data))
    }

    @Test
    fun `负数样本按小端正确解析（补码）`() {
        // -1 = 0xFFFF -> 小端字节 [0xFF, 0xFF]
        assertArrayEquals(shortArrayOf(-1), AudioMix.toShorts(byteArrayOf(0xFF.toByte(), 0xFF.toByte())))
        // -32768 = 0x8000 -> 小端字节 [0x00, 0x80]
        assertArrayEquals(
            shortArrayOf(Short.MIN_VALUE),
            AudioMix.toShorts(byteArrayOf(0x00, 0x80.toByte())),
        )
    }

    @Test
    fun `奇数长度的字节流丢掉最后一个半样本而不是崩`() {
        val data = byteArrayOf(0x10, 0x00, 0x20)
        assertArrayEquals(shortArrayOf(16), AudioMix.toShorts(data))
    }

    @Test
    fun `空输入返回空数组`() {
        assertEquals(0, AudioMix.toShorts(ByteArray(0)).size)
    }

    // ---------------------------------------------------------------
    // 限幅（溢出回绕会把响亮的峰值变成反相暴音）
    // ---------------------------------------------------------------

    @Test
    fun `正溢出饱和到 32767 而不是回绕成负数`() {
        assertEquals(Short.MAX_VALUE, AudioMix.saturate(40_000))
        // 回绕的错误实现会得到 -25536 这种负数 —— 听感是刺耳的暴音
        assertTrue(AudioMix.saturate(40_000) > 0)
    }

    @Test
    fun `负溢出饱和到 -32768`() {
        assertEquals(Short.MIN_VALUE, AudioMix.saturate(-40_000))
    }

    @Test
    fun `量程内的值原样保留`() {
        assertEquals(0, AudioMix.saturate(0).toInt())
        assertEquals(12_345, AudioMix.saturate(12_345).toInt())
        assertEquals(-12_345, AudioMix.saturate(-12_345).toInt())
    }

    // ---------------------------------------------------------------
    // 混音
    // ---------------------------------------------------------------

    @Test
    fun `两路相加`() {
        val mixed = AudioMix.mix(shortArrayOf(100, -100, 0), shortArrayOf(50, 50, 50), selfMuted = false)
        assertArrayEquals(shortArrayOf(150, -50, 50), mixed)
    }

    @Test
    fun `闭麦时自己的声音不进混音`() {
        val mixed = AudioMix.mix(shortArrayOf(100, -100), shortArrayOf(9999, 9999), selfMuted = true)
        // 只剩远端那一路 —— 这正是"闭麦了却录到自己"那个 bug 的反面
        assertArrayEquals(shortArrayOf(100, -100), mixed)
    }

    @Test
    fun `两路长度不同时短的那路按静音补齐`() {
        val mixed = AudioMix.mix(shortArrayOf(10, 20, 30), shortArrayOf(1), selfMuted = false)
        assertArrayEquals(shortArrayOf(11, 20, 30), mixed)
    }

    @Test
    fun `混音不会溢出回绕`() {
        val loud = ShortArray(4) { Short.MAX_VALUE }
        val mixed = AudioMix.mix(loud, loud, selfMuted = false)
        mixed.forEach { assertEquals(Short.MAX_VALUE, it) }
        assertTrue(AudioMix.wouldClip(loud, loud))
    }

    @Test
    fun `两路都是空时输出空`() {
        assertEquals(0, AudioMix.mix(ShortArray(0), ShortArray(0), selfMuted = false).size)
    }

    @Test
    fun `不削顶时 wouldClip 为 false`() {
        assertFalse(AudioMix.wouldClip(shortArrayOf(100), shortArrayOf(200)))
    }

    // ---------------------------------------------------------------
    // 时间轴取样（越界必须返回静音，不能重复上一段）
    // ---------------------------------------------------------------

    @Test
    fun `缓冲范围内的取样`() {
        val buf = shortArrayOf(11, 22, 33)
        assertEquals(11, AudioMix.sampleAt(buf, startSample = 100, end = 3, pos = 100))
        assertEquals(33, AudioMix.sampleAt(buf, startSample = 100, end = 3, pos = 102))
    }

    @Test
    fun `早于缓冲起点的位置返回静音`() {
        val buf = shortArrayOf(11, 22, 33)
        assertEquals(0, AudioMix.sampleAt(buf, startSample = 100, end = 3, pos = 99))
    }

    @Test
    fun `晚于缓冲终点的位置返回静音（不能重复上一段，否则会听到拖尾）`() {
        val buf = shortArrayOf(11, 22, 33)
        assertEquals(0, AudioMix.sampleAt(buf, startSample = 100, end = 3, pos = 103))
        assertEquals(0, AudioMix.sampleAt(buf, startSample = 100, end = 3, pos = 9999))
    }
}
