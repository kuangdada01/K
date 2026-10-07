package top.kuangdada.k.nativeapp.notify

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import top.kuangdada.k.nativeapp.MainActivity
import top.kuangdada.k.nativeapp.R

/**
 * ============================================================
 * 社交通知（新私信 / 互动 / 公告）
 * ============================================================
 * 用户反馈："收到消息没有通知栏弹窗" —— 在这之前原生端**只有两类通知**：
 * 语音房前台服务（保活凭据）与 APK 更新下载，**业务消息一条都没有**。
 *（`POST_NOTIFICATIONS` 虽然在 Manifest 里声明过，但代码从没申请过运行时权限，
 *  所以 Android 13+ 上连那两条也不会显示，见 [hasPermission]。）
 *
 * ## 触发链路（谁调用这里）
 *
 * `AppShell` 收集 SSE 事件流，**只在 App 不在前台时**落到这里
 * （前台时页面自己有未读角标与刷新，再弹通知栏是打扰）。
 * 详见 `AppShell` 里那段事件分发的注释。
 *
 * ## 两类渠道，而不是一个
 *
 * · [CHANNEL_MESSAGES]（IMPORTANCE_HIGH）：私信。要横幅 + 提示音，这是"有人在等我回话"。
 * · [CHANNEL_ACTIVITY]（IMPORTANCE_DEFAULT）：互动与公告。有声音但不做横幅，
 *   避免"有人评论了你的帖子"把整屏盖住。
 *
 * 分开的另一个理由：**用户可以单独静音某一类**（Android 设置里按渠道控制）。
 * 合成一个渠道的话，"只想关掉点赞提醒、保留私信"就做不到。
 *
 * ## 通知 id 的策略
 *
 * · 私信：`[ID_MESSAGE_BASE] + 对方 id` —— **每个会话占一条**，同一个人的新消息
 *   覆盖上一条（而不是叠出一串），不同会话并排显示。这正是微信那种观感。
 * · 互动 / 公告：固定 id —— 同类只留最新一条，因为它们是"看一眼就过去"的通知。
 *
 * `PendingIntent` 的 requestCode 必须跟着 id 走，否则系统的"相同 requestCode 视为同一个
 * PendingIntent"规则会让后建的通知点开跳到**前一个**会话（`FLAG_UPDATE_CURRENT` 只更新
 * extra，不会把它变成另一个目标）。
 */
object SocialNotifier {

    private const val CHANNEL_MESSAGES = "k_messages"
    private const val CHANNEL_ACTIVITY = "k_activity"

    /** 私信通知 id 的基准值：留出低位给"对方 id"，避免和下面的固定 id 撞号 */
    private const val ID_MESSAGE_BASE = 10_000
    private const val ID_INTERACTION = 90_001
    private const val ID_ANNOUNCEMENT = 90_002

    /**
     * 正文最多保留这么多字符。
     *
     * 通知栏折叠态大约能放 40~50 个汉字，超出的部分在展开态（`BigTextStyle`）才看得到。
     * 这里截到 120 留足展开态的内容，同时避免整篇长评论把通知撑成一块板。
     */
    private const val MAX_BODY_CHARS = 120

    // ------------------------------------------------------------------
    // 对外入口
    // ------------------------------------------------------------------

    /**
     * 新私信。
     *
     * @param partnerId 对方 id：既是通知 id 的一部分，也是点击后深链的目标（`chat:<id>`）
     * @param name      对方昵称（拉不到时回落到"新消息"）
     * @param preview   内容摘要；服务端对图片消息已经给了占位文案（`[图片]` 之类）
     */
    fun notifyMessage(context: Context, partnerId: Long, name: String?, preview: String?) {
        post(
            context = context,
            channelId = CHANNEL_MESSAGES,
            id = messageNotificationId(partnerId),
            title = name?.takeIf { it.isNotBlank() } ?: context.getString(R.string.notify_fallback_sender),
            body = preview?.takeIf { it.isNotBlank() }
                ?: context.getString(R.string.notify_fallback_preview),
            deepLink = "chat:$partnerId",
            icon = R.drawable.ic_notify_message,
        )
    }

    /**
     * 互动通知（有人评论了你的帖子 / 回复了你的评论）。
     *
     * @param type 服务端 `NotificationDto.type`：`comment`（评论帖子）或 `reply`（回复评论）；
     *   未知取值不猜测，直接用通用文案 —— 服务端以后加类型时这里不会显示错话。
     */
    fun notifyInteraction(
        context: Context,
        fromName: String?,
        type: String,
        content: String?,
        postId: Long?,
    ) {
        val action = when (type) {
            "comment" -> context.getString(R.string.notify_action_comment)
            "reply" -> context.getString(R.string.notify_action_reply)
            else -> context.getString(R.string.notify_action_generic)
        }
        val who = fromName?.takeIf { it.isNotBlank() }
            ?: context.getString(R.string.notify_fallback_sender)
        val detail = content?.takeIf { it.isNotBlank() }
        post(
            context = context,
            channelId = CHANNEL_ACTIVITY,
            id = ID_INTERACTION,
            // 标题放人名（与系统短信/微信一致：先看"谁"，再看"干了什么"）
            title = who,
            body = if (detail != null) "$action：$detail" else action,
            // 通知里带 post_id 才能点进那条帖子；没有就退到消息页（那里能看到全部互动）
            deepLink = if (postId != null && postId > 0) "post:$postId" else "messages",
            icon = R.drawable.ic_notify_activity,
        )
    }

