package top.kuangdada.k.nativeapp.ui

import android.content.ClipData
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import android.os.Build
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.PathOperation
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import coil3.compose.AsyncImage
import coil3.compose.SubcomposeAsyncImage
import coil3.compose.SubcomposeAsyncImageContent
// httpHeaders 是扩展函数（定义在 coil3.network.ImageRequestsKt），不 import 会报
// "Unresolved reference 'httpHeaders' on receiver of type ImageRequest.Builder"
import coil3.network.httpHeaders
import kotlin.math.roundToInt
import kotlinx.coroutines.launch
import top.kuangdada.k.core.data.AdminRepository
import top.kuangdada.k.core.data.ApiError
import top.kuangdada.k.core.data.ApiResult
import top.kuangdada.k.core.data.MessageRepository
import top.kuangdada.k.core.data.RealtimeClient
import top.kuangdada.k.core.data.SessionRepository
import top.kuangdada.k.core.data.dayDividerText
import top.kuangdada.k.core.data.displayMessage
import top.kuangdada.k.core.data.timeGapMillis
import top.kuangdada.k.core.designsystem.component.KButton
import top.kuangdada.k.core.designsystem.component.KButtonVariant
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
import top.kuangdada.k.nativeapp.ui.viewer.rememberImageViewer

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
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MessagesScreen(
    messages: MessageRepository,
    admin: AdminRepository,
    /** SSE 事件流：新私信/新通知/新公告到达时列表与角标**自己更新**，不用用户下拉 */
    realtime: RealtimeClient? = null,
    isLoggedIn: Boolean,
    onOpenChat: (partnerId: Long, username: String?, avatarUrl: String?) -> Unit,
    onOpenAnnouncements: () -> Unit,
    /** 点一条互动通知 → 打开它指向的帖子详情（通知里带 `post_id`） */
    onOpenPost: (Long) -> Unit = {},
    onRequireLogin: () -> Unit,
    onUnreadChanged: (Int) -> Unit,
) {
    val c = KTheme.colors
    val scope = rememberCoroutineScope()

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
    val estimatedHeaderPx = WindowInsets.statusBars.getTop(density) + with(density) {
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

    // 先用仓库里的进程内缓存**直接渲染**（切走再回来不空白、不转圈），随后静默刷新
    var conversations by remember { mutableStateOf(messages.cachedConversations) }
    var notifications by remember { mutableStateOf(messages.cachedNotifications) }
    // 公告未读数（「公告」入口的角标；拉取失败静默 —— 角标不显示比显示错误更合适）
    var annUnread by remember { mutableIntStateOf(0) }
    // 导航胶囊角标 = 私信未读 + 通知未读。
    // 与 Web 版 `selectUnreadTotal`（私信 3 + 通知 2 = 5）同一口径；只算私信的话
    // 「通知」标签有了红点、导航却不亮，用户会以为漏了消息。
    var convUnread by remember { mutableIntStateOf(0) }
    var notifUnread by remember { mutableIntStateOf(0) }
    var loading by remember { mutableStateOf(conversations.isEmpty()) }
    var error by remember { mutableStateOf<String?>(null) }
    var notifError by remember { mutableStateOf<String?>(null) }
    var toast by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(convUnread, notifUnread) { onUnreadChanged(convUnread + notifUnread) }

    /**
     * 通知列表单独拉、单独报错。
     * 原来失败被静默吞掉、只留一句「还没有通知」—— 网络/鉴权出问题时，
     * 用户看到的是"没人评论我"，而不是"没拉到"，这种"错误伪装成空态"最难排查。
     */
    suspend fun loadNotifications() {
        notifError = null
        when (val r = messages.notifications()) {
            is ApiResult.Success -> {
                notifications = r.data
                notifUnread = r.data.count { !it.raw.isRead }
            }
            is ApiResult.Failure -> notifError = r.error.displayMessage
        }
    }

    /**
     * @param silent 静默刷新：**不显示下拉指示器**。SSE 事件触发的刷新要走这条 ——
     *   否则对方每发一条消息、页面顶部就闪一下转圈，很吵。
     */
    suspend fun load(silent: Boolean = false) {
        if (!silent) loading = true
        error = null
        when (val r = messages.conversations()) {
            is ApiResult.Success -> {
                conversations = r.data
                convUnread = r.data.sumOf { it.raw.unreadCount }
            }
            is ApiResult.Failure -> error = r.error.displayMessage
        }
        // 公告未读（与会话未读是两套数据：公告有自己的 read 标记）
        when (val r = admin.myAnnouncements()) {
            is ApiResult.Success -> annUnread = r.data.count { !it.read }
            else -> Unit
        }
        loading = false
    }

    LaunchedEffect(isLoggedIn) {
        if (isLoggedIn) {
            // 已有缓存就静默刷新：重进页面不闪转圈
            load(silent = conversations.isNotEmpty())
            loadNotifications()
        } else {
            loading = false
            convUnread = 0
            notifUnread = 0
        }
    }

    /**
     * SSE：新私信 / 新通知 / 新公告 → 会话列表、通知列表与未读角标**自己更新**。
     *
     * 用静默刷新（不闪下拉圈）：事件是"别人做了什么"，不该打断正在看列表的用户。
     */
    LaunchedEffect(realtime, isLoggedIn) {
        if (!isLoggedIn || realtime == null) return@LaunchedEffect
        realtime.events.collect { event ->
            if (event.isMessage || event.isNotification || event.isAnnouncement) {
                load(silent = true)
                loadNotifications()
            }
        }
    }

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
                                    action = { KButton("重试", onClick = { scope.launch { loadNotifications() } }) },
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
                                    // 交给 Shell 打开帖子详情；顺手标记已读（本地先置位，红点当场消失）
                                    scope.launch { messages.markNotificationRead(n.raw.id) }
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
                                    action = { KButton("重试", onClick = { scope.launch { load() } }) },
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
private fun CenteredState(
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
 * 卡片是实心 `surface`（浅色 #ffffff / 深色 #1e232d），落在 `bgPage`（#eef2ee / #0d0f14）上，
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
                Glyph(tint = c.accent, kind = GlyphKind.Megaphone, size = KDimens.navIcon)
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

/**
 * ============================================================
 * 聊天（沉浸态：隐藏底部导航）
 * ============================================================
 * 消息历史是**游标分页**：首屏拉最新 50 条，向上翻页传 `before_id` = 当前最旧一条的 id。
 */
@Composable
fun ChatScreen(
    messages: MessageRepository,
    partnerId: Long,
    partnerName: String?,
    /** 对方的头像（会话列表带过来的绝对地址）；为空时用默认人像 */
    partnerAvatar: String? = null,
    /** 自己的头像（当前登录用户）；为空时用默认人像 */
    myAvatar: String? = null,
    /** SSE 事件流：对方发来新消息时，正在看的这条会话自己刷新出来 */
    realtime: RealtimeClient? = null,
    onBack: () -> Unit,
) {
    val c = KTheme.colors
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()

    /**
     * 这个会话上次拉到的首屏历史（仓库进程内缓存，没有则为 null）。
     *
     * 进来的那一刻先拿它把消息铺上：用户反馈「点进对话消息中间有个加载圈」——
     * 那一圈之所以去不掉，是因为每次进来都要等一次网络往返。有缓存时连"加载"这个状态
     * 都不会出现（见下面的 [loading] 初值），只在真的第一次打开时才走骨架。
     */
    val cachedHistory = remember(partnerId) { messages.cachedHistory(partnerId) }

    var items by remember {
        // 先用仓库里的进程内缓存**直接渲染**（重进同一个会话不空白、不出加载圈），随后静默刷新。
        // 与消息页的会话列表同一套做法；缓存由 MessageRepository.history 与下面的回写维护。
        mutableStateOf(cachedHistory?.first ?: emptyList())
    }
    var hasMore by remember { mutableStateOf(cachedHistory?.second ?: false) }
    var loading by remember { mutableStateOf(cachedHistory == null) }
    var sending by remember { mutableStateOf(false) }
    var input by remember { mutableStateOf("") }
    var replyTo by remember { mutableStateOf<MessageRepository.MessageUi?>(null) }
    /**
     * 输入框的焦点句柄：**点「引用」要把焦点交给它**，IME 随之弹起，用户直接就能打字。
     *
     * 与详情页评论框同一套做法（见 `PostDetailScreen.inputFocusRequester`）。
     * `runCatching` 在真正的调用点上兜"节点还没附着"的极端时序，不会崩。
     */
    val inputFocusRequester = remember { androidx.compose.ui.focus.FocusRequester() }
    var error by remember { mutableStateOf<String?>(null) }
    var toast by remember { mutableStateOf<String?>(null) }
    var menuOpen by remember { mutableStateOf(false) }
    var confirmClear by remember { mutableStateOf(false) }

    /**
     * @param silent 静默刷新：**不显示骨架**。有缓存时走这条 —— 内容已经在屏幕上了，
     *   再闪一下骨架反而像"消息被重新加载了一遍"。
     */
    suspend fun loadInitial(silent: Boolean = false) {
        if (!silent) loading = true
        error = null
        when (val r = messages.history(partnerId)) {
            is ApiResult.Success -> {
                items = r.data.first
                hasMore = r.data.second
            }
            is ApiResult.Failure -> error = r.error.displayMessage
        }
        loading = false
    }

    LaunchedEffect(partnerId) { loadInitial(silent = items.isNotEmpty()) }

    /**
     * 本地改动（发送 / 撤回 / 清空 / 翻页）也**回写缓存**。
     *
     * 只在 [MessageRepository.history] 里写缓存的话，这些改动要等到"下一次真的拉了首屏"
     * 才进缓存 —— 中间重进会话会先闪出旧内容（最明显的是**已撤回的那条又出现一下**才消失）。
     */
    LaunchedEffect(items, hasMore) { messages.rememberHistory(partnerId, items, hasMore) }

    /**
     * SSE：**正在看的这条会话**来了新消息就自己刷出来（微信那种"对方发来立刻出现"）。
     *
     * 服务端对收发双方都推 `message` 事件，`from` 是发送者 —— 所以
     * `from == partnerId`（对方发来）或 `to == partnerId`（我在别的端发的）都该刷新。
     */
    LaunchedEffect(realtime, partnerId) {
        if (realtime == null) return@LaunchedEffect
        realtime.events.collect { event ->
            if (event.isMessage && (event.from == partnerId || event.to == partnerId)) {
                when (val r = messages.history(partnerId)) {
                    is ApiResult.Success -> {
                        items = r.data.first
                        hasMore = r.data.second
                    }
                    is ApiResult.Failure -> Unit // 静默：不打断正在输入的用户
                }
            }
        }
    }

    // 按自然日切分隔条（设计稿顶部那条「今天 14:32」）
    val entries = remember(items) { buildChatEntries(items) }

    /**
     * 这一段对话里的**全部图片**（时间正序）。
     *
     * 点开任意一张时把它整段交给查看器：聊天里翻图本该能左右滑着看完这段对话的图，
     * 只给一张的话用户看完还得退回来再点下一张。
     *
     * 不走 `postId` / 来源登记（那是帖子配图的几何飞行用的）——私信图片没有"九宫格来源格"
     * 这套东西，查看器会直接落位。
     *
     * ★ 必须取 [MessageRepository.MessageUi.imageUrl]（**已 resolveUrl 的绝对地址**），
     * 不是 `raw.imageUrl`：DTO 里那份是服务端给的相对路径（`/uploads/messages/…`），
     * 交给查看器就是"图片加载失败"（Coil 拿相对地址无法发起请求）。
     * 气泡自己一直用的是 `msg.imageUrl`，所以缩略图正常、全屏那张却挂 —— 两个字段不是一回事。
     */
    val chatImageUrls = remember(items) { items.mapNotNull { it.imageUrl } }
    // 私密图片必须带 JWT 头，查看器与保存都靠它
    val openViewer = rememberImageViewer(topInsetPx = { 0f })
    /**
     * 离开这段对话时**注销它那一组图片来源**。
     *
     * 为什么必须清：来源表是全局的（挂在 Shell 上），气泡登记的是"这一格在窗口里的矩形"。
     * 页面退出后这些矩形已经不作数，若留在表里，下次从别的地方用同一个键查就会拿到过期位置。
     * （单格的 `removeToken` 在气泡被回收时也会走，但**不确定每种退出路径都会触发**——
     * 沉浸页整页移除时格子未必逐个 dispose 完，所以这里按"整组"再兜一次，幂等无害。）
     */
    val viewerOrigins = LocalViewerOrigins.current
    DisposableEffect(viewerOrigins, partnerId) {
        onDispose { viewerOrigins?.removeChatOrigins(partnerId) }
    }

    Box(modifier = Modifier.fillMaxSize().background(c.bgPage)) {
        // 顶栏真毛玻璃：Kyant0 的 backdrop 库。用法与注意事项见 BooksScreen 同段注释
        // （要点：backdrop 里先铺页底色；**不要加 vibrancy/colorFilter**，本机实测会打断效果链）。
        val canBlur = Build.VERSION.SDK_INT >= 31
        val pageBg = KTheme.colors.bgPage
        // 色膜厚度：决定"透出多少背后的颜色"。
        //  · 0.92 = 背后几乎全盖住（最稳，但颜色也看不出来）；
        //  · 0.85 = 当前值 —— 背后贡献 15%，能透出图片的色调，而**形状早就被 32dp 模糊糊没了**，
        //    所以透出来的是颜色、不是字。沸腾在重度模糊的色场上表现为缓慢的色彩漂移，不是"沸腾"。
        //  · 再往下调会更透，但残留细节会重新变得可辨、沸腾也会回来。
        val frostedTint = KTheme.colors.frosted.copy(alpha = 0.85f)
        // 玻璃源：**本页自己录**（内容列上挂 layerBackdrop）。顶栏在 shell 那层的内容里，
        // 采样 shell 那层会自引用（无限递归 → 原生崩溃），所以这里只用页面级的源；
        // 细节与理由见 rememberTopBarGlass 的注释。
        val backdrop = rememberLayerBackdrop(onDraw = rememberBackdropOnDraw(pageBg))
        // 点消息列表的空白处收起键盘（输入时键盘挡着半屏内容）
        val keyboard = LocalSoftwareKeyboardController.current
        /**
         * 点「引用」的**唯一出口**（长按菜单那一项走这里）。
         *
         * 用户要求的两件事都落在这个函数里：
         *  1. **引用后自动聚焦输入框、唤起输入法** —— 引用完就是要接着打字，
         *     再让用户手动点一下输入框是多一步；语义与详情页点「回复」完全一致
         *     （见 `PostDetailScreen` 的 `onReply`）。
         *  2. **键盘已经开着时不许把它收掉** —— 长按菜单是 `Popup(focusable = true)`，
         *     弹出时本身会抢走焦点、把 IME 收掉；所以这里**必须重新把焦点交还输入框**
         *     并再 `show()` 一次（`requestFocus()` 在"焦点刚从别处回来"时
         *     不一定会自己弹 IME，少数机型尤其明显）。
         *
         * `requestFocus()` 必须**先于** `show()`：反过来的话，系统先按"当前聚焦节点"起 IME，
         * 那时焦点还在 Popup 上，等于白喊。
         *
         * `keyboard?.show()` 带 150ms 的等待：菜单刚 `dismiss` 时弹层窗口还在拆，
         * 同一帧喊 show 会被系统忽略（表现就是"还是不弹"）。这个延迟只在"引用"这一条
         * 用户动作上出现，看不见也不影响其它交互。
         */
        fun quoteMessage(target: MessageRepository.MessageUi) {
            replyTo = target
            runCatching { inputFocusRequester.requestFocus() }
            scope.launch {
                // 让菜单的退场先走完（Popup 窗口销毁是异步的），再喊起 IME
                kotlinx.coroutines.delay(KEYBOARD_SETTLE_MS)
                keyboard?.show()
            }
        }
        /**
         * 上下翻聊天记录时**也**收起键盘（用户反馈：只有"点一下"能收，翻记录时不收）。
         *
         * 判据是**用户手指拖拽的起点**（[DragInteraction.Start]），不是
         * `listState.isScrollInProgress` —— 后者把**程序化滚动**也算进去，而发完消息
         * `animateScrollToItem(0)` 会自动滚到底：用它的话"发一条消息键盘就没了"，
         * 连发几条根本没法用。拖拽交互是 `scrollable` 里只有手指真的在拖才会发的事件，
         * 惯性甩动属于同一次拖拽（起点已经收过键盘，不需要重复收）。
         *
         * 列表是 `reverseLayout`，键盘收起只改动输入栏那一块的高度，列表内容位置不动，
         * 所以"收起键盘"本身不会让聊天记录跳 —— 这是敢在滚动里收键盘的前提。
         */
        LaunchedEffect(listState) {
            listState.interactionSource.interactions.collect { interaction ->
                if (interaction is DragInteraction.Start) keyboard?.hide()
            }
        }
        // 顶栏的实际高度：列表的 contentPadding.top 按它让位 —— 滚到最顶上时最老的消息
        // 正好停在顶栏之下；平时消息从顶栏底下穿过（毛玻璃）
        // 顶栏高度：首帧先用估算值起步，实测值到达后覆盖。
        // 若从 0 起步，最老的消息会先顶到最上面、测量回来后才弹到顶栏之下 ——
        // 真机表现就是"刚进页面时顶栏高矮跳一下"（见 kTopBarHeightEstimatePx）。
        val estimatedTopBarPx = kTopBarHeightEstimatePx(bottomPadding = KSpacing.md)
        var measuredTopBarPx by remember { mutableIntStateOf(0) }
        val density = LocalDensity.current
        val topBarPx = if (measuredTopBarPx > 0) measuredTopBarPx else estimatedTopBarPx
        val topInset = with(density) { topBarPx.toDp() }

        Column(
            modifier = Modifier
                .fillMaxSize()
                // 玻璃源：栏的兄弟节点，且在栏之前绘制
                .then(if (canBlur) Modifier.layerBackdrop(backdrop) else Modifier),
        ) {
            Box(modifier = Modifier.weight(1f)) {
                when {
                    /**
                     * **有内容就先渲染**（缓存命中，或 SSE 已经刷过）：连加载失败也**不把已有消息
                     * 换成一张错误页** —— 刷新是后台动作，静默失败比"正在看的消息突然消失"好。
                     */
                    items.isNotEmpty() -> LazyColumn(
                        state = listState,
                        modifier = Modifier
                            .fillMaxSize()
                            .pointerInput(Unit) { detectTapGestures { keyboard?.hide() } },
                        /**
                         * **reverseLayout**：最新一条是列表的 index 0、天然贴在底部。
                         *
                         * 不开的话只能"先渲染最旧一屏，再 animateScrollToItem 滚到底"——那正是
                         * 用户看到的**进会话先闪一下顶部、再自己跳到底部**（首帧内容还是错的）。
                         * 开了之后首帧就是最新消息，不需要任何滚动动画。
                         * 代价：列表顺序要反过来（[entries] 反转），"加载更早的消息"作为最后一项
                         * 出现在**视觉最上方**。
                         */
                        reverseLayout = true,
                        contentPadding = PaddingValues(
                            start = KSpacing.md,
                            end = KSpacing.md,
                            // top = 顶栏实际高：滚到最顶上时最老的消息停在顶栏之下；
                            // 平时消息从毛玻璃顶栏底下穿过
                            top = topInset + KSpacing.sm,
                            bottom = KSpacing.sm,
                        ),
                        verticalArrangement = Arrangement.spacedBy(KSpacing.xs),
                    ) {
                        items(entries.asReversed(), key = { it.key }) { entry ->
                            when (entry) {
                                is ChatEntry.Day -> DayDivider(entry.text)
                                is ChatEntry.Bubble -> MessageBubble(
                                    msg = entry.msg,
                                    imageHeaders = messages.imageHeaders(),
                                    partnerAvatar = partnerAvatar,
                                    myAvatar = myAvatar,
                                    /**
                                     * 这一格的来源键与下标：与下面 `openViewer` 传的
                                     * **必须是同一套**（同一个 [chatImageOriginKey]、同一份
                                     * `chatImageUrls` 里的下标），否则飞行起点会指到别的格子上。
                                     */
                                    imageOriginKey = chatImageOriginKey(partnerId),
                                    imageOriginIndex = entry.msg.imageUrl
                                        ?.let { u -> chatImageUrls.indexOf(u) } ?: -1,
                                    /**
                                     * 点图片 → 全屏看图（用户反馈"聊天里的图点不开全屏"）。
                                     * 传**整段对话的图 + 这张的下标**：进去之后能左右滑着看完。
                                     * `msg.imageUrl` 是**已解析的绝对地址**（同 [chatImageUrls]），
                                     * 不能用 `raw.imageUrl` —— 那是相对路径，查看器会加载失败。
                                     */
                                    onImageClick = {
                                        val url = entry.msg.imageUrl
                                        if (!url.isNullOrBlank()) {
                                            openViewer(
                                                chatImageUrls,
                                                chatImageUrls.indexOf(url).coerceAtLeast(0),
                                                messages.imageHeaders(),
                                                /**
                                                 * ★ 传**虚拟来源键**而不是 null（用户反馈"聊天里的图点开是直接闪现，
                                                 * 没有详情页那种飞出来的动画"）。
                                                 *
                                                 * 第 4 个参数在查看器里叫 `postId`，但它真正的身份是
                                                 * **"去来源表里查哪一组格子"的键** —— 传 null 就等于
                                                 * `ViewerOrigins.of(null, n)` 直接返回空表，
                                                 * 查看器按设计退化成"直接落位"（见 `ImageViewerRequest.postId` 注释）。
                                                 *
                                                 * 私信图片没有帖子 id，所以用 [chatImageOriginKey] 造一个
                                                 * 落在负数区间的键：与帖子的正数 postId **共用同一张表、互不撞号**。
                                                 * 气泡那一格也已用同一个键 `registerViewerOrigin` 登记过。
                                                 */
                                                chatImageOriginKey(partnerId),
                                            )
                                        }
                                    },
                                    // 引用与撤回都在长按菜单里（气泡自身不带常显操作文字）
                                    onQuote = { quoteMessage(entry.msg) },
                                    onRecall = {
                                        scope.launch {
                                            val id = entry.msg.raw.id
                                            when (val r = messages.recall(id)) {
                                                is ApiResult.Success -> {
                                                    items = items.filterNot { it.raw.id == id }
                                                    toast = "已撤回"
                                                }
                                                is ApiResult.Failure -> toast = r.error.displayMessage
                                            }
                                        }
                                    },
                                    /**
                                     * 新消息 / 撤回时的重排走弹簧（M4）。
                                     *
                                     * 注意这个列表是 `reverseLayout = true`（最新消息在最下面），
                                     * `animateItem` 的位移是**在列表坐标系里**算的，所以"新消息挤进来"
                                     * 表现为旧消息整体往上让位 —— 正是聊天该有的观感。
                                     * 入场淡入用框架默认值：这里刻意不再叠一层自定义滑入，
                                     * 否则"让位 + 滑入"两套动画同时跑，观感会打架（§6 每屏最多一个抢注意力动效）。
                                     */
                                    modifier = Modifier.animateItem(),
                                )
                            }
                        }
                        // reverseLayout 下"最后一项"在视觉最上方 = 更早的消息
                        if (hasMore) {
                            item {
                                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                                    KButton(
                                        text = "加载更早的消息",
                                        onClick = {
                                            scope.launch {
                                                val oldest = items.firstOrNull()?.raw?.id
                                                when (val r = messages.history(partnerId, beforeId = oldest)) {
                                                    is ApiResult.Success -> {
                                                        items = r.data.first + items
                                                        hasMore = r.data.second
                                                    }
                                                    is ApiResult.Failure -> toast = r.error.displayMessage
                                                }
                                            }
                                        },
                                        variant = KButtonVariant.Ghost,
                                    )
                                }
                            }
                        }
                    }

                    /**
                     * 首次打开这个会话（没有任何缓存）才走骨架。
                     *
                     * 原来这里是页面正中一个 `CircularProgressIndicator`（用户反馈：
                     * 「点进对话消息中间有个加载圈」）。转圈只表达"在忙"，不表达"忙完长什么样"，
                     * 而且它居中、真实内容却贴着底部 —— 加载完是"中间一个圈 → 底部一片气泡"，
                     * 视觉上要跳一次。骨架按真实版式铺、**贴底**，与加载完的画面是连续的。
                     */
                    /**
                     * ⚠️ **不要在这里加 `.padding(top = topInset)`**（用户反馈："从别人个人主页
                     * 点私信进去，里面的提示还没有居中" —— 就是这两处）。
                     *
                     * 原因：`topInset` 是**顶栏高度**，而顶栏**根本不在这个 Box 里** ——
                     * 外层 `Column` 是「顶栏 / Box(weight(1f)) / 输入栏」三行，这个 Box
                     * 已经是"顶栏下面那一块"了。再减一次顶栏高度就是**凭空往下推**。
                     *
                     * 更隐蔽的是它推的量是**一半**：`align(Alignment.Center)` 先按 Box 中心
                     * 摆好，而 `padding(top = x)` 让内容盒变高 x → 居中时内容整体下移 **x/2**。
                     * 真机上就是"提示偏下小半格"，不是明显到一眼能说出原因的那种偏。
                     *
                     * 消息列表页那边（`CenteredState`）遇到过同一个问题，当时的教训是
                     * "得按列表视口 − 顶栏量出可用高度"；但**这里压根不需要**——
                     * 这个 Box 的边界已经排除了顶栏与输入栏，直接 `align(Center)` 就是准的。
                     */
                    loading -> Box(Modifier.fillMaxSize().padding(top = topInset)) { ChatSkeleton() }

                    error != null -> KPlaceholder(
                        kind = KPlaceholderKind.Error,
                        title = "消息加载失败",
                        description = error,
                        action = { KButton("重试", onClick = { scope.launch { loadInitial() } }) },
                        modifier = Modifier.align(Alignment.Center),
                    )

                    else -> KPlaceholder(
                        kind = KPlaceholderKind.Empty,
                        title = "还没有消息",
                        description = "打个招呼吧",
                        modifier = Modifier.align(Alignment.Center),
                    )
                }
            }

            /**
             * 引用条（回复某条消息时出现）。
             *
             * 样式照用户给的参考图：**灰底圆角条**（不再是通栏色块）
             * + 「用户名：内容」单行省略 + 右侧一个圆形 ×。
             *
             * 位置**留在输入框之上**、不进输入框内部：引用内容可能很长，
             * 塞进输入框会和正在打的字抢位置，而输入框是单行、只能把它整条省略掉。
             * 单独一条则能给出"回复谁 + 引用什么"的完整上下文（超长才省略）。
             *
             * **带进出动画**（用户要求）：出现时展开 + 淡入，取消时收起 + 淡出 ——
             * 不再是瞬间出现/消失（那条会连带把输入栏整体推移，硬跳最容易被看成卡顿）。
             * 降级（系统关动画）时两端都是 `None`，状态变化本身不依赖动画也成立。
             */
            val replyAnimations = LocalAnimationsEnabled.current
            /**
             * 退场动画期间 `replyTo` 已经是 null，但这一条还要按原内容画完 ——
             * 不留住最后一个非空值，退场帧里就是一条**空条**（甚至 `!!` 直接崩）。
             */
            val shownReplyTo = rememberLastNonNull(replyTo)
            AnimatedVisibility(
                visible = replyTo != null,
                enter = if (replyAnimations) {
                    expandVertically(animationSpec = KMotion.spatial()) +
                        fadeIn(animationSpec = KMotion.effects())
                } else {
                    EnterTransition.None
                },
                exit = if (replyAnimations) {
                    shrinkVertically(animationSpec = KMotion.spatial()) +
                        fadeOut(animationSpec = KMotion.effects())
                } else {
                    ExitTransition.None
                },
            ) {
                shownReplyTo?.let { target ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = KSpacing.md, vertical = KSpacing.xs)
                            .clip(RoundedCornerShape(KRadius.control))
                            .background(c.surfaceRaised)
                            .padding(start = KSpacing.sm, end = KSpacing.xxs, top = KSpacing.xxs, bottom = KSpacing.xxs),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
                    ) {
                        Text(
                            // 「用户名：内容」—— 冒号而不是"回复 xxx："：这一条本身就在输入框上面，
                            // 不需要再解释一遍它在干嘛（参考图也是这个写法）
                            text = "${target.raw.senderUsername}：${target.raw.content.ifBlank { "[图片]" }}",
                            style = KType.body,
                            color = c.textSecondary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        // 取消引用：小圆底 + 叉（见参考图）。`onClickLabel` 给读屏一句说明 ——
                        // 这个钮没有文字，不给说明等于"读屏用户听到一个无名按钮"
                        Box(
                            modifier = Modifier
                                .clip(CircleShape)
                                .clickable(onClickLabel = "取消引用") { replyTo = null }
                                .background(c.borderStrong)
                                .padding(KSpacing.xxs),
                        ) {
                            Glyph(tint = c.surface, kind = GlyphKind.Close, size = KDimens.navIcon)
                        }
                    }
                }
            }

            // 输入栏（设计稿「消息对话」）：白/深卡片条 + 凹陷底输入框 + 发送按钮。
            // 圆角统一成**详情页那一档**（KRadius.control 小圆角），不再是胶囊 ——
            // 两处输入条看起来要像同一个组件（用户要求）。
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(c.surface)
                    .navigationBarsPadding()
                    .imePadding()
                    .padding(horizontal = KSpacing.md, vertical = KSpacing.sm),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(KSpacing.sm),
            ) {
                Box(modifier = Modifier.weight(1f)) {
                    KTextField(
                        value = input,
                        onValueChange = { input = it },
                        placeholder = "说点什么…",
                        shape = RoundedCornerShape(KRadius.control),
                        variant = KTextFieldVariant.Inset,
                        // 点「引用」时把焦点交给它（见 quoteMessage），IME 随之弹起
                        focusRequester = inputFocusRequester,
                    )
                }
                KButton(
                    text = if (sending) "…" else "发送",
                    // 与输入框同一档圆角（详情页评论输入条同款）
                    cornerRadius = KRadius.control,
                    onClick = {
                        if (input.isBlank()) {
                            toast = "不能发空消息"
                            return@KButton
                        }
                        scope.launch {
                            sending = true
                            val quoted = replyTo?.raw?.id
                            when (val r = messages.send(partnerId, input.trim(), quotedMessageId = quoted)) {
                                is ApiResult.Success -> {
                                    items = items + r.data
                                    input = ""
                                    replyTo = null
                                    // 发出去的消息在 reverseLayout 里是 index 0：
                                    // 主动滚一次，避免用户翻了旧消息后看不到自己刚发的那条
                                    listState.animateScrollToItem(0)
                                }
                                is ApiResult.Failure -> toast = r.error.displayMessage
                            }
                            sending = false
                        }
                    },
                    // 设计稿里空输入时发送按钮也是实心 accent（不置灰）；
                    // 空内容点它由上面的 input.isBlank() 分支给一句提示，不会发出空消息。
                    enabled = !sending,
                )
            }
        }

        // 顶栏浮层（毛玻璃）：返回 | 对方名字 | 「…」。消息从它底下穿过。
        // 画在内容层**之后** = 盖在内容之上；「清空聊天记录」的菜单跟着这个浮层走。
        Row(
            modifier = Modifier
                .fillMaxWidth()
                // 顶栏毛玻璃（统一写法，见 rememberTopBarGlass）。
                // 必须挂在 kTopBar（状态栏避让）的**左侧**：玻璃矩形才含状态栏那一条，
                // 滚到顶时最老的消息正好停在玻璃之下
                .then(
                    rememberTopBarGlass(
                        canBlur = canBlur,
                        backdrop = backdrop,
                        blurRadius = KGlassBlurRadius,
                        tint = frostedTint,
                        solid = KTheme.colors.frostedSolid,
                    )
                )
                // 量的是含状态栏的**整条**高：列表 contentPadding.top 按它让位，
                // 滚到顶时最老的消息正好停在玻璃之下
                .onSizeChanged { measuredTopBarPx = it.height }
                .kTopBar()
                .padding(start = KSpacing.md, end = KSpacing.md, bottom = KSpacing.md),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(KSpacing.md),
        ) {
            KIconButton(icon = GlyphKind.ChevronLeft, onClick = onBack)
            Text(
                text = partnerName?.ifBlank { null } ?: "用户$partnerId",
                style = KType.subtitle,
                color = c.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Box {
                KIconButton(icon = GlyphKind.More, onClick = { menuOpen = true })
                DropdownMenu(
                    expanded = menuOpen,
                    onDismissRequest = { menuOpen = false },
                    shape = RoundedCornerShape(KRadius.control),
                    containerColor = c.surfaceRaised,
                    tonalElevation = 0.dp,
                    shadowElevation = KElevation.raised,
                    border = BorderStroke(1.dp, c.borderSubtle),
                ) {
                    ChatMenuItem("清空聊天记录", c.danger) {
                        menuOpen = false
                        confirmClear = true
                    }
                }
            }
        }

        if (toast != null) {
            // 聊天页是沉浸态，没有胶囊要避让，直接放在输入栏之上
            Box(modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 96.dp)) {
                KToastInline(text = toast!!, onDismiss = { toast = null })
            }
        }

        // 清空聊天记录（顶栏「…」）：不可撤销，所以必须二次确认
        if (confirmClear) {
            AlertDialog(
                onDismissRequest = { confirmClear = false },
                title = { Text("清空聊天记录", style = KType.subtitle, color = c.textPrimary) },
                text = {
                    Text(
                        "与「${partnerName?.ifBlank { null } ?: "用户$partnerId"}」的全部消息会被删除，且不可恢复。",
                        style = KType.body,
                        color = c.textSecondary,
                    )
                },
                confirmButton = {
                    Text(
                        "清空",
                        style = KType.bodyStrong,
                        color = c.danger,
                        modifier = Modifier
                            .clip(RoundedCornerShape(KRadius.control))
                            .clickable {
                                confirmClear = false
                                scope.launch {
                                    when (val r = messages.clearConversation(partnerId)) {
                                        is ApiResult.Success -> {
                                            items = emptyList()
                                            hasMore = false
                                            toast = "已清空"
                                        }
                                        is ApiResult.Failure -> toast = r.error.displayMessage
                                    }
                                }
                            }
                            .padding(horizontal = KSpacing.sm, vertical = KSpacing.xs),
                    )
                },
                dismissButton = {
                    Text(
                        "取消",
                        style = KType.body,
                        color = c.textMuted,
                        modifier = Modifier
                            .clip(RoundedCornerShape(KRadius.control))
                            .clickable { confirmClear = false }
                            .padding(horizontal = KSpacing.sm, vertical = KSpacing.xs),
                    )
                },
                containerColor = c.surface,
            )
        }
    }
}

