package top.kuangdada.k.core.data.api

import kotlinx.serialization.Serializable
import retrofit2.http.Body
import retrofit2.http.POST

/**
 * ============================================================
 * 客户端「通知链路」自检上报（`POST /api/notify-diag`）
 * ============================================================
 * 服务端只把这一行写进结构化日志（不落库、不改任何业务状态）。
 *
 * 为什么要有它：Android 端"收不到通知"在服务端只能看到**结果**（推送发送记录），
 * 看不到**原因** —— 原因全在客户端：推送注册成功没有、通知通道与系统开关是什么状态、
 * 声音与震动的实际取值。让 App 在切到后台时主动上报一行，与服务端日志按时间对齐，
 * 就能一眼看出是哪一环断了，不必来回让人念截图。
 *
 * 全部用字符串/基础类型：服务端只做白名单取值写日志，不需要强类型契约。
 */
@Serializable
data class NotifyDiagRequest(
    /** App 版本（排查时先确认"用户装的到底是哪一版"） */
    val version: String,
    val loggedIn: Boolean,
    /** 设备是否支持 OPPO 推送（非 OPPO/一加/realme 机型为 false） */
    val pushSupported: Boolean = false,
    /** 是否已拿到 registration_id（服务端据此下发离线推送） */
    val pushRegistered: Boolean = false,
    /** 推送注册/上报的最近失败原因（null = 没失败过） */
    val pushError: String? = null,
    /**
     * 本机「新消息」通道的当前 id（含 `_g2` 之类后缀）。
     *
     * 远程排查"推送到了但看不到"的第一线索：Android 9+ 的通知栏消息按 channel_id
     * 找设备上的通道，对不上就静默丢弃 —— 需要通道 id 才能确认服务端下发用哪一代。
     */
    val channelId: String? = null,
    /** 应用级通知开关（系统设置里"允许通知"；false 时一切通知都不展示） */
    val notificationsEnabled: Boolean = true,
    /** Android 13+ 运行时通知权限是否已授予 */
    val notifPermission: Boolean = true,
    // ---- 声音/震动这条路的实际取值（见 SocialNotifier.soundDiagnostics）----
    /** 0=静音 1=震动 2=正常 */
    val ringerMode: Int = -1,
    val notificationVolume: Int = -1,
    val channelImportance: Int = -1,
    /** 渠道提示音 URI（null = 无声） */
    val channelSound: String? = null,
    val channelVibrate: Boolean = false,
)

interface DiagApi {

    /** 上报一行诊断；服务端只记日志。失败无副作用，调用方忽略结果即可 */
    @POST("api/notify-diag")
    suspend fun report(@Body body: NotifyDiagRequest)
}
