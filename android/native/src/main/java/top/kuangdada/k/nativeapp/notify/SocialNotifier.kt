package top.kuangdada.k.nativeapp.notify

import android.app.NotificationChannel
import android.app.NotificationManager
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.util.Log
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
 * 语音房前台服务（前台服务凭据）与 APK 更新下载，**业务消息一条都没有**。
 *（`POST_NOTIFICATIONS` 虽然在 Manifest 里声明过，但代码从没申请过运行时权限，
 *  所以 Android 13+ 上连那两条也不会显示，见 [hasPermission]。）
 *
 * ## 触发链路（谁调用这里）
 *
 * `SocialNotificationCenter`（进程级）订阅事件流，**只在 App 不在前台时**落到这里
 * （前台时页面自己有未读角标与刷新，再弹通知栏是打扰）。
 *
 * ⚠️ 它只覆盖"App 进程活着"的窗口。App 退后台/被杀后的提醒由 **OPPO 离线推送**
 * 承担（系统推送服务直接展示通知，不经过本进程，见 `KPush` 与
 * docs/android-background-notify-plan.md §7）。
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
 * · 私信：**每个会话占一条**，同一个人的新消息
 *   覆盖上一条（而不是叠出一串），不同会话并排显示。这正是微信那种观感。
 *   id 由「落盘映射 partnerId → 槽位」分配（[MessageNotifyIdSlots]）：直接取模的话，
 *   两个 id 相差整数倍槽位数的人会撞号（A 的通知被 B 覆盖、撤错会话）。
 * · 互动 / 公告：固定 id —— 同类只留最新一条，因为它们是"看一眼就过去"的通知。
 *
 * `PendingIntent` 的 requestCode 必须跟着 id 走，否则系统的"相同 requestCode 视为同一个
 * PendingIntent"规则会让后建的通知点开跳到**前一个**会话（`FLAG_UPDATE_CURRENT` 只更新
 * extra，不会把它变成另一个目标）。
 */
object SocialNotifier {

    private const val CHANNEL_MESSAGES = "k_messages_v2"
    private const val CHANNEL_ACTIVITY = "k_activity_v2"

    /**
     * 0.1.x 早期版本建过的渠道 id（只用于升级时删除）。
     *
     * ⚠️ **渠道的重要性/提示音/震动一旦创建就改不了**（Android 的设计：用户自己可以调，
     * 应用不能覆盖）。2026-10-07 的反馈是「通知能弹出来，但没有声音和震动」，
     * 而当时那两个渠道是**没有显式指定提示音与震动**建出来的 —— 于是换了新 id 重建，
     * 并把旧渠道删掉（不删的话系统设置里会留两条永远不会再亮的渠道）。
     */
    private const val CHANNEL_MESSAGES_LEGACY = "k_messages"
    private const val CHANNEL_ACTIVITY_LEGACY = "k_activity"

    /**
     * 历史遗留的通知渠道 id（只用于升级时删除）。
     *
     * `k_background_v2` / 更早的 `k_background` 是已废弃的后台提醒渠道，
     * 不再有任何代码往它们发通知；清库走 [ensureChannels] —— 不删的话
     * 用户的系统通知设置里会留一条永远不会再亮的渠道。
     */
    private const val CHANNEL_BACKGROUND_DEPRECATED = "k_background_v2"

    /** 0.1.3 用过的旧渠道 id（只用于升级时删除） */
    private const val CHANNEL_BACKGROUND_LEGACY = "k_background"

    /**
     * 私信通知 id 的槽位区间：`[ID_MESSAGE_BASE, ID_INTERACTION)`（8 万个），
     * 避免和下面的固定 id 撞号。internal：槽位分配器（[MessageNotifyIdSlots]）要对齐边界。
     */
    internal const val ID_MESSAGE_BASE = 10_000
    internal const val ID_INTERACTION = 90_001
    private const val ID_ANNOUNCEMENT = 90_002

