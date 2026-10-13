package top.kuangdada.k.core.data.api

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import retrofit2.http.Body
import retrofit2.http.HTTP
import retrofit2.http.Header
import retrofit2.http.POST

/**
 * ============================================================
 * 推送设备注册（`/api/push/devices`，2026-10-08）
 * ============================================================
 * 服务端在"用户没有 Android 在线连接"时会向这些注册设备发 OPPO 离线推送
 * （见 server/src/sse.ts 与 services/push.service）。客户端职责：
 *  · 登录后把 OPPO SDK 给的 registration_id 上报（幂等 upsert）；
 *  · 退出登录时**先解绑再登出**（见 [KPush.unbindOnLogout]）。
 *
 * DELETE 用 `@HTTP(hasBody = true)` 而不是 `@DELETE`：Retrofit 的 `@DELETE`
 * 声明为无请求体，带 `@Body` 会直接在构造时抛 "Non-body HTTP method"。
 */
@Serializable
data class PushDeviceRequest(
    /** 推送厂商（服务端枚举目前只有 'oppo'） */
    val provider: String = "oppo",
    /** OPPO registration_id（设备级标识） */
    val token: String,
    /** 上报时的 applicationId（debug 包带 .debug 后缀），仅诊断用 */
    @SerialName("package_name")
    val packageName: String? = null,
    /**
     * 本机「新消息」通知通道的当前 id（见 SocialNotifier.messagesChannelId）。
     *
     * Android 9+ 的通知栏消息必须带 channel_id 且要与设备上**真实存在**的通道一致，
     * 否则系统静默丢弃（接口仍返回成功，2026-10-08 真机事故）。通道 id 会因
     * "静默修复"带 `_g2` 后缀、只有设备自己知道，所以由客户端上报、服务端逐设备存储。
     */
    @SerialName("channel_id")
    val channelId: String? = null,
)

interface PushApi {

    /** 注册/刷新绑定（需登录态，走全局拦截器的 Bearer） */
    @POST("api/push/devices")
    suspend fun register(@Body body: PushDeviceRequest)

    /**
     * 解绑（退出登录）。
     *
     * 显式携带 Bearer：调用时机在 `session.logout()` **之前**，但请求真正发出
     * 可能在登出之后 —— 里外都带上"登出前同步快照的 token"，就不会因为
     * 拦截器读到已清空的登录态而 401（KApi 的拦截器在请求已有 Authorization 头时不覆盖）。
     */
    @HTTP(method = "DELETE", path = "api/push/devices", hasBody = true)
    suspend fun unregister(
        @Header("Authorization") bearer: String,
        @Body body: PushDeviceRequest,
    )
}
