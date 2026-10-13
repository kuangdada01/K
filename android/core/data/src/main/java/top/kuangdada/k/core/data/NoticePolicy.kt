package top.kuangdada.k.core.data

/**
 * ============================================================
 * 「这条事件要不要提醒、提醒哪一种」的判定（**纯逻辑**，零 Android 依赖）
 * ============================================================
 * 为什么要把这段从 UI 里抠出来：这段判定原本写在 `AppShell` 的
 * `LaunchedEffect` 里（收集 SSE 事件 → 拉摘要 → 发系统通知），
 * 于是它**只在 Activity 的这棵树活着时存在** —— 用户退到后台、Activity 被系统回收后
 * 就没人收事件了。现在判定归这里（可单测），收发通道归
 * `SocialNotificationCenter`（进程级），两套传输（进程内 SSE / 将来的厂商推送）
 * 共用同一份规则，不会各自漂移。
 *
 * ## 常量规则（都是从既有实现里逐条搬过来的，改一条都要有理由）
 *
 *  · **只提醒"发给我的"**：服务端对私信的**收发双方**都推 `message` 事件
 *    （见 `server/src/services/message.service.ts` 的 `notifyUser(receiverId)` +
 *    `notifyUser(senderId)`），所以自己发的那个回声（`to != me`）必须在这里挡掉，
 *    否则"我自己在手机上发给别人"会弹一条"有人给我发消息"。
 *  · **撤回不算新消息**：服务端撤回走的是**同一个 `message` 类型**
 *    （`{ from, to, recalled }`），只认 `isNewMessage` 才不会把"对方撤回一条"
 *    提示成"对方给你发了一条消息"。
 *  · **未知 type 不猜**：服务端以后加事件类型时，旧客户端安静忽略 —— 宁可少提醒一条，
 *    也不能显示一句错的文案。
 *  · **拿不到 from 就不提醒**：通知点击要走 `chat:<partnerId>` 深链，
 *    没有对方 id 的通知点进去只会落到消息页，不如不发。
 */
object NoticePolicy {

    /** 值得提醒的一类事件（已剔除回声、撤回、未知类型） */
    sealed interface Notice {

        /** 新私信：`partnerId` 既是通知 id 的一部分，也是点击后深链的目标（`chat:<id>`） */
        data class Message(val partnerId: Long) : Notice

        /**
         * 互动（有人评论了你的帖子 / 回复了你的评论）。
         *
         * @param postId 通知里带 `post_id` 才能点进那条帖子；为 null 时退到消息页
         */
        data class Interaction(val postId: Long?) : Notice

        /** 新公告（点了去公告页，「公告」没有单独的详情深链） */
        data class Announcement(val announcementId: Long?) : Notice
    }

    /**
     * @param myUserId 当前登录用户 id（<= 0 表示还不知道自己是谁 → 私信一律不提醒，
     *   因为无法区分"发给我"和"我发的"）
     */
    fun decide(event: RealtimeClient.Event, myUserId: Long): Notice? = when {
        // 只认"发给我的新消息"（`isMessage` 含着撤回，必须用 isNewMessage）
        event.isNewMessage && myUserId > 0L && event.to == myUserId -> {
            event.from?.let { Notice.Message(it) }
        }

        event.isNotification -> Notice.Interaction(event.postId)

        event.isAnnouncement -> Notice.Announcement(event.announcementId)

        else -> null
    }
}
