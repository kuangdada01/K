package top.kuangdada.k.nativeapp.voice

import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicReference

/**
 * ============================================================
 * 活动语音房会话持有者（VoiceRoomSessionHub）
 * ============================================================
 * 进程内唯一的活动房间会话登记处（装配在 [top.kuangdada.k.nativeapp.AppGraph]，
 * 由 KApp.onCreate 安装为进程默认）。UI 退房按钮、通知栏「退出房间」、
 * 服务端踢出/房间关闭、登录态失效**全部收敛到这里的幂等 `leave(sessionId, reason)`**，
 * 不再各自直接触碰控制器 —— 此前通知栏的 ACTION_STOP 只 stopSelf，
 * 信令/WebRTC 一概不收，另一端看到的是「人还在房里」的幽灵会话。
 *
 * 会话 ID（sessionId）由控制器在进房时生成（房间 id + 进程内唯一后缀），
 * 通知的停止意图带着它回来：**旧通知的停止请求关不掉新房间**
 * （sessionId 不匹配直接忽略），这是「退出旧房间不影响新房间」的判定依据。
 *
 * ## cleanup scope
 * [runCleanup] 把必须完成的收尾（WebRTC native 销毁、录制结算）放到
 * 比控制器业务 scope 生命周期更长的独立 scope 上：`leave()` 里紧随其后的
 * `scope.cancel()` 取消不掉已经交给这里的收尾。返回 [Job] 供调用方/测试观察完成结果。
 *
 * ## 线程约定
 * register / unregister / requestLeave / leaveActive / onForegroundServiceError
 * 都在主线程调用（控制器、前台服务、AppShell 组合均在主线程）；内部只用
 * 原子引用做最小同步，不依赖 Handler —— 纯 JVM 单测可以直接构造使用。
 */
interface VoiceRoomHandle {
    /**
     * 幂等退房：按「录制 → 共享 → 信令 → WebRTC → 前台服务」的顺序收尾。
     * **契约**：实现方在真正开始退房时必须 [VoiceRoomSessionHub.unregister] 自己
     * （[VoiceRoomController.teardown] 首行即是），否则迟到的路由还会打到已死的会话上。
     */
    fun leave(reason: String)

    /**
     * 前台服务启动/升级失败回传（服务侧 catch 到异常后经 hub 路由）。
     * 控制器负责停止已占用的资源并显示**可重试**的错误，而不是吞掉后继续显示已加入。
     */
    fun onForegroundServiceFailed(message: String)
}

class VoiceRoomSessionHub(
    /** 收尾失败的记录出口；默认打 Log.w，单测注入假实现避免触碰 android.util.Log */
    private val logFailure: (tag: String, error: Throwable) -> Unit = { tag, error ->
        Log.w(tag, "语音房收尾失败", error)
    },
) {

    data class ActiveSession(val sessionId: String, val handle: VoiceRoomHandle)

    private val activeRef = AtomicReference<ActiveSession?>(null)

    /** 当前活动会话（无则 null） */
    val active: ActiveSession? get() = activeRef.get()

    /** 收尾协程域：生命周期长于任何控制器（进程级），业务 scope 取消不影响它 */
    val cleanupScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /**
     * 登记活动会话。若上一个会话尚未退房就被新会话取代（正常导航流不会发生，
     * 防御性兜底），先令其退房，保证任何时刻最多一个活动会话。
     */
    fun register(sessionId: String, handle: VoiceRoomHandle) {
        val previous = activeRef.getAndSet(ActiveSession(sessionId, handle))
        if (previous != null && previous.sessionId != sessionId) {
            previous.handle.leave("被新房间会话取代")
        }
    }

    /** 注销：只有 sessionId 与 handle 都匹配当前活动会话时才清除（迟到的旧会话清理不动新会话） */
    fun unregister(sessionId: String, handle: VoiceRoomHandle) {
        while (true) {
            val cur = activeRef.get() ?: return
            if (cur.sessionId == sessionId && cur.handle === handle) {
                if (activeRef.compareAndSet(cur, null)) return
            } else {
                return
            }
        }
    }

    /** 该会话是否为当前活动会话 */
    fun isActive(sessionId: String): Boolean = activeRef.get()?.sessionId == sessionId

    /**
     * 幂等退房请求（通知栏按钮等外部入口）。
     * @return sessionId 匹配当前活动会话并已路由退房才为 true；
     *         旧通知的停止请求（sessionId 不匹配）返回 false，不影响新房间。
     */
    fun requestLeave(sessionId: String, reason: String): Boolean {
        val cur = activeRef.get() ?: return false
        if (cur.sessionId != sessionId) return false
        cur.handle.leave(reason)
        return true
    }

    /** 退掉当前活动会话（登录态失效等「无具体会话标识」的入口）。无活动会话返回 false。 */
    fun leaveActive(reason: String): Boolean {
        val cur = activeRef.get() ?: return false
        cur.handle.leave(reason)
        return true
    }

    /** 前台服务启动/升级失败回传：只路由给匹配会话。 */
    fun onForegroundServiceError(sessionId: String, message: String): Boolean {
        val cur = activeRef.get() ?: return false
        if (cur.sessionId != sessionId) return false
        cur.handle.onForegroundServiceFailed(message)
        return true
    }

    /**
     * 在 cleanup scope 上执行必须完成的收尾。失败会记录原因（不吞异常静默），
     * 取消异常原样重抛以保持协程取消语义。
     */
    fun runCleanup(tag: String, block: suspend () -> Unit): Job =
        cleanupScope.launch {
            try {
                block()
            } catch (ce: CancellationException) {
                throw ce
            } catch (t: Throwable) {
                logFailure(TAG, t)
            }
        }

    companion object {
        private const val TAG = "KVoiceRoom"

        @Volatile
        private var installed: VoiceRoomSessionHub? = null

        /** KApp 未注册时的进程级兜底实例（与 AppGraph 持有的同一个语义） */
        private val fallback = VoiceRoomSessionHub()

        /** 装配进程默认实例（KApp.onCreate → VoiceRoomSessionHub.install(graph.voiceHub)） */
        fun install(hub: VoiceRoomSessionHub) {
            installed = hub
        }

        /** 取进程默认实例：前台服务、控制器等无 Activity 上下文的调用点经此访问 */
        fun get(): VoiceRoomSessionHub = installed ?: fallback
    }
}
