package top.kuangdada.k.nativeapp.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
// httpHeaders 是扩展函数（定义在 coil3.network.ImageRequestsKt），不 import 会报
// "Unresolved reference 'httpHeaders' on receiver of type ImageRequest.Builder"
import coil3.network.httpHeaders
import java.io.File
import kotlin.math.roundToInt
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import top.kuangdada.k.core.data.ApiError
import top.kuangdada.k.core.data.ApiResult
import top.kuangdada.k.core.data.InboxStore
import top.kuangdada.k.core.data.MessageRepository
import top.kuangdada.k.core.data.RealtimeClient
import top.kuangdada.k.core.data.SessionRepository
import top.kuangdada.k.core.data.dayDividerText
import top.kuangdada.k.core.data.displayMessage
import top.kuangdada.k.core.data.image.ImageCompressor
import top.kuangdada.k.core.data.timeGapMillis
import top.kuangdada.k.core.designsystem.component.KButton
import top.kuangdada.k.core.designsystem.component.KButtonVariant
import top.kuangdada.k.core.designsystem.component.KEmojiButton
import top.kuangdada.k.core.designsystem.component.KEmojiPanel
import top.kuangdada.k.core.designsystem.component.KEmojiPanelHeight
import top.kuangdada.k.core.designsystem.component.KPlaceholder
import top.kuangdada.k.core.designsystem.component.KListSkeleton
import top.kuangdada.k.core.designsystem.component.KPlaceholderKind
import top.kuangdada.k.core.designsystem.component.KTextField
import top.kuangdada.k.core.designsystem.component.KTextFieldVariant
import top.kuangdada.k.core.designsystem.component.kShimmer
import top.kuangdada.k.core.designsystem.theme.KElevation
import top.kuangdada.k.core.designsystem.theme.KDimens
import top.kuangdada.k.core.designsystem.theme.KMotion
import top.kuangdada.k.core.designsystem.theme.KMotionOffset
import top.kuangdada.k.core.designsystem.theme.KRadius
import top.kuangdada.k.core.designsystem.theme.KSpacing
import top.kuangdada.k.core.designsystem.theme.KTheme
import com.kyant.backdrop.backdrops.layerBackdrop
import com.kyant.backdrop.backdrops.rememberLayerBackdrop
import top.kuangdada.k.core.designsystem.theme.KType
import top.kuangdada.k.core.designsystem.theme.LocalAnimationsEnabled
import top.kuangdada.k.nativeapp.notify.InboxPollCadence
import top.kuangdada.k.nativeapp.notify.SocialNotifier
import top.kuangdada.k.nativeapp.ui.viewer.rememberImageViewer

/** 本页的轮询间隔（与 Web 版消息页的 `MESSAGES_POLL_MS` 同值；合并后取最小间隔） */
private const val MESSAGES_POLL_MS = 10_000