/**
 * 聊天首屏的内容骨架（M7）。
 *
 * 形态直接对着真实气泡铺：左右交替（对方在左、自己在右，都带头像）、长短不一，
 * 并且**贴底** —— 真实列表是 `reverseLayout`，最新一条在最下面。
 * 这样从骨架切到真内容时版式是连续的；转圈那种"中间一个环 → 底部一片气泡"的跳变就没有了。
 *
 * 微光由 `kShimmer` 内部按 [LocalAnimationsEnabled] 门控，并带 `contentDescription`
 * 把"加载中"交给读屏（§6：动效不能是唯一信号）。
 */
@Composable
private fun ChatSkeleton() {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .semantics { contentDescription = "加载中" }
            // 与真实列表同一套内外边距，骨架 → 真内容时位置不跳
            .padding(horizontal = KSpacing.md, vertical = KSpacing.sm),
        verticalArrangement = Arrangement.spacedBy(KSpacing.sm, Alignment.Bottom),
    ) {
        // (是不是自己的, 气泡宽度占可用宽度的比例, 气泡高)
        listOf(
            Triple(false, 0.62f, 48.dp),
            Triple(true, 0.44f, 48.dp),
            Triple(false, 0.70f, 68.dp),
            Triple(true, 0.52f, 48.dp),
            Triple(false, 0.38f, 48.dp),
        ).forEach { (mine, fraction, bubbleHeight) ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start,
                verticalAlignment = Alignment.Bottom,
            ) {
                if (!mine) {
                    Box(Modifier.size(KDimens.avatarCard).kShimmer(CircleShape))
                    Spacer(Modifier.width(KSpacing.xs))
                }
                Box(
                    modifier = Modifier
                        // 比例是对"整行宽"算的，加上头像（40 + 8）也不会越过行宽（最长 0.70）
                        .fillMaxWidth(fraction)
                        .height(bubbleHeight)
                        .kShimmer(RoundedCornerShape(KRadius.row)),
                )
                if (mine) {
                    Spacer(Modifier.width(KSpacing.xs))
                    Box(Modifier.size(KDimens.avatarCard).kShimmer(CircleShape))
                }
            }
        }
    }
}

