package top.kuangdada.k.nativeapp.ui

import androidx.compose.ui.geometry.Rect
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

/**
 * 详情页内联播放器 → 沉浸全屏播放器**交接单**的单测。
 *
 * 用户报的就是"点全屏不能续播"，所以这条链上的每个判据都值得钉住：
 * 对不上帖子号不能续、过期不能续、读一次就得清（否则第二次进全屏会莫名跳到旧位置）、
 * **一次取走**（分两次取会让第二次拿到 null —— 表现是"能续播但没动画"）。
 */
class VideoHandoffTest {

    private val rect = Rect(0f, 800f, 1080f, 1407.5f)
    private val origin = VideoOrigin(rect, 16f / 9f, 42f)

    @Before
    fun setUp() {
        // 进程级单例：每个用例从干净状态开始，避免用例之间互相影响
        VideoHandoff.clear()
    }

    @After
    fun tearDown() {
        VideoHandoff.clear()
    }

    // ------------------------------------------------------------------
    // 进度
    // ------------------------------------------------------------------

    @Test
    fun `同一帖子取回进度`() {
        VideoHandoff.offer(postId = 7L, positionMs = 12_345L, durationMs = 60_000L)
        assertEquals(12_345L, videoFullscreenHandoff(7L).positionMs!!)
    }

    @Test
    fun `取一次之后就清掉`() {
        // 「读并清」是刻意的：用户退出全屏再进第二次时，不该又跳到上一次的位置
        VideoHandoff.offer(postId = 7L, positionMs = 12_345L, durationMs = 60_000L)
        assertEquals(12_345L, videoFullscreenHandoff(7L).positionMs!!)
        assertNull(videoFullscreenHandoff(7L).positionMs)
    }

    @Test
    fun `帖子号对不上时不续播`() {
        // 从 A 帖的视频进全屏、路上又切到 B 帖：拿 A 的进度去 seek B 就是"随便跳一下"，
        // 比从头播更糟 —— 对不上就丢弃，返回空（从头播）
        VideoHandoff.offer(postId = 7L, positionMs = 12_345L, durationMs = 60_000L)
        assertNull(videoFullscreenHandoff(8L).positionMs)
        // 且那张对不上的单子也应当被消费掉（不留着给下一次误用）
        assertNull(videoFullscreenHandoff(7L).positionMs)
    }

    @Test
    fun `进度为零或负数不续播但几何仍然保留`() {
        // 刚起播（0ms）没有可续的东西，但"从哪一块飞出去"仍然有意义 ——
        // 用户可能刚点开视频就立刻点全屏
        VideoHandoff.offer(postId = 7L, positionMs = 0L, durationMs = 60_000L, origin = origin)
        val got = videoFullscreenHandoff(7L)
        assertNull(got.positionMs)
        assertNotNull(got.origin)
    }

    @Test
    fun `进度与几何都没有时不登记`() {
        VideoHandoff.offer(postId = 7L, positionMs = 0L, durationMs = 60_000L, origin = null)
        assertNull(videoFullscreenHandoff(7L).positionMs)
        assertNull(videoFullscreenHandoff(7L).origin)
    }

    @Test
    fun `非法帖子号不登记`() {
        // postId <= 0 是"没有帖子身份"的哨兵（探索页那条路径不传），不该占用这份便签
        VideoHandoff.offer(postId = 0L, positionMs = 5_000L, durationMs = 60_000L, origin = origin)
        assertNull(videoFullscreenHandoff(0L).positionMs)

        VideoHandoff.offer(postId = -1L, positionMs = 5_000L, durationMs = 60_000L, origin = origin)
        assertNull(videoFullscreenHandoff(-1L).positionMs)
    }

    @Test
    fun `非法帖子号不去消费别人的单子`() {
        VideoHandoff.offer(postId = 7L, positionMs = 12_345L, durationMs = 60_000L, origin = origin)
        // 0 是"这条路径不传帖子号"的默认值：不该去查表，查了就会把 7 号那张单子误消费掉
        assertNull(videoFullscreenHandoff(0L).positionMs)
        assertNull(videoFullscreenHandoff(0L).origin)
        // 7 号那张还在（没被 0 号的查询误消费）
        assertEquals(12_345L, videoFullscreenHandoff(7L).positionMs!!)
    }

