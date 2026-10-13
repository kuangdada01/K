package top.kuangdada.k.nativeapp.notify

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import top.kuangdada.k.core.data.InboxStore
import top.kuangdada.k.core.data.RealtimeClient
import top.kuangdada.k.core.data.SessionRepository

/**
 * ============================================================
 * 进程级联动：SSE 连接 / 收件箱对账 / 诊断上报（ForegroundRealtime）
 * ============================================================
 * 2026-10-10 从 `AppShell` 的生命周期观察者里整体搬出来。
 *
 * "App 在不在前台"本来就不该由某个 Activity 的 STARTED/STOPPED 判断：
 * Activity 的生命周期会因转屏、多窗口、系统回收等频繁抖动，
 * Activity 级的观察者一旦把 SSE 掐断，服务端就认为"手机不在线"，
 * 同一条消息转投系统推送 → 用户对着正开着的 App 收到重复的系统提醒。
 *
 * 现在的条件 = **`AppForeground.isForeground && 已登录`**（进程级）：
 *  · 进程退到后台才断（0.1.17 的语义不变：断开后由厂商推送兜底）；
 *  · 登录 / 登出 / 回前台 / 退后台四条边沿都在这里收口。
 *
 * ## 三条动作各自的时机（由 [ForegroundSessionState] 的纯逻辑判定边沿）
 *
 *  | 边沿 | 动作 | 原实现位置（Activity 级时代） |
 *  |---|---|---|
 *  | 进入"前台+登录"稳态 | `realtime.start` + `inbox.refresh()`（把错过的补齐） | ON_START |
 *  | 离开该稳态（退后台 / 登出） | `realtime.stop`（服务端据此转投系统推送） | ON_STOP |
 *  | 前台 → 后台 | `NotifyDiag.report`（通知链路自检一行，服务端只记日志） | ON_STOP |
 *
 * 装配在 `AppGraph` / `KApp.onCreate`（进程级），**不要**再放回组合树 ——
 * 它服务的对象（连接、角标、通知）全都比任何一棵组合树活得长。
 */
class ForegroundRealtime(
    /** 上报诊断用（ApplicationContext） */
    private val context: Context,
    private val realtime: RealtimeClient,
    private val inbox: InboxStore,
    private val session: SessionRepository,
    private val foreground: AppForeground,
    /** 进程级作用域（`AppGraph.appScope`：Main.immediate + crashGuard） */
    private val scope: CoroutineScope,
) {

    private val state = ForegroundSessionState()

    /** 在 `KApp.onCreate` 调用一次（幂等由调用点保证） */
    fun install() {
        scope.launch {
            combine(
                foreground.flow,
                session.state,
            ) { fg, auth ->
                fg to (auth is SessionRepository.AuthState.LoggedIn)
            }
                .distinctUntilChanged()
                .collect { (fg, loggedIn) -> apply(state.onState(fg, loggedIn)) }
        }
    }

    private fun apply(change: ForegroundSessionState.Change) {
        if (change.connect) {
            // start 是幂等的（内部 `job?.isActive` 判定）；refresh 自带单飞，重复调用安全
            realtime.start(scope)
            scope.launch { inbox.refresh() }
        }
        if (change.disconnect) {
            realtime.stop()
        }
        if (change.leftForeground) {
            /**
             * 退到后台的那一刻上报一行通知链路自检（服务端只记日志）。
             *
             * 这正是"后台收不到通知"类事故发生的时刻，而现场只有 App 自己知道：
             * 推送注册成功没有、通知通道与系统开关是什么状态。有了这一行，
             * 服务端的推送日志就能被解释，不必再靠用户念截图来定位（见 `DiagApi`）。
             */
            scope.launch {
                NotifyDiag.report(session, NotifyDiag.payload(context = context, session = session))
            }
        }
    }
}

/**
 * 前台 / 登录 → 三条动作的**边沿判定**（纯逻辑，独立出来是为了能单测）。
 *
 * 为什么值得单独抽：这里错了的表现是"该连时不连、该断时不断"或
 * "每帧都重连" —— 前者在真机上表现为"消息要下拉才有"，后者是耗电与连接风暴，
 * 两者都很难在开发机上定位；而真值表 + 边沿是几行断言就能钉住的东西。
 *
 * 语义（与单窗口时代的 ON_START/ON_STOP 对齐）：
 *  · [Change.connect]：**进入**"前台+登录"稳态的边沿（含首次进入、登录、
 *    回前台、以及"冷启动时前台先到、鉴权后到"这类乱序组合）；
 *  · [Change.disconnect]：**离开**该稳态的边沿（退后台或登出）；
 *  · [Change.leftForeground]：**前台 → 后台**的边沿（不看登录态 —— 诊断上报
 *    与账号无关，与 ON_STOP 的无条件上报同语义）。
 */
class ForegroundSessionState {

    private var lastForeground = false
    private var lastConnected = false

    /** 一次状态迁移要触发的动作（全 false = 什么都不做） */
    data class Change(
        val connect: Boolean = false,
        val disconnect: Boolean = false,
        val leftForeground: Boolean = false,
    )

    fun onState(foreground: Boolean, loggedIn: Boolean): Change {
        val connectNow = foreground && loggedIn
        val change = Change(
            connect = connectNow && !lastConnected,
            disconnect = !connectNow && lastConnected,
            leftForeground = !foreground && lastForeground,
        )
        lastForeground = foreground
        lastConnected = connectNow
        return change
    }
}