/**
 * 长按菜单项。只改内边距与文字色，其余交给 M3（触控高度 48dp、涟漪、语义）——
 * M3 默认的 `contentPadding` 是 12/16，配上 15sp 文字会让一个三项菜单比气泡还占地方。
 */
@Composable
internal fun ChatMenuItem(text: String, color: Color, onClick: () -> Unit) {
    DropdownMenuItem(
        text = { Text(text, style = KType.body, color = color) },
        onClick = onClick,
        contentPadding = PaddingValues(horizontal = KSpacing.lg, vertical = KSpacing.xs),
    )
}

/**
 * 长按菜单里的一项。
 * [danger] = 危险动作（撤回），文字走 `danger` 色。
 */
private data class ChatMenuAction(
    val label: String,
    val danger: Boolean = false,
    val onClick: () -> Unit,
)

/**
 * 聊天气泡的长按菜单（形态对齐 Web 版 `ChatContextMenu.module.css`）。
 *
 * 为什么不用 M3 的 `DropdownMenu`：它没有"指向锚点的小三角"，也没法定制横排 + 竖线分隔；
 * 而且它固定把菜单压在锚点下方（会盖住被长按的那条气泡）。这里用 `Popup` 自己定位：
 *  · 卡片浮在气泡**上方**（上方放不下才翻到下方），有一个小三角指向气泡水平中心；
 *  · 三项**横排**，中间 1dp 竖线隔开；
 *  · 卡片视觉与全项目一致：`surfaceRaised` 底 + 1dp `borderSubtle` + 10dp 圆角 + `raised` 阴影。
 *
 * @param anchor 气泡在**窗口坐标系**里的矩形（`boundsInWindow()`）
 */
