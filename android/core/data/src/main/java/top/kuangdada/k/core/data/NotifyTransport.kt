package top.kuangdada.k.core.data

import kotlinx.coroutines.flow.SharedFlow

/**
 * ============================================================
 * 通知事件的**传输抽象**（"谁把事件送进来"）
 * ============================================================
 * 现在只有一种实现：进程内 SSE（[RealtimeClient]）—— App 在前台时的事件流。
 *
 * ⚠️ 厂商推送（OPPO）**不经过本接口**：后台/被杀时的通知栏消息由**系统推送服务**
 * 直接接收并展示（App 进程不参与），点击时走 `deep_link` 深链回到 App
 * （见 MainActivity 的深链解析）。服务端在"没有 android 在线连接"时改投推送
 * （server/src/sse.ts），所以 SSE 缺席不会丢消息。
 *
 * 事件的消费方只认这个接口：判定在 [NoticePolicy]（纯函数）、分发在
 * `SocialNotificationCenter`、落通知在 `SocialNotifier`、角标在 [InboxStore]。
 */
interface NotificationSource {

    /**
     * 服务端推来的事件流（多个消费者可同时收集）。
     *
     * 复用 [RealtimeClient.Event] 而不是另立一套 DTO：事件形状由服务端唯一决定
     * （`shared/src/schemas/sse.ts` 的判别联合），客户端再定义一份必然会漂移。
     */
    val events: SharedFlow<RealtimeClient.Event>
}
