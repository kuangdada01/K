package top.kuangdada.k.nativeapp.notify

import android.content.Context
import top.kuangdada.k.core.data.SessionRepository

/**
 * ============================================================
 * 通知链路的**切后台自检上报**（进程退后台时一行）
 * ============================================================
 * 用途只有一个：把"后台收不到通知"这件事从**只能靠用户口述**变成**服务端可读的一行日志**。
 *
 * 触发时机是 [ForegroundRealtime] 的"前台 → 后台"边沿（S1 多窗口起从
 * `AppShell` 的 ON_STOP 挪到进程级；语义不变：整个 App 退到后台的那一刻）——
 * 这正是"后台收不到通知"类事故发生的时刻，
 * 而现场只有 App 自己知道：推送注册成功没有（[KPush.status]）、通知通道与系统开关
 * 是什么状态、声音/震动这条路上系统侧的**实际取值**（见 [SocialNotifier.soundDiagnostics]）。
 * 服务端只写日志、不落库（见 server/src/routes/meta.ts 的 /notify-diag）。
 *
 * 失败静默：诊断本身绝不能影响功能。
 */
object NotifyDiag {

    /** 组装一条上报（字段取值都来自"系统现在认什么"，而不是"我们设置成了什么"） */
    fun payload(
        context: Context,
        session: SessionRepository,
    ): top.kuangdada.k.core.data.api.NotifyDiagRequest {
        val sound = SocialNotifier.soundDiagnostics(context)
        val push = KPush.status.value
        return top.kuangdada.k.core.data.api.NotifyDiagRequest(
            version = top.kuangdada.k.nativeapp.BuildConfig.VERSION_NAME,
            loggedIn = session.isLoggedIn,
            pushSupported = push.supported,
            pushRegistered = push.registered,
            pushError = push.lastError,
            // 通道适配与通知开关：这两层是"推送到了但看不到"排查的关键，
            // 都要能让服务端日志看见 —— 之前只能靠截图
            channelId = SocialNotifier.messagesChannelId(context),
            notificationsEnabled = SocialNotifier.diagnostics(context).notificationsEnabled,
            notifPermission = SocialNotifier.hasPermission(context),
            ringerMode = sound.ringerMode,
            notificationVolume = sound.notificationVolume,
            channelImportance = sound.channelImportance,
            channelSound = sound.channelSound,
            channelVibrate = sound.channelVibrate,
        )
    }

    /** 上报一条（失败静默：诊断本身绝不能影响功能） */
    suspend fun report(session: SessionRepository, request: top.kuangdada.k.core.data.api.NotifyDiagRequest) {
        runCatching { session.api.diag.report(request) }
    }
}
