package top.kuangdada.k.nativeapp.notify

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ============================================================
 * 前后台计数（通知要不要弹的那道闸门）
 * ============================================================
 * 它错了的表现两头都很难查：
 *  · 卡在"前台"：后台永远不弹通知（就是用户报的那个症状，而通知代码本身完全正常）；
 *  · 卡在"后台"：用户正在用 App，通知栏却一直响。
 */
class ForegroundCounterTest {

    @Test
    fun `初始为后台`() {
        // 冷启动时 Application.onCreate 发生在任何 Activity 之前 —— 此刻说"在前台"会吞掉首条通知
        assertFalse(ForegroundCounter().isForeground)
    }

    @Test
    fun `有界面started才算前台`() {
        val counter = ForegroundCounter()
        counter.onStarted()
        assertTrue(counter.isForeground)
        counter.onStopped()
        assertFalse(counter.isForeground)
    }

    @Test
    fun `第二个界面打开时_前一个stop不影响判定`() {
        // 例如从 App 跳到系统设置页/相机：我们自己的 Activity 被 stop，但 App 仍是"用户在用"
        val counter = ForegroundCounter()
        counter.onStarted() // A
        counter.onStarted() // B
        counter.onStopped() // A 停
        assertTrue(counter.isForeground)
        counter.onStopped() // B 停
        assertFalse(counter.isForeground)
    }

    @Test
    fun `先stop后start的乱序不会把计数打成负数`() {
        // Activity 重建（旋转/系统回收）时 stop 可能先到；一旦为负，isForeground 将永远为 false
        val counter = ForegroundCounter()
        counter.onStopped()
        counter.onStopped()
        counter.onStarted()
        assertTrue(counter.isForeground)
    }
}