@Composable
private fun ChatContextMenu(
    anchor: Rect,
    actions: List<ChatMenuAction>,
    onDismiss: () -> Unit,
) {
    val c = KTheme.colors
    val density = LocalDensity.current
    val windowSize = LocalWindowInfo.current.containerSize
    val animationsEnabled = LocalAnimationsEnabled.current

    val gapPx = with(density) { KSpacing.xs.toPx() }          // 气泡与菜单之间的缝（指针的尖端落在这里）
    val marginPx = with(density) { KSpacing.xs.toPx() }       // 距屏幕边缘的最小留白
    val arrowWPx = with(density) { 12.dp.toPx() }
    val arrowHPx = with(density) { 6.dp.toPx() }
    val arrowHDp = 6.dp
    val cornerPx = with(density) { KRadius.control.toPx() }

    var cardSize by remember { mutableStateOf(IntSize.Zero) }
    val measured = cardSize.width > 0

    // 优先放消息**上方**（指针在卡片下边）；上方放不下才翻到下方（指针在卡片上边）。
    // cardSize 现在把指针的 6dp 也算在内（见下面形状），所以这里不用再单减一次 arrowHPx。
    val menuAbove = cardSize.height > 0 && anchor.top - gapPx - cardSize.height >= marginPx
    // 卡片左上角（窗口坐标，仅用于算指针位置）：这里必须与下面 PopupPositionProvider 的算法一致
    val cardX = if (!measured) 0f else (anchor.center.x - cardSize.width / 2f)
        .coerceIn(marginPx, (windowSize.width - cardSize.width - marginPx).coerceAtLeast(marginPx))
    // 指针中心：对准消息中心，但不许跑到卡片圆角外面去
    val arrowCx = if (!measured) 0f else (anchor.center.x - cardX).coerceIn(
        cornerPx + arrowWPx / 2f,
        (cardSize.width - cornerPx - arrowWPx / 2f).coerceAtLeast(cornerPx + arrowWPx / 2f),
    )

    Popup(
        /**
         * 定位**必须**走 PopupPositionProvider（与 M3 的 DropdownMenu 同一套约定）：
         * 它拿到的 `anchorBounds` 是"应用窗口坐标系"，返回值也按同一套解释。
         *
         * 踩过的坑：这里一开始用"Popup 铺满窗口 + 返回 IntOffset.Zero + 卡片自己在内容里按窗口坐标偏移"，
         * 结果卡片整体被画低了 165px（= 本机状态栏高度）——弹层窗口的 (0,0) 是**屏幕**原点，
         * 而 `boundsInWindow()` 是**应用窗口**原点，该机型上两者差了整整一个状态栏。
         * 表现就是"菜单盖住被长按的那条消息"。改回官方约定后位置才对。
         */
        popupPositionProvider = remember(anchor, gapPx, marginPx) {
            object : PopupPositionProvider {
                override fun calculatePosition(
                    anchorBounds: IntRect,
                    windowSize: IntSize,
                    layoutDirection: LayoutDirection,
                    popupContentSize: IntSize,
                ): IntOffset {
                    val w = popupContentSize.width
                    val h = popupContentSize.height
                    val x = (anchorBounds.center.x - w / 2f)
                        .coerceIn(marginPx, (windowSize.width - w - marginPx).coerceAtLeast(marginPx))
                    val y = if (anchorBounds.top - gapPx - h >= marginPx) {
                        anchorBounds.top - gapPx - h // 气泡上方
                    } else {
                        anchorBounds.bottom + gapPx   // 上方放不下：翻到下方
                    }
                    return IntOffset(x.roundToInt(), y.roundToInt())
                }
            }
        },
        /**
         * ★ `focusable = true` 是**必须**的：它负责"点菜单外面就关掉"
         * （`onDismissRequest` 只有可聚焦弹层才会收到），也负责菜单能拿到点击。
         *
         * 代价与对策（用户反馈："**输入法在唤醒的时候长按消息引用会退出输入法**"）：
         * 可聚焦弹层会把焦点从输入框抢走 → IME 随之收起。**这是系统行为，弹层里改不掉**，
         * 所以对策放在"引用"这个动作上 —— 见 `quoteMessage`：它会把焦点交还输入框
         * 并重新 `show()` 一次，用户看到的是"键盘闪了一下又回来了"。
         *
         * 为什么不干脆改成 `focusable = false` 让弹层不抢焦点：那样 `onDismissRequest`
         * 永远不会触发（点空白关不掉菜单），得自己加全屏透明遮罩层接管点击，
         * 反而多一个"遮罩会不会挡住气泡长按"的新问题，得不偿失。
         */
        properties = PopupProperties(focusable = true),
        onDismissRequest = onDismiss,
    ) {
        // 只有内容本身那么大（位置由 provider 定），点空白关闭交给 focusable + onDismissRequest
        /**
         * 弹出时的"弹性缩放"（M4）：从贴着气泡的那个角长出来，带一点过冲。
         *
         * 起点 0.86 而不是 0：长按菜单是"从手指下钻出来"的东西，从 0 放大像凭空出现；
         * 过冲用 [KMotion.pressSpec]（阻尼比 0.45）—— 与点赞同一个语义："手指施加了力"。
         * 首帧 `measured` 还是 false（卡片尺寸没量到，三角位置会闪），所以量到之后才开始弹。
         */
        val pop = remember { Animatable(0f) }
        LaunchedEffect(measured) {
            if (!measured) return@LaunchedEffect
            if (animationsEnabled) {
                pop.snapTo(0f)
                pop.animateTo(1f, KMotion.pressSpec)
            } else {
                pop.snapTo(1f)
            }
        }
        Column(
            modifier = Modifier
                .graphicsLayer {
                    // 绘制期读动画值：每帧只重绘，不重组
                    val p = if (animationsEnabled) pop.value else 1f
                    val s = 0.86f + 0.14f * p
                    scaleX = s
                    scaleY = s
                    alpha = if (measured) 1f else 0f
                    // 从"靠近锚点"的那个角长出来：菜单在上方 → 从底边长；指针在中 → 从中间长
                    transformOrigin = TransformOrigin(0.5f, if (menuAbove) 1f else 0f)
                },
        ) {
            // 菜单卡片：**一个形状**（圆角矩形 + 指向消息的小三角一体成型）。
            // 旧实现是"三角 + 矩形"两块拼的：三角自己描三条边、矩形自己描四条边，
            // 拼缝处叠出一条多余的线，阴影也只跟矩形走（用户反馈"小三角跟矩形框不是一体的"）。
            // 合成一个形状后，背景/描边/阴影都作用在同一个轮廓上，天然无缝。
            val menuShape = remember(menuAbove, arrowCx, cornerPx, arrowWPx, arrowHPx) {
                ChatMenuShape(
                    pointerUp = !menuAbove,
                    pointerCenterX = arrowCx,
                    pointerWidth = arrowWPx,
                    pointerHeight = arrowHPx,
                    radius = cornerPx,
                )
            }
            Box(
                modifier = Modifier
                    .shadow(KElevation.raised, menuShape)
                    .clip(menuShape)
                    .background(c.surfaceRaised)
                    .border(1.dp, c.borderSubtle, menuShape)
                    // 指针占掉的那 6dp 让给形状画（内容避让，别顶进三角里）
                    .padding(
                        top = if (!menuAbove) arrowHDp else 0.dp,
                        bottom = if (menuAbove) arrowHDp else 0.dp,
                    )
                    .onSizeChanged { cardSize = it },
            ) {
                Row(
                    modifier = Modifier.height(IntrinsicSize.Min),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    actions.forEachIndexed { index, action ->
                        if (index > 0) {
                            Box(
                                modifier = Modifier
                                    .width(1.dp)
                                    .fillMaxHeight()
                                    .padding(vertical = KSpacing.xs)
                                    .background(c.borderSubtle),
                            )
                        }
                        Text(
                            text = action.label,
                            style = KType.body,
                            color = if (action.danger) c.danger else c.textPrimary,
                            modifier = Modifier
                                .clickable(onClick = action.onClick)
                                .padding(horizontal = KSpacing.lg, vertical = KSpacing.sm),
                        )
                    }
                }
            }
        }
    }
}