    /** 新公告。公告目前只有标题，正文直接用标题。 */
    fun notifyAnnouncement(context: Context, title: String?) {
        post(
            context = context,
            channelId = CHANNEL_ACTIVITY,
            id = ID_ANNOUNCEMENT,
            title = context.getString(R.string.notify_announcement_title),
            body = title?.takeIf { it.isNotBlank() }
                ?: context.getString(R.string.notify_announcement_fallback),
            deepLink = "announcements",
            icon = R.drawable.ic_notify_activity,
        )
    }

    /**
     * 撤掉某个会话的通知（用户已经点进去看了）。
     *
     * `autoCancel` 只在"点了这条通知"时生效；用户从消息列表点进会话、或从别处进来时，
     * 那条通知会一直挂着，看着像"还没读"。会话页进入时主动清一次最省事。
     */
    fun clearMessage(context: Context, partnerId: Long) {
        runCatching {
            NotificationManagerCompat.from(context).cancel(messageNotificationId(partnerId))
        }
    }

    /** 清掉全部社交通知（退出登录时用：换账号后不该留着上一个人的消息） */
    fun clearAll(context: Context) {
        runCatching {
            val nm = NotificationManagerCompat.from(context)
            nm.cancel(ID_INTERACTION)
            nm.cancel(ID_ANNOUNCEMENT)
            // 私信通知的 id 是"基准 + 对方 id"，没法枚举 → 走 cancelAll，
            // 它同时会清掉语音房那条前台服务通知（那条在退房时会自己回来，无害）
            nm.cancelAll()
        }
    }

    // ------------------------------------------------------------------
    // 内部
    // ------------------------------------------------------------------

    /** 每个会话一条通知：同一个人的新消息覆盖上一条 */
    private fun messageNotificationId(partnerId: Long): Int =
        ID_MESSAGE_BASE + (partnerId % 10_000L).toInt()

    /**
     * Android 13+ 需要运行时通知权限。
     *
     * 没权限时 `notify()` 是**静默失败**（不抛异常、也不显示），所以这里先判一次：
     * 至少能在调用点知道"用户关掉了通知"，而不是对着空白通知栏排查。
     */
    fun hasPermission(context: Context): Boolean =
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            NotificationManagerCompat.from(context).areNotificationsEnabled()
        } else {
            context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) ==
                android.content.pm.PackageManager.PERMISSION_GRANTED
        }

    private fun post(
        context: Context,
        channelId: String,
        id: Int,
        title: String,
        body: String,
        deepLink: String,
        icon: Int,
    ) {
        ensureChannels(context)
        val nm = NotificationManagerCompat.from(context)
        // 没开通知就直接不发：Android 13+ 未授权时 notify 是静默失败，不必等到系统层丢
        if (!nm.areNotificationsEnabled()) return

        // 点击回到 App 并落到对应页面：走 `deep_link` extra，
        // 与语音房通知 / 站内链接**同一条解析路径**（`DeepLink.fromIntent` + MainActivity）。
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("deep_link", deepLink)
        }
        val pending = PendingIntent.getActivity(
            context,
            id, // requestCode 跟通知 id 走，见类注释
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val text = body.take(MAX_BODY_CHARS)
        val notification = NotificationCompat.Builder(context, channelId)
            .setSmallIcon(icon)
            .setContentTitle(title)
            .setContentText(text)
            // 展开态显示完整正文：长评论被折叠成一行时用户看不出到底说了什么
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(pending)
            // 点了就消失（"已读"由进页面时的 markRead 负责，不该再挂一条）
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .build()

        // Android 13+ 的 POST_NOTIFICATIONS 是运行时权限：在调用点内联 checkSelfPermission
        // （lint 的 MissingPermission 只识别同方法内的显式检查；areNotificationsEnabled
        // 只反映渠道/总开关，不等于运行时授权）。拒绝时直接不发，
        // runCatching 仍兜底 SecurityException，但正常路径不依赖异常流。
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
            android.content.pm.PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        runCatching { nm.notify(id, notification) }
    }

    /**
     * 建渠道（幂等）。
     *
     * 必须在**发出第一条通知之前**建好：Android 8+ 上往一个不存在的渠道发通知
     * 同样是静默丢弃。
     */
    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_MESSAGES) == null) {
            manager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_MESSAGES,
                    context.getString(R.string.notify_channel_messages),
                    // HIGH：私信要横幅 + 声音 —— "有人在等我回话"
                    NotificationManager.IMPORTANCE_HIGH,
                ).apply { description = context.getString(R.string.notify_channel_messages_desc) }
            )
        }
        if (manager.getNotificationChannel(CHANNEL_ACTIVITY) == null) {
            manager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ACTIVITY,
                    context.getString(R.string.notify_channel_activity),
                    // DEFAULT：有声音但不横幅，别把"有人评论了你的帖子"盖住整屏
                    NotificationManager.IMPORTANCE_DEFAULT,
                ).apply { description = context.getString(R.string.notify_channel_activity_desc) }
            )
        }
    }
}
