package top.kuangdada.k.nativeapp.notify

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ============================================================
 * SSE / 对账 / 诊断的**边沿判定**（多窗口后"前台"的定义换了主人）
 * ============================================================
 * 它错了的表现两头都很难查：
 *  · 该连时不连（回前台没有 connect）：消息要下拉才有、角标不动 —— 看起来像服务端问题；
 *  · 该断时不断：App 在后台连着 SSE，服务端认为"在线"不补推 → 通知静默丢失；
 *  · 重复 connect（状态没变也 connect）：连接风暴与耗电，日志里只有一串"已连接"。
 *
 * 用真值表 + 逐边沿推进的写法，把上面三类都钉死。
 */
class ForegroundSessionStateTest {

    private fun ForegroundSessionState.advance(fg: Boolean, login: Boolean) = onState(fg, login)

    @Test
    fun `初始态_后台且未登录_不触发任何动作`() {
        // 冷启动：Application.onCreate 时还没有 Activity started，鉴权也还在 Restoring
        val change = ForegroundSessionState().advance(fg = false, login = false)
        assertFalse(change.connect)
        assertFalse(change.disconnect)
        assertFalse(change.leftForeground)
    }

    @Test
    fun `冷启动常见序列_前台先到鉴权后到_登录时才connect`() {
        val s = ForegroundSessionState()
        // MainActivity onStart 已发生，但 /auth/me 还没回来
        val c1 = s.advance(fg = true, login = false)
        assertFalse("还没登录不该连", c1.connect)
        // 鉴权恢复完成 → 进入"前台+登录"稳态
        val c2 = s.advance(fg = true, login = true)
        assertTrue("登录完成应当连", c2.connect)
        assertFalse(c2.leftForeground)
    }

    @Test
    fun `乱序_登录态先到前台后到_也只在进入稳态时connect一次`() {
        val s = ForegroundSessionState()
        assertFalse(s.advance(fg = false, login = true).connect)
        val c = s.advance(fg = true, login = true)
        assertTrue(c.connect)
        // 同状态重复推进（StateFlow 去重失效之类）不许重复 connect
        assertFalse(s.advance(fg = true, login = true).connect)
    }

    @Test
    fun `退后台_断开并上报一行诊断`() {
        val s = ForegroundSessionState()
        s.advance(fg = true, login = true) // 先进稳态（connect）
        val c = s.advance(fg = false, login = true)
        assertTrue("退后台必须断开（服务端据此转投推送）", c.disconnect)
        assertTrue("退后台要上报诊断", c.leftForeground)
        assertFalse(c.connect)
    }

    @Test
    fun `回前台_重新connect做对账`() {
        val s = ForegroundSessionState()
        s.advance(fg = true, login = true)
        s.advance(fg = false, login = true) // 退后台
        val c = s.advance(fg = true, login = true) // 回前台
        assertTrue("回前台要重连（顺带 refresh 对账）", c.connect)
        assertFalse("回前台不是上报时机", c.leftForeground)
        assertFalse(c.disconnect)
    }

    @Test
    fun `登出_断开连接（不牵动诊断边沿）`() {
        val s = ForegroundSessionState()
        s.advance(fg = true, login = true)
        val c = s.advance(fg = true, login = false)
        assertTrue(c.disconnect)
        assertFalse(c.leftForeground)
    }

    @Test
    fun `未登录退后台_照样上报诊断（与账号无关）`() {
        // 原实现是 ON_STOP 无条件上报；边沿判定保留这个语义
        val s = ForegroundSessionState()
        s.advance(fg = true, login = false)
        val c = s.advance(fg = false, login = false)
        assertTrue(c.leftForeground)
        assertFalse("从没连过就没什么可断", c.disconnect)
    }

    @Test
    fun `前台内反复登录登出_每次登录只connect一次`() {
        val s = ForegroundSessionState()
        s.advance(fg = true, login = false)
        assertEquals(true, s.advance(fg = true, login = true).connect)
        assertEquals(true, s.advance(fg = true, login = false).disconnect)
        assertEquals(true, s.advance(fg = true, login = true).connect)
        // 稳定态不再触发
        val c = s.advance(fg = true, login = true)
        assertFalse(c.connect)
        assertFalse(c.disconnect)
        assertFalse(c.leftForeground)
    }
}