/**
 * 长按菜单的形状：**圆角矩形 + 指向消息的小三角一体成型**。
 *
 * 三角的底边故意压进矩形 1px —— 两个 Path 取并集后，底边就不再是轮廓的一部分，
 * 描边只会画三角的两条斜边与矩形的其余边，接缝处不会有那条多余的线。
 *
 * @param pointerUp true = 指针在**顶部**（菜单翻到了消息下方时）
 * @param pointerCenterX 指针中心相对卡片左缘的像素（调用方已按圆角收口）
 */
private class ChatMenuShape(
    private val pointerUp: Boolean,
    private val pointerCenterX: Float,
    private val pointerWidth: Float,
    private val pointerHeight: Float,
    private val radius: Float,
) : Shape {
    override fun createOutline(size: Size, layoutDirection: LayoutDirection, density: Density): Outline {
        // 矩形：指针那一侧内缩 pointerHeight（那片留给三角）
        val rectTop = if (pointerUp) pointerHeight else 0f
        val rectBottom = if (pointerUp) size.height else size.height - pointerHeight
        val rectPath = Path().apply {
            addRoundRect(
                RoundRect(
                    Rect(0f, rectTop, size.width, rectBottom),
                    CornerRadius(radius),
                )
            )
        }
        val baseY = if (pointerUp) rectTop + 1f else rectBottom - 1f
        val tipY = if (pointerUp) 0f else size.height
        val cx = pointerCenterX.coerceIn(
            pointerWidth / 2f + radius,
            (size.width - pointerWidth / 2f - radius).coerceAtLeast(pointerWidth / 2f + radius),
        )
        val triPath = Path().apply {
            moveTo(cx - pointerWidth / 2f, baseY)
            lineTo(cx, tipY)
            lineTo(cx + pointerWidth / 2f, baseY)
            close()
        }
        // 取并集：矩形 + 三角 → 单一轮廓（描边/阴影都跟它走）
        val merged = Path().apply { op(rectPath, triPath, PathOperation.Union) }
        return Outline.Generic(merged)
    }
}

