package top.kuangdada.k.nativeapp.notify

/**
 * ============================================================
 * 收件箱轮询节奏（纯逻辑，独立出来是为了能单测）
 * ============================================================
 * 轮询是 SSE 半死连接与服务端"无离线补偿"的唯一兜底，但它在后台
 * 纯属电量与流量的消耗——谁负责后台提醒，决定了后台还要不要轮询：
 *
 *  · **前台**：SSE 可能假死（读超时 0、无 TCP keepalive），轮询按正常节奏走；
 *  · **后台 + 已绑定厂商推送**（[KPush.Status.serverBound]）：提醒由系统推送
 *    服务承担（App 进程不参与），本地轮询纯属空打 —— 停表；
 *  · **后台 + 未绑定推送**（非 OPPO 机型 / regId 上报失败）：厂商推送发不出来，
 *    轮询是**唯一**的后台提醒渠道，降到 90s 低频兜底（电量与及时性的折中，
 *    与 `SocialNotificationCenter` 历史口径一致）。
 *
 * 这里错了的表现是"后台也在 30s 空打三个请求"（耗电）或"后台彻底收不到
 * 提醒"（漏消息），两者都只有真机长测才能发现 —— 用真值表钉死。
 */
object InboxPollCadence {

    /** Shell 消费方的前台间隔（与 Web 版 Sidebar 的 `SIDEBAR_POLL_MS` 同口径） */
    const val SHELL_FOREGROUND_MS = 30_000

    /** 后台兜底间隔（仅"未绑定厂商推送"的设备） */
    const val BACKGROUND_FALLBACK_MS = 90_000

    /**
     * Shell 消费方的轮询间隔（ms；0 = 停表，见 [InboxStore.retainPoll] 的合并语义）。
     * 页面级消费方（消息页 10s）另见 [page]。
     */
    fun shell(foreground: Boolean, pushServerBound: Boolean): Int = when {
        foreground -> SHELL_FOREGROUND_MS
        pushServerBound -> 0 // 后台提醒已归厂商推送，本地轮询停表
        else -> BACKGROUND_FALLBACK_MS
    }

    /**
     * 页面级消费方的间隔：页面只在可见（= 前台）时有意义，退到后台即停——
     * 否则消息页的 10s retain 会把 Shell 的后台节奏拉回 10s，后台门控形同虚设。
     */
    fun page(foreground: Boolean, pageMs: Int): Int = if (foreground) pageMs else 0
}
