package top.kuangdada.k.nativeapp.notify

import android.app.Activity
import android.app.Application
import android.os.Bundle
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * ============================================================
 * 「App 现在在不在前台」的**进程级**判定
 * ============================================================
 * 为什么不能再用 Compose 里那个 `appInForeground`（`AppShell` 原来就是这么写的）：
 * 它是 `remember { mutableStateOf(true) }` —— **只存在于那棵组合树里**。
 * 而"要不要发通知栏提醒"这件事的判断者在进程级（[SocialNotificationCenter]）：
 *  · Activity 被系统回收后组合树没了，可进程还在（前台服务还连着），
 *    这时再想判断"我在不在前台"就没人回答了；
 *  · 通知中心与 UI 在不同的生命周期上，用一个 UI 状态当全局开关迟早会读到过期的值。
 *
 * 实现用 `ActivityLifecycleCallbacks` 的 started/stopped 计数（而不是 onResume/onPause）：
 * started 才是"用户看得见这个 App"的语义 —— 弹权限框、被半透明页遮住等 onPause 场景
 * 不该被当成"退到后台"（那种情况下发通知反而是对的：用户没在看内容）。
 *
 * ★ 2026-10-10：新增 [flow]（前台状态的响应式镜像）——
 * `realtime` 的连接条件从"某个 Activity 的 STARTED/STOPPED"改成**进程级**的
 * `flow == true && 已登录`（见 [ForegroundRealtime]）。理由：Activity 生命周期
 * 会因转屏、多窗口、系统回收等频繁抖动，用它判断"用户还在不在用 App"会误判离线。   *
 * 不引 `androidx.lifecycle:lifecycle-process`：它做的正是同一件事，
 * 而这里只需要 20 行（项目一贯的做法：宁可自己写清楚，也不为一个计数加依赖）。
 */
class AppForeground {

    private val counter = ForegroundCounter()

    /**
     * 前台状态的**响应式镜像**（与 [isForeground] 恒同步）。
     *
     * 用 `MutableStateFlow` 而不是回调列表：连接条件是"前台 × 登录态"的组合，
     * StateFlow 天然满足"新订阅者立刻拿到当前值"（装配晚于第一个 Activity start
     * 也不会漏掉状态；相同值重复写入自动去重）。
     */
    private val _flow = MutableStateFlow(false)
    val flow: StateFlow<Boolean> = _flow.asStateFlow()

    /** 当前是否至少有一个 Activity 处于 started 状态（= 用户看得见） */
    val isForeground: Boolean get() = counter.isForeground

    /** 在 `Application.onCreate` 里调用一次（幂等由调用点保证） */
    fun install(app: Application) {
        app.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            override fun onActivityStarted(activity: Activity) {
                counter.onStarted()
                _flow.value = counter.isForeground
            }

            override fun onActivityStopped(activity: Activity) {
                counter.onStopped()
                _flow.value = counter.isForeground
            }

            // 其余回调不需要：计数器只关心 "started 状态下的 Activity 有几个"
            override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
            override fun onActivityResumed(activity: Activity) = Unit
            override fun onActivityPaused(activity: Activity) = Unit
            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
            override fun onActivityDestroyed(activity: Activity) = Unit
        })
    }
}

/**
 * started 计数（纯逻辑，独立出来是为了能单测 —— 它错了的表现是"该弹通知时不弹、
 * 不该弹时反而弹"，两者都很难在真机上定位）。
 */
class ForegroundCounter {

    private var started = 0

    val isForeground: Boolean get() = started > 0

    fun onStarted() {
        started += 1
    }

    /**
     * 计数**不能为负**：Activity 重建（旋转/系统回收）时 stop 可能比 start 先到，
     * 负计数会让 [isForeground] 永远为 false —— 通知从此再不弹，且完全无声。
     */
    fun onStopped() {
        started = (started - 1).coerceAtLeast(0)
    }
}
