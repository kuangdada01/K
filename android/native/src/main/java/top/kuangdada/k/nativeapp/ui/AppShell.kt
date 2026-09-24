package top.kuangdada.k.nativeapp.ui

import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.ContentTransform
import androidx.compose.animation.SharedTransitionLayout
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import android.os.Build
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.dp
import top.kuangdada.k.core.data.AdminRepository
import top.kuangdada.k.core.data.ApiResult
import top.kuangdada.k.core.data.BookRepository
import top.kuangdada.k.core.data.ComposerRepository
import top.kuangdada.k.core.data.CommentRepository
import top.kuangdada.k.core.data.FriendRepository
import top.kuangdada.k.core.data.MessageRepository
import top.kuangdada.k.core.data.PostRepository
import top.kuangdada.k.core.data.RealtimeClient
import top.kuangdada.k.core.data.SessionRepository
import top.kuangdada.k.core.data.ThemePreference
import top.kuangdada.k.core.data.UserRepository
import top.kuangdada.k.core.data.VoiceRepository
import top.kuangdada.k.core.data.resolveUrl
import top.kuangdada.k.core.data.model.BookChapter
import top.kuangdada.k.core.data.model.BookDetail
import top.kuangdada.k.core.data.model.VoiceRoom
import top.kuangdada.k.core.designsystem.component.KButton
import top.kuangdada.k.core.designsystem.component.KNavCapsule
import top.kuangdada.k.core.designsystem.component.KNavItem
import top.kuangdada.k.core.designsystem.component.KPlaceholder
import top.kuangdada.k.core.designsystem.component.KPlaceholderKind
import top.kuangdada.k.core.designsystem.motion.MotionEnterOnce
import top.kuangdada.k.core.designsystem.theme.KDimens
import top.kuangdada.k.core.designsystem.theme.KMotion
import top.kuangdada.k.core.designsystem.theme.KSpacing
import top.kuangdada.k.core.designsystem.theme.KTheme
import com.kyant.backdrop.backdrops.layerBackdrop
import com.kyant.backdrop.backdrops.rememberLayerBackdrop
import com.kyant.backdrop.drawBackdrop
import com.kyant.backdrop.effects.blur
import com.kyant.backdrop.effects.lens
import com.kyant.backdrop.highlight.Highlight
import top.kuangdada.k.core.designsystem.theme.KType
import top.kuangdada.k.core.designsystem.theme.LocalAnimationsEnabled
import top.kuangdada.k.nativeapp.voice.VoiceRoomController

/**
 * 房间对象缓存（进程内）。
 *
 * 导航状态里只放 `roomId`（要能被序列化以支持进程回收恢复），房间名/简介这类信息
 * 放这里。缓存丢失时（进程被回收）房内页会退回列表页，而不是显示一个信息不全的房间。
 */
private val VoiceRoomCache = mutableMapOf<Long, VoiceRoom>()

/**
 * 待编辑帖子的进程内缓存（导航状态里只放 postId）。
 *
 * 编辑入口在帖子卡片上（长按/菜单），那里能拿到完整帖子对象；把它放这里，
 * 导航状态只需一个 id。缓存丢失时（进程回收）编辑入口不会出现在 UI 上，
 * 所以不需要额外的兜底分支。
 */
data class ComposerEditSource(
    val id: Long,
    val description: String,
    val images: List<String>,
    val location: String,
    /**
     * 打开编辑页时**直接把删除确认弹窗亮出来**。
     *
     * 用途：个人主页长按作品的选单里点「删除帖子」—— 用户已经明确表达了"我要删"，
     * 再让他自己去找编辑页里的删除 chip 是多余的。复用同一个编辑页而不是另做一个
     * 确认页，是为了让"删除"只有一处实现（[ComposerScreen] 的弹窗）。
     */
    val openDeleteConfirm: Boolean = false,
)

private val ComposerEdits = mutableMapOf<Long, ComposerEditSource>()

/**
 * 沉浸页里把悬浮胶囊**挪出窗口**的平移量（px，绘制期）。
 *
 * 只是"藏起来"的手段，不参与布局：取值只要**远大于任何窗口高度**就够
 * （本机最高 3168px，这里留了三倍余量，缩放/折叠屏都覆盖得到）。
 * 为什么不写 dp：它必须原样大于窗口像素，跟密度无关才稳。
 */
private const val NavParkedTranslationPx = 10_000f

/**
 * ============================================================
 * 应用外壳：路由分发 + 悬浮导航胶囊
 * ============================================================
 * 设计稿 §3.3 的定稿规则都在这里成立：
 *  · 导航是**不占布局空间的悬浮胶囊**（Box + align(BottomCenter)），内容从它左右留白
 *    与上方继续可见并被真正模糊掉；
 *  · 5 个顶层入口：首页 / 消息 / 图书 / 语音 / 主页；
 *  · **哪些页面高亮哪一项、哪些页面隐藏导航，全部由 [AppDestination] 的路由表决定**
 *    （不再靠路径正则散判 —— 那正是文档指出的旧实现缺陷）。
 */
enum class Tab(val key: String, val label: String) {
    Home("home", "首页"),
    Messages("messages", "消息"),
    Books("books", "图书"),
    Voice("voice", "语音"),
    Profile("profile", "主页"),
}