/** 日期分隔条：居中、muted 小字（设计稿「今天 14:32」） */
@Composable
private fun DayDivider(text: String) {
    val c = KTheme.colors
    Box(
        modifier = Modifier.fillMaxWidth().padding(vertical = KSpacing.sm),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, style = KType.footnote, color = c.textMuted)
    }
}

/** 聊天列表项：日期分隔条 或 一条消息 */
private sealed interface ChatEntry {
    val key: String

    data class Day(override val key: String, val text: String) : ChatEntry
    data class Bubble(override val key: String, val msg: MessageRepository.MessageUi) : ChatEntry
}

/**
 * 把消息切成「分隔条 + 消息」的扁平列表。
 *
 * 分隔条规则与 web 移动端（`lib/chatRows.ts`）同一条：相邻两条**间隔超过 5 分钟**就插一条，
 * 最旧的一条总是带（跨天必然超过 5 分钟，所以不用再单独判 `isSameDay`）。
 * 文案取那条消息的时间（「今天 14:32」/「昨天 14:32」/「9月12日 14:32」）。
 * 气泡下不再带时间戳（web 移动端亦然），分隔条是唯一的时间信息。
 */
private fun buildChatEntries(items: List<MessageRepository.MessageUi>): List<ChatEntry> {
    val out = mutableListOf<ChatEntry>()
    items.forEachIndexed { index, msg ->
        val prev = items.getOrNull(index - 1)
        val gap = prev?.let { timeGapMillis(msg.raw.createdAt, it.raw.createdAt) }
        if (prev == null || (gap != null && gap > CHAT_TIME_GAP_MS)) {
            out += ChatEntry.Day("day-${msg.raw.id}", dayDividerText(msg.raw.createdAt))
        }
        out += ChatEntry.Bubble("msg-${msg.raw.id}", msg)
    }
    return out
}

