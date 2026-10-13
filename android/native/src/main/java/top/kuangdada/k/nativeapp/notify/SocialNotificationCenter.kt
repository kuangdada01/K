package top.kuangdada.k.nativeapp.notify

import android.content.Context
import android.util.Log
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import top.kuangdada.k.core.data.InboxStore
import top.kuangdada.k.core.data.NoticePolicy
import top.kuangdada.k.core.data.NotificationSource
import top.kuangdada.k.core.data.RealtimeClient
import top.kuangdada.k.core.data.SessionRepository

/**
 * ============================================================
 * 事件 → 系统通知（**进程级**，不跟任何页面/Activity 的生命周期走）
 * ============================================================
 * 它取代的是原来写在 `AppShell` 里的那段 `LaunchedEffect`（收集 SSE → 拉摘要 → 弹通知）。
 * 那段代码的三个问题，正是"后台收不到通知"的一半原因：
 *
 *  1. **只活在组合树里**：Activity 一销毁就没人收事件（进程还在、连接还在，通知却没了）；
 *  2. 判断"在不在前台"用的是 Compose 状态（见 [AppForeground] 的注释）；
 *  3. 判定规则散在 UI 里，没法单测 —— 现在规则在 `NoticePolicy`（纯函数，有测试），
 *     这里只负责"取摘要 + 落通知"的 I/O。
 *
 * ## 摘要从哪来（不新开接口，也不改服务端）
 *
 *  · 私信 → `conversations()` 的 `username` + `last_message`（服务端已把图片消息拼成占位文案）。
 *    **绝不能用 `history()`**：那个接口**有副作用**，会把对方发来的消息标记成已读 ——
 *    拿它取摘要会静默吃掉未读（这条是既有实现里的血泪注释，照搬）。
 *  · 互动 → `notifications()` 的第一条（列表按时间倒序）。
 *  · 公告 → `myAnnouncements()` 的第一条。
 *
 * 这三份数据现在都由 [InboxStore] 的**单飞刷新**统一承担（原本通知路径与角标路径
 * 各拉一份，一次事件打 4 个请求）。拉取失败就退化成通用文案：
 * 通知栏宁可少说一句，也不能因为一次网络抖动就不提醒。
 *
 * ## 只在"不在前台"时发
 *
 * 前台时页面自己会刷出内容、底部导航也有未读角标（[InboxStore] 保证它一定准），
 * 再弹一次通知栏等于同一件事说两遍。这条规则与 Web 版 `useNativeNotifications` 一致。
 */