/**
 * ============================================================
 * 消息（设计稿「消息会话 · 会话列表」——高亮消息 tab）
 * ============================================================
 * 结构（按设计稿 + 用户补充）：
 *  · 页头「消息」（右上角没有按钮 —— 设计稿画了"写消息"铅笔，但原生还没有
 *    「选择私信对象」的入口交互，放了也只能是空按钮，先不加，定了交互再补）；
 *  · 分段「会话 | 通知」：**通知 = 帖子评论/回复的互动通知**（不是公告）；
 *  · 会话列表**第一行固定是「公告」入口**，点进去是公告界面，右侧带公告未读角标；
 *  · 会话卡：圆角 14 白卡，头像 48 + 两行（名字/时间 · 预览/未读角标），上限 `99+`；
 *  · 下拉刷新（原页头那个「刷新」按钮换成了手势，设计稿没有刷新按钮）。
 *
 * ⚠️ 本页**不再自己拉数据、也不再自己算未读**（2026-10 改）：那些都归 [InboxStore]。
 * 它原来持有的 `conversations`/`notifications`/`convUnread` 等 8 个 `remember` 状态，
 * 一旦离开组合就全部丢失 —— 而"离开组合"在本 App 里是常态（切 tab、进二级页）。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MessagesScreen(
    /** SSE 事件流：聊天页仍然直接收它（会话列表/通知改由 [inbox] 统一负责） */
    realtime: RealtimeClient? = null,
    /**
     * 收件箱状态（会话 / 通知 / 公告 / 未读）的**唯一**来源，与导航胶囊角标读同一份。
     *
     * 2026-10 改：本页原来自己维护 `conversations`/`notifications`/`convUnread`/… 一堆
     * `remember` 状态，并靠"进页面时拉一次 + SSE 事件时拉一次"更新 —— 结果是
     * **离开这一页就再没有任何更新**，而 Web 版一直有"合并轮询 + 挂载即拉"这一层
     * （`client/src/state/inboxStore.ts`）。现在统一交给 [inbox]：
     * 本页只是它的一个读者，顺带 retain 一个更快的轮询间隔（10s）。
     */
    inbox: InboxStore,
    isLoggedIn: Boolean,
    /**
     * 进程级前台状态（`AppGraph.foreground.flow`）：本页的 10s 轮询只在**前台**保持——
     * 退到后台后组合树仍存活，无条件的 retain 会把 Shell 的后台节奏
     * （已绑推送停表 / 未绑推送 90s，见 [InboxPollCadence]）拉回 10s。
     */
    foreground: kotlinx.coroutines.flow.StateFlow<Boolean>,
    onOpenChat: (partnerId: Long, username: String?, avatarUrl: String?) -> Unit,
    onOpenAnnouncements: () -> Unit,
    /** 点一条互动通知 → 打开它指向的帖子详情（通知里带 `post_id`） */
    onOpenPost: (Long) -> Unit = {},
    onRequireLogin: () -> Unit,
) {
    val c = KTheme.colors
    val scope = rememberCoroutineScope()

    /**
     * 本页的**轮询消费方**：10s（与 Web 版消息页的 `MESSAGES_POLL_MS` 同值），仅前台。
     *
     * 比 Shell 那份 30s 更快：用户正盯着这一页时，"要等 30 秒才出现"是能被感知到的卡顿。
     * 合并轮询会取最小间隔，全 App 仍然只有一根定时器（离开本页自动降回 30s；
     * 退到后台自动停表 —— 页面本身已不可见，见 [InboxPollCadence.page]）。
     */
    val inboxState by inbox.state.collectAsState()
    val appForeground by foreground.collectAsState()
    val pollMs = InboxPollCadence.page(appForeground, MESSAGES_POLL_MS)
    DisposableEffect(inbox, pollMs) {
        if (pollMs == 0) return@DisposableEffect onDispose { }
        val release = inbox.retainPoll(pollMs)
        onDispose { release() }
    }

    // 快照里的字段直接当成原来的局部状态用（语义一一对应，见 InboxStore.Snapshot）
    val conversations = inboxState.conversations
    val notifications = inboxState.notifications
    val annUnread = inboxState.announcementsUnread
    val loading = inboxState.loading
    val error = inboxState.error
    val notifError = inboxState.notifError
    val convUnread = conversations.sumOf { it.raw.unreadCount }
    val notifUnread = notifications.count { !it.raw.isRead }

    /**
     * 「会话 | 通知」选中项。
     *
     * **必须是 `rememberSaveable`**：点一条通知会跳到帖子详情，本页随之离开组合；
     * 返回时如果是 `remember`，标签会被重置回默认的「会话」——用户看到的正是
     * 「从通知进详情，返回却落在会话列表」（用户实测反馈）。
     *
     * `AppShell` 的 `SaveableStateHolder` 就是为这件事准备的，但它**只覆盖
     * `rememberSaveable` 系**（见那里的注释），所以这里不能省。
     */
    var tabIndex by rememberSaveable { mutableIntStateOf(0) }

    /**
     * 切「会话 | 通知」时**新内容的一次性进场**（M7）。
     *
     * 改之前两个分支是 `if (tabIndex == 1) … else …`：段选中态有过渡之后，列表本身还是硬切
     * （旧列表当场消失、新列表当场出现），药丸在滑、内容却在跳，两半不合拍。
     *
     * **为什么是 `remember(tabIndex)` 而不是一个常驻的 Animatable**：Compose 在 tabIndex 变了
     * 的那一次组合里就会重建它，初值 0 与新内容的**第一帧**对齐。改成"LaunchedEffect 里再
     * `snapTo(0f)`"则会先画出一帧完整内容、然后才跳回透明 —— 那一下闪，正是要避免的。
     *
     * `animationsEnabled` 关掉时初值直接是终态（跟随系统"移除动画"）。
     */
    val animationsEnabled = LocalAnimationsEnabled.current
    // 本次组合是不是"切段"（首屏不做：进页面自己有转场，§6 每屏只留一个主角动效）
    var tabEnterArmed by remember { mutableStateOf(false) }
    val tabEnter = remember(tabIndex) {
        Animatable(if (tabEnterArmed && animationsEnabled) 0f else 1f)
    }
    LaunchedEffect(tabIndex) {
        if (tabEnterArmed && animationsEnabled) {
            tabEnter.animateTo(1f, KMotion.spatial())
        } else {
            tabEnter.snapTo(1f)
        }
        tabEnterArmed = true
    }

    /**
     * 进场方向：按下标 —— 靠后的段从右侧进、靠前的从左侧进。两个段时它正好等于
     * "往哪边切就从哪边进来"（会话 → 通知 从右、通知 → 会话 从左），
     * 而且不需要记"上一次点的是哪一段"这个额外状态。
     */
    val tabEnterSign = if (tabIndex == 0) -1f else 1f

    /**
     * 分段内容的进场层：`alpha` 与横向位移都在**绘制期**读（切段时只重绘、不重组）。
     *
     * 只挂在"随分段变化的内容"上 —— 顶栏与分段控件本身**不许挂**：它们在这块区域之外，
     * 跟着动的话读起来就是"整页在左右翻"，而底部导航又没动。
     */
    val tabEnterLayer = Modifier.graphicsLayer {
        val p = tabEnter.value
        alpha = p
        translationX = tabEnterSign * (1f - p) * KMotionOffset.switchSlide.toPx()
    }

    /**
     * 两个分段**各自一份滚动位置**。
     *
     * 共用一个 `LazyListState` 会有个不明显但很难看的后果：在「会话」里往下滚过之后切到
     * 「通知」，新列表会**沿用旧的 firstVisibleItemIndex / offset** —— 而通知往往只有一两条，
     * 于是那唯一一项被顶到视口上方（或只剩一点边），看起来就是"空状态不见了 / 没居中"。
     */
    val conversationListState = rememberLazyListState()
    val notificationListState = rememberLazyListState()

    /**
     * 量出来的三个高度（px），用来把空 / 失败态放在**顶栏下面那块区域的正中**。
     *
     * 为什么非要量：占位符是 `LazyColumn` 的 item，item 既没有 `align`、也不能 `fillMaxSize()`
     * （高度约束是 Infinity），而 `fillParentMaxHeight()` 是"整屏高"—— 它上面还有顶栏，
     * 照整屏居中就会往下溢出。所以只能用"列表视口 − 顶栏（− 会话分支的公告项）"。
     */
    var listHeightPx by remember { mutableIntStateOf(0) }
    var measuredHeaderPx by remember { mutableIntStateOf(0) }
    var measuredAnnouncementPx by remember { mutableIntStateOf(0) }
    val density = LocalDensity.current

    /**
     * 页头与公告入口卡的**首帧估算高**（实测值要等布局完成才回来）。
     *
     * 从 0 起步的后果与二级页顶栏那次一模一样：`emptyBodyHeight` 先被算成 0，
     * 空态 / 骨架占位"没有高度"，测量回来后又突然撑开 —— 看上去就是这块跳了一下。
     * 这里按设计常量各给一个首帧值，实测值到达后覆盖（见下面两个 val）。
     */
    val estimatedHeaderPx = kStatusBarTopPx() + with(density) {
        // 与列表首个 item 的结构一一对应：kTopBar 上内边距 + 页头行高
        // + 页头自身下内边距（KPageHeader 自带 padding(bottom = KSpacing.xs)）
        // + 项间距（spacedBy(KSpacing.sm)）+ 分段控件最小高
        (KSpacing.xs * 2 + KDimens.headerIconButton + KSpacing.sm + KDimens.segmentHeight).roundToPx()
    }
    val estimatedAnnouncementPx = with(density) {
        // 公告入口卡 = 上下内边距 + 内容高（内容由 size = avatarRow 的圆标决定，通常高于两行文字）
        (KDimens.avatarRow + KSpacing.sm * 2).roundToPx()
    }
    val headerHeightPx = if (measuredHeaderPx > 0) measuredHeaderPx else estimatedHeaderPx
    val announcementHeightPx =
        if (measuredAnnouncementPx > 0) measuredAnnouncementPx else estimatedAnnouncementPx

    val emptyBodyHeight = with(density) {
        // 减掉列表自身的底部内边距与项间距，让总内容刚好一屏（多出来的部分会变成可以滚的空白）
        val reserved = (KDimens.navScrollPadding + KSpacing.lg).toPx() + KSpacing.xs.toPx() +
            headerHeightPx + if (tabIndex == 0) announcementHeightPx else 0
        (listHeightPx - reserved).coerceAtLeast(0f).toDp()
    }

    /**
     * 首次进页面若还没有任何数据 → 主动拉一次（**挂载即拉**，Web 版 `useInbox` 同一行为）。
     *
     * 为什么这里还要再来一次（Shell 的 ON_START 已经对过账了）：这一页可能在
     * "App 一直开着、只是切到消息 tab"时进组合，而那次切换不一定伴随 ON_START；
     * 漏了这一步就会看到"明明有未读、进来却是空的"，等 10s 轮询才补上。
     * `refresh()` 是单飞的，与同时发生的轮询/事件合并成一次请求，不会重复打接口。
     */
    LaunchedEffect(isLoggedIn, inbox) {
        if (isLoggedIn) inbox.refresh()
    }

    var toast by remember { mutableStateOf<String?>(null) }

    Box(modifier = Modifier.fillMaxSize().background(c.bgPage)) {
        if (!isLoggedIn) {
            Column(
                modifier = Modifier.fillMaxSize(),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                KPlaceholder(
                    kind = KPlaceholderKind.Empty,
                    title = "未登录",
                    description = "登录后才能收发私信",
                    action = { KButton("去登录", onClick = onRequireLogin) },
                )
            }
            return@Box
        }

        // **不做下拉刷新**：下拉刷新只属于首页（列表流）—— 消息靠 SSE 自己更新，
        // 之前那个 PullToRefreshBox 会在每次进页面（loading=true）时把顶部转圈拉出来，
        // 看起来像"点一下就刷新"。
        LazyColumn(
            // 分段各用各的滚动位置（见 conversationListState 的注释）
            state = if (tabIndex == 1) notificationListState else conversationListState,
            // 量出列表视口高：空 / 失败态要靠它算居中（见 emptyBodyHeight）
            modifier = Modifier.fillMaxSize().onSizeChanged { listHeightPx = it.height },
            contentPadding = PaddingValues(
                start = KSpacing.md,
                end = KSpacing.md,
                // 这里**不能**有 top：页头浮层那一项自己挂 kTopBar（见 KWidgets.kTopBar）。
                // 底部这档给悬浮胶囊留位（否则最后一条被永久盖住）。
                bottom = KDimens.navScrollPadding + KSpacing.lg,
            ),
            verticalArrangement = Arrangement.spacedBy(KSpacing.xs),
        ) {
            item {
                Column(
                    // 顶栏垂直位置的唯一来源（状态栏安全区 + KSpacing.xs）
                    modifier = Modifier
                        .kTopBar()
                        .onSizeChanged { measuredHeaderPx = it.height },
                    verticalArrangement = Arrangement.spacedBy(KSpacing.sm),
                ) {
                    KPageHeader(title = "消息")
                    // 会话 / 通知 分段：**通知是帖子评论/回复的互动通知**（公告在会话列表第一行）
                    KSegmentedTabs(
                        options = listOf("会话", "通知"),
                        selectedIndex = tabIndex,
                        onSelect = { tabIndex = it },
                    )
                }
            }

                if (tabIndex == 1) {
                    // ---- 通知：帖子评论/回复 ----
                    when {
                        notifError != null -> item {
                            CenteredState(Modifier.fillMaxWidth().height(emptyBodyHeight).then(tabEnterLayer)) {
                                KPlaceholder(
                                    kind = KPlaceholderKind.Error,
                                    title = "通知加载失败",
                                    description = notifError,
                                    action = { KButton("重试", onClick = { scope.launch { inbox.refresh() } }) },
                                )
                            }
                        }

                        notifications.isEmpty() && loading -> item {
                            // 内容骨架（M4）：通知行只有一行文字，所以不要媒体块
                            KListSkeleton(
                                modifier = tabEnterLayer.padding(vertical = KSpacing.xs),
                                items = 3,
                                withMedia = false,
                            )
                        }

                        notifications.isEmpty() -> item {
                            CenteredState(Modifier.fillMaxWidth().height(emptyBodyHeight).then(tabEnterLayer)) {
                                KPlaceholder(
                                    kind = KPlaceholderKind.Empty,
                                    title = "还没有通知",
                                    description = "有人评论或回复你的帖子时会出现在这里",
                                )
                            }
                        }

                        else -> items(notifications, key = { it.raw.id }) { n ->
                            NotificationRow(
                                n = n,
                                onClick = {
                                    val postId = n.raw.postId ?: return@NotificationRow
                                    // 交给 Shell 打开帖子详情；顺手标记已读（本地先置位，红点与角标当场消失）
                                    scope.launch { inbox.markNotificationRead(n.raw.id) }
                                    onOpenPost(postId)
                                },
                                /**
                                 * 只保留**让位**的弹簧，关掉框架默认的淡入淡出。
                                 *
                                 * 淡出是"列表残影"的来源：切段时整批旧行被标成"消失"，默认要淡出
                                 * 两三百毫秒，而新列表此刻还在自己的进场动画里（alpha 从 0 起）——
                                 * 于是半透明的旧行叠着半透明的新行同屏出现，就是用户看到的重影。
                                 * 进场本身已经由 [tabEnterLayer] 负责，这里不需要再来一层。
                                 */
                                modifier = tabEnterLayer.then(
                                    Modifier.animateItem(fadeInSpec = null, fadeOutSpec = null),
                                ),
                            )
                        }
                    }
                } else {
                    // ---- 会话：第一行固定「公告」入口（点进去是公告界面）----
                    item(key = "announcements") {
                        AnnouncementEntry(
                            unread = annUnread,
                            onClick = onOpenAnnouncements,
                            // 量高：空态要减掉它（见 emptyBodyHeight）
                            modifier = tabEnterLayer.onSizeChanged { measuredAnnouncementPx = it.height },
                        )
                    }

                    when {
                        loading && conversations.isEmpty() -> item {
                            // 内容骨架（M4）：会话行 = 头像 + 两行文字，与通知同理不要媒体块
                            KListSkeleton(
                                modifier = tabEnterLayer.padding(vertical = KSpacing.xs),
                                items = 3,
                                withMedia = false,
                            )
                        }

                        error != null -> item {
                            CenteredState(Modifier.fillMaxWidth().height(emptyBodyHeight).then(tabEnterLayer)) {
                                KPlaceholder(
                                    kind = KPlaceholderKind.Error,
                                    title = "会话列表加载失败",
                                    description = error,
                                    action = { KButton("重试", onClick = { scope.launch { inbox.refresh() } }) },
                                )
                            }
                        }

                        conversations.isEmpty() -> item {
                            CenteredState(Modifier.fillMaxWidth().height(emptyBodyHeight).then(tabEnterLayer)) {
                                KPlaceholder(
                                    kind = KPlaceholderKind.Empty,
                                    title = "还没有会话",
                                    description = "从别人的主页进入私信即可开始",
                                )
                            }
                        }

                        else -> items(conversations, key = { it.raw.partnerId }) { conv ->
                            ConversationRow(
                                conv = conv,
                                onClick = { onOpenChat(conv.raw.partnerId, conv.raw.username, conv.avatarUrl) },
                                // 只留让位的弹簧，理由同通知行（淡出会让切段出现残影）
                                modifier = tabEnterLayer.then(
                                    Modifier.animateItem(fadeInSpec = null, fadeOutSpec = null),
                                ),
                            )
                        }
                    }
                }
        }

        if (toast != null) {
            KToast(text = toast!!, onDismiss = { toast = null }, modifier = Modifier.align(Alignment.BottomCenter))
        }
    }
}