    @Test
    fun `后登记的单子覆盖先前的`() {
        VideoHandoff.offer(postId = 7L, positionMs = 1_000L, durationMs = 60_000L)
        VideoHandoff.offer(postId = 7L, positionMs = 9_000L, durationMs = 60_000L)
        assertEquals(9_000L, videoFullscreenHandoff(7L).positionMs!!)
    }

    @Test
    fun `clear 之后取不到`() {
        VideoHandoff.offer(postId = 7L, positionMs = 12_345L, durationMs = 60_000L, origin = origin)
        VideoHandoff.clear()
        assertNull(videoFullscreenHandoff(7L).positionMs)
        assertNull(videoFullscreenHandoff(7L).origin)
    }
    // ------------------------------------------------------------------
    // 几何（★ 一次取走：分两次取是这条链上最隐蔽的坑）
    // ------------------------------------------------------------------

    @Test
    fun `进度与几何一次取走`() {
        VideoHandoff.offer(postId = 7L, positionMs = 12_345L, durationMs = 60_000L, origin = origin)
        val got = videoFullscreenHandoff(7L)
        assertEquals(12_345L, got.positionMs!!)
        assertEquals(origin, got.origin)
    }

    @Test
    fun `取走进度不会把几何留在表里`() {
        // 这条用例钉的是"只有一个入口"这件事：如果实现里多出一个"只取进度"的入口，
        // 调用方先调它就会把整张单子消费掉 —— 后面取几何拿到 null，
        // 真机表现是"能续播但没有飞行动画"（最难查的那种）。取完之后两边都必须是空的。
        VideoHandoff.offer(postId = 7L, positionMs = 12_345L, durationMs = 60_000L, origin = origin)
        videoFullscreenHandoff(7L)
        assertNull(videoFullscreenHandoff(7L).positionMs)
        assertNull(videoFullscreenHandoff(7L).origin)
    }

    @Test
    fun `几何里带着矩形与圆角`() {
        VideoHandoff.offer(postId = 7L, positionMs = 1_000L, durationMs = 60_000L, origin = origin)
        val got = videoFullscreenHandoff(7L).origin!!
        assertEquals(rect, got.rect)
        assertEquals(42f, got.cornerRadiusPx, 0.01f)
        assertEquals(16f / 9f, got.aspect!!, 0.001f)
    }

    @Test
    fun `没有几何时返回空的来源`() {
        // 探索页那条路径不传帖子号、也没有详情页那一块可量 → 退化成"直接落位"，不该出错。
        // ⚠️ 只取一次：单子是读并清的，第二次取必然是空的（见上面那条用例）
        VideoHandoff.offer(postId = 7L, positionMs = 1_000L, durationMs = 60_000L, origin = null)
        val got = videoFullscreenHandoff(7L)
        assertNull(got.origin)
        assertEquals(1_000L, got.positionMs!!)
    }

    // ------------------------------------------------------------------
    // VideoRectProbe：详情页每帧上报的位置
    // ------------------------------------------------------------------

    @Test
    fun `探针量到矩形后能打包成来源`() {
        val probe = VideoRectProbe()
        probe.update(rect, 42f)
        val got = probe.toOrigin(aspect = 16f / 9f)!!
        assertEquals(rect, got.rect)
        assertEquals(42f, got.cornerRadiusPx, 0.01f)
    }

    @Test
    fun `探针还没量到时不给来源`() {
        // 首帧之前还没布局，这时点全屏应当退化成"直接落位"，而不是飞出一个零矩形
        assertNull(VideoRectProbe().toOrigin(aspect = 16f / 9f))
    }

    @Test
    fun `探针的矩形尺寸退化时不给来源`() {
        val probe = VideoRectProbe()
        probe.update(Rect(0f, 0f, 0f, 0f), 42f)
        assertNull(probe.toOrigin())
    }

    @Test
    fun `探针后一次测量覆盖前一次`() {
        // 列表滚动 / 页面转场都会让它变；点全屏时要用"最近一次"的位置
        val probe = VideoRectProbe()
        probe.update(Rect(0f, 100f, 100f, 200f), 0f)
        probe.update(rect, 42f)
        assertEquals(rect, probe.toOrigin()!!.rect)
    }
}
