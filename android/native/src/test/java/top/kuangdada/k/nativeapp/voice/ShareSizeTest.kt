package top.kuangdada.k.nativeapp.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * 信令里的"共享者声明的采集尺寸"如何收成 State 用的 [Pair]（[shareSizeOf]）。
 *
 * 为什么单测：这个判断错了**不会报错** —— 缺一边、或 0/负数被放进比例里，
 * 表现是"画面框被压成一条线"或"比例永远是 16:9"，真机上极难定位。
 * 语义与缺省行为见 `VoiceParticipantDto.width`（唯一事实来源：shared/src/types.ts 的
 * `VoiceParticipant.width`）：**缺任一 / 非正数 = 未声明**，与老客户端不发这两个字段同一条路径。
 */
class ShareSizeTest {

    @Test
    fun `两个正整数才成对采纳`() {
        assertEquals(1920 to 1200, shareSizeOf(1920, 1200))
    }

    @Test
    fun `缺任一边 = 未声明`() {
        assertNull(shareSizeOf(null, 1200))
        assertNull(shareSizeOf(1920, null))
        assertNull(shareSizeOf(null, null))
    }

    /** 0/负数只可能是字段被写坏：当未声明处理，交给接收探针（不能拿它算比例） */
    @Test
    fun `非正数 = 未声明`() {
        assertNull(shareSizeOf(0, 1200))
        assertNull(shareSizeOf(1920, 0))
        assertNull(shareSizeOf(-1920, 1200))
        assertNull(shareSizeOf(1920, -1200))
    }

    /** 竖屏共享是正常形态（手机 1080x2400），不能被当成非法值丢掉 */
    @Test
    fun `竖屏尺寸照样采纳`() {
        assertEquals(1080 to 2400, shareSizeOf(1080, 2400))
    }
}
