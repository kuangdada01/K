package top.kuangdada.k.nativeapp.ui

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 共享画面比例的取值规则（[shareContentAspect]）。
 *
 * 为什么这几行值得单测：取错了**不会报错**，只会以"画面被裁切"或"画面跳一下"的形式
 * 出现在真机上（这两条正是用户反复报的问题）。而这一段的规则是纯函数，
 * 不必上真机就能钉死：
 * **本地缓存（解码尺寸） → 共享者声明的采集尺寸 → 会话接收探针 → 16:9 兜底**。
 *
 * "解码尺寸排第一"（2026-10-15 从"声明第一"调整）的缘由：它是真实的画面尺寸，
 * 中途变化（手机旋转去打横屏游戏、共享者换共享源）时跟着走；而声明值只在进共享那一刻
 * 报过一次、中途无法重新声明 —— 声明第一会让原生观看端停在进共享时的方向
 * （用户实测"横屏游戏应用时投屏不会切到横屏"）。
 *
 * 声明值仍在第二：首帧之前解码尺寸还不存在，由它保证画面框**从第一帧起**就是正确比例
 * （不出现"先填满 16:9、首帧那一刻收一下"）；两者比例在 5% 迟滞内时不重排。
 *
 * 另外它还是"不许依赖只有挂了渲染器才会产生的状态"这条规矩的门禁：
 * 四个来源里任何一个缺席都必须能退回下一档，绝不能返回 0（返回 0 会让画面框算成 0 高）。
 */
class ShareContentAspectTest {

    private val frame16x9 = 16f / 9f
    private val frame16x10 = 1920 to 1200

    // ---------------- 最高优先：解码尺寸（真实画面尺寸） ----------------

    /**
     * 解码尺寸压过声明：声明还是进共享时的竖屏 9:16，而解码出来的已经是横屏 16:9
     * （共享者中途把手机转去打游戏了）—— 画面框必须跟解码尺寸走，否则横屏内容
     * 一直嵌在竖屏框里。
     */
    @Test
    fun `解码尺寸优先于声明值（中途旋转或换共享源时跟随真实画面）`() {
        assertEquals(1.7777f, shareContentAspect(1080 to 1920, 1.7777f, 0f), 1e-6f)
    }

    /** 缓存本身是退化值（0.05 以下）时按未知处理，退回声明值（不能拿它把框压成一条线） */
    @Test
    fun `缓存退化值按未知处理`() {
        assertEquals(1.6f, shareContentAspect(frame16x10, 0.04f, 0f), 1e-6f)
    }

    /** 声明尺寸在首帧之前就到位：缓存与探针都还是"未知"时它照样给出正确比例 */
    @Test
    fun `只有声明尺寸时也拿得到正确比例`() {
        assertEquals(1.6f, shareContentAspect(frame16x10, null, 0f), 1e-6f)
    }

    /** 竖屏共享（手机 1080x2400 → 0.45）同样跟随声明值，不被 16:9 兜底吃掉 */
    @Test
    fun `竖屏声明尺寸照用`() {
        assertEquals(0.45f, shareContentAspect(1080 to 2400, null, 0f), 1e-6f)
    }

    /** 任一边非正 = 该字段没意义（信令里被写坏/老客户端缺字段），必须回落到下一档 */
    @Test
    fun `声明尺寸退化值按未声明处理`() {
        assertEquals(1.6f, shareContentAspect(0 to 1200, null, 1.6f), 1e-6f)
        assertEquals(1.6f, shareContentAspect(1920 to 0, null, 1.6f), 1e-6f)
    }

    /** 声明比例离谱（0.05 以下，例如 1x1080）时不排版，交出给缓存/探针/兜底 */
    @Test
    fun `声明比例过小时按未声明处理`() {
        assertEquals(frame16x9, shareContentAspect(1 to 1080, null, 0f), 1e-6f)
    }

    // ---------------- 以下三档是加"声明尺寸"之前的既有回落链 ----------------

    /** 无声明时，缓存是"本轨量到过的真实比例"，优先级最高 */
    @Test
    fun `没有声明时缓存优先于探针`() {
        assertEquals(1.6f, shareContentAspect(null, 1.6f, 1.7777f), 1e-6f)
    }

    /** 声明与缓存都没有（渲染器刚建、一帧都没来）时，用会话接收探针给的比例 */
    @Test
    fun `没有声明与缓存时用探针`() {
        assertEquals(1.6f, shareContentAspect(null, null, 1.6f), 1e-6f)
    }

    /** 探针的 0 表示"还没收到帧"，必须当成未知回落 16:9（0 会让画面框算成 0 高） */
    @Test
    fun `探针未知时回落 16 比 9`() {
        assertEquals(frame16x9, shareContentAspect(null, null, 0f), 1e-6f)
    }

    /**
     * 探针给出的极小值（0.05 以下）同样按未知处理：竖屏共享是 0.45 左右，
     * 0.04 这种数只可能是"字段被写坏了"，拿它排版会把画面压成一条线。
     */
    @Test
    fun `探针的退化值按未知处理`() {
        assertEquals(frame16x9, shareContentAspect(null, null, 0.04f), 1e-6f)
    }

    /** 兜底值必须是个能用的比例（>0），否则画面框会塌成 0 */
    @Test
    fun `兜底比例可用`() {
        val fallback = shareContentAspect(null, null, 0f)
        assert(fallback > 1f) { "兜底比例应是一个正常的横屏比例，实际 $fallback" }
    }
}
