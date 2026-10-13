package top.kuangdada.k.core.data

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import top.kuangdada.k.core.data.model.AnnouncementDto

/**
 * ============================================================
 * 收件箱状态（会话 / 通知 / 公告 / 未读角标）—— 全 App **唯一**一份
 * ============================================================
 * 与 Web 版 `client/src/state/inboxStore.ts` **同一套语义**（那份是参考实现，逐条对齐）。
 *
 * ## 为什么必须要有它（用户实测反馈）
 *
 * 「**在 App 里消息页也没有角标，一定要点进消息页才看到消息来了**」。
 *
 * 原生端原来的两个来源是：
 *  · `AppShell` 收集 SSE 事件时顺手调一次 `unreadTotal()` —— **只有事件到达才会更新**；
 *  · 消息页自己 `load()` 后 `onUnreadChanged(...)` 回填 —— **只有进过那一页才有值**。
 *
 * 于是：冷启动（或进程被系统冻结/回收后重新打开）时角标**必然是 0**，
 * 而连接一旦漏掉事件，角标就再也补不回来 —— 服务端**没有离线补偿**
 * （`server/src/sse.ts` 的 `notifyUser`：没有在线连接就把事件丢弃），
 * 漏掉的事件只会永远消失。Web 版当年正是为此加了"挂载即拉 + 合并轮询"，
 * 原生重写时漏了这一层。
 *
 * ## 它有四个刷新来源，缺一不可
 *
 *  1. **挂载即拉**（App 启动 / 打开消息页时的第一次 `refresh()`）；
 *  2. **SSE 事件**（[start] 里订阅）：最快，正常情况下的主路径；
 *  3. **回前台对账**（`AppShell` 的 ON_START）：把"冻结/断网期间错过的一切"一次补齐；
 *  4. **轮询兜底**（[retainPoll]）：防 SSE **半死连接** —— 客户端读超时是 0、
 *     OkHttp 也不开 TCP keepalive，链路假死时读会永远挂着、不报错也不重连，
 *     光看 SSE 状态是"已连接"。节奏由消费方决定（Shell/消息页按前后台与
 *     推送绑定状态 retain 不同间隔，见 native 的 `InboxPollCadence`）。
 *
 * ## 两条不能丢的约束
 *
 *  · **单飞**（[refresh]）：SSE 事件会同一刻打给多个消费方（角标、消息页、通知中心），
 *    不去重的话一次事件会打出好几份一模一样的请求（Web 版就是这么踩出来的）。
 *  · **失败保留上一次快照**：一次网络抖动不能把已经画好的列表清空、也不能把角标清零，
 *    更不能让"加载失败"顶掉一屏本来好好的内容（所以 `error` 只在**列表本来就是空**时
 *    才对外暴露）。
 */
