package top.kuangdada.k.nativeapp.voice

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ============================================================
 * 语音房会话持有者测试（VoiceRoomSessionHub）
 * ============================================================
 * 对应维护方案 P0-2.1 的验收：
 *  - 通知退房路由到当前会话（带原因）；**旧会话的停止请求关不掉新房间**
 *  - 会话取代/注销/失败回传只作用于匹配的会话
 *  - 必须完成的收尾交给 hub 的 cleanup scope：业务 scope 立即取消后仍执行完毕
 *    （旧实现的坑：把收尾 launch 在控制器自己的 scope 上再紧接着 cancel）
 *  - 收尾失败有记录（不静默吞掉）
 *
 * hub 不依赖 Handler/Looper（主线程约定只写在文档里），纯 JVM 可测。
 */
class VoiceRoomSessionHubTest {

    /** 与真实控制器同契约：leave 时注销自己（teardown 首行即 unregister） */
    private class FakeHandle(private val hub: VoiceRoomSessionHub, private val sessionId: String) : VoiceRoomHandle {
        val leaveReasons = mutableListOf<String>()
        val serviceErrors = mutableListOf<String>()

        override fun leave(reason: String) {
            leaveReasons += reason
            hub.unregister(sessionId, this)
        }

        override fun onForegroundServiceFailed(message: String) {
            serviceErrors += message
        }
    }

    private fun newHub() = VoiceRoomSessionHub(logFailure = { _, _ -> })

    private fun register(hub: VoiceRoomSessionHub, sessionId: String): FakeHandle =
        FakeHandle(hub, sessionId).also { hub.register(sessionId, it) }

    @Test
    fun `requestLeave 路由到匹配会话并带回原因`() {
        val hub = newHub()
        val handle = register(hub, "room-1")

        val handled = hub.requestLeave("room-1", "通知栏退出")

        assertTrue(handled)
        assertEquals(listOf("通知栏退出"), handle.leaveReasons)
    }

    @Test
    fun `旧通知的停止请求关不掉新房间`() {
        val hub = newHub()
        val oldHandle = register(hub, "room-old")
        val newHandle = register(hub, "room-new")
        // register 取代旧会话时旧 handle 已被退房（防御路径）
        assertEquals(listOf("被新房间会话取代"), oldHandle.leaveReasons)

        // 迟到的旧停止请求：不匹配新会话 → 拒绝，新房间不受影响
        val handled = hub.requestLeave("room-old", "通知栏退出")

        assertFalse(handled)
        assertTrue(newHandle.leaveReasons.isEmpty())
        assertEquals(1, oldHandle.leaveReasons.size)
    }

    @Test
    fun `requestLeave 无活动会话时返回 false`() {
        val hub = newHub()
        assertFalse(hub.requestLeave("room-x", "通知栏退出"))
    }

    @Test
    fun `leaveActive 退掉当前会话`() {
        val hub = newHub()
        val handle = register(hub, "room-1")

        assertTrue(hub.leaveActive("登录态失效"))
        assertEquals(listOf("登录态失效"), handle.leaveReasons)
        // 退房即注销：再退没有会话可退
        assertFalse(hub.leaveActive("登录态失效"))
    }

    @Test
    fun `onForegroundServiceError 只路由给匹配会话`() {
        val hub = newHub()
        val handle = register(hub, "room-1")

        assertTrue(hub.onForegroundServiceError("room-1", "语音服务启动失败"))
        assertFalse(hub.onForegroundServiceError("room-other", "语音服务启动失败"))
        assertEquals(listOf("语音服务启动失败"), handle.serviceErrors)
    }

    @Test
    fun `unregister 后不再路由（迟到的清理不动后续会话）`() {
        val hub = newHub()
        val handle = register(hub, "room-1")
        hub.unregister("room-1", handle)

        assertFalse(hub.requestLeave("room-1", "通知栏退出"))
        assertTrue(handle.leaveReasons.isEmpty())

        // 同 id 的新会话不受旧会话的 unregister 影响
        val next = register(hub, "room-1")
        hub.unregister("room-1", handle)
        assertTrue(hub.isActive("room-1"))
        assertTrue(next.leaveReasons.isEmpty())
    }

    @Test
    fun `业务 scope 立即取消后 cleanup 仍完整执行（旧 leave 的坑）`() = runBlocking {
        val hub = VoiceRoomSessionHub(logFailure = { _, _ -> })
        var stopped = false
        val businessScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

        // 复刻旧 leave() 的调用形态：提交收尾后紧接着取消自己的业务 scope。
        // 若收尾仍挂在业务 scope 上（旧实现），它会在被调度前取消，永远跑不到 stop()
        val cleanupJob = hub.runCleanup("session.stop") {
            delay(100)
            stopped = true
        }
        businessScope.cancel()

        withTimeout(5_000) { cleanupJob.join() }
        assertTrue("cleanup 不能被业务 scope 的取消带走", stopped)
    }

    @Test
    fun `cleanup 失败会记录原因而不是静默`() = runBlocking {
        val failures = mutableListOf<Throwable>()
        val hub = VoiceRoomSessionHub(logFailure = { _, t -> failures += t })

        val job = hub.runCleanup("boom") { throw IllegalStateException("stop 失败") }
        withTimeout(5_000) { job.join() }

        assertEquals(1, failures.size)
        assertEquals("stop 失败", failures.single().message)
    }
}