/**
 * 空 / 失败态的居中容器（消息页）。
 *
 * 为什么不直接在调用处写 `Modifier.align(Alignment.Center)`：这些占位符挂在 `LazyColumn`
 * 的 item 里 —— item 没有 `align`，而 `fillMaxSize()` 会因为 item 的高度约束是 Infinity
 * 直接算崩。高度由页面按「列表视口 − 顶栏（− 会话分支的公告项）」量出来传进来
 * （见 `emptyBodyHeight`），它才真的落在**顶栏下面那块区域的正中**，
 * 而不是像原来那样贴着左上角（用户反馈："还没有通知"没有居中）。
 */
@Composable
internal fun CenteredState(
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    Box(modifier = modifier, contentAlignment = Alignment.Center) {
        content()
    }
}

/**
 * 「公告」入口（会话列表第一行，设计稿之外用户明确要求的）：
 * 与会话行同款白卡 + 同款两行节奏（标题行 / 说明行），角标压在说明行行尾 ——
 * 这样它插在会话列表里不会"另成一种行"。
 *
 * **消息页的行卡一律不要阴影**（用户反馈"取消消息列表和公告边框的阴影"）：
 * 这一条同时管着 [ConversationRow] 与 [NotificationRow]。去掉阴影不会丢层次 ——
 * 卡片是实心 `surface`（浅色 #ffffff / 深色 #1c1c1c），落在 `bgPage`（#f5f5f5 / #121212）上，
 * 明度差本来就够；阴影在这三行贴在一起时反而互相叠成"一圈灰边"。
 */