    /** 「发送测试通知」用的固定 id（设置页诊断行） */
    private const val ID_TEST = 90_004

    /**
     * 全屏意图 PendingIntent 的 requestCode 偏移。
     *
     * 全屏意图与点击内容是两个 Intent，只差一个 extra（`filterEquals` 相同）——
     * requestCode 相同的话系统会把它们并成同一个 PendingIntent（类注释里的碰撞规则），
     * 后建的会覆盖先建的。固定错开一个偏移即可：私信 id 上限 19_999、固定 id 到 90_00x，
     * 加偏移后与任何现有 requestCode 都不撞。
     */
    private const val FULL_SCREEN_REQUEST_OFFSET = 100_000

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
     * @param badgeCount 未读总数 → 通知的 `setNumber`，也就是**桌面图标角标**上的数字
     * @param newCount  与该会话的**未读数** → QQ 式计数标题（2026-10-11 反馈）：
     *   同一个人连发多条时通知会被同 id 覆盖成一张卡，标题从"昵称"变成
     *   "昵称(N条新消息)"，正文永远是最新的那条 —— 对齐 QQ 锁屏观感。
     *   N ≤ 1 时退回普通标题（单条消息带计数是噪音）。
     *
     * 通知大图标（头像）按 2026-10-08 的反馈**取消**：不再设 `setLargeIcon`，
     * 通知只保留应用小图标 + 标题 + 正文。连带删除的还有原来的 `avatarLargeIcon` 取图链
     * （Coil + 限时兜底 + 首字圆片），所以这里不再是挂起函数，调用方也不必再拼头像 URL。
     */
    fun notifyMessage(
        context: Context,
        partnerId: Long,
        name: String?,
        preview: String?,
        badgeCount: Int = 0,
        newCount: Int = 1,
    ) {
        val sender = name?.takeIf { it.isNotBlank() }
            ?: context.getString(R.string.notify_fallback_sender)
        post(
            context = context,
            channelId = messagesChannelId(context),
            id = messageNotificationId(context, partnerId),
            title = if (newCount > 1) {
                context.getString(R.string.notify_messages_count, sender, newCount)
            } else {
                sender
            },
            body = preview?.takeIf { it.isNotBlank() }
                ?: context.getString(R.string.notify_fallback_preview),
            deepLink = "chat:$partnerId",
            icon = R.drawable.ic_notify_message,
            badgeCount = badgeCount,
        )
    }