class SocialNotificationCenter(
    private val context: Context,
    private val session: SessionRepository,
    private val inbox: InboxStore,
    private val source: NotificationSource,
    private val foreground: AppForeground,
) {

    /**
     * 自己的作用域：挂在进程上（`SupervisorJob` 保证一条事件处理失败不会拖垮整条收集链）。
     * 用 `Dispatchers.Main.immediate` 是为了与 [InboxStore] 的定时器/单飞在同一个调度器上 ——
     * 那些共享状态的读写都假定发生在主线程。
     *
     * 带 [CoroutineExceptionHandler]：`launch` 里未捕获的异常会冒到线程的未捕获异常处理器
     * （= 崩掉整个 App），而这里处理的是"别人发了消息"这种后台杂活 —— 宁可丢一条通知，
     * 也不能让用户在后台被闪退。
     */
    private val scope = CoroutineScope(
        SupervisorJob() + Dispatchers.Main.immediate +
            CoroutineExceptionHandler { _, e -> Log.e(TAG, "通知分发异常（已吞掉）", e) }
    )

    private var job: Job? = null

    /** 收件箱快照的观察句柄（轮询兜底那条路径，见 [onSnapshot]） */
    private var watchJob: Job? = null

    /**
     * 上一次"有底"的快照里，每个会话的未读数 / 未读通知数（**轮询兜底的比较基准**）。
     *
     * `null` = 还没打过底：第一份真正对过账的快照只用来当基准、不发通知 ——
     * 否则"进程被杀后由 `START_STICKY` 在后台重启"会把几十条历史未读一次性弹出来。
     */
    private var lastUnreadByPartner: Map<Long, Int>? = null
    private var lastUnreadNotifications: Int? = null

    /** 在 `Application.onCreate` 里调用一次（幂等：重复调用不会挂出第二条收集链） */
    fun start() {
        if (job?.isActive != true) {
            job = scope.launch {
                source.events.collect { event ->
                    // 单条事件处理失败（网络/序列化）不能断掉整条链：下一个事件还得能提醒
                    runCatching { handle(event) }
                }
            }
        }
        if (watchJob?.isActive != true) {
            watchJob = scope.launch {
                inbox.state.collect { snapshot -> runCatching { onSnapshot(snapshot) } }
            }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
        watchJob?.cancel()
        watchJob = null
    }

    /**
     * **轮询兜底**：SSE 可能是"半死连接"（客户端读超时是 0、OkHttp 不开 TCP keepalive，
     * 链路假死时读会永远挂着、不报错也不重连），那时"事件"这条路彻底断了，
     * 唯一还能发现"未读涨了"的就是 [InboxStore] 的轮询（前台 30s；
     * 后台仅"未绑定厂商推送"的设备保留 90s 低频，见 [InboxPollCadence]）。
     *
     * 2026-10-07 的真机事故正是这样：服务端日志 `SSE 推送时无在线连接（事件已丢弃）`，
     * 而客户端这边"只有角标会更新、通知永远不发" —— 因为这条兜底路径当时还不存在。
     *
     * ## 为什么不怕与事件路径重复提醒
     *
     * 私信通知 id = `基准 + 对方 id`、互动通知是固定 id：同一个人再发一条只会**覆盖**上一条，
     * 不会叠出两条。所以"事件先发、轮询又补一次"是安全的，反过来也一样。
     */
    private suspend fun onSnapshot(snapshot: InboxStore.Snapshot) {
        if (!snapshot.loadedOnce) return // 还没对过账：拿不到可信的未读，不能当基准

        val prev = lastUnreadByPartner
        val prevNotif = lastUnreadNotifications
        lastUnreadByPartner = snapshot.conversations.associate { it.raw.partnerId to it.raw.unreadCount }
        lastUnreadNotifications = snapshot.notifications.count { !it.raw.isRead }
        if (prev == null || prevNotif == null) return // 第一份对过账的快照：只打底，不发
        if (foreground.isForeground) return // 前台不打扰（页面自己有角标与刷新）
        // 已绑定厂商推送的设备：后台提醒由系统推送服务承担（App 进程不参与）。
        // 本地再发就是同一条消息两张卡（本地 id 与推送 id 不同，互相不覆盖）。
        // 基准已更新 —— 解绑推送回前台后，比较基准仍是新鲜的。
        if (KPush.status.value.serverBound) return

        snapshot.conversations
            .filter { (prev[it.raw.partnerId] ?: 0) < it.raw.unreadCount }
            .forEach { conv ->
                SocialNotifier.notifyMessage(
                    context = context,
                    partnerId = conv.raw.partnerId,
                    name = conv.raw.username,
                    preview = conv.raw.lastMessage,
                    badgeCount = snapshot.unreadTotal,
                    // 未读数 → QQ 式计数标题（"昵称(N条新消息)"），见 notifyMessage
                    newCount = conv.raw.unreadCount.coerceAtLeast(1),
                )
            }

        if ((lastUnreadNotifications ?: 0) > prevNotif) {
            val latest = snapshot.notifications.firstOrNull()
            SocialNotifier.notifyInteraction(
                context = context,
                fromName = latest?.raw?.fromUsername,
                type = latest?.raw?.type.orEmpty(),
                content = latest?.raw?.content,
                postId = latest?.raw?.postId,
                badgeCount = snapshot.unreadTotal,
            )
        }
    }

    private suspend fun handle(event: RealtimeClient.Event) {
        if (foreground.isForeground) return
        // 已绑定厂商推送的设备上，这条路径只可能在"退后台的边缘竞态"里执行
        // （SSE 仅前台连接），此时服务端已把手机视为离线、正在发系统推送 ——
        // 本地再发就是两张卡。整段跳过，后台提醒统一归推送（未绑定的设备不受影响）。
        if (KPush.status.value.serverBound) return

        val myUserId = (session.state.value as? SessionRepository.AuthState.LoggedIn)?.user?.id ?: 0L
        when (val notice = NoticePolicy.decide(event, myUserId)) {
            is NoticePolicy.Notice.Message -> {
                // 刷新失败也要提醒（摘要退化成通用文案），所以不看刷新结果
                inbox.refresh()
                val snapshot = inbox.state.value
                val conv = snapshot.conversations
                    .firstOrNull { it.raw.partnerId == notice.partnerId }
                SocialNotifier.notifyMessage(
                    context = context,
                    partnerId = notice.partnerId,
                    name = conv?.raw?.username,
                    preview = conv?.raw?.lastMessage,
                    // 未读总数 → 通知的 setNumber → 桌面图标角标上的数字
                    badgeCount = snapshot.unreadTotal,
                    // 与该会话的未读数 → QQ 式计数标题（"昵称(N条新消息)"）。
                    // 同一个人连发多条时每条事件都会走到这里，通知被同 id 覆盖成一张卡，
                    // 标题里的数字随之涨 —— 最终锁屏上就是 QQ 那种"昵称(N条新消息) + 最新一条"。
                    newCount = (conv?.raw?.unreadCount ?: 1).coerceAtLeast(1),
                )
            }

            is NoticePolicy.Notice.Interaction -> {
                inbox.refresh()
                val snapshot = inbox.state.value
                val latest = snapshot.notifications.firstOrNull()
                SocialNotifier.notifyInteraction(
                    context = context,
                    fromName = latest?.raw?.fromUsername,
                    type = latest?.raw?.type.orEmpty(),
                    content = latest?.raw?.content,
                    // 事件里的 post_id 更可信（它对应"刚发生的这一次"），拿不到才退回列表首条
                    postId = notice.postId ?: latest?.raw?.postId,
                    badgeCount = snapshot.unreadTotal,
                )
            }

            is NoticePolicy.Notice.Announcement -> {
                inbox.refresh()
                val latest = inbox.state.value.announcements.firstOrNull()
                SocialNotifier.notifyAnnouncement(context, latest?.title)
            }

            null -> Unit
        }
    }

    private companion object {
        /** logcat 过滤用：`adb logcat -s KNotify` */
        const val TAG = "KNotify"
    }
}
