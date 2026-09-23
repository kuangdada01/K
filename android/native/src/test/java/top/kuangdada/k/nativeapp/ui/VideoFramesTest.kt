package top.kuangdada.k.nativeapp.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 发布页"选封面"里两处**纯计算**（M6.6）。
 *
 * 抽帧本身要真机（`MediaMetadataRetriever` 解不了 JVM 里的假文件），
 * 但这两处最容易写错、又完全与设备无关，所以单独钉住：
 *  · [frameTimesMs]：帧条上每个缩略图抽哪一毫秒 —— 取到 `duration` 本身会拿到空位图；
 *  · [formatClock]：设计稿左下角那个「0:42」（**定义在 `VideoPlayer.kt`，全工程共用一个**）。
 *    这一条是补出来的教训：本轮我先在 `VideoFrames.kt` 里又写了一份同名函数，
 *    结果调用点与测试都静默解析到旧的那个（两个重载，Kotlin 选更具体的一个）——
 *    所以现在**只留一份**，并在这里把它钉住。
 */
class VideoFramesTest {

    @Test
    fun clock_formats_minutes_and_seconds() {
        assertEquals("0:42", formatClock(42_000L))
        assertEquals("0:05", formatClock(5_000L))
        assertEquals("1:00", formatClock(60_000L))
        assertEquals("59:59", formatClock(3_599_000L))
        // 不足一秒**截断**成 0（播放器惯例；不四舍五入）
        assertEquals("0:00", formatClock(600L))
    }

    @Test
    fun clock_adds_hours_only_when_needed() {
        assertEquals("1:00:00", formatClock(3_600_000L))
        assertEquals("2:05:03", formatClock(7_503_000L))
    }

    /** 拿不到时长不该出现 `-1:-1` 这种显示（调用方用 `?.let` 决定画不画那个胶囊） */
    @Test
    fun clock_clamps_negative() {
        assertEquals("0:00", formatClock(-1L))
    }

    @Test
    fun frame_times_start_at_zero_and_never_reach_the_end() {
        val times = frameTimesMs(10_000L, count = 5)
        assertEquals(5, times.size)
        assertEquals(0L, times.first())
        assertTrue("最后一帧不能取到 duration 本身", times.last() < 10_000L)
        // 严格递增（否则帧条上会出现两张一样的图）
        times.zipWithNext().forEach { (a, b) -> assertTrue("$a -> $b", b > a) }
    }

    /** 时长未知/为 0：退回"全是 0"（面板里就是同一张首帧），而不是崩或不抽 */
    @Test
    fun frame_times_fall_back_when_duration_unknown() {
        assertEquals(listOf(0L, 0L, 0L), frameTimesMs(null, count = 3))
        assertEquals(listOf(0L, 0L), frameTimesMs(0L, count = 2))
        assertTrue(frameTimesMs(1_000L, count = 0).isEmpty())
        assertEquals(listOf(0L), frameTimesMs(1_000L, count = 1))
    }
}