    /**
     * 互动通知（有人评论了你的帖子 / 回复了你的评论）。
     *
     * @param type 服务端 `NotificationDto.type`：`comment`（评论帖子）或 `reply`（回复评论）；
     *   未知取值不猜测，直接用通用文案 —— 服务端以后加类型时这里不会显示错话。
     *
     * 通知大图标（头像）已同样取消，见 [notifyMessage] 的说明。
     */
    fun notifyInteraction(
        context: Context,
        fromName: String?,
        type: String,
        content: String?,
        postId: Long?,
        badgeCount: Int = 0,
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
            badgeCount = badgeCount,
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
            NotificationManagerCompat.from(context).cancel(messageNotificationId(context, partnerId))
            rememberPostedId(context, messageNotificationId(context, partnerId), posted = false)
        }
    }

    /**
     * 清掉全部**社交通知**（退出登录时用：换账号后不该留着上一个人的消息）。
     *
     * ⚠️ **不能用 `NotificationManagerCompat.cancelAll()`**：它会连带清掉
     * **语音房前台服务**那条通知（服务还在跑，通知却没了 —— 用户看不到也退不掉房）。
     * 这里改成按已知 id 逐个撤：
     *  · 本进程发过的（[postedIds]，含"映射分配"那类无法枚举的私信通知 id）；
     *  · 上一次进程发过、还挂在通知栏上的（落盘的 id 集合，见 [KEY_POSTED_IDS]）；
     *  · 两个固定 id（互动 / 公告）。
     * （离线推送的提醒由**系统推送服务**展示，不经过本进程，天然不在清理范围里。）
     */
    fun clearAll(context: Context) {
        runCatching {
            val nm = NotificationManagerCompat.from(context)
            val ids = mutableSetOf(ID_INTERACTION, ID_ANNOUNCEMENT)
            synchronized(postedIds) {
                ids += postedIds
                postedIds.clear()
            }
            ids += persistedPostedIds(context)
            ids.forEach { nm.cancel(it) }
            postedPrefs(context).edit().remove(KEY_POSTED_IDS).apply()
        }
    }

    // ------------------------------------------------------------------
    // 内部
    // ------------------------------------------------------------------

    /**
     * 本进程发过的通知 id（[clearAll] 与 [clearMessage] 用）。
     *
     * 私信通知的 id 经落盘映射分配（[MessageNotifyIdSlots]），**没法枚举**（对方 id 是任意 long）——
     * 所以只能"发的时候记一笔"。同一个 id 还要**落盘**：进程重启后通知栏里
     * 仍可能挂着上一个进程发的通知，只靠内存集合会在退登时漏清
     * （换账号后看到上一个人的消息摘要，这是隐私问题，不是观感问题）。
     */
    private val postedIds = mutableSetOf<Int>()

    private fun postedPrefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun persistedPostedIds(context: Context): Set<Int> =
        postedPrefs(context).getStringSet(KEY_POSTED_IDS, emptySet())
            .orEmpty()
            .mapNotNull { it.toIntOrNull() }
            .toSet()

    private fun rememberPostedId(context: Context, id: Int, posted: Boolean) {
        synchronized(postedIds) {
            if (posted) postedIds += id else postedIds -= id
        }
        runCatching {
            val current = persistedPostedIds(context).toMutableSet()
            if (posted) current += id else current -= id
            postedPrefs(context).edit()
                .putStringSet(KEY_POSTED_IDS, current.map { it.toString() }.toSet())
                .apply()
        }
    }

    /** 每个会话一条通知：同一个人的新消息覆盖上一条 */
    private fun messageNotificationId(context: Context, partnerId: Long): Int {
        val slots = messageIdSlots(context)
        val isNew = partnerId !in slots.map
        val id = slots.idFor(partnerId)
        if (isNew) persistMessageIdSlots(context, slots)
        return id
    }

    // ------------------------------------------------------------------
    // 私信通知 id 的落盘映射（partnerId → 槽位）
    // ------------------------------------------------------------------
    // ⚠️ 不能用「基准 + partnerId % 槽位数」：两个 id 相差整数倍槽位数的人会共用
    // 同一条通知（A 的被 B 覆盖、点进 A 的会话撤掉 B 的），活跃会话过百后撞号
    // 概率过半（生日界）。改为落盘映射：每个 partner 首次出现时分得下一个空闲槽位
    // （轮转计数，写满 8 万活跃会话才回收最老的），之后终身稳定 —— 分配逻辑在
    // [MessageNotifyIdSlots]（纯逻辑，有单测），这里只负责读写 prefs。

    private const val KEY_MSG_ID_MAP = "msg_notify_id_map"
    private const val KEY_MSG_ID_NEXT = "msg_notify_id_next"

    /** partnerId → 槽位映射的进程内缓存（首次用到时从 prefs 读一次） */
    @Volatile
    private var messageIdSlotsCache: MessageNotifyIdSlots? = null

    private val messageIdSlotsLock = Any()

    private fun messageIdSlots(context: Context): MessageNotifyIdSlots {
        messageIdSlotsCache?.let { return it }
        synchronized(messageIdSlotsLock) {
            messageIdSlotsCache?.let { return it }
            val prefs = postedPrefs(context)
            val map = HashMap<Long, Int>()
            prefs.getStringSet(KEY_MSG_ID_MAP, emptySet()).orEmpty().forEach { entry ->
                val parsed = parseMessageIdEntry(entry)
                if (parsed != null) map[parsed.first] = parsed.second
            }
            val slots = MessageNotifyIdSlots(map, prefs.getInt(KEY_MSG_ID_NEXT, 0))
            messageIdSlotsCache = slots
            return slots
        }
    }

    /** 分配新槽位后落盘（只在"新会话第一次提醒"时发生） */
    private fun persistMessageIdSlots(context: Context, slots: MessageNotifyIdSlots) {
        val prefs = postedPrefs(context)
        prefs.edit()
            .putStringSet(
                KEY_MSG_ID_MAP,
                slots.map.map { (partner, slot) -> formatMessageIdEntry(partner, slot) }.toSet(),
            )
            .putInt(KEY_MSG_ID_NEXT, slots.next)
            .apply()
    }

    /** 单条映射的字符串形态：`partnerId:slot`（lastIndexOf 解析，容忍 id 里的负号） */
    internal fun formatMessageIdEntry(partnerId: Long, slot: Int): String = "$partnerId:$slot"

    internal fun parseMessageIdEntry(entry: String): Pair<Long, Int>? {
        val sep = entry.lastIndexOf(':')
        if (sep <= 0) return null
        val partner = entry.substring(0, sep).toLongOrNull() ?: return null
        val slot = entry.substring(sep + 1).toIntOrNull() ?: return null
        return partner to slot
    }

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

    /**
     * 锁屏亮屏（全屏意图）权限当前是否可用。
     *
     * API 34+ 系统不再默认授予 `USE_FULL_SCREEN_INTENT`（只有通话/闹钟类 App 安装即得），
     * 其余 App 要用户在系统设置里手动开；API 34 以下声明即授予，恒为 true。
     * 诊断行据此决定要不要显示「去开启」入口 —— 不判的话 API 34+ 的机型上
     * 全屏意图静默无效，用户看到的仍是「锁屏不亮屏」。
     */
    fun canFullScreenIntent(context: Context): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            context.getSystemService(NotificationManager::class.java)?.canUseFullScreenIntent() ?: false
        } else {
            true
        }

    /**
     * 全屏意图权限的系统设置页 Intent（仅 API 34+ 有意义，低版本返回 null 不用跳）。
     * 带 package URI 直达本 App 的开关，省得用户在列表里找。
     */
    fun fullScreenIntentSettingsIntent(context: Context): Intent? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            Intent(android.provider.Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT)
                .setData(android.net.Uri.fromParts("package", context.packageName, null))
        } else {
            null
        }

    // 通知大图标（头像）已取消（2026-10-08 反馈）：这里原来有一整条
    // 「Coil 取头像 → 限时兜底 → 首字圆片」的 `avatarLargeIcon` / `letterAvatar` 链，
    // 连同 `LARGE_ICON_PX`、`LARGE_ICON_TIMEOUT_MS` 与 Coil 依赖一起删掉 ——
    // 通知只保留应用小图标 + 标题 + 正文，也不再为一张头像引入 1.2s 的通知延迟风险。

    private fun post(
        context: Context,
        channelId: String,
        id: Int,
        title: String,
        body: String,
        deepLink: String,
        icon: Int,
        /**
         * 未读总数 → `setNumber`。
         *
         * ⚠️ **桌面图标角标（红点/数字）完全由通知驱动**：Android 没有"应用自己设角标"的
         * 公开 API —— 启动器看到这个 App 有活动通知时才点亮角标，数字则取自
         * `setNumber`（支持数字角标的启动器；ColorOS/一加以"通知圆点"形式显示）。
         * 所以"没有通知 = 没有角标"是同一个问题的两面，2026-10-07 的用户反馈正是如此。
         */
        badgeCount: Int = 0,
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

        // 全屏意图用**另一个** PendingIntent：多带一个 `from_full_screen` 标记，
        // MainActivity 只有带它进来才开"画在锁屏之上 + 点亮屏幕"（离开前台即关）。
        // 这两个标志常开的话，"锁屏前开着 App → 按电源键亮屏"会绕过锁屏直接进
        // 可操作的 App（2026-10-11 反馈，见 MainActivity.EXTRA_LAUNCHED_FROM_FULL_SCREEN）。
        val fullScreenPending = PendingIntent.getActivity(
            context,
            id + FULL_SCREEN_REQUEST_OFFSET,
            Intent(intent).putExtra(MainActivity.EXTRA_LAUNCHED_FROM_FULL_SCREEN, true),
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
            // 锁屏亮屏：带全屏意图的通知在锁屏状态下由系统点亮屏幕/在锁屏上展示。
            // 用独立的 fullScreenPending（带 from_full_screen 标记）：点亮后的落点
            // 与点击通知一致（deep_link 解析），但只有这一趟才允许出现在锁屏上。
            // 权限未授予（API 34+ 需用户在系统设置里开）时系统按普通通知处理，不会崩。
            .setFullScreenIntent(fullScreenPending, true)
            // 锁屏上直接显示内容（默认 PRIVATE 会把正文藏成"内容已隐藏"，
            // 亮了屏还得解锁才能看到是谁/说了什么）。介意隐私可改回 PRIVATE ——
            // 亮屏行为不受它影响，只影响锁屏上是否露出正文。
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            // 点了就消失（"已读"由进页面时的 markRead 负责，不该再挂一条）
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            // 桌面角标：数字取未读总数（系统/启动器决定显示圆点还是数字）
            .setNumber(badgeCount.coerceAtLeast(0))
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
        // 记一笔：私信通知的 id 算不出来（见 postedIds 的注释），退登时要按这个集合逐个撤
        rememberPostedId(context, id, posted = true)
    }

    /**
     * 「发送测试通知」——设置页诊断行上的自检按钮。
     *
     * 为什么值得做：通知不响的可能性分散在几层（系统权限 / 应用级开关 / 渠道 / 推送注册），
     * 而用户能描述的只有"我收不到"。这一条通知**不依赖网络、不依赖任何服务**，
     * 按下就发：能弹出来 ⇒ 权限、渠道、通知栏这条链路是通的，问题在推送注册或网络；
     * 弹不出来 ⇒ 问题就在权限或渠道，诊断行会同时显示是哪一层。
     */
    fun notifyTest(context: Context) {
        post(
            context = context,
            channelId = messagesChannelId(context),
            id = ID_TEST,
            title = context.getString(R.string.notify_test_title),
            body = context.getString(R.string.notify_test_body),
            deepLink = "messages",
            icon = R.drawable.ic_notify_message,
            badgeCount = 1,
        )
    }

    /**
     * 诊断：把"通知这条路"上每一道闸门的状态取出来给设置页显示。
     *
     * 加它的理由很直接 —— 「我收不到通知」这个问题现在只能靠用户描述来猜，
     * 而实际可能是几件事里的任意一件（运行时权限 / 应用级开关 / 渠道被删）。
     * 与其每次来回问，不如让用户自己看到哪一道关着。
     * （推送注册那一段的诊断在 `KPush.status`，设置页把两者排在一起显示。）
     */
    data class Diagnostics(
        /** Android 13+ 的运行时权限（低版本恒为 true） */
        val runtimePermission: Boolean,
        /** 应用级通知开关（用户在系统设置里关掉整个 App 的通知时为 false） */
        val notificationsEnabled: Boolean,
        /** 私信渠道还在不在（用户可以在系统设置里删掉某个渠道） */
        val messagesChannel: Boolean,
        /** 互动渠道还在不在 */
        val activityChannel: Boolean,
    )

    fun diagnostics(context: Context): Diagnostics {
        val nm = NotificationManagerCompat.from(context)
        val manager = context.getSystemService(NotificationManager::class.java)
        return Diagnostics(
            runtimePermission = hasPermission(context),
            notificationsEnabled = nm.areNotificationsEnabled(),
            messagesChannel = manager?.getNotificationChannel(messagesChannelId(context)) != null,
            activityChannel = manager?.getNotificationChannel(CHANNEL_ACTIVITY) != null,
        )
    }

    /**
     * 诊断：**声音与震动这条路的实际取值**（不是"我们设置成了什么"，而是"系统现在认什么"）。
     *
     * 2026-10-07 的用户反馈是「通知能弹出来，但没有声音和震动」，而这条路上有五个独立闸门：
     *  1. 手机处于**静音/勿扰**（`ringerMode`）—— 应用再怎么写也不会响；
     *  2. 通知音量被拉到 0；
     *  3. 渠道的重要性（`IMPORTANCE_LOW` 以下不出声）；
     *  4. 渠道的提示音被清成 null；
     *  5. 渠道的震动被关掉。
     * 只看代码里的设置无法区分这五种情况，所以把**取值**上报出来（见 `NotificationCenter` 的诊断上报）。
     */
    data class SoundDiagnostics(
        /** 0=静音 1=震动 2=正常（AudioManager.RINGER_MODE_*） */
        val ringerMode: Int,
        /** 通知音量（0 = 被拉到最低） */
        val notificationVolume: Int,
        /** 渠道重要性（DEFAULT=3 及以上才会有声音） */
        val channelImportance: Int,
        /** 渠道提示音（null/空 = 无声） */
        val channelSound: String?,
        /** 渠道是否允许震动 */
        val channelVibrate: Boolean,
        val notificationsEnabled: Boolean,
    )

    fun soundDiagnostics(context: Context): SoundDiagnostics {
        val manager = context.getSystemService(NotificationManager::class.java)
        val channel = manager?.getNotificationChannel(messagesChannelId(context))
        val audio = context.getSystemService(android.media.AudioManager::class.java)
        return SoundDiagnostics(
            ringerMode = audio?.ringerMode ?: -1,
            notificationVolume = audio?.getStreamVolume(android.media.AudioManager.STREAM_NOTIFICATION) ?: -1,
            channelImportance = channel?.importance ?: -1,
            channelSound = channel?.sound?.toString(),
            channelVibrate = channel?.shouldVibrate() ?: false,
            notificationsEnabled = NotificationManagerCompat.from(context).areNotificationsEnabled(),
        )
    }

    /**
     * 建渠道（幂等）。
     *
     * 必须在**发出第一条通知之前**建好：Android 8+ 上往一个不存在的渠道发通知
     * 同样是静默丢弃。
     *
     * 注意：**渠道一旦建过，重要性就改不动了**（Android 的设计：用户可以自己调，
     * 应用每次启动都改回去等于绕过用户的设置）。所以下面这些 `IMPORTANCE_*`
     * 只对"第一次创建"生效 —— 如果你在开发期调过重要性，得删掉 App 重装才会变。
     */
    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        createMessagesChannel(context, manager, messagesChannelId(context))
        createActivityChannel(context, manager)
        // 升级清理：历史版本的渠道再也发不出通知了（id 换代 / 功能已删），删掉它们，
        // 否则系统通知设置里会留几条永远不会亮起的死渠道（见各 *_LEGACY / *_DEPRECATED 常量）。
        runCatching { manager.deleteNotificationChannel(CHANNEL_BACKGROUND_DEPRECATED) }
        runCatching { manager.deleteNotificationChannel(CHANNEL_BACKGROUND_LEGACY) }
        runCatching { manager.deleteNotificationChannel(CHANNEL_MESSAGES_LEGACY) }
        runCatching { manager.deleteNotificationChannel(CHANNEL_ACTIVITY_LEGACY) }
    }

    /**
     * 当前生效的私信渠道 id。
     *
     * 第 1 代就是常量；一旦发生过一次"自动修复"（见 [migrateSilentChannelIfNeeded]）
     * 就变成 `k_messages_v2_g2`、`_g3` …—— 渠道的提示音/震动**创建后不可修改**，
     * 所以"修"只能是"换一个新 id 重建"。
     */
    fun messagesChannelId(context: Context): String {
        val gen = prefs(context).getInt(KEY_CHANNEL_GEN, 1)
        return if (gen <= 1) CHANNEL_MESSAGES else "${CHANNEL_MESSAGES}_g$gen"
    }

    /**
     * **自动修复"能弹但不响不震"**（用户实测反馈：声音/震动得自己去系统设置里开）。
     *
     * ## 为什么需要它
     *
     * Android 8+ 把提示音与震动绑在**渠道**上，而渠道开关**只有用户能改**
     * （平台的设计：应用不能覆盖用户对某个渠道的选择）。但现实中会出现：
     * 渠道是应用刚建、参数完全正确，却被 ROM 的通知管理**默认按"静默"处理**了 ——
     * 2026-10-07 真机实测上报回来的就是 `channelSound=null` + `channelVibrate=false`
     * 而 `channelImportance=4`（HIGH）：用户什么都没做，就是没声音没震动。
     *
     * ## 修法：换一个新渠道 id 重建（**只做一次**）
     *
     * 建一条参数完全相同的新渠道 → 记下"已自动修过一次" → 删掉旧的。
     * 之后若再被关，就认定那是用户在系统设置里的主动选择，**不再跟他抢**，
     * 只由设置页的诊断行提示 + 提供直达渠道设置的入口。
     */
    fun migrateSilentChannelIfNeeded(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        val p = prefs(context)
        if (p.getBoolean(KEY_CHANNEL_MIGRATED, false)) return

        val legacyId = messagesChannelId(context)
        val current = manager.getNotificationChannel(legacyId) ?: return
        // 只要提示音或震动有一个被关，就当作"被系统静默了"
        if (current.sound != null && current.shouldVibrate()) return

        p.edit().putBoolean(KEY_CHANNEL_MIGRATED, true).apply()
        p.edit().putInt(KEY_CHANNEL_GEN, p.getInt(KEY_CHANNEL_GEN, 1) + 1).apply()
        val freshId = messagesChannelId(context)
        createMessagesChannel(context, manager, freshId)
        runCatching { manager.deleteNotificationChannel(legacyId) }
        Log.i(TAG, "私信渠道被静默（无提示音/震动），已自动迁移：$legacyId → $freshId")
    }

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /**
     * 建私信渠道（**参数唯一来源**：`ensureChannels` 与自动迁移都走它，
     * 免得"迁移出来的渠道"和"正常建的渠道"参数悄悄分叉）。
     */
    private fun createMessagesChannel(context: Context, manager: NotificationManager, id: String) {
        if (manager.getNotificationChannel(id) != null) return
        manager.createNotificationChannel(
            NotificationChannel(
                id,
                context.getString(R.string.notify_channel_messages),
                // HIGH：私信要横幅 + 声音 + 震动 —— "有人在等我回话"
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = context.getString(R.string.notify_channel_messages_desc)
                // 桌面角标（红点/数字）是**渠道级**开关（`Notification.setShowBadge` 不存在，
                // 只有 `NotificationChannel.setShowBadge`）。默认就是 true，写出来是为了
                // 让"角标从哪来"这件事在代码里看得见：渠道允许 → 有活动通知 → 启动器亮角标。
                setShowBadge(true)
                // 提示音与震动**必须显式写**：早期版本没写，真机上就是"能弹但不响不震"。
                // 声音用系统默认通知铃声（用户改了系统铃声也跟着变），属性标成通知类。
                setSound(
                    RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
                    AudioAttributes.Builder()
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                        .build(),
                )
                enableVibration(true)
                // 短-停-短：与系统默认通知震动接近，又不至于长到烦人
                vibrationPattern = longArrayOf(0L, 220L, 120L, 220L)
            }
        )
    }

    /** 互动/公告渠道（DEFAULT：有声音但不横幅，别把"有人评论了你的帖子"盖住整屏） */
    private fun createActivityChannel(context: Context, manager: NotificationManager) {
        if (manager.getNotificationChannel(CHANNEL_ACTIVITY) != null) return
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ACTIVITY,
                context.getString(R.string.notify_channel_activity),
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply {
                description = context.getString(R.string.notify_channel_activity_desc)
                setShowBadge(true)
                setSound(
                    RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
                    AudioAttributes.Builder()
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                        .build(),
                )
                enableVibration(true)
                // 互动通知比私信轻一档：只震一下
                vibrationPattern = longArrayOf(0L, 160L)
            }
        )
    }

    /** 与 AppShell/设置页共用的通知偏好在同一个文件里（`k_notify`） */
    private const val PREFS = "k_notify"

    /** 已发布过的通知 id（退登时按它逐个撤，见 [postedIds]） */
    private const val KEY_POSTED_IDS = "posted_notification_ids"

    /** 私信渠道的"代次"（见 [messagesChannelId]） */
    private const val KEY_CHANNEL_GEN = "messages_channel_gen"

    /** 是否已经自动修复过一次"渠道被静默"（见 [migrateSilentChannelIfNeeded]） */
    private const val KEY_CHANNEL_MIGRATED = "messages_channel_migrated"

    /**
     * logcat 过滤用（与 `KPush` 同一个 tag）：
     * 通知链路的排查日志都聚在 `KNotify` 里，`adb logcat -s KNotify` 一把看全。
     */
    private const val TAG = "KNotify"
}