@Composable
fun AppShell(
    session: SessionRepository,
    posts: PostRepository,
    comments: CommentRepository,
    books: BookRepository,
    users: UserRepository,
    /** 关注（他人主页的「关注 / 已关注」按钮） */
    friends: FriendRepository,
    voice: VoiceRepository,
    messages: MessageRepository,
    realtime: RealtimeClient,
    composer: ComposerRepository,
    admin: AdminRepository,
    navigator: AppNavigator,
    themeMode: ThemePreference.Mode = ThemePreference.Mode.System,
    onThemeChange: (ThemePreference.Mode) -> Unit = {},
    /**
     * 返回栈已空时再按返回键的兜底动作（把 App 最小化，而不是杀进程）。
     *
     * 由 MainActivity 传进来（`moveTaskToBack(true)`）：返回键的处理已经搬到本函数
     * （因为三个覆盖层里有两个是 Shell 自己的状态），但"最小化"是 Activity 的能力。
     */
    minimize: () -> Unit = {},
) {
    val c = KTheme.colors
    val scope = rememberCoroutineScope()
    // 系统关掉动画时，Shell 的进出场（FAB）直接到位，不做缩放/淡入
    val animationsEnabled = LocalAnimationsEnabled.current
    // 打开图片查看器时要拿它做后台预解码（Coil 需要一个 Context）
    val viewerContext = LocalContext.current

    // 首页信息流列表：在 Shell 层创建一次 → 跨 tab 存活（切走再回来不重拉、不丢滚动位置）
    val feedList = remember { posts.newList(PostRepository.Source.Feed) }

    // 未读数：消息页加载会话后回填、SSE 事件到达时也会刷新，用于导航胶囊的消息角标
    var unread by remember { mutableIntStateOf(0) }

    // 当前登录用户 id：决定帖子卡片上要不要显示"编辑"入口（只有自己的帖子能编辑）
    val authState by session.state.collectAsState()
    val myUserId = (authState as? SessionRepository.AuthState.LoggedIn)?.user?.id ?: 0L
    val isLoggedIn = session.isLoggedIn

    /**
     * 当前用户的头像 / 昵称：**优先接口真值，其次落盘的上一份**。
     *
     * 为什么需要这层兜底（用户实测反馈："**私信对话页自己的头像先有占位、然后才变成自己头像**"）：
     * 冷启动时 `authState` 先是 `Restoring`，`/auth/me` 回来之前拿不到 `LoggedIn.user`
     * —— 直接用 `authState` 取的话就是 `null`，头像组件只能先画**默认人像图标**，
     * 等网络往返回来才换成真头像，那一跳正好被用户看到。
     *
     * [SessionRepository.cachedAvatar] 是**上一次登录时落盘**的值，同一帧就读得到，
     * 于是首帧直接就是正确头像。接口回来后这里自动切到真值（换头像因此不会被旧缓存卡住）。
     * 未登录时 `cachedAvatar` 返回 null，不会拿上一个人的头像来渲染。
     */
    val myAvatarUrl = resolveUrl(
        (authState as? SessionRepository.AuthState.LoggedIn)?.user?.avatar
            ?: session.cachedAvatar,
        session.api.baseUrl,
    )
    val myUsername = (authState as? SessionRepository.AuthState.LoggedIn)?.user?.username
        ?: session.cachedUsername.orEmpty()

    /**
     * 实时连接的生命周期：**已登录 + 在前台**才保持长连接。
     *
     * 退到后台就断开（一直挂着白耗电，服务端也有 5 条/账号的上限），回前台自动重连。
     * 退出登录时 [RealtimeClient.runLoop] 自己会结束。
     */
    val lifecycleOwner = androidx.lifecycle.compose.LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner, isLoggedIn) {
        val observer = androidx.lifecycle.LifecycleEventObserver { _, event ->
            when (event) {
                androidx.lifecycle.Lifecycle.Event.ON_START -> if (isLoggedIn) realtime.start(scope)
                androidx.lifecycle.Lifecycle.Event.ON_STOP -> realtime.stop()
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        if (isLoggedIn) realtime.start(scope)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
            realtime.stop()
        }
    }

    /**
     * 事件分发（"微信/小红书那种自己更新"）。
     *
     * 这里只做**跨页面**的两件事：角标未读数、以及事件所指帖子的计数。
     * 页面自己的列表刷新由各页面收集同一个事件流完成（消息页、聊天页、帖子详情页）——
     * 只有它们知道自己当前在看什么，在 Shell 层猜反而会多拉请求。
     */
    LaunchedEffect(realtime) {
        realtime.events.collect { event ->
            when {
                // 新私信/新通知/新公告：都可能改变未读角标
                event.isMessage || event.isNotification || event.isAnnouncement -> {
                    when (val r = messages.unreadTotal()) {
                        is ApiResult.Success -> unread = r.data
                        is ApiResult.Failure -> Unit
                    }
                }
                else -> Unit
            }
            // 有人评论/回复了某条帖子：就地刷新那条帖子的计数（包括首页卡片上的评论数）
            val commented = event.postId
            if (event.isNotification && commented != null) {
                posts.refreshDetail(commented)
            }
        }
    }

    /**
     * 内容版本（发帖/编辑/删帖成功时由仓库自增）。
     *
     * 它是**跨页面的唯一"内容变了"信号**：
     *  · 主页（个人主页）的三份列表也缓存在仓库里，不重拉就看不到刚发的帖子
     *    —— 之前只有首页会刷新，主页要重启 App 才更新（用户实测反馈）；
     *  · 这里订阅一次，同时驱动首页与主页的刷新，避免每个页面各自判断。
     *
     * 原来还有一个 `feedRefreshKey`（发布成功后手写自增），已经删掉：
     * 那条路径上真正生效的是 `resetTo(Home)`，而它正是"从哪进"被弄丢的元凶；
     * 现在刷新统一由这个版本号驱动，不需要第二个信号。
     */
    val contentVersion by posts.contentVersion.collectAsState()

    /**
     * 打开帖子详情。
     *
     * 不再需要记录"从哪来"：`backToPrevious()` 里的 `pop()` 本来就会回到栈里的下一页，
     * 也就是用户进来的地方。之前那些 `resetTo` 才是把"从哪进"弄丢的元凶。
     */
    fun openPostDetail(postId: Long) {
        navigator.push(AppDestination.PostDetailDest(postId))
    }

    /**
     * 资料保存成功后自增 → 让主页重新拉一次 `GET /users/:id`。
     *
     * 为什么要提到 Shell 层：主页在编辑资料页压栈期间**离开了组合**，
     * 它自己的 `remember` 状态已经不是决定因素了；而"该不该重拉"这件事是
     * **导航事件的产物**，放在发起导航的地方（这里）才不会被页面的生命周期吃掉。
     */
    var profileRefreshKey by remember { mutableIntStateOf(0) }

    /**
     * 主页设置弹层开着没有。
     *
     * **状态必须在这里**（而不是 ProfileScreen 内部）：弹层要盖住悬浮导航胶囊，
     * 而胶囊是在页面之后画的 —— 画在页面里的弹层永远压在胶囊下面（用户实测反馈：
     * 「点设置层级被导航栏挡住了」）。提到 Shell 层才能把它画在胶囊**之后**（= 之上）。
     */
    var showProfileSettings by remember { mutableStateOf(false) }

    /**
     * 设置弹层是**从哪一页**打开的（null = 没开）。
     *
     * 为什么不能只用一个布尔：设置入口有**两个** —— 主页右上角的滑块（[ProfileScreen]）
     * 与**他人主页右上角的「…」**（[UserProfileScreen]，设计稿上那一页就是三个点）。
     * 只记"开着没有"的话，弹层只能挂在一个目的地上，另一个页面点了会毫无反应；
     * 而用布尔挂两处又会在同一帧里画出两个弹层。
     *
     * 存**目的地的 encoded 串**（不是 AppDestination 对象）：弹层关闭时
     * `dest` 可能已经变了，用值相等判断才不会"页面切走了弹层还亮着"。
     */
    var profileSettingsFrom by remember { mutableStateOf<String?>(null) }

    /**
     * 长按作品打开的「编辑 / 删除」选单里那条帖子（非空 = 选单开着）。
     *
     * 与 [showProfileSettings] 同样提到 Shell 层：菜单要盖住悬浮导航胶囊，
     * 而胶囊是在页面之后画的（用户实测反馈：「长按弹出的层级会被导航栏遮挡」）。
     */
    var postMenu by remember { mutableStateOf<ComposerEditSource?>(null) }

    /**
     * 图片查看器（M5）：**画在 Shell 里**而不是独立 Activity。
     *
     * 为什么必须搬进来：跨 Activity 做不了 Compose 共享元素，旧实现只能硬切（黑屏一闪）。
     * 搬进 Shell 后它与被点的缩略图共享同一个 `SharedTransitionLayout`，
     * 于是"点图放大 / 下拉缩小回卡片"能真的飞起来。
     *
     * 这里只存"请求"，真正的绘制在下面（胶囊之后）；关闭时把页码回传给请求里的 `onClosed`，
     * 调用方据此把列表滚到同一张（旧实现用 `setResult`，语义一致）。
     */
    var viewer by remember { mutableStateOf<ImageViewerRequest?>(null) }
    /** 查看器当前停在第几张（返回键关闭时也用它回传页码） */
    var viewerPage by remember { mutableIntStateOf(0) }
    /**
     * Shell 请求查看器**开始退场**（返回键）。
     *
     * 为什么不直接 `viewer = null`：退场飞行由查看器自己播（缩回来源缩略格），
     * 这一刻就把内容卸掉会让飞行腰斩 —— 用户看到的是"图片直接消失、没飞回去"。
     */
    var viewerClosing by remember { mutableStateOf(false) }
    /**
     * 缩略格的位置登记表（见 [ViewerOrigins]）：页面里的格子写、查看器读，
     * 用来算"从哪一格飞出来、飞回哪一格"。
     */
    val viewerOrigins = remember { ViewerOrigins() }

    /**
     * 「长按图片/视频 → 底部弹层 → 保存到相册」的当前请求（null = 没开着）。
     *
     * 与查看器同一条思路：能长按的地方有四处（聊天图片、帖子九宫格、全屏看图、视频播放器），
     * 弹层与"保存中/已保存/失败"状态机只在这里养一份，页面通过 [LocalMediaSaveOpener] 喊一声。
     */
    var mediaSaveTarget by remember { mutableStateOf<MediaSaveTarget?>(null) }

    /**
     * 共享元素的"声明计数"表（见 [SharedElementPeers]）。
     *
     * 与 [viewerOrigins] 同一个位置、同一个理由：**一处创建、多处写入**。
     * 目前只服务视频封面那条飞行（判断"对面那一端在不在"，见 [shouldPreHideSharedElement]）。
     */
    val sharedElementPeers = remember { SharedElementPeers() }

    /**
     * 打开**他人主页**（点首页卡片/帖子详情里的头像与昵称，或深链 `/profile/:id`）。
     *
     * 三种情况分别处理，缺一个都会出错：
     *  1. `userId <= 0`：服务端没有这个用户（历史数据里的匿名帖），什么都不做 ——
     *     推一个必然 404 的页面比不响应更糟；
     *  2. **点的是自己**（`userId == myUserId`）：**切到「主页」tab**，而不是推一个
     *     "他人主页"——那里没有编辑资料/分享主页/管理后台/转发收藏，用户会以为自己的
     *     东西不见了。这条路径真实存在：自己的帖子出现在首页信息流里，点自己的头像；
     *  3. 其它人：压栈进他人主页（滑动进场，返回回到"进来的那一页"，可能是详情页）。
     *
     * 顺带清掉主页长按留下的作品选单：那个选单挂在 Shell 上、只在 [AppDestination.Profile]
     * 时收掉（见下面的 LaunchedEffect），从别处推他人主页时它还开着就会压在新页面上。
     */
    fun openUserProfile(userId: Long) {
        if (userId <= 0L) return
        postMenu = null
        if (myUserId > 0L && userId == myUserId) {
            navigator.switchTab(AppDestination.Profile)
            return
        }
        navigator.push(AppDestination.UserProfileDest(userId))
    }

    /**
     * 公告发布成功后自增 → 让管理后台的公告列表重新拉一次。
     *
     * 与 [profileRefreshKey] 同一个道理：管理后台在新建公告页压栈期间**离开了组合**，
     * 它自己的 remember 状态已经不是决定因素；"该不该重拉"是导航事件的产物，
     * 放在发起导航的地方才不会被页面的生命周期吃掉。
     */
    var announcementRefreshKey by remember { mutableIntStateOf(0) }

    val dest = navigator.current

    // 离开主页时把设置弹层收掉（它挂在 Shell 上，不跟页面的生命周期走）——
    // 不收的话，切到别的 tab 再回来会发现弹层还开着（用户从没点过它）
    LaunchedEffect(dest) {
        // 设置入口只在这两页上：自己的主页（滑块）与他人主页（「…」）
        if (!dest.hasSettingsEntry) {
            showProfileSettings = false
            profileSettingsFrom = null
            postMenu = null
        }
        // 从 A 的主页「…」打开设置、又切到 B 的主页时，弹层要跟着收掉 ——
        // 它的内容（主题/退出登录）是全局的，但"属于哪一页"变了就该重开
        if (profileSettingsFrom != null && profileSettingsFrom != encodeDest(dest)) {
            showProfileSettings = false
        }
    }

    /** 设置弹层当前是不是开着（可见性判据见 [profileSettingsFrom] 的注释） */
    val settingsVisible = showProfileSettings && profileSettingsFrom == encodeDest(dest)

    /**
     * 覆盖态：登录弹层要浮在**返回栈顶那一页**之上（设计稿 §3.3.1 —— 遮罩压暗背后页面，
     * 连底部导航一起压暗）。所以背后渲染的是 `navigator.previous`，而不是 Login 自己。
     * 栈空时（进程回收后直接恢复到 login）回落到首页。
     */
    val base = if (dest is AppDestination.Login) navigator.previous ?: AppDestination.Home else dest

    /**
     * [base] 对应的**实例号**（见 [AppNavigator.currentSeq]）。
     *
     * 覆盖态要取栈顶条目的号、不能取登录页自己的：登录压栈时底下那页照常渲染，
     * 用登录页的实例号会让底下这个详情页被当成"新实例"（滚动位置丢掉）。
     */
    val baseSeq = if (dest is AppDestination.Login) navigator.previousSeq ?: 0L else navigator.currentSeq

    /**
     * 每个目的地的 `rememberSaveable` 状态保管箱。
     *
     * 为什么需要它：导航到二级页时，栈顶那一页会**离开组合**，`rememberLazyListState()`
     * 这类状态随之被销毁 —— 返回时列表就跳回顶部（用户看到的是"返回首页回到顶部、
     * 所有页面都没有记忆"）。Compose 为此提供了 [rememberSaveableStateHolder]：
     * 按 key 把可保存状态存下来、回来时恢复，**不用把每个列表的 scrollState 逐个提到 Shell 层**。
     *
     * 注意它只覆盖 `rememberSaveable` 系（`rememberLazyListState` / `rememberScrollState` /
     * `rememberSaveable`）—— 用 `remember { mutableStateOf }` 的临时状态不在其中，
     * 这类状态要么本来就该丢，要么要改成 `rememberSaveable`。
     */
    val stateHolder = androidx.compose.runtime.saveable.rememberSaveableStateHolder()

    /**
     * 进过组合的、**带实例号**的页面状态 key（清理时用，见下面那个 `LaunchedEffect`）。
     *
     * ⚠️ 只记二级/三级页（`seq > 0`）。一级 tab 用的是稳定 key（`home` / `messages` …），
     * **绝不能进这个集合** —— tab 之间切换不压栈，切走的那一页必然不在"当前页 + 返回栈"里，
     * 一旦被当成"已出栈"清掉，切回来列表就蹦回顶部（实测踩过：首页 → 图书 → 首页，
     * 列表滚到一半的位置没了）。tab 页的记忆是既有约定，见 MessagesScreen 里
     * `tabIndex` 那段注释。
     */
    val savedPageKeys = remember { mutableSetOf<String>() }

    /**
     * 把**已经出栈**的页面遗留在 [stateHolder] 里的状态清掉。
     *
     * 为什么需要清：key 里带了实例号（见 [destStateKey]），每次"进详情页 → 返回 → 再进"
     * 都会产生一个新 key，旧 key 再没有恢复的机会 —— 不清就随访问次数线性占内存。
     *
     * 为什么延迟 1.2s：`SaveableStateProvider` 是在内容**离开组合**那一刻把状态写回保管箱的，
     * 而 `AnimatedContent` 的退场页要等转场动画播完才离开组合；清早了会被它写回，等于没清。
     * 转场弹簧约 0.3~0.6s，这里留了一倍余量。
     *
     * 依赖 `current` / `depth` 触发：每次导航后都会重跑，所以万一时序上漏了一次
     * （例如用户在 1.2s 内连续进出同一页），下一次导航还会把它清掉。
     */
    LaunchedEffect(navigator.current, navigator.depth) {
        kotlinx.coroutines.delay(1200)
        val alive = navigator.aliveStateKeys()
        val dead = savedPageKeys.filterNot { it in alive }
        dead.forEach { stateHolder.removeState(it) }
        savedPageKeys.removeAll(dead.toSet())
    }

    /**
     * 转场用的"页面 + 这一步的导航操作 + 层级 + **实例号**"。
     *
     * **为什么要把 op / 层级冻进 targetState，而不是在 `transitionSpec` 里读
     * `navigator.lastOp`**（这正是改前的写法，有真机 bug）：
     *
     * `AnimatedContent` 要求 `transitionSpec` 是 `(initialState, targetState)` 的**纯函数** ——
     * 它在转场进行期间会随重组被反复求值。之前读的 `lastOp` / `depth` 是导航器上的可变状态，
     * 于是**后续任意一次导航改写它，正在飞的转场就会换方向**：表现是同一个帖子
     * **第一次进是从右往左、第二次进有时从左往右**（用户实测反馈）。
     *
     * `remember(base, baseSeq)` 把它在"base 变化的那一次组合"里冻结：Compose 的快照是整帧
     * 原子生效的，`push()` 里 `current` 与 `lastOp` 的写入在同一帧被观测到，所以这里读到的
     * op 一定属于这一步导航；此后 base 不变，op 也不会再变。
     *
     * 于是方向只由"这一对页面"决定：同一对页面（Home → PostDetail）**永远是同一个方向**，
     * 与历史、与时机、与是否打断上一个转场都无关。
     *
     * `seq`（实例号）一并冻进来是给**转场期间那两个内容**用的：旧内容那一份要按它当初的
     * 实例号找自己的状态保管箱（见 [destStateKey]）。它也是 `remember` 的第二个 key ——
     * 换实例（`replace()`）时内容要重建，不能复用被替换那页的状态。
     */
    val shellPage = remember(base, baseSeq) {
        ShellPage(dest = base, op = navigator.lastOp, depth = navigator.depth, seq = baseSeq)
    }

    /**
     * 头像共享元素的"发起状态"（见 [AvatarShareState]）。
     *
     * 由 Shell 持有：**卡片写入**（点头像时记下"是这张卡发起的"）、**对方主页读取** ——
     * 这样同一屏里同作者的多个头像只有发起的那一个参与共享元素，
     * 不会出现"头像从另一张卡的位置飞过来"。
     */
    val avatarShare = remember { AvatarShareState() }

    /**
     * 当前页正文（路由分发）。
     *
     * 参数名用 `page`、**刻意不叫 `base`**：页面转场期间同一帧里存在两页 ——
     * 外层的 `base` 是"目标页"，这个参数是"这一份组合要渲染的那一页"，两者不是一回事。
     * 若继续用 `base` 命名，出场的旧页会按新页的数据渲染（表现为"旧页闪一下新内容"）。
     *
     * **不要用 `remember` 包这个 lambda**：它捕获了 `myUserId` / `unread` / `contentVersion`
     * 这些"每次组合重算"的值，`remember` 会把首次的值冻住（表现为登录后头像不变、
     * 未读数不涨这类"看起来像数据没刷新"的 bug）。
     */
    val pageContent: @Composable (page: AppDestination) -> Unit = { page ->
        when (page) {
            is AppDestination.Home -> FeedScreen(
                posts = posts,
                list = feedList,
                // 未登录点互动（点赞/收藏/转发）→ 拉起登录弹层
                isLoggedIn = isLoggedIn,
                onRequireLogin = { navigator.push(AppDestination.Login) },
                // 页头右上角的搜索圆钮 → 搜索发现（设计稿映射表：搜索发现高亮「首页」）
                onOpenExplore = { navigator.push(AppDestination.Explore()) },
                refreshKey = contentVersion,
                myUserId = myUserId,
                // 首页卡片上**不再有编辑入口**（用户要求）：编辑统一从「个人主页 → 我的作品」进。
                // 详情页的「…」里的编辑保留 —— 那是帖子自己的动作菜单，不是列表上的杂物。
                onEdit = null,
                // 信息流里点任何东西（卡片、配图、视频封面、评论数）都进详情页：
                // 全屏看图 / 全屏播放属于详情页里的二次动作（用户明确要求）
                onOpenPost = { postId -> openPostDetail(postId) },
                // 点正文里的 #话题 → 搜该话题的相关帖子（同一个搜索页，带 tag 参数）
                onTagClick = { tag -> navigator.push(AppDestination.Explore(tag = tag)) },
                // 点卡片上的头像 / 昵称 → 进这个人的主页（自己的话切到「主页」tab）
                onOpenUser = { userId -> openUserProfile(userId) },
            )

            // 设计稿映射表：搜索发现高亮**首页**（二级页面按所属一级页高亮）
            is AppDestination.Explore -> ExploreScreen(
                posts = posts,
                session = session,
                myUserId = myUserId,
                initialTag = page.tag,
                onTagClick = { tag -> navigator.push(AppDestination.Explore(tag = tag)) },
                // 同上：搜索结果的卡片也不放编辑入口
                onEdit = null,
                onOpenPost = { postId -> openPostDetail(postId) },
                onOpenVideo = { postId -> navigator.push(AppDestination.VideoDest(postId)) },
                onOpenUser = { userId -> openUserProfile(userId) },
            )

            // 帖子详情（首页/发现点卡片或评论数进来）
            is AppDestination.PostDetailDest -> PostDetailScreen(
                postId = page.postId,
                posts = posts,
                comments = comments,
                session = session,
                realtime = realtime,
                myUserId = myUserId,
                onBack = { navigator.pop() },
                onRequireLogin = { navigator.push(AppDestination.Login) },
                onEdit = { post ->
                    ComposerEdits[post.id] = ComposerEditSource(
                        id = post.id,
                        description = post.description,
                        images = post.post.images,
                        location = post.location,
                    )
                    navigator.push(AppDestination.ComposerDest(editingPostId = post.id))
                },
                // 详情页的视频不再跳全屏播放器：正文块里的视频**进来就带声自动播放**
                // 并在画面底部带进度条（用户要求），所以这里不再传 onOpenVideo。
                // 评论数变化同步到列表卡片（详情页是"发一条 +1、删一条 -1"）
                onCommentCountChanged = { delta -> posts.bumpCommentCount(page.postId, delta) },
                // 正文视频的全屏入口 → 沉浸播放器（地址由 VideoDest 自己从缓存取）
                onOpenVideo = { navigator.push(AppDestination.VideoDest(page.postId)) },
                // 帖子已不存在（详情接口 404）→ 摘掉这个死页面后退回**进来时那一页**
                // （从消息点通知进来就回消息，不再把人甩去首页）
                onPostGone = { goneId ->
                    posts.removeLocal(goneId)
                    ComposerEdits.remove(goneId)
                    posts.bumpContentVersion()
                    val popped = navigator.backToPrevious { dest ->
                        dest is AppDestination.PostDetailDest && dest.postId == goneId
                    }
                    // 栈空（深链直接进详情页）时没有"上来那一页"可回，兜底回首页
                    if (!popped) navigator.resetTo(AppDestination.Home)
                },
                // 点正文里的 #话题 → 搜该话题
                onTagClick = { tag -> navigator.push(AppDestination.Explore(tag = tag)) },
                // 点作者行（头像 / 昵称）→ 这个人的主页
                onOpenUser = { userId -> openUserProfile(userId) },
            )

            // 他人主页（设计稿「他人资料页」）：从卡片/详情的头像进来，或深链 /profile/:id
            is AppDestination.UserProfileDest -> UserProfileScreen(
                userId = page.userId,
                posts = posts,
                users = users,
                friends = friends,
                session = session,
                myUserId = myUserId,
                // 深链 `/profile/:id` 直接推上来时返回栈是空的（没有"上来那一页"），
                // 这时兜底回首页；正常从卡片/详情进来则是 pop 回那一页
                onBack = { if (!navigator.pop()) navigator.resetTo(AppDestination.Home) },
                onRequireLogin = { navigator.push(AppDestination.Login) },
                onOpenPost = { postId -> openPostDetail(postId) },
                // 点「私信」→ 与这个人聊天（昵称顺手带下去，聊天页顶栏要用）
                onOpenChat = { userId, name ->
                    navigator.push(AppDestination.ChatDest(userId, name))
                },
                // 「…」→ 设置弹层（与主页同一个弹层；层级见 profileSettingsFrom 的注释）
                onOpenSettings = {
                    profileSettingsFrom = encodeDest(page)
                    showProfileSettings = true
                },
                // 长按自己的作品 → 编辑/删除选单（由 Shell 画在导航胶囊之上）
                onRequestPostMenu = { source -> postMenu = source },
                postsRefreshKey = contentVersion,
            )

            // 视频播放（沉浸）。视频地址从帖子缓存取；缓存丢了就直接退回上一页
            is AppDestination.VideoDest -> {
                val cached = posts.cached(page.postId)
                val videoUrl = resolveUrl(cached?.post?.videoUrl, session.api.baseUrl)
                if (videoUrl != null) {
                    VideoPlayerScreen(
                        url = videoUrl,
                        title = cached?.title,
                        onBack = { navigator.pop() },
                    )
                } else {
                    androidx.compose.runtime.LaunchedEffect(page.postId) { navigator.pop() }
                }
            }

            is AppDestination.Messages -> MessagesScreen(
                messages = messages,
                admin = admin,
                realtime = realtime,
                isLoggedIn = session.isLoggedIn,
                onOpenChat = { partnerId, name, avatar ->
                    navigator.push(AppDestination.ChatDest(partnerId, name, avatar))
                },
                onOpenAnnouncements = { navigator.push(AppDestination.Announcements) },
                // 点互动通知 → 打开它指向的帖子（通知里带 post_id）
                onOpenPost = { postId -> openPostDetail(postId) },
                onRequireLogin = { navigator.push(AppDestination.Login) },
                onUnreadChanged = { unread = it },
            )

            is AppDestination.Announcements -> AnnouncementsScreen(
                repo = admin,
                isLoggedIn = session.isLoggedIn,
                onBack = { navigator.pop() },
                onRequireLogin = { navigator.push(AppDestination.Login) },
            )

            is AppDestination.Admin -> AdminScreen(
                repo = admin,
                onBack = { navigator.pop() },
                onNewAnnouncement = { navigator.push(AppDestination.NewAnnouncement) },
                refreshKey = announcementRefreshKey,
            )

            // 新建公告（设计稿「新建公告」）。发布成功后回到管理后台并重拉公告列表 ——
            // 不重拉的话新公告不会出现在列表里（用户会以为发布失败）
            is AppDestination.NewAnnouncement -> NewAnnouncementScreen(
                repo = admin,
                onBack = { navigator.pop() },
                onCreated = {
                    navigator.pop()
                    announcementRefreshKey += 1
                },
            )

            is AppDestination.ChatDest -> ChatScreen(
                messages = messages,
                partnerId = page.partnerId,
                partnerName = page.partnerName,
                // 对方头像由会话列表带过来（消息接口里没有头像字段）
                partnerAvatar = page.partnerAvatar,
                // 自己的头像取当前登录用户；未登录/无头像 → 默认人像。
                // 走 [myAvatarUrl]（含"落盘的上一份"兜底）而不是直接读 authState ——
                // 否则冷启动首帧是 null、要等 /auth/me 回来才出图（用户实测的"先占位再变"）
                myAvatar = myAvatarUrl,
                realtime = realtime,
                onBack = { navigator.pop() },
            )

            is AppDestination.ComposerDest -> ComposerScreen(
                composer = composer,
                // 设计稿「发布弹层」的头像行要显示当前登录用户的头像与昵称
                // （同样走带落盘兜底的 [myAvatarUrl]/[myUsername]）
                myAvatar = myAvatarUrl,
                myName = myUsername,
                onClose = { navigator.pop() },
                onPosted = {
                    /**
                     * 发布/保存成功 → 退回**进来时那一页**，并让各列表重拉。
                     *
                     * 之前这里是 `pop()` 之后紧接 `resetTo(Home)`：那句 `resetTo` 把刚才的
                     * pop 完全盖掉了 —— 不管从哪进发布页，最后都会**清空返回栈、硬落到首页**
                     * （与用户反馈的"从消息点通知进帖子，返回却不在消息"是同一类问题：
                     * `resetTo` 会丢掉"从哪进"）。
                     *
                     * 现在只 `pop()`：从主页发就回主页、从首页发就回首页。
                     * 列表的新鲜度由 [PostRepository.contentVersion] 驱动（发帖成功时自增），
                     * 不再需要在这里手写"回首页看结果"。
                     */
                    navigator.pop()
                },
                editing = page.editingPostId?.let { id ->
                    ComposerEdits[id]?.let { e ->
                        EditingPost(
                            id = e.id,
                            description = e.description,
                            existingImages = e.images,
                            location = e.location,
                            openDeleteConfirm = e.openDeleteConfirm,
                        )
                    }
                },
                /**
                 * 删帖（编辑态 chip 触发，已二次确认）。
                 *
                 * 走 [PostRepository.deletePost]：它在服务端删除成功后**就地把它从所有已加载
                 * 的列表里摘掉**（首页/主页/搜索/收藏都会同步），并连带清掉 [ComposerEdits]
                 * 这份进程内缓存 —— 不清的话，返回后如果又点开这条帖子，编辑页还能拿到它的
                 * 旧正文（缓存里还留着），看起来像"删了还能编辑"。
                 */
                onDeleteRequest = { postId ->
                    val r = posts.deletePost(postId)
                    if (r is ApiResult.Success) ComposerEdits.remove(postId)
                    r
                },
                /**
                 * 删帖成功 → **退回"进来时那一页"**（主页进就回主页、消息进就回消息、首页进就回首页）。
                 *
                 * 关键点有两个，缺一个就会出错：
                 *  1. **先把"指向这条已被删掉的帖子"的详情页从栈里摘掉**，否则 pop 回去
                 *     正好是那个死页面（实测「帖子加载失败 HTTP 404」）；
                 *  2. 然后 `backToPrevious()` —— 而不是 `resetTo(...)`。
                 *     之前我用 `resetTo`：死页面确实没了，但它**清空返回栈**、把人硬送回某个固定页
                 *     （先是 Home，后来改成 detailEntryDest）——"从哪进"这个信息直接丢了
                 *     （用户实测反馈：从消息点通知进帖子，返回却落在别处）。
                 */
                onDeleted = {
                    val goneId = page.editingPostId
                    val popped = navigator.backToPrevious { dest ->
                        goneId != null && dest is AppDestination.PostDetailDest && dest.postId == goneId
                    }
                    // 栈空（深链/进程回收后直接进详情页）：没有"上来那一页"可回，兜底回首页
                    if (!popped) navigator.resetTo(AppDestination.Home)
                    // 内容变了：首页/主页的列表都要重拉（deletePost 里已就地移除，
                    // 这里补一次版本号让各页面按自己的口径刷新）
                    posts.bumpContentVersion()
                },
            )

            is AppDestination.Books -> BooksScreen(
                books = books,
                onOpenDetail = { id -> navigator.push(AppDestination.BookDetailDest(id)) },
                // **没有 onOpenExplore**：图书页的搜索是它自己的（就地搜书名/作者，见 BooksScreen）。
                // 曾经这里 push 的是首页那个"搜索发现"—— 那是搜帖子的，搜书名一条也搜不到。
            )

            is AppDestination.Voice -> VoiceRoomsScreen(
                voice = voice,
                isLoggedIn = session.isLoggedIn,
                onOpenRoom = { room ->
                    // 把房间对象放进进程内缓存：导航状态里只带 roomId（可序列化），
                    // 进程被回收后恢复时缓存为空 → 会让用户回到列表页而不是空白房内页
                    VoiceRoomCache[room.id] = room
                    navigator.push(AppDestination.VoiceRoomDest(room.id))
                },
            )

            is AppDestination.VoiceRoomDest -> {
                val room = VoiceRoomCache[page.roomId]
                if (room == null) {
                    // 进程回收后恢复：缓存没了，退回列表页（比进一个信息不全的房间页好）
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        KPlaceholder(
                            kind = KPlaceholderKind.Error,
                            title = "房间信息已丢失",
                            description = "进程被系统回收后无法恢复房内状态，请从列表重新进入",
                            action = { KButton("返回列表", onClick = { navigator.pop() }) },
                        )
                    }
                } else {
                    // LocalContext.current 必须在 @Composable 作用域里读 ——
                    // 放进 remember 的 lambda 里会报 "Composable invocations can only
                    // happen from the context of a @Composable function"
                    val appContext = LocalContext.current
                    // 控制器与页面同生命周期：进房建、离房销毁（leave 会关 WS 与麦克风）
                    val controller = remember(page.roomId) {
                        VoiceRoomController(
                            context = appContext,
                            voice = voice,
                            room = room,
                        )
                    }
                    VoiceRoomScreen(
                        voice = voice,
                        controller = controller,
                        room = room,
                        onBack = { navigator.pop() },
                        /**
                         * 清空聊天记录的权限（设计稿「文字聊天 → 清空」）：
                         * **房间创建者或管理员**，与 Web 端 `canClearChat` 同一判据
                         * （服务端还会再判一次，这里只决定画不画那个按钮）。
                         */
                        canClearChat = room.isCreator ||
                            (authState as? SessionRepository.AuthState.LoggedIn)?.user?.isAdmin == true,
                        // 「…」菜单里的删除房间入口（真正的权限在服务端再判一次）。
                        // 判据比 canClearChat 多一条 creator_id 比对：**建房响应里的 room
                        // 不带 isCreator**（只有列表接口逐查看者计算），刚建完就进房时
                        // 只能靠 creator_id == 我的 id 判定，否则菜单里永远没有删除项。
                        canDelete = room.isCreator == true ||
                            (myUserId > 0 && room.creatorId == myUserId) ||
                            voice.isOwnGuestRoom(room.id) ||
                            (authState as? SessionRepository.AuthState.LoggedIn)?.user?.isAdmin == true,
                    )
                }
            }

            is AppDestination.Profile -> ProfileScreen(
                posts = posts,
                users = users,
                session = session,
                themeMode = themeMode,
                onThemeChange = onThemeChange,
                onLoggedOut = { navigator.resetTo(AppDestination.Home) },
                onRequireLogin = { navigator.push(AppDestination.Login) },
                onOpenAdmin = { navigator.push(AppDestination.Admin) },
                onOpenEditProfile = { navigator.push(AppDestination.ProfileEdit) },
                onOpenSettings = {
                    profileSettingsFrom = encodeDest(AppDestination.Profile)
                    showProfileSettings = true
                },
                refreshKey = profileRefreshKey,
                /**
                 * 帖子内容版本 -> 主页的「帖子」列表重拉。
                 *
                 * 主页渲染的是 `GET /users/:id/posts` 那份列表（缓存在仓库里），
                 * 发帖/删帖只改了服务端与本地缓存 —— 不给这个信号，用户从发布页回到主页
                 * 看到的是**旧列表**（要重启 App 才刷新）。
                 */
                postsRefreshKey = contentVersion,
                /**
                 * 长按作品 → 打开操作选单（编辑 / 删除）。
                 *
                 * 选单由 Shell 画（要盖住导航胶囊）；这里只记下"是哪条帖子"。
                 */
                onRequestPostMenu = { source -> postMenu = source },
                // 点作品格子 → 帖子详情（沉浸页，自带返回）
                onOpenPost = { postId -> openPostDetail(postId) },
            )

            // 编辑资料（设计稿「编辑资料」）。昵称/简介/邮箱都来自会话里的登录用户，
            // 这里把 authState 里的用户透传下去；未登录时页面自己渲染"去登录"。
            is AppDestination.ProfileEdit -> ProfileEditScreen(
                users = users,
                session = session,
                user = (authState as? SessionRepository.AuthState.LoggedIn)?.user,
                onBack = { navigator.pop() },
                // 保存成功后就地返回主页，并让主页重拉一次公开资料
                // （会话里的用户对象已由编辑页替换，但主页渲染的是 /users/:id 的结果）
                onSaved = {
                    navigator.pop()
                    profileRefreshKey += 1
                },
                onRequireLogin = { navigator.push(AppDestination.Login) },
            )

            // 覆盖态：底下那页已由 base 渲染，这里不再有内容（弹层在本函数末尾叠加）
            is AppDestination.Login -> Unit

            is AppDestination.BookDetailDest -> BookDetailScreen(
                books = books,
                bookId = page.bookId,
                onBack = { navigator.pop() },
                onRead = { detail, chapter ->
                    BookReaderEntries[detail.id] = detail to chapter
                    navigator.push(readerDestination(detail, chapter))
                },
            )

            is AppDestination.ReaderDest -> ReaderHost(
                books = books,
                bookId = page.bookId,
                chapterFile = page.chapterFile,
                onBack = { navigator.pop() },
                // 阅读器的 ☀ 工具切的是 App 主题（Q5：阅读器跟随 App 主题）
                themeMode = themeMode,
                onThemeChange = onThemeChange,
            )
        }
    }

    /**
     * 返回键：**先关弹层 → 再退页面栈 → 最后最小化**。
     *
     * 为什么从 `MainActivity` 搬到这里（M2）：三个覆盖层里有两个（设置弹层 / 作品选单）
     * 是 Shell 自己的布尔状态，MainActivity 看不到它们 —— 留在那边就会出现
     * **"设置弹层开着按返回键，App 直接被最小化"**（因为 `navigator.pop()` 在 tab 页上返回 false）。
     *
     * 为什么用 `PredictiveBackHandler` 而不是 `BackHandler`：`BackHandler` 会**吞掉手势进度**，
     * 系统拿不到 progress 就没法做预测式返回的预览（Android 13+ 的返回手势观感）。
     * 这里把 `progress` 收下来不用（M4 会把它透给弹层做"跟手"），
     * **`collect` 正常结束 = 手势已提交**（用户确实要返回）；手势中途取消时
     * `collect` 抛 CancellationException 直接结束协程，下面的分支不会执行 —— 这正是想要的。
     */
    PredictiveBackHandler(enabled = true) { progress ->
        progress.collect { }
        when {
            // 图片查看器在最上层（M5）：返回键先退它，再退弹层、页面栈 —— 与绘制顺序一致。
            // 这里只是**请求**退场：飞行由查看器播完（缩回来源缩略格）再回来把 viewer 置空，
            // 直接置空会让飞行腰斩（旧实现就是这么丢掉"飞回去"的）。
            viewer != null -> viewerClosing = true
            navigator.current is AppDestination.Login -> navigator.pop()
            showProfileSettings -> showProfileSettings = false
            postMenu != null -> postMenu = null
            !navigator.pop() -> minimize()
        }
    }

    /**
     * 覆盖层"最后一个非空值"（退出动画期间数据已被清空，但弹层还要按原内容画完）。
     *
     * 为什么需要：作品选单的可见性由 `postMenu != null` 决定，而关闭它的那一刻
     * `postMenu` 就变成 null 了 —— 没有这份留存，退场动画会画出一个空弹层。
     */
    val menuPost = rememberLastNonNull(postMenu)

    /**
     * 底部导航胶囊的真毛玻璃源（Kyant0 的 backdrop 库）。
     *
     * 挂在下面的 `SharedTransitionLayout` 上（见那段「源层上移」的注释）：
     * 录进去的是**页面内容 + 共享元素的飞行覆盖层** → 飞行经过胶囊时，玻璃折射的是真实画面，
     * 而不是"卡片被挖掉的那块空白"。
     *
     * ⚠️ 这一层**只能给胶囊用**：胶囊画在源层**之后**（源里不含它）✓。
     * 页面内部的顶栏用的是各自的页面级源（见 `rememberTopBarGlass` 的注释 ——
     * 顶栏在源层内容**里面**，采样这层会自引用、直接原生崩溃）。
     *
     * 它不随转场移动（`fillMaxSize()`、且是胶囊的共同祖先）→ 坐标稳定，不需要任何开关判据。
     *
     * ⚠️ 不要加 vibrancy()/colorFilter：本机实测它会打断效果链、blur 不生效（详见 BooksScreen 同段注释）。
     */
    val canBlur = Build.VERSION.SDK_INT >= 31
    val pageBg = c.bgPage
    val frostedTint = c.frosted
    // 胶囊的色膜刻意比顶栏淡：液态玻璃要"通透 + 折射"，色膜太厚会把折射压成一片灰。
    val capsuleTint = c.frosted.copy(alpha = 0.32f)
    // ⚠️ 源那一层的 `onDraw` 必须用 [rememberBackdropOnDraw]（固定实例），
    // **不要**在这里写内联 lambda —— 那是"玻璃闪一下 / 重新加载"的根因，理由见那个函数的注释。
    val shellBackdrop = rememberLayerBackdrop(onDraw = rememberBackdropOnDraw(pageBg))

    /**
     * 胶囊的**玻璃 modifier（整份记住）**。
     *
     * ⚠️ 必须整份 `remember`，不要每次重组都现场 `Modifier.drawBackdrop(...)`：
     * 那条链里塞了 5 个 lambda（shape / effects / highlight / onDrawSurface / …），
     * 而库的 `DrawBackdropElement.equals` 是逐个比较它们的 —— 内联 lambda 每次重组都是新对象
     * → 判成"元素变了" → `update()` → `invalidateDrawCache()` → `updateEffects()`
     * → **整条效果链（模糊 + 折射 + 高光）在那一帧被清掉重建**。
     * 真机抓帧实测（`.workbuddy/memory/2026-09-23.md`）：返回沉浸页后约 0.3s 里
     * 胶囊是一块**没有任何折射结构的平整浅色**（= 效果链没生效），1.7s 后才恢复正常玻璃
     * —— 就是"色膜 → 玻璃"那个转变。记住之后，重组不再触碰效果链。
     *
     * 键取 `canBlur` / `shellBackdrop` / `capsuleTint`：这三样一变（低版本降级、换玻璃源、切主题）
     * 本来就该重建一次，其余时候它必须是**同一个实例**。
     *
     * ---- 参数说明（原样保留）----
     * **液态玻璃**（Kyant0 的 backdrop 库）。液态玻璃 ≠ 磨砂玻璃：
     * 磨砂靠"糊"，液态玻璃靠**通透 + 边缘折射 + 镜面高光** —— 背后的内容应当是
     * **看得见但被折射扭曲**的。所以这套参数和顶栏刻意相反：模糊压到很轻，把"折射"让出来当主角。
     *
     * 与另一个库（QWEA0/Liquid-Glass-Android）的参数对应关系：
     *   refractionHeight / bevelWidth  →  lens(refractionHeight, refractionAmount)
     *   dispersionStrength             →  lens(chromaticAberration = true)
     *   sensorHighlight                →  highlight（Highlight.Ambient）
     *   cornerRadius / glassMaterial   →  shape + onDrawSurface 的色调
     *
     * 参数硬约束（官方文档，写错不报错但效果会突变）：
     *  · 透镜要求 shape 是 `CornerBasedShape` —— `RoundedCornerShape` 满足；
     *  · `refractionHeight` ∈ [0, shape.minCornerRadius]：胶囊 percent 50，
     *    最小圆角半径 = 高度一半 = 34dp，所以取 26dp（留余量）；
     *  · `refractionAmount` ∈ [0, size.minDimension]：胶囊高 68dp，取 38dp。
     *
     * 顺序铁律：颜色滤镜 ⇒ 模糊 ⇒ 透镜。这里**刻意不加颜色滤镜**（vibrancy/colorFilter）
     * —— 本机实测它会打断整条效果链，导致 blur 完全不生效（详见 BooksScreen 同段注释）。
     *
     * 边缘镜面高光**必须用 `Plain`**，不能用 `Ambient` / `Default`：后两者的着色器都带
     * `angle` uniform，是**有方向**的高光（光从某一个方向来），只有一侧亮、另一侧完全没有 ——
     * 真机上表现为"右上有一道光、右下什么都没有"。`Plain` 不含着色器，是用 `BlendMode.Plus`
     * 画的一圈**无方向**描边，整圈都有高光，符合玻璃边缘被环境光勾边的观感。
     */
    val capsuleGlass: Modifier = remember(canBlur, shellBackdrop, capsuleTint) {
        if (canBlur) {
            Modifier.drawBackdrop(
                backdrop = shellBackdrop,
                shape = { RoundedCornerShape(percent = 50) },
                effects = {
                    blur(8.dp.toPx())
                    lens(
                        refractionHeight = 26.dp.toPx(),
                        refractionAmount = 38.dp.toPx(),
                        chromaticAberration = true,
                    )
                },
                highlight = { Highlight.Plain },
                onDrawSurface = { drawRect(capsuleTint) },
            )
        } else {
            Modifier.background(c.frostedSolid)
        }
    }





    /**
     * 共享元素（M3 起、M5 扩展）：`SharedTransitionLayout` 必须是**源与目标共同的祖先**。
     *
     * M5 把它从"只包轻页面分支"提到最外层；**M6.4 又把它收回成"只包页面"** —— 原因见下面那段
     * 「层级」注释：飞行中的那一份画在 `SharedTransitionLayout` 自己的**覆盖层**里，
     * 而覆盖层永远画在它的内容**之后** —— 所以只要胶囊/FAB 还在它里面，飞行元素就一定压住它们。
     *
     * 重页面分支依旧**不**注入 [LocalSharedElementScopes]（不做双向转场，也就没有"飞"的语义）。
     *
     * ------------------------------------------------------------
     * 2026-09-23：玻璃的**源层从这里（页面容器）上移到 `SharedTransitionLayout`**
     * ------------------------------------------------------------
     * 用户反馈：点被胶囊压住的封面（**长图帖**尤其明显）→ 进详情 → 返回，
     * 胶囊会"从纯色变回玻璃"。
     *
     * 原因：共享元素飞行期间，**参与飞行的那一格是刻意不原地画的**（内容改由覆盖层带着飞，
     * 这是 M5.8 定下的行为 —— 否则会看到"原地一份、飞行一份"）。于是**页面容器那一层**
     * 在卡片位置留下一个**空白矩形**；胶囊正压着它时，玻璃就忠实地"折射"那块空白
     * → 看着像一层纯色色膜。飞行落地、卡片恢复原地绘制，玻璃就又"变回"玻璃。
     * 为什么长图帖最明显：bounds 变化极大 → 弹簧最长 → 这段窗口最久（可达一两秒）。
     *
     * 修法：源层包住 `SharedTransitionLayout`（= 页面内容 **+ 飞行覆盖层**）——
     * 玻璃于是折射**屏幕上真实存在的东西**（包括正从它下面飞过去的封面），而不是那块空白；
     * 而**稳态下覆盖层是空的 → 观感与从前完全一致**（这不是改效果，是把"源"补全）。
     */
    /**
     * ★ 长按保存的入口必须提供在**最外层**（而不是只包页面的那个 provider 里）。
     *
     * 页面之外还有一批**覆盖层**也能长按：全屏看图（`ZoomableImage`）、全屏视频播放器、
     * 以及画在 `SharedTransitionLayout` 之后的媒体保存弹层本身。早先它和
     * `LocalImageViewerOpener` 挤在同一个 provider 里，而那个 provider **只包到页面为止**
     * （见下面 `SharedTransitionLayout` 的收尾）—— 覆盖层读到的一律是 null，
     * 真机表现就是"长按没反应、不弹窗"（日志实测：`viewer longpress opener=false`）。
     *
     * `LocalImageViewerOpener` 不必外提：读它的是页面里的缩略格，而查看器自己**是被打开的那一个**。
     */
    CompositionLocalProvider(
        LocalMediaSaveOpener provides { target -> mediaSaveTarget = target },
    ) {
    Box(modifier = Modifier.fillMaxSize()) {
    SharedTransitionLayout(
        modifier = Modifier
            .fillMaxSize()
            // 玻璃的**源层**：库会把「本节点的绘制」（= 页底色 + drawContent()）录进 shellBackdrop，
            // 挂在 SharedTransitionLayout 上才**同时包到飞行覆盖层**（覆盖层是它的子节点，
            // 原来的页面容器包不到它 → 飞行期间会留下一块空白，见上面那段注释）。
            // 胶囊是它后面的兄弟节点，所以源层里**不含胶囊** ✓
            .then(if (canBlur) Modifier.layerBackdrop(shellBackdrop) else Modifier),
    ) {
        CompositionLocalProvider(
            // 页面里（卡片、详情页、主页网格）用的"打开查看器"入口
            LocalImageViewerOpener provides { request ->
                viewerClosing = false
                viewer = request
                // 先把这一张原图在后台解码好（真机实测：不预热时"打开"里约 57ms 花在重新解码上）
                preloadViewerImage(viewerContext, request)
            },
            // 缩略格把自己在窗口里的位置登记在这里，查看器的飞行几何靠它（见 ViewerOrigins）
            LocalViewerOrigins provides viewerOrigins,
            // 共享元素的"声明计数"：判断某个 key 是不是真的两端都在（见 SharedElementPeers）
            LocalSharedElementPeers provides sharedElementPeers,
        ) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(c.bgPage),
        // 注意：玻璃的源层**不在这里**（已上移到上面的 SharedTransitionLayout，理由见那段注释）
    ) {
        if (base.isHeavyPage) {
            /**
             * 重页面（独占资源页）：**只做一次性入场，不做双份组合**。
             *
             * `AnimatedContent` 的转场要求新旧两屏同时在组合里，对语音房/视频/聊天/阅读器
             * 就等于同一份独占资源建两遍（第二个 ExoPlayer、第二条 WebSocket）。
             * 所以这些页面走"瞬间切换 + 入场动画"：离场时不做淡出，
             * 麦克风/解码器立刻释放（详见 MotionEnterOnce 的注释）。
             */
            MotionEnterOnce(modifier = Modifier.fillMaxSize()) {
                // key 里带实例号：重页面（阅读器/语音房/聊天）每次进来也是全新的一次访问
                val pageStateKey = destStateKey(base, baseSeq)
                if (baseSeq > 0L) savedPageKeys += pageStateKey
                stateHolder.SaveableStateProvider(pageStateKey) { pageContent(base) }
            }
        } else {
            /**
             * 两个作用域通过 [LocalSharedElementScopes] 往下注入，而不是给每个屏幕加参数 ——
             * 端点一个在信息流卡片里、一个在详情页里，逐层透传要改 6 个文件的签名。
             * 叶子组件只需一行 `Modifier.sharedBoundsIfAvailable(key)`，
             * 没有共享元素上下文时它会自动退化成普通 Modifier（不需要 null 判断）。
             *
             * 重页面（上面的 `if` 分支）刻意**不**提供这个作用域：它们不做双向转场，
             * 也就没有"同一元素在两屏之间飞"的语义。
             */
            AnimatedContent(
                    // 传 ShellPage（目的地 + 这一步的操作 + 层级），而不是裸的 base ——
                    // 原因见下面 shellPage 的注释：转场方向必须是**纯函数**
                    targetState = shellPage,
                    modifier = Modifier.fillMaxSize(),
                    // 同页不同参（Explore(tag=a) → Explore(tag=b)）也算新目标，要转场。
                    // 再看**实例号**：同一个目的地的新一次访问（出栈后再进）也是新内容 ——
                    // 否则 AnimatedContent 会把上一轮那份内容（含它的滚动位置）当同一份复用。
                    contentKey = { destStateKey(it.dest, it.seq) },
                    transitionSpec = {
                        // 只读 targetState 里的字段 —— 这里**绝不能**再读 navigator.lastOp /
                        // navigator.depth 这类外部可变状态（详见 shellPage 的注释）
                        val transform = when (targetState.op) {
                            // 进：新页从右侧滑入，旧页只走 1/8 屏（层叠感，不是整屏平移）
                            NavOp.Push -> pageTransform(
                                intoFromRight = true,
                                // 层级越深、位移越小（三级页比二级页更"轻"）
                                inFraction = if (targetState.depth > 2) 6 else 4,
                                outFraction = 8,
                            )
                            // 退：与 Push 严格反向
                            NavOp.Pop -> pageTransform(intoFromRight = false, inFraction = 4, outFraction = 8)
                            // 切 tab / 重置：同级，不左右滑动（滑动会误导用户以为层级变了）
                            NavOp.Tab, NavOp.Reset ->
                                fadeIn(KMotion.effects()) togetherWith fadeOut(KMotion.effects())
                        }
                        // clip = false：位移期间不裁剪 —— 裁剪会在边缘切出硬边（尤其配圆角时）
                        transform.using(SizeTransform(clip = false))
                    },
                    label = "shellPage",
                ) { shell ->
                    // 这一层的 `this` 就是 AnimatedContentScope（它实现了 AnimatedVisibilityScope），
                    // 共享元素必须拿到它 —— 少了它两端匹配不上，图只会淡入淡出、不会飞。
                    val pageVisibilityScope = this
                    /**
                     * 页面转场进行中 → **图片加载让路**（见 [AnimationGate]）。
                     *
                     * 判据是这一页自己的 `Transition`：`currentState != targetState` 就是"正在进出场"。
                     * 用 `DisposableEffect` 而不是 `LaunchedEffect`：转场期间新页面会进组合、
                     * 旧页面转完就退出组合，dispose 时**一定会**把令牌还回去，
                     * 不会出现"某个页面走了但闸门还关着"（那会让图再也不加载）。
                     */
                    val gateToken = remember(shell.dest) { Any() }
                    val transitioning = pageVisibilityScope.transition.let {
                        it.currentState != it.targetState
                    }
                    // `transitioning` 只用于下面的图片加载闸门。
                    // （注：曾把它上提给容器做"落定那一帧 1px 微移"逼 haze 重读坐标，
                    //   顶栏改纯色后那段补丁已删除 —— 它会让整页每帧抖 1px，是闪烁源。）
                    DisposableEffect(gateToken, transitioning) {
                        if (transitioning) {
                            AnimationGate.begin(gateToken)
                            onDispose { AnimationGate.end(gateToken) }
                        } else {
                            onDispose { }
                        }
                    }
                    CompositionLocalProvider(
                        LocalSharedElementScopes provides SharedElementScopes(
                            transition = this@SharedTransitionLayout,
                            visibility = pageVisibilityScope,
                        ),
                        // 头像共享元素的发起状态（卡片写、对方主页读）
                        LocalAvatarShareState provides avatarShare,
                    ) {
                        val pageStateKey = destStateKey(shell.dest, shell.seq)
                        if (shell.seq > 0L) savedPageKeys += pageStateKey
                        stateHolder.SaveableStateProvider(pageStateKey) {
                            pageContent(shell.dest)
                        }
                    }
                }
        }
    }
        }
    }

        /**
         * ---- 层级（M6.4，用户实测："详情页退回来的时候会遮挡导航栏和发布按钮"）----
         *
         * `SharedTransitionLayout` 把飞行中的那一份画在**它自己的覆盖层**里，而覆盖层永远
         * 画在它的内容**之后** —— 所以"谁在它里面，谁就被飞行元素压住"。
         * 原来胶囊、发布 FAB、各弹层都包在里面，于是「首页底部那张配图 → 详情页」这条飞行
         * 会在图片经过底部时**盖住导航胶囊与发布按钮**，要等弹簧收完（约 1 秒）才让出来。
         *
         * 修法：**`SharedTransitionLayout` 只包页面**（共享元素的两端都在页面里，共同祖先够用），
         * 胶囊 / FAB / 各覆盖层画在它**之后**（外面这个 Box）—— 于是飞行元素从下面穿过，
         * 悬浮导航始终在最上层。这与"页面里的卡片也永远在胶囊之下"是同一个观感约定。
         *
         * 顺序仍然是：**页面 → 胶囊/FAB → 各覆盖层**（查看器、登录、设置、作品选单）。
         * 最后那组必须留在最上面：查看器要盖住底部导航（用户明确要求过），
         * 设置弹层也要盖住胶囊（否则设置项被导航栏挡住）。
         */

        // 悬浮胶囊：沉浸页不显示（路由表的 immersive 字段决定，不做路径匹配）。
        // 判定用 base 而不是 dest —— 登录弹层覆盖在沉浸页（如图书详情）之上时，
        // 胶囊仍应保持隐藏；覆盖态自身是非沉浸的，用 dest 会错误地把它显示出来。
        //
        // ---- 2026-09-23：沉浸页**不再把胶囊摘出组合**，只把它挪出窗口 ----
        //
        // 实测（真机抓帧，见 `.workbuddy/memory/2026-09-23.md`）：从沉浸页（帖子详情）返回后
        // **约 0.3s 内**胶囊是一块**平整的浅色面**、边缘没有任何折射结构，1.7s 后才恢复正常玻璃
        // —— 也就是"色膜 → 玻璃"那个转变。这段时间刚好是"胶囊重新挂载之后"：
        // `KNavCapsule` 上的 `drawBackdrop` 是**全新节点**，GraphicsLayer / 效果链 / 坐标全都要重来一遍。
        // 「沉浸页不显示胶囊」这个诉求没错，错的是**用销毁重建来实现它**。
        //
        // 修法：永远留在组合里，沉浸页把它挪到窗口外（绘制期平移、不动布局 → 坐标恒定），
        // 并且**跳过绘制**（不做无谓的录制/模糊开销）：
        //  · 平移出窗口 + 不画 → 看不见，也点不到（命中测试跟着 layer 变换走）；
        //  · 布局坐标与效果链一直有效 → 回来第一次绘制就是正常玻璃，不需要任何重新初始化；
        //  · 语义树清掉 → 否则读屏会在沉浸页里念出一个看不见的导航栏。
        // 玻璃本身（形状 / 参数 / 绘制顺序）一个字没改。
        val capsuleVisible = !base.immersive
        Box(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(horizontal = KSpacing.md, vertical = KDimens.navCapsuleGap)
                .graphicsLayer {
                    translationY = if (capsuleVisible) 0f else NavParkedTranslationPx
                }
                .drawWithContent { if (capsuleVisible) drawContent() }
                .then(if (capsuleVisible) Modifier else Modifier.clearAndSetSemantics {}),
        ) {
            KNavCapsule(
                // 参数与理由都写在上面 `capsuleGlass` 的定义处（效果链的坑也在那里）。
                // ⚠️ 这个 modifier 是**记住**的（见上面 `capsuleGlass` 的定义）：
                // 每次重组都新建的话，库会判成"元素变了" → 重建整条效果链，
                // 那一帧的玻璃会短暂失效（真机抓帧实测：返回后约 0.3s 是一块平整浅色）。
                modifier = capsuleGlass,
                items = navItems(unread),
                selectedKey = base.navKey ?: navigator.activeTabKey,
                onSelect = { key ->
                    val target = when (key) {
                        Tab.Messages.key -> AppDestination.Messages
                        Tab.Books.key -> AppDestination.Books
                        Tab.Voice.key -> AppDestination.Voice
                        Tab.Profile.key -> AppDestination.Profile
                        else -> AppDestination.Home
                    }
                    navigator.switchTab(target)
                },
            )
        }

        if (!base.immersive) {
            // 分享 FAB：设计稿把「分享」从导航移到首页右下角的 56px 悬浮按钮。
            // 它**仍然整体摘掉**（与胶囊不同）：没有玻璃、不涉及上面那套重建问题，
            // 而且它本来就会随页面收放（下面那个 AnimatedVisibility），摘掉更省。
            // 同样按 base 判定：登录弹层压在首页上时，FAB 留在背景里被遮罩压暗。
            //
            // M4：进出场用 scale + fade（从**右下角**长出来 —— 它就在那个角上，
            // 从中心缩放会显得"凭空冒出来"）。切到别的 tab 时缩回去再消失，
            // 而不是"啪"地不见；降级时直接到位。
            AnimatedVisibility(
                visible = base is AppDestination.Home,
                enter = if (animationsEnabled) {
                    scaleIn(
                        animationSpec = KMotion.spatial(),
                        transformOrigin = TransformOrigin(1f, 1f),
                    ) + fadeIn(KMotion.effects())
                } else {
                    EnterTransition.None
                },
                exit = if (animationsEnabled) {
                    scaleOut(
                        animationSpec = KMotion.spatial(),
                        transformOrigin = TransformOrigin(1f, 1f),
                    ) + fadeOut(KMotion.effects())
                } else {
                    ExitTransition.None
                },
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .navigationBarsPadding()
                    .padding(
                        end = KSpacing.md,
                        // 浮在胶囊之上（胶囊高 + 间距 + 再上抬一点）
                        bottom = KDimens.navCapsuleHeight + KDimens.navCapsuleGap * 3,
                    ),
                label = "shareFab",
            ) {
                val fabShape = RoundedCornerShape(percent = 50)
                Box(
                    modifier = Modifier
                        .size(KDimens.fab)
                        .clip(fabShape)
                        .background(c.accent)
                        // 未登录点发帖：先拉登录窗（登录/有令牌后才进发布器）
                        .clickable {
                            if (isLoggedIn) {
                                navigator.push(AppDestination.ComposerDest())
                            } else {
                                navigator.push(AppDestination.Login)
                            }
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    // 图标跟 onAccent 反色（深色主题下 accent 是浅金，白图标只有 3.6:1）
                    Text("＋", style = KType.title, color = c.onAccent)
                }
            }
        }

        /**
         * 图片查看器（M5）：画在**胶囊之后** —— 它必须盖住底部导航（旧 Activity 时代靠独立窗口做到，
         * 现在靠绘制顺序，与设置/登录弹层同一套约定）。
         *
         * **M5.2：这里不再包 `AnimatedVisibility`。** 原来包着它，是因为共享元素要一个
         * `AnimatedVisibilityScope`；但真机慢放实测这条配对**根本不飞**（元素被画在来源格的
         * 矩形上干等，落位时直接跳过去），而且 `AnimatedVisibility` 自己的淡出先结束时会把内容
         * 卸掉，退场飞行被腰斩 —— 用户看到的就是"开图顿一下、退出不飞回去"。
         *
         * 现在进场/退场飞行由 [ImageViewerOverlay] 自己播（几何来自 [ViewerOrigins]），
         * 播完才回调 [ImageViewerOverlay] 的 onClosed → 这里把 `viewer` 置空。
         * 因此内容取的是 `viewer` 本身（退场期间它一直是非空的，不需要"最后一份非空值"留存）。
         */
        viewer?.let { request ->
            ImageViewerOverlay(
                request = request,
                closing = viewerClosing,
                // 点画面 / 下拉过阈值 / 返回键最终都汇到这一个标志上，退场只有一条路
                onRequestClose = { viewerClosing = true },
                onClosed = { index ->
                    viewer = null
                    viewerClosing = false
                    // 页码回传：列表据此滚到同一张（旧实现是 setResult）
                    request.onClosed?.invoke(index)
                },
                onPageChanged = { viewerPage = it },
            )
        }

        /**
         * 媒体保存弹层（长按图片/视频）：
         * 画在查看器**之后** —— 全屏看图里长按"保存"时，弹层必须压在图片之上。
         * 自己是 [ModalBottomSheet]（带遮罩与下拉关闭），所以这里不需要再包 AnimatedVisibility。
         *
         * ★ `?.let` 而不是把 null 传进去让宿主自己 return：sheetState 必须与 sheet 同生共死，
         * 理由见 [MediaSaveSheetHost] 的注释（复用停在 Hidden 的状态 = 第二次长按弹不出来）。
         */
        mediaSaveTarget?.let { target ->
            MediaSaveSheetHost(
                target = target,
                onDismiss = { mediaSaveTarget = null },
            )
        }

        // 覆盖态 1：登录弹层。画在页面与导航胶囊**之上**，于是胶囊留在背景里被遮罩压暗。
        // 关闭 / 登录成功都走 navigator.pop()；返回键由上面的 PredictiveBackHandler 走同一条路。
        //
        // 为什么从 `if` 改成 `AnimatedVisibility`：`if` 是"瞬间出现、瞬间消失"，
        // 而 AnimatedVisibility 在 visible 变 false 之后**还会把内容留在组合里播完退场**。
        // 面板自己的上滑在各弹层内部（MotionEnterOnce，fade = false：淡入由这里统一做，
        // 两边都淡会让面板比遮罩暗得更快，看起来像"没对齐"）。
        AnimatedVisibility(
            visible = dest is AppDestination.Login,
            enter = fadeIn(KMotion.effects(KMotion.Preset.Fast)),
            exit = fadeOut(KMotion.effects(KMotion.Preset.Fast)),
            label = "loginOverlay",
        ) {
            LoginOverlay(
                session = session,
                onDismiss = { navigator.pop() },
            )
        }

        // 覆盖态 2：设置弹层（主页右上角的滑块 / 他人主页右上角的「…」）。
        // **必须画在胶囊之后**（Compose 按调用顺序绘制，后画的在上层）—— 早先它画在
        // ProfileScreen 里面，就永远压在悬浮胶囊下面，观感是"设置项被导航栏挡住"（用户实测反馈）。
        // 这里还让它压住胶囊而不是把胶囊藏掉：设计上遮罩要把底下的页面**连胶囊一起**压暗。
        //
        // 可见性用 [settingsVisible]（= 开着 **且** 还是打开它的那一页）：入口有两个，
        // 只判布尔会让"在 A 的主页开着设置、又切到 B 的主页"时弹层跟着漂过去。
        AnimatedVisibility(
            visible = settingsVisible,
            enter = fadeIn(KMotion.effects(KMotion.Preset.Fast)),
            exit = fadeOut(KMotion.effects(KMotion.Preset.Fast)),
            label = "profileSettings",
        ) {
            ProfileSettingsOverlay(
                themeMode = themeMode,
                onThemeChange = onThemeChange,
                session = session,
                onDismiss = { showProfileSettings = false },
                onLoggedOut = { navigator.resetTo(AppDestination.Home) },
            )
        }
        /**
         * 覆盖态 3：作品操作选单。同上面两个一样画在胶囊**之后**，
         * 所以不会被导航栏挡住（用户实测反馈过这一点）。
         *
         * 只在主页显示：它是由主页的长按触发的，切页时由上面的 LaunchedEffect 一起收掉。
         *
         * 内容取 [menuPost]（留存的最后一条）而不是 `postMenu`：关闭选单的那一刻
         * `postMenu` 就是 null 了，退场动画会画出一个空弹层。
         */
        AnimatedVisibility(
            visible = (dest is AppDestination.Profile || dest is AppDestination.UserProfileDest) &&
                postMenu != null,
            enter = fadeIn(KMotion.effects(KMotion.Preset.Fast)),
            exit = fadeOut(KMotion.effects(KMotion.Preset.Fast)),
            label = "postMenu",
        ) {
            menuPost?.let { menu ->
                ProfilePostMenu(
                    post = menu,
                    onEdit = {
                        postMenu = null
                        // 编辑缓存里存的图要**相对路径**（服务端按它匹配 keepImages）；
                        // 缓存命中就用服务端原始值，命不中再退回主页给的绝对地址
                        val ui = posts.cached(menu.id)
                        ComposerEdits[menu.id] = ComposerEditSource(
                            id = menu.id,
                            description = menu.description,
                            images = ui?.post?.images ?: menu.images,
                            location = menu.location,
                        )
                        navigator.push(AppDestination.ComposerDest(editingPostId = menu.id))
                    },
                    onDelete = {
                        postMenu = null
                        // 标记"进来就弹删除确认"：用户已经明确要删，不该再让他自己去编辑页找那个 chip
                        val ui = posts.cached(menu.id)
                        ComposerEdits[menu.id] = ComposerEditSource(
                            id = menu.id,
                            description = menu.description,
                            images = ui?.post?.images ?: menu.images,
                            location = menu.location,
                            openDeleteConfirm = true,
                        )
                        navigator.push(AppDestination.ComposerDest(editingPostId = menu.id))
                    },
                    onDismiss = { postMenu = null },
                )
            }
        }
    }
    }

    // 返回键已由本函数开头的 PredictiveBackHandler 统一处理（弹层 → 页面栈 → 最小化）
}

