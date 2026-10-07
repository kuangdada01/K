package top.kuangdada.k.core.data.image

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 选图压缩判据单测（纯函数）。
 *
 * 为什么值得钉死：这条判据决定"哪些图会被重编码"。压太少 → 9 张相机原图仍以全尺寸进 WebView
 * （历史上大文件上传闪退就出在这段 JS 堆）；压太多 → 小图被无意义地掉一次画质。
 */
class ImageCompressorTest {

    @Test
    fun `小图不压（重编码只会掉画质）`() {
        assertFalse(ImageCompressor.needsCompressionFor(800, 600, 200_000L))
        assertFalse(ImageCompressor.needsCompressionFor(1080, 1920, 1_000_000L))
    }

    @Test
    fun `长边超过 2560 才压（宽或高任一）`() {
        assertTrue(ImageCompressor.needsCompressionFor(2561, 100, 1_000L))
        assertTrue(ImageCompressor.needsCompressionFor(100, 2561, 1_000L))
        // 正好 2560 不压（边界是"大于"）
        assertFalse(ImageCompressor.needsCompressionFor(2560, 2560, 1_000L))
    }

    @Test
    fun `体积超过 1_5MB 才压（即使尺寸不大）`() {
        assertTrue(ImageCompressor.needsCompressionFor(1000, 1000, 1_500_001L))
        assertFalse(ImageCompressor.needsCompressionFor(1000, 1000, 1_500_000L))
    }

    @Test
    fun `典型相机原图（4000x3000 数 MB）必须压`() {
        assertTrue(ImageCompressor.needsCompressionFor(4000, 3000, 4_200_000L))
    }

    @Test
    fun `解不出尺寸（0x0）但体积大 → 仍压`() {
        assertTrue(ImageCompressor.needsCompressionFor(0, 0, 3_000_000L))
    }

    @Test
    fun `解不出尺寸且体积未知（0）→ 不压（失败就回退原图，不误伤）`() {
        assertFalse(ImageCompressor.needsCompressionFor(0, 0, 0L))
    }

    // ------------------------------------------------------------------
    // 目标尺寸（真机日志：2700x1519 被"原尺寸重编码"，结果反而更大）
    // ------------------------------------------------------------------

    @Test
    fun `刚过阈值一点也要缩到正好 2560（不能只靠 2 的幂采样）`() {
        assertEquals(2560 to 1440, ImageCompressor.scaledSizeFor(2700, 1519))
    }

    @Test
    fun `阈值内原样返回`() {
        assertEquals(2560 to 1440, ImageCompressor.scaledSizeFor(2560, 1440))
        assertEquals(800 to 600, ImageCompressor.scaledSizeFor(800, 600))
    }

    @Test
    fun `竖图按高缩，比例不丢`() {
        assertEquals(1280 to 2560, ImageCompressor.scaledSizeFor(2500, 5000))
    }

    @Test
    fun `极端比例也不会缩成 0`() {
        val (width, height) = ImageCompressor.scaledSizeFor(10000, 3)
        assertEquals(2560, width)
        assertEquals(1, height)
    }

    @Test
    fun `尺寸为 0 时不缩（交给调用方的兜底）`() {
        assertEquals(0 to 0, ImageCompressor.scaledSizeFor(0, 0))
    }

    // ------------------------------------------------------------------
    // 负优化守卫
    // ------------------------------------------------------------------

    @Test
    fun `压完更大就丢掉结果（真机实测 295198B 到 342768B）`() {
        assertFalse(ImageCompressor.smallerThanOriginal(295_198L, 342_768L))
    }

    @Test
    fun `真的更小才采用`() {
        assertTrue(ImageCompressor.smallerThanOriginal(4_200_000L, 900_000L))
    }

    @Test
    fun `一样大也不采用（白掉一次画质没意义）`() {
        assertFalse(ImageCompressor.smallerThanOriginal(1_000L, 1_000L))
    }

    @Test
    fun `空输出视为编码失败，不采用`() {
        assertFalse(ImageCompressor.smallerThanOriginal(1_000L, 0L))
    }
}