@Composable
private fun AnnouncementEntry(
    unread: Int,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = KTheme.colors
    androidx.compose.material3.Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(KRadius.row),
        color = c.surface,
        onClick = onClick,
    ) {
        Row(
            modifier = Modifier.padding(KSpacing.sm),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(KSpacing.sm),
        ) {
            Box(
                modifier = Modifier
                    .size(KDimens.avatarRow)
                    .clip(CircleShape)
                    .background(c.accentSoft),
                contentAlignment = Alignment.Center,
            ) {
                Glyph(tint = c.accentText, kind = GlyphKind.Megaphone, size = KDimens.navIcon)
            }
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(KSpacing.xxs),
            ) {
                Text("公告", style = KType.bodyStrong, color = c.textPrimary, maxLines = 1)
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
                ) {
                    Text(
                        text = "查看最新公告",
                        style = KType.caption,
                        color = c.textMuted,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    if (unread > 0) {
                        UnreadBadge(unread)
                    }
                }
            }
        }
    }
}

/**
 * 通知行：第一行「触发者 + 时间」、第二行「摘要 + 未读点」，与会话行同一套两行节奏。
 *
 * **点击 = 跳到相关帖子**（用户实测反馈：「通知评论点了没法转移到相关的帖子」）：
 * 通知里带着 `post_id`（服务端 `NotificationDto` 有），拿它进帖子详情即可。
 * 这条能力当初没接，是因为原生端那时**还没有帖子详情页**（见仓库里那段旧注释）——
 * 现在有了，就该接上。
 *
 * `postId` 为空的极少数通知（服务端理论上都会带）不可点：宁可不响应，也不要跳到一个空白页。
 *
 * 无阴影 —— 与公告入口、会话行同一条规矩（见 [AnnouncementEntry]）。
 */