/**
 * 记住"最后一个非空值"（M2 新增，给覆盖层的退场动画用）。
 *
 * 用法：可见性用 `xxx != null` 判定，内容用这里留存的值 ——
 * 关闭弹层时数据先变 null、动画还要再播两百毫秒，没有这份留存就会画出空弹层。
 *
 * 首次组合时 `holder` 还没机会被 `LaunchedEffect` 写入，所以回落到 `value` 本身。
 */
@Composable
private fun <T : Any> rememberLastNonNull(value: T?): T? {
    val holder = remember { mutableStateOf<T?>(null) }
    LaunchedEffect(value) {
        if (value != null) holder.value = value
    }
    return value ?: holder.value
}

/**
 * 转场目标 = 目的地 + **这一步用的导航操作与层级** + **这一次访问的实例号**
 * （见 AppShell 里 `shellPage` 的注释）。
 *
 * 把 op / depth 放进 targetState 里，`transitionSpec` 才能写成"只读 targetState"的纯函数，
 * 从而不受转场期间 `navigator.lastOp` 被后续导航改写的影响。
 *
 * `seq` 决定这一份内容用哪个 `rememberSaveable` 状态保管箱（见 [destStateKey]）：
 * 同一个目的地、不同实例 = 不同 key = 不继承上一轮的滚动位置。
 */