/**
 * 私信通知 id 的**槽位分配器**（纯逻辑，独立出来是为了能单测）。
 *
 * 每个会话一条通知，id 必须满足两条：
 *  · **同一个 partner 恒定**：同一个人的新消息覆盖上一条（QQ 式合并）；
 *  · **不同 partner 不撞号**：撞号的表现是"A 的通知被 B 覆盖、点进 A 的会话撤掉
 *    B 的通知" —— 取模方案（`基准 + partnerId % 槽数`）在活跃会话过百后撞号
 *    概率过半（生日界），故改为映射分配。
 *
 * 槽位区间 `[SocialNotifier.ID_MESSAGE_BASE, SocialNotifier.ID_INTERACTION)` 共 8 万个；
 * 分配用**轮转计数**（next 递增取模）：写满 8 万活跃会话后才开始回收最老分配的槽位
 * （真到那一天，被回收槽位上的旧通知会被新会话覆盖 —— 概率与代价都趋近于零）。
 *
 * 状态落盘由 [SocialNotifier] 负责（prefs），本类只管分配与计数 —— 纯逻辑无 Android 依赖。
 */
class MessageNotifyIdSlots(
    /** 已分配的映射（进程内缓存，来自落盘） */
    val map: MutableMap<Long, Int> = mutableMapOf(),
    /** 下一个待分配的槽位序号（轮转计数，来自落盘） */
    var next: Int = 0,
) {

    /** 取该 partner 的通知 id；首次出现时分配新槽位并推进计数 */
    fun idFor(partnerId: Long): Int {
        val slot = map.getOrPut(partnerId) {
            val allocated = next % MESSAGE_ID_SLOTS
            next += 1
            allocated
        }
        return MESSAGE_ID_BASE + slot
    }

    companion object {
        /** 槽位区间与 SocialNotifier 的固定 id 段对齐（ [ID_MESSAGE_BASE, ID_INTERACTION) ） */
        const val MESSAGE_ID_BASE = SocialNotifier.ID_MESSAGE_BASE
        const val MESSAGE_ID_SLOTS = SocialNotifier.ID_INTERACTION - SocialNotifier.ID_MESSAGE_BASE
    }
}