@Composable
private fun NotificationRow(
    n: MessageRepository.NotificationUi,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = KTheme.colors
    val openable = n.raw.postId != null
    androidx.compose.material3.Surface(
        modifier = modifier
            .fillMaxWidth()
            .then(if (openable) Modifier.clickable(onClick = onClick) else Modifier),
        shape = RoundedCornerShape(KRadius.row),
        color = c.surface,
    ) {
        Row(
            modifier = Modifier.padding(KSpacing.sm),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(KSpacing.sm),
        ) {
            Avatar(url = n.avatarUrl, name = n.raw.fromUsername, size = KDimens.avatarRow)
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(KSpacing.xxs),
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
                ) {
                    Text(
                        text = n.raw.fromUsername.ifBlank { "有新通知" },
                        style = KType.bodyStrong,
                        color = c.textPrimary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    Text(n.timeText, style = KType.tiny, color = c.textMuted)
                }
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
                ) {
                    Text(
                        text = n.raw.content,
                        style = KType.caption,
                        color = c.textMuted,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    if (!n.raw.isRead) {
                        Box(
                            modifier = Modifier
                                .size(8.dp)
                                .clip(CircleShape)
                                .background(c.danger),
                        )
                    }
                }
            }
        }
    }
}

/**
 * 会话行（设计稿「消息会话 · 会话列表」）：
 *  · 圆角统一 `radiusRow(14)`，头像 48dp（`avatarRow`），行内边距 12 —— 三者一起决定行高 72；
 *  · **两行结构**：第一行「名字 + 时间（右）」、第二行「预览 + 未读角标（右）」。
 *    时间/角标各自贴在自己那一行的右端，而不是像旧版那样挤在右侧一列里 ——
 *    旧版角标跑到时间下面，会读成"两个不同的元信息块"，设计稿里它是预览行的行尾。
 *  · 角标固定最小宽度并居中（1 位与 2 位不参差）、上限 `99+`。
 *
 * 无阴影 —— 与公告入口、通知行同一条规矩（见 [AnnouncementEntry]）。
 */