private data class ShellPage(
    val dest: AppDestination,
    val op: NavOp,
    val depth: Int,
    val seq: Long,
)

/**
 * 页面转场的 [ContentTransform]。
 *
 * `inFraction` / `outFraction` 是**分母**：数字越大位移越小。
 * 新页滑入整屏的 1/4、被压下去的旧页只走 1/8 —— 两者不等速才有"层叠"感
 * （等速整屏平移是"幻灯片"，不是现代 App 的转场）。
 *
 * ------------------------------------------------------------
 * ★ 2026-09-24：「进详情页闪一下」**不是**这里的问题（已排查并回退过一次改动）
 * ------------------------------------------------------------
 * 曾经按"页面淡入比共享元素边界弹簧快、有相位差"的假设把这里的 `fadeIn/fadeOut`
 * 换成过一档极快的 `KMotion.pageFadeIn`。**两个方向都不成立**：
 *  · `KMotion.effects(Default)`（k=1600）收敛 ~188ms、共享边界 `spatial(Default)`（k=700）
 *    收敛 ~179ms —— **几乎同步**，没有相位差；
 *  · 真正的病根在远程：[SharedElements.sharedElementIfAvailable] 的 `renderInOverlay`
 *    被传成 `false`，导致 **"飞行那一份"压根不存在**（只活在覆盖层里），两端各自原地画。
 *
 * 所以这里**保持 `effects()` 不动**。改淡入速度只是把症状挪一挪，还会白白改掉转场观感。
 */