/** 相邻消息超过这个间隔就插时间分隔条（与 web 的 `TIME_GAP_MS` 同值） */
private const val CHAT_TIME_GAP_MS = 5 * 60 * 1000L

/**
 * 消息气泡（样式对齐 web 移动端的 MessageBubble）：
 *  · **头像贴在消息外侧**：对方的在左、自己的在右，与消息间距 8dp。
 *  · 文本消息：圆角统一 `radiusRow(14)`、内边距 16dp、**不是**旧版那种"一角切平"的气泡尾巴。
 *  · 图片消息：**裸图**（没有气泡底），圆角 10、等比缩进 65vw × 50vw 内 —— 与 web 的
 *    `.messageImage` 同一套（旧版是"彩色气泡里塞一张 180×180 方图"，多了一层壳）。
 *  · 引用条：气泡**外**跟着的一枚灰色小圆角条（`.messageQuote`），单行「名字: 内容」超出省略；
 *    引用纯图片时是「名字:」+ 24dp 缩略图。旧版塞在气泡里，观感是"气泡里还套一块"。
 *  · **气泡下不带时间**：时间信息只由分隔条给出（相邻消息间隔 > 5 分钟插一条，与 web 同规则）；
 *    复制/引用/撤回一律长按弹出（与 Web 版 ChatContextMenu 同一套项与顺序）。
 */
