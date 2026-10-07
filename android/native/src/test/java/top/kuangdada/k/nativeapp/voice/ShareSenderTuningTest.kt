package top.kuangdada.k.nativeapp.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ============================================================
 * 屏幕共享采集尺寸换算单测
 * ============================================================
 * 这段换算有两个"错了也不报错"的坑，所以必须钉住：
 *
 *  1. **竖屏的比例**：手机物理分辨率是 1440×3168，长边是**高**。
 *     只压宽或只压高都会把画面压变形（对方看到的字会被拉长/压扁）。
 *  2. **不能算出 0**：`ScreenCapturerAndroid.startCapture(0, …)` 是**静默失败**
 *     （不抛异常、不报错），表现就是对方**永远黑屏**。极端比例下必须兜到 1。
 */
class ShareSenderTuningTest {

    @Test
    fun `长边不超上限时保持原样`() {
        // 上限是 1920（1080p 的长边，见 MAX_CAPTURE_LONG_EDGE）
        assertEquals(1280 to 720, captureSizeFor(1280, 720))
        assertEquals(1920 to 1080, captureSizeFor(1920, 1080))
    }

    @Test
    fun `竖屏超长时按长边封顶且保持宽高比`() {
        val (w, h) = captureSizeFor(1440, 3168)
        // 长边（高）被压到 1920
        assertEquals(1920, h)
        // 比例保持：1440/3168 == w/1920（允许 1px 取整误差）
        val expectedW = Math.round(1440.0 * 1920 / 3168).toInt()
        assertEquals(expectedW, w)
        assertTrue("缩放后绝不能变成 0（0 会让采集静默失败）", w > 0 && h > 0)
    }

    @Test
    fun `横屏超长时压的是宽`() {
        val (w, h) = captureSizeFor(3840, 2160)
        assertEquals(1920, w)
        assertEquals(1080, h)
    }

    @Test
    fun `非法尺寸回落到兜底值而不是 0`() {
        assertEquals(1280 to 720, captureSizeFor(0, 3168))
        assertEquals(1280 to 720, captureSizeFor(1440, 0))
        assertEquals(1280 to 720, captureSizeFor(-1, -1))
    }

    @Test
    fun `极端窄比例也不会算出 0`() {
        // 10000×1：压长边后高度按比例会是 0.19 → 必须兜到 1
        val (w, h) = captureSizeFor(10000, 1)
        assertEquals(1920, w)
        assertTrue("高度必须 >= 1", h >= 1)
    }

    @Test
    fun `首选帧率是 60，退档是 30`() {
        assertEquals(60, SHARE_CAPTURE_FPS)
        assertEquals(30, SHARE_FALLBACK_FPS)
    }

    @Test
    fun `码率上限与 Web 端 1080p60 档一致（30M）`() {
        // 与 client/src/voice/types.ts 的 SHARE_QUALITY_PRESETS['1080p60'].maxBitrate 对齐
        assertEquals(30_000_000, SHARE_MAX_BITRATE_BPS)
    }

    // ---------------------------------------------------------------
    // 自动纠偏判据（与 Web 端 shareStatsMonitor 同一套规则）
    // ---------------------------------------------------------------

    @Test
    fun `帧率明显没到 60 且是 CPU 受限时判定降档`() {
        assertTrue(shouldDowngradeTo30(38.0, "cpu"))
        assertTrue(shouldDowngradeTo30(30.0, "other"))
    }

    @Test
    fun `帧率达标不动它`() {
        // 60fps 附近有正常波动，不能因为 58 就降档（否则永远在拉锯）
        assertFalse(shouldDowngradeTo30(58.0, "cpu"))
        assertFalse(shouldDowngradeTo30(45.0, "cpu"))
        assertFalse(shouldDowngradeTo30(60.0, null))
    }

    @Test
    fun `带宽受限不降帧率`() {
        // 带宽不足时降帧率提高不了清晰度 —— 该让码率自适应，不该动帧率
        assertFalse(shouldDowngradeTo30(20.0, "bandwidth"))
    }

    @Test
    fun `拿不到数据（0fps 或原因未知）不判定`() {
        // 还没编出帧 / 统计未就绪时不能误触发降档
        assertFalse(shouldDowngradeTo30(0.0, "cpu"))
        assertFalse(shouldDowngradeTo30(30.0, null))
        assertFalse(shouldDowngradeTo30(30.0, "none"))
    }
}