private fun pageTransform(
    intoFromRight: Boolean,
    inFraction: Int,
    outFraction: Int,
): ContentTransform {
    /**
     * 进场与出场必须**方向相反**：新页从右侧滑入时，被压在下面的旧页要往**左**退。
     *
     * 这里曾经写成同向（进出都用 `+distance`），当时以为只是"层叠感"参数，其实它引出过一个
     * 真机 bug：打断返回动画、立刻再进同一个帖子时，详情页会**从左往右**进场
     * （用户实测："只有第一次是右到左，反复进入有时会从左到右"）。
     *
     * 机制：`AnimatedContent` 在目标又变回"正在出场的那一页"时，会**复用同一个内容实例**
     * 并把它的**出场动画倒着播回来**（这正是我们要的：不会出现两份详情页）。
     * 于是倒放的方向就完全取决于"出场往哪走" —— 出场写成往左，倒放就是**从左进场**。
     * 把出场改成往右（与进场相反）之后，倒放自然变成"从右进场"，与正常进场一致。
     *
     * 顺带一提，"两页对着分开"本身也不对：标准做法是新旧两页**同向移动**、旧页退得稍慢。
     */
    val sign = if (intoFromRight) 1 else -1
    val enter = slideInHorizontally(animationSpec = KMotion.spatial()) { full ->
        sign * (full / inFraction)
    } + fadeIn(KMotion.effects())
    val exit = slideOutHorizontally(animationSpec = KMotion.spatial()) { full ->
        // 注意取负：旧页退向与进场相反的一侧
        -sign * (full / outFraction)
    } + fadeOut(KMotion.effects())
    return enter togetherWith exit
}