@Composable
private fun MessageBubble(
    msg: MessageRepository.MessageUi,
    imageHeaders: Map<String, String>,
    partnerAvatar: String?,
    myAvatar: String?,
    /**
     * 这一格图片的来源登记键与下标（见 [chatImageOriginKey]）。
     *
     * 由上层算好传进来，而不是在这里就地算 —— 因为"这段对话里的第几张"要跟
     * 上层 `chatImageUrls`（打开查看器时用的同一份列表）严格同源，
     * 两个地方各算各的迟早会错位。
     *
     * `originKey == null` 表示不登记（例如这条消息的图不在 `chatImageUrls` 里）。
     */
    imageOriginKey: Long? = null,
    imageOriginIndex: Int = -1,
    /** 点图片：打开全屏查看器（图片消息才用得到） */
    onImageClick: () -> Unit,
    onQuote: () -> Unit,
    onRecall: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = KTheme.colors
    val mine = msg.isMine
    val bubbleShape = RoundedCornerShape(KRadius.row)
    val bubbleBg = if (mine) c.accent else c.surface
    val bubbleFg = if (mine) c.onAccent else c.textPrimary
    var menu by remember { mutableStateOf(false) }
    // 气泡在窗口坐标系里的位置：长按菜单要据此定位（含指向气泡的小三角）
    var bubbleBounds by remember { mutableStateOf<Rect?>(null) }
    // 剪贴板与协程（M3 之后：LocalClipboard 的 setClipEntry 是挂起函数，需要一个 scope）
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()

    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start,
        verticalAlignment = Alignment.Top,
    ) {
        if (!mine) {
            Avatar(
                // 有头像就显示头像；没有（含深链进来拿不到头像）退化成默认人像
                url = partnerAvatar,
                name = msg.raw.senderUsername,
                // 设计稿「消息对话」实测头像 40dp（比会话列表行的 48 小一档）
                size = KDimens.avatarCard,
                glyph = GlyphKind.User,
                bg = c.surfaceSubtle,
                fg = c.textPrimary,
            )
            Spacer(Modifier.width(KSpacing.xs))
        }

        Column(
            horizontalAlignment = if (mine) Alignment.End else Alignment.Start,
            modifier = Modifier.widthIn(max = 280.dp),
        ) {
            // 外层 Box 只做长按菜单的锚点（菜单贴着消息弹出）
            Box {
                if (msg.imageUrl != null) {
                    // ---- 图片消息：对齐 web 移动端（MessageBubble.module.css 的 .messageImage）----
                    // web 是**裸图**：没有气泡底、圆角 12、等比缩进 65vw × 50vw 内；
                    // 旧版是"彩色气泡里再塞一张方图"，观感上多了一层壳。
                    // 私密图片必须带鉴权头，否则恒 403（表现为"图片永远白块"）。
                    val context = androidx.compose.ui.platform.LocalContext.current
                    val headers = coil3.network.NetworkHeaders.Builder().apply {
                        imageHeaders.forEach { (k, v) -> set(k, v) }
                    }.build()
                    /**
                     * 图片消息的两个手势（与文字气泡**刻意不同**）：
                     *  · **单击 → 全屏看图**（用户反馈"聊天里的图片点不开全屏"）；
                     *  · **长按 → 底部弹层**（保存图片 / 引用 / 撤回）。
                     *
                     * 为什么图片不走文字那套"长按弹气泡旁的小菜单"：用户明确要求
                     * "长按图片/视频从下面弹出可保存的框"（2026-09-23），而文字气泡的
                     * 横排小菜单保持原样 —— 它没有"保存"这种主操作，弹层反而慢。
                     *
                     * 弹层宿主在 Shell（[LocalMediaSaveOpener]）：保存的进度与结果都在那里，
                     * 这里只负责"喊一声"，不重复实现一遍下载/落盘。
                     */
                    val mediaOpener = LocalMediaSaveOpener.current
                    /**
                     * 这一格的 painter：**额外 remember 一份**，只用来给来源登记读
                     * "这张图什么比例"。
                     *
                     * 为什么不能复用 `SubcomposeAsyncImage` 内部那个 painter：那个在
                     * `SubcomposeAsyncImageContent` 的 subcomposition 里，**外面拿不到**。
                     * 而 [registerViewerOrigin] 需要 painter 来算飞行落位帧的比例
                     * （否则退化成"铺满屏幕"再缩回，看着就是你说的"直接闪现"之后又跳一下）。
                     *
                     * 代价是多一份 painter 对象 —— 但 Coil 的请求**共用内存缓存**，
                     * 同一张图不会解码两次（这也是全项目所有 `registerViewerOrigin` 的既有做法）。
                     */
                    val originPainter = coil3.compose.rememberAsyncImagePainter(
                        model = coil3.request.ImageRequest.Builder(context)
                            .data(msg.imageUrl)
                            .httpHeaders(headers)
                            .build(),
                    )
                    Box(
                        modifier = Modifier
                            // 长按菜单要按图片在窗口里的真实位置定位（指针指向它）
                            .onGloballyPositioned { bubbleBounds = it.boundsInWindow() }
                            // 登记"这一格在哪 + 取景比例 + 圆角"：全屏查看器的进出场飞行靠它。
                            // 圆角必须与下面那行 `clip(...)` 一致（都是 KRadius.control）——
                            // 飞行图会从这个圆角变到全屏的直角。
                            .then(
                                if (imageOriginKey != null && imageOriginIndex >= 0) {
                                    Modifier.registerViewerOrigin(
                                        postId = imageOriginKey,
                                        index = imageOriginIndex,
                                        painter = originPainter,
                                        cornerRadius = KRadius.control,
                                    )
                                } else {
                                    Modifier
                                },
                            )
                            .combinedClickable(
                                onClick = onImageClick,
                                onLongClick = {
                                    val url = msg.imageUrl
                                    if (mediaOpener != null && !url.isNullOrBlank()) {
                                        mediaOpener(
                                            MediaSaveTarget(
                                                url = url,
                                                kind = MediaKind.Image,
                                                headers = imageHeaders,
                                                extraActions = buildList {
                                                    add(MediaSheetAction("引用") { onQuote() })
                                                    if (mine) {
                                                        add(
                                                            MediaSheetAction("撤回", danger = true) {
                                                                onRecall()
                                                            },
                                                        )
                                                    }
                                                },
                                            ),
                                        )
                                    }
                                },
                            ),
                    ) {
                        SubcomposeAsyncImage(
                            model = coil3.request.ImageRequest.Builder(context)
                                .data(msg.imageUrl)
                                .httpHeaders(headers)
                                .build(),
                            contentDescription = null,
                            modifier = Modifier.clip(RoundedCornerShape(KRadius.control)),
                        ) {
                            // 等比缩放：拿到真实宽高后按 aspectRatio 定尺寸，
                            // Fit 让图正好填满（等价于 web 的 max-width/max-height 等比缩放）。
                            // intrinsicSize 还没量出来（加载中）时先画占位块，量到后自动重组成真图。
                            val isz = painter.intrinsicSize
                            val ratio =
                                if (isz.width > 0f && isz.height > 0f) isz.width / isz.height else null
                            val winW = LocalWindowInfo.current.containerSize.width
                            val maxW = with(LocalDensity.current) { (winW * 0.65f).toDp() }
                            val maxH = with(LocalDensity.current) { (winW * 0.50f).toDp() }
                            if (ratio == null) {
                                Box(
                                    Modifier
                                        .size(180.dp)
                                        .kShimmer(RoundedCornerShape(KRadius.control))
                                )
                            } else {
                                SubcomposeAsyncImageContent(
                                    modifier = Modifier
                                        .widthIn(max = maxW)
                                        .heightIn(max = maxH)
                                        .aspectRatio(ratio),
                                    contentScale = ContentScale.Fit,
                                )
                            }
                        }
                    }
                } else {
                    // ---- 文本消息：原气泡 ----
                    Box(
                        modifier = Modifier
                            // 长按菜单要按气泡在窗口里的真实位置定位（指针指向它）
                            .onGloballyPositioned { bubbleBounds = it.boundsInWindow() }
                            // 气泡**至少**与头像同高：单行消息正好齐平。不能靠"内边距凑高度"——
                            // 文字行高是 sp（随系统字号缩放），dp 内边距怎么凑都会差出 1-2dp，
                            // 看起来就是"没对齐"；min 高度 + 文字垂直居中则永远严格齐平。
                            .heightIn(min = KDimens.avatarCard)
                            .clip(bubbleShape)
                            .background(bubbleBg)
                            .combinedClickable(
                                // 单击不做任何事（设计稿里气泡是"可长按"而不是"可点"）；
                                // 复制/引用/撤回全部收进长按菜单，界面上不再常显任何操作文字。
                                onClick = {},
                                onLongClick = { menu = true },
                            )
                            .padding(horizontal = KSpacing.sm),
                        contentAlignment = Alignment.CenterStart,
                    ) {
                        Text(
                            text = msg.raw.content,
                            style = KType.body,
                            // 自己的气泡是 accent 底 → 文字必须 onAccent（深色下 accent 是浅金）
                            color = bubbleFg,
                        )
                    }
                }

                // 长按菜单：自己画的浮层（横排 + 竖线分隔 + 指向气泡的小三角），
                // 视觉令牌与全项目一致；见 ChatContextMenu 的注释。
                if (menu && bubbleBounds != null) {
                    ChatContextMenu(
                        anchor = bubbleBounds!!,
                        actions = buildList {
                            // 纯图片消息没有文字可复制，这一项就不出现（Web 版恒定显示，点了是空操作）
                            if (msg.raw.content.isNotBlank()) {
                                add(
                                    ChatMenuAction("复制") {
                                        menu = false
                                        // 旧写法 LocalClipboardManager.setText 已废弃；
                                        // 新 API 是挂起的 setClipEntry（见 PostDetailScreen 的同类改动）
                                        scope.launch {
                                            clipboard.setClipEntry(
                                                ClipEntry(
                                                    ClipData.newPlainText("聊天消息", msg.raw.content),
                                                ),
                                            )
                                        }
                                    }
                                )
                            }
                            add(
                                ChatMenuAction("引用") {
                                    menu = false
                                    onQuote()
                                }
                            )
                            if (mine) {
                                add(
                                    ChatMenuAction("撤回", danger = true) {
                                        menu = false
                                        onRecall()
                                    }
                                )
                            }
                        },
                        onDismiss = { menu = false },
                    )
                }
            }

            // 引用条：对齐 web 移动端（.messageQuote）—— **气泡外**的一枚灰色小圆角条，
            // 单行「名字: 内容」超出省略；引用的是纯图片时是「名字:」+ 24dp 缩略图。
            // 旧版把引用块塞在气泡里，观感是"气泡里还套一块"；web 上它是跟着气泡走的独立小条。
            if (msg.raw.quotedMessageId != null) {
                val imageQuote = msg.raw.quotedContent.isNullOrBlank() &&
                    !msg.raw.quotedImageUrl.isNullOrBlank()
                Row(
                    modifier = Modifier
                        .padding(top = KSpacing.xxs)
                        .clip(RoundedCornerShape(KRadius.chip))
                        .background(c.surfaceSubtle)
                        .padding(horizontal = KSpacing.xs, vertical = KSpacing.xxs),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
                ) {
                    if (imageQuote) {
                        Text(
                            text = "${msg.raw.quotedSenderUsername.orEmpty()}:",
                            style = KType.caption,
                            color = c.textSecondary,
                            maxLines = 1,
                        )
                        val context = androidx.compose.ui.platform.LocalContext.current
                        val headers = coil3.network.NetworkHeaders.Builder().apply {
                            imageHeaders.forEach { (k, v) -> set(k, v) }
                        }.build()
                        AsyncImage(
                            model = coil3.request.ImageRequest.Builder(context)
                                .data(msg.raw.quotedImageUrl)
                                .httpHeaders(headers)
                                .build(),
                            contentDescription = null,
                            contentScale = ContentScale.Crop,
                            // 引用缩略图不参与长按菜单，固定 24dp 方块即可
                            modifier = Modifier
                                .size(24.dp)
                                .clip(RoundedCornerShape(KRadius.chip)),
                        )
                    } else {
                        Text(
                            text = "${msg.raw.quotedSenderUsername.orEmpty()}: ${msg.raw.quotedPreview}",
                            style = KType.caption,
                            color = c.textSecondary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }

        if (mine) {
            Spacer(Modifier.width(KSpacing.xs))
            Avatar(
                url = myAvatar,
                name = msg.raw.senderUsername,
                size = KDimens.avatarCard,
                glyph = GlyphKind.User,
                bg = c.accent,
                fg = c.onAccent,
            )
        }
    }
}

/**
 * 聊天页内联提示。
 *
 * 与 [KToast] 的区别：那个会为导航胶囊留 101px，聊天页是沉浸态，用这个避免出现一块空白。
 */
@Composable
private fun KToastInline(text: String, onDismiss: () -> Unit) {
    val c = KTheme.colors
    LaunchedEffect(text) {
        kotlinx.coroutines.delay(1600)
        onDismiss()
    }
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(KRadius.row))
            .background(c.surfaceRaised)
            .padding(horizontal = KSpacing.md, vertical = KSpacing.xs),
    ) {
        Text(text, style = KType.caption, color = c.textPrimary)
    }
}

/**
 * 长按菜单退场后、再喊起输入法的等待时长。
 *
 * `Popup(focusable = true)` 关闭时弹层窗口是**异步拆掉**的：同一帧调
 * `keyboard.show()` 会被系统忽略（那时焦点还没真正回到本页的输入框上），
 * 表现就是"点了引用但键盘还是不弹"。150ms 足够让 popup 窗口销毁 + 焦点落回来，
 * 又短到用户完全感知不到。
 */
private const val KEYBOARD_SETTLE_MS = 150L

/**
 * 「最后一个非空值」：专门给**退场动画**用。
 *
 * `AnimatedVisibility(visible = replyTo != null)` 在退场期间内容仍在组合里，
 * 而那一刻 `replyTo` 已经被清成 null —— 不留住最后一个非空值，退场帧里就是一条**空条**
 * （或者 `!!` 直接崩）。与 AppShell 里那个同名工具同一个理由。
 */
@Composable
private fun <T : Any> rememberLastNonNull(value: T?): T? {
    val holder = remember { mutableStateOf<T?>(null) }
    LaunchedEffect(value) {
        if (value != null) holder.value = value
    }
    return value ?: holder.value
}