@Composable
private fun ConversationRow(
    conv: MessageRepository.ConversationUi,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = KTheme.colors
    androidx.compose.material3.Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(KRadius.row),
        color = c.surface,
        onClick = onClick,
    ) {
        Row(
            modifier = Modifier.padding(KSpacing.sm),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(KSpacing.sm),
        ) {
            Avatar(url = conv.avatarUrl, name = conv.raw.username, size = KDimens.avatarRow)
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(KSpacing.xxs),
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
                ) {
                    Text(
                        text = conv.raw.username.ifBlank { "用户${conv.raw.partnerId}" },
                        style = KType.bodyStrong,
                        color = c.textPrimary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    Text(conv.timeText, style = KType.tiny, color = c.textMuted)
                }
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
                ) {
                    Text(
                        text = conv.raw.lastMessage.ifBlank { "[图片]" },
                        style = KType.caption,
                        color = c.textMuted,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    if (conv.raw.unreadCount > 0) {
                        UnreadBadge(conv.raw.unreadCount)
                    }
                }
            }
        }
    }
}

/** 未读角标：最小 18px 宽 + 居中 + `99+` 上限（设计稿 §3.2 明确要求） */
@Composable
fun UnreadBadge(count: Int) {
    val c = KTheme.colors
    Box(
        modifier = Modifier
            .height(18.dp)
            .widthIn(min = 18.dp)
            .clip(RoundedCornerShape(percent = 50))
            .background(c.danger)
            .padding(horizontal = 5.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = if (count > 99) "99+" else count.toString(),
            // 角标文字走 onAccent，不用白色（深色下白字配 #E0586B 只有 3.63:1）
            color = c.onAccent,
            style = KType.tiny,
            maxLines = 1,
        )
    }
}