/**
 * 「重页面」判定（M2 新增）：这些页面各自持有**独占资源**，转场期间不能存在两份。
 *
 *  · 语音房：WebSocket + 麦克风采集 + 前台服务
 *  · 视频：ExoPlayer 实例
 *  · 阅读器：章节正文缓存与滚动位置（两份组合会让换章状态串台）
 *
 * 判断依据是"资源"而不是"页面大小"：图书详情、帖子详情这类页面很大但无独占资源，
 * 照样走正常的双向转场。**判断错误是有代价的**：多列一个页面进来，它就退化成
 * "从下往上淡入 + 离场硬切"，跟别的二级页不一致。
 *
 * ------------------------------------------------------------
 * M7：聊天**不再是**重页面
 * ------------------------------------------------------------
 * 原来这里还有一条「聊天：SSE 订阅」—— 那是把 `RealtimeClient.events` 当成了独占资源，
 * 实际不是：它是 `MutableSharedFlow`（源码里明确写着"多个页面可同时收集"），
 * 连接本身由 Shell 的生命周期观察者调 `start()/stop()` 管，**跟谁在收集无关**；
 * 转场那 250ms 两屏并存的代价只是"同一个事件被两个 ChatScreen 各处理一次"，
 * 而两个 ChatScreen 并存只在"聊天 → 聊天"时才会发生 —— 导航上没有这条路。
 *
 * 换来的东西很值：聊天页终于能走**和其他二级页一样的左右转场**
 * （用户要求："界面应该从右往左进入，跟首页点搜索一样"）。留在这一列里的话，
 * 它只能走 [MotionEnterOnce] 的"从下往上淡入 + 离场硬切"。
 */