class InboxStore(
    private val messages: MessageRepository,
    private val admin: AdminRepository,
    private val session: SessionRepository,
    private val source: NotificationSource,
    /** 所有的定时器与在途请求都挂在这个作用域（进程级，见 `AppGraph.appScope`） */
    private val scope: CoroutineScope,
) {

    /**
     * 一份**不可变**的收件箱快照。
     *
     * @param unreadTotal 导航胶囊角标 = 私信未读 + 通知未读（与 Web `selectUnreadTotal` 同口径；
     *   只算私信的话「通知」分段有了红点而导航不亮，用户会以为漏了消息）
     * @param loadedOnce 区分"还没拉到"与"拉到了确实是空" —— 空态/骨架屏都靠它
     */
    data class Snapshot(
        val conversations: List<MessageRepository.ConversationUi> = emptyList(),
        val notifications: List<MessageRepository.NotificationUi> = emptyList(),
        val announcements: List<AnnouncementDto> = emptyList(),
        val unreadTotal: Int = 0,
        val announcementsUnread: Int = 0,
        val loading: Boolean = false,
        val error: String? = null,
        val notifError: String? = null,
        val loadedOnce: Boolean = false,
    )

    /**
     * 初始快照直接用仓库的**进程内缓存**：切走再回来（消息页离开组合）时不空白、不转圈。
     * 缓存本身按用户 id 隔离（见 `MessageRepository.cachedConversations`）。
     */
    private val _state = MutableStateFlow(
        Snapshot(
            conversations = messages.cachedConversations,
            notifications = messages.cachedNotifications,
        )
    )

    val state: StateFlow<Snapshot> = _state.asStateFlow()

    /** 上次刷新对应的用户 id：换账号时整份快照必须丢掉，否则会闪出上一个人的会话 */
    private var ownerId: Long = session.tokens.userId

    /** 在途刷新的**单飞**句柄（见类注释） */
    private var inFlight: Job? = null

    private val pollPlan = InboxPollPlan()
    private var pollJob: Job? = null

    /** 当前定时器用的间隔（与 [InboxPollPlan.cadence] 比对，决定要不要重建定时器） */
    private var activeCadence = 0

    private var eventJob: Job? = null

    // ------------------------------------------------------------------
    // 刷新
    // ------------------------------------------------------------------

    /**
     * 拉一次收件箱（会话 + 通知 + 公告），并把未读角标一起算出来。
     *
     * 单飞：已经在拉的时候**复用同一次请求**（并发调用者只等它结束），
     * 所以"SSE 事件 + 轮询 + 回前台对账"同时发生也只会打一份请求。
     */
    suspend fun refresh() {
        if (!session.isLoggedIn) {
            resetForLogout()
            return
        }
        val running = inFlight
        if (running != null) {
            running.join()
            return
        }
        val job = scope.launch(start = CoroutineStart.LAZY) { runRefresh() }
        inFlight = job
        job.invokeOnCompletion { if (inFlight === job) inFlight = null }
        job.start()
        job.join()
    }

    /** 退出登录：清空快照（角标立刻归零，别留着上一个人的未读数） */
    private fun resetForLogout() {
        ownerId = 0L
        _state.value = Snapshot()
    }

    private suspend fun runRefresh() {
        val owner = session.tokens.userId
        if (owner != ownerId) {
            // 换账号：先把快照清空（不保留、也不从仓库缓存取），避免闪出上一个人的会话
            ownerId = owner
            _state.value = Snapshot(loading = true)
        } else {
            // 有缓存就不显示骨架屏（只在"第一次拉"时 loading）
            _state.update { it.copy(loading = !it.loadedOnce) }
        }

        // 三个接口并行：串行的话角标延迟 = 三次 RTT 之和（与 Web 版 Promise.all 同理）
        val (conv, notif, ann) = coroutineScope {
            val conversations = async { messages.conversations() }
            val notifications = async { messages.notifications() }
            val announcements = async { admin.myAnnouncements() }
            Triple(conversations.await(), notifications.await(), announcements.await())
        }

        _state.update { prev ->
            val conversations = (conv as? ApiResult.Success)?.data ?: prev.conversations
            val notifications = (notif as? ApiResult.Success)?.data ?: prev.notifications
            val announcements = (ann as? ApiResult.Success)?.data ?: prev.announcements
            prev.copy(
                conversations = conversations,
                notifications = notifications,
                announcements = announcements,
                unreadTotal = conversations.sumOf { it.raw.unreadCount } +
                    notifications.count { !it.raw.isRead },
                announcementsUnread = announcements.count { !it.read },
                loading = false,
                loadedOnce = true,
                // 只有"手里本来就是空的"才对外报错：拉取失败不该把已经画好的列表换成错误页
                error = (conv as? ApiResult.Failure)
                    ?.takeIf { conversations.isEmpty() }?.error?.displayMessage,
                notifError = (notif as? ApiResult.Failure)
                    ?.takeIf { notifications.isEmpty() }?.error?.displayMessage,
            )
        }
    }

    // ------------------------------------------------------------------
    // 事件驱动 + 轮询
    // ------------------------------------------------------------------

    /**
     * 把一条互动通知标记为已读（消息页点通知时调用）。
     *
     * **先改本地快照再打接口**：点击会立刻跳去帖子详情，等接口回来时页面已经切走了，
     * 那份"未读红点"要到下次刷新才消失 —— 用户看到的就是"点了还是未读"。
     * 本地先置位后红点与角标当场更新；接口失败不回滚（已读是弱语义，不值得把红点弹回来）。
     *
     * （这两句是从 `MessageRepository.markNotificationRead` 的注释里搬过来的，但那边
     *  只改了**仓库缓存**，而列表渲染用的是页面自己的状态 —— 所以那句承诺当时其实没有兑现。
     *  现在快照是唯一来源，承诺才真的成立。）
     */
    suspend fun markNotificationRead(id: Long) {
        _state.update { prev ->
            val notifications = prev.notifications.map {
                if (it.raw.id == id) it.copy(raw = it.raw.copy(read = 1)) else it
            }
            prev.copy(
                notifications = notifications,
                unreadTotal = prev.conversations.sumOf { it.raw.unreadCount } +
                    notifications.count { !it.raw.isRead },
            )
        }
        messages.markNotificationRead(id)
    }

    /**
     * 订阅 [NotificationSource]：任何"可能改变未读"的事件都立刻刷一次。
     *
     * 注意这里**不判断 `appInForeground`** —— 列表与角标在前台后台都该是对的；
     * "要不要弹通知栏"是另一件事（`SocialNotificationCenter` 负责）。
     */
    fun start() {
        if (eventJob?.isActive == true) return
        eventJob = scope.launch {
            source.events.collect { event ->
                // 撤回也走 message 事件（会改 last_message），所以判 isMessage 而不是 isNewMessage
                if (event.isMessage || event.isNotification || event.isAnnouncement) refresh()
            }
        }
    }

    /**
     * 注册一个轮询消费方，返回释放函数（**合并轮询**：多个消费方只有一根定时器，
     * 按最小间隔走；全部释放后停表）。
     *
     * 现有消费方：`AppShell`（前台 30s / 后台按推送绑定 90s 或停表）与消息页（10s，仅前台）。
     * 不合并的话，光消息页开着就会有 2 根定时器各拉同样的三个接口。
     * （前后台与推送绑定的节奏判定在 native 的 `InboxPollCadence`：后台提醒已绑定
     * 厂商推送的设备归推送管，未绑定的靠 90s 低频轮询兜底。）
     */
    fun retainPoll(cadenceMs: Int): () -> Unit {
        val id = pollPlan.retain(cadenceMs)
        syncPoll()
        return {
            pollPlan.release(id)
            syncPoll()
        }
    }

    private fun syncPoll() {
        val cadence = pollPlan.cadence
        if (cadence == activeCadence && pollJob?.isActive == (cadence > 0)) return
        pollJob?.cancel()
        pollJob = null
        activeCadence = cadence
        if (cadence > 0) {
            pollJob = scope.launch {
                while (isActive) {
                    delay(cadence.toLong())
                    if (!session.isLoggedIn) continue // 登出后不空转网络
                    refresh()
                }
            }
        }
    }
}

/**
 * 合并轮询的**间隔计算**（纯逻辑，独立出来是为了能单测：
 * "多个消费方取最小间隔、全部释放后归零"这条规则错了只会表现为
 * 「莫名其妙一直在轮询」或「该轮询时不轮询」，肉眼很难发现）。
 */
class InboxPollPlan {

    private val retains = LinkedHashMap<Int, Int>()
    private var seq = 0

    /** 当前生效的间隔（ms）；0 = 没有消费方，应当停表 */
    var cadence: Int = 0
        private set

    /** 注册一个消费方，返回它的 id（[release] 时用） */
    fun retain(cadenceMs: Int): Int {
        val id = ++seq
        retains[id] = cadenceMs
        recompute()
        return id
    }

    fun release(id: Int) {
        retains.remove(id)
        recompute()
    }

    private fun recompute() {
        cadence = retains.values.minOrNull() ?: 0
    }
}