private val AppDestination.isHeavyPage: Boolean
    get() = when (this) {
        // 一个分支一行：`when` 条件里加尾逗号在部分 Kotlin 版本上不被接受，不冒这个险
        is AppDestination.VoiceRoomDest -> true
        is AppDestination.VideoDest -> true
        is AppDestination.ReaderDest -> true
        else -> false
    }

/**
 * 这一页有没有**设置入口**（决定 Shell 上那个设置弹层要不要跟着页面收掉）。
 *
 * 入口有两个：自己的主页右上角（滑块图标，[ProfileScreen]）与他人主页右上角
 * （「…」，[UserProfileScreen]）。两页共用同一个弹层 —— 主题 / 分享主页 /
 * 退出登录都是**账号级**的东西，在谁的主页打开都一样。
 */
private val AppDestination.hasSettingsEntry: Boolean
    get() = this is AppDestination.Profile || this is AppDestination.UserProfileDest

/**
 * 阅读器宿主：先拿 BookDetail 再渲染阅读器。
 *
 * 为什么需要它：阅读器可能由"进程回收后恢复"直接进入（导航器只保了一个
 * `read:<bookId>:<file>` 字符串），那时没有内存里的 BookDetail，必须自己重取。
 */
@Composable
private fun ReaderHost(
    books: BookRepository,
    bookId: String,
    chapterFile: String,
    onBack: () -> Unit,
    themeMode: ThemePreference.Mode,
    onThemeChange: (ThemePreference.Mode) -> Unit,
) {
    var detail by remember(bookId) { mutableStateOf<BookDetail?>(null) }
    var chapter by remember(bookId, chapterFile) { mutableStateOf<BookChapter?>(null) }
    var error by remember(bookId) { mutableStateOf<String?>(null) }

    LaunchedEffect(bookId) {
        // 优先用详情页刚放进来的内存版（省一次请求）
        val cached = BookReaderEntries[bookId]
        if (cached != null && cached.first.id == bookId) {
            detail = cached.first
        } else {
            when (val r = books.detail(bookId)) {
                is ApiResult.Success -> detail = r.data
                is ApiResult.Failure -> error = r.error.message
            }
        }
    }

    val d = detail
    if (error != null) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            KPlaceholder(
                kind = KPlaceholderKind.Error,
                title = "阅读器打不开",
                description = error,
                action = {
                    top.kuangdada.k.core.designsystem.component.KButton("返回", onClick = onBack)
                },
            )
        }
        return
    }
    if (d == null) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            top.kuangdada.k.core.designsystem.component.KPlaceholder(
                kind = KPlaceholderKind.Loading,
                title = "正在打开…",
                description = null,
            )
        }
        return
    }

    val target = chapter
        ?: d.flatChapters.firstOrNull { it.file == chapterFile }
        ?: d.flatChapters.firstOrNull()
    if (target == null) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            top.kuangdada.k.core.designsystem.component.KPlaceholder(
                kind = KPlaceholderKind.Empty,
                title = "这本书没有可读章节",
                description = null,
            )
        }
        return
    }
    if (chapter == null) chapter = target

    ReaderScreen(
        books = books,
        detail = d,
        chapter = target,
        onBack = onBack,
        onOpenChapter = { chapter = it },
        themeMode = themeMode,
        onThemeChange = onThemeChange,
    )
}

/**
 * 详情页 → 阅读器的**进程内传递**（避免把整个 BookDetail 序列化进导航状态）。
 * 进程被回收时这里为空，[ReaderHost] 会自动回退到重新请求详情。
 */
private val BookReaderEntries = mutableMapOf<String, Pair<BookDetail, BookChapter>>()

/** 5 个导航项（图标是自绘的 lucide 形状，见 [Glyph]）；消息项带未读角标 */
@Composable
private fun navItems(unread: Int): List<KNavItem> = listOf(
    KNavItem(key = Tab.Home.key, label = Tab.Home.label, icon = { t, _ -> Glyph(t, GlyphKind.Home) }),
    KNavItem(
        key = Tab.Messages.key,
        label = Tab.Messages.label,
        icon = { t, _ -> Glyph(t, GlyphKind.Chat) },
        // 角标压住图标右上角（设计稿 §3.3）；数量由消息页回填
        badgeCount = unread,
    ),
    KNavItem(key = Tab.Books.key, label = Tab.Books.label, icon = { t, _ -> Glyph(t, GlyphKind.Book) }),
    KNavItem(key = Tab.Voice.key, label = Tab.Voice.label, icon = { t, _ -> Glyph(t, GlyphKind.Voice) }),
    KNavItem(
        key = Tab.Profile.key,
        label = Tab.Profile.label,
        icon = { t, _ -> Glyph(t, GlyphKind.User) },
    ),
)















