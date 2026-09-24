package top.kuangdada.k.nativeapp.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import kotlinx.coroutines.launch
import top.kuangdada.k.core.data.ApiResult
import top.kuangdada.k.core.data.PostUi
import top.kuangdada.k.core.data.PostRepository
import top.kuangdada.k.core.data.SessionRepository
import top.kuangdada.k.core.data.ThemePreference
import top.kuangdada.k.core.data.UserRepository
import top.kuangdada.k.core.data.displayMessage
import top.kuangdada.k.core.data.model.UserProfile
import top.kuangdada.k.core.designsystem.component.KButton
import top.kuangdada.k.core.designsystem.component.KButtonVariant
import top.kuangdada.k.core.designsystem.component.KPlaceholder
import top.kuangdada.k.core.designsystem.component.KPlaceholderKind
import top.kuangdada.k.core.designsystem.motion.motionSheetEnter
import top.kuangdada.k.core.designsystem.theme.KDimens
import top.kuangdada.k.core.designsystem.theme.KElevation
import top.kuangdada.k.core.designsystem.theme.KRadius
import top.kuangdada.k.core.designsystem.theme.KSpacing
import top.kuangdada.k.core.designsystem.theme.KTheme
import top.kuangdada.k.core.designsystem.theme.KType

/**
 * ============================================================
 * 个人主页（设计稿「个人主页」——高亮主页 tab）
 * ============================================================
 * 设计稿形态：
 *  · 页头「主页」+ 右上角**设置圆钮**（滑块图标）—— 主题 /
 *    退出登录收进设置弹层（弹层由 AppShell 画在导航胶囊之上，见 [ProfileSettingsOverlay]）；
 *  · 资料区：头像 64 + **名字 20 Bold / @用户名 / 简介**（@用户名是设计稿明确有的，原实现漏了）；
 *  · 统计：帖子 / 粉丝 / 关注（数值 17 SemiBold / 标签 12 muted）；
 *  · 「编辑资料（实心）+ 分享主页（白底描边）」**两个等宽各占一半**；
 *  · **「管理后台」整宽入口行**（盾牌 + 管理后台 + 用户 · 帖子 · 公告 + ›），
 *    **只有管理员账号才画**（设计稿：只有管理员才有）；
 *  · 标签：帖子 / 转发 / 收藏 —— **纯文字三等分**（不是分段控件），选中 accent + Bold；
 *  · 作品：**3 列方形封面网格**（首图直出，无图用占位），**点格子进帖子详情页**。
 *
 * 三个标签对应三个端点：`/api/users/:id/posts`、`/api/posts/reposts/me`、`/api/posts/bookmarks/me`
 * （转发/收藏是"我的"，不是"某个用户的"——服务端就这么设计的）。
 */
@Composable
fun ProfileScreen(
    posts: PostRepository,
    users: UserRepository,
    session: SessionRepository,
    onLoggedOut: () -> Unit,
    onRequireLogin: () -> Unit,
    onOpenAdmin: () -> Unit,
    /**
     * 打开设置弹层。
     *
     * 为什么是回调而不是页面内部的一个 `showSettings` 布尔：弹层必须画在**悬浮导航胶囊之上**，
     * 而胶囊是 AppShell 在页面之后画的 —— 画在页面里的弹层永远在胶囊下面
     * （用户实测反馈：「点设置层级被导航栏挡住了」）。所以状态提到 AppShell，
     * 由它在最外层渲染 [ProfileSettingsOverlay]。
     */
    onOpenSettings: () -> Unit = {},
    /** 进「编辑资料」页（设计稿的二级页，沉浸）。保存返回后由 [refreshKey] 触发重新拉资料 */
    onOpenEditProfile: () -> Unit = {},
    /**
     * 点作品网格里的格子 → 进**帖子详情页**。
     *
     * 注意这里不带 `PostUi`：详情页自己会从仓库缓存/接口取帖子，
     * 传一个 id 就够（与信息流、搜索页的 `onOpenPost` 同一套约定）。
     */
    onOpenPost: (Long) -> Unit = {},
    /**
     * 长按作品格子 → 请求打开操作选单（编辑 / 删除）。
     *
     * **只上报"哪条帖子"，不由本页渲染菜单**：菜单要盖住悬浮导航胶囊，
     * 而胶囊是在页面**之后**画的 —— 画在页面里的弹层永远在胶囊下面
     * （用户实测反馈：「长按弹出的层级会被导航栏遮挡」）。
     * 这与设置弹层提到 AppShell 的理由完全一样。
     */
    onRequestPostMenu: (ComposerEditSource) -> Unit = {},
    /**
     * 资料刷新信号：**每次从编辑资料页保存返回时由 Shell 自增**。
     *
     * 为什么要它：保存只改了**服务端的用户对象**（会话缓存里的那份），而这一页渲染的是
     * `GET /users/:id` 拉回来的 [UserProfile] —— 两者不共享内存，不重新拉一次的话
     * 返回主页看到的还是旧昵称/旧简介（用户会以为"没保存成功"）。
     */
    refreshKey: Int = 0,
    /**
     * 帖子内容版本（发帖/编辑/删帖成功后由 AppShell 透传）。
     *
     * 与 [refreshKey] 的分工：那个管**资料**（昵称/简介/头像，来自 `/users/:id`），
     * 这个管**作品列表**（来自 `/users/:id/posts`）—— 两者是不同的接口、
     * 由不同的动作触发，合并成一个信号会导致"改个昵称也重拉帖子列表"。
     */
    postsRefreshKey: Int = 0,
    themeMode: ThemePreference.Mode = ThemePreference.Mode.System,
    onThemeChange: (ThemePreference.Mode) -> Unit = {},
) {
    val c = KTheme.colors
    val context = androidx.compose.ui.platform.LocalContext.current
    val openViewer = top.kuangdada.k.nativeapp.ui.viewer.rememberImageViewerSimple()
    val scope = rememberCoroutineScope()
    val authState by session.state.collectAsState()

    /**
     * 「帖子 / 转发 / 收藏」选中项。
     *
     * 与消息页同一个坑：点进帖子详情/编辑页后本页离开组合，用 `remember` 的话
     * 返回时会跳回「帖子」——用户明明在看「收藏」，返回却换了标签。
     * `AppShell` 的 `SaveableStateHolder` 只保存 `rememberSaveable` 系，所以这里必须用它。
     */
    var tabIndex by rememberSaveable { mutableIntStateOf(0) }
    val tabTitles = remember { listOf("帖子", "转发", "收藏") }

    /**
     * 当前用户 id：**优先会话真值，其次落盘的上一份**。
     *
     * 为什么要这层兜底（同 `AppShell.myAvatarUrl` 的理由）：冷启动时 `authState` 先是
     * `Restoring`、`/auth/me` 没回来，`LoggedIn.user.id` 还取不到 → 原来这里会直接
     * `profile = null` 并**提前 return**，于是整页停在"没有资料"的状态，
     * 连下面 `loadIfEmpty()` 都不跑 —— 用户看到的就是主页要点一下才出内容。
     *
     * `tokens.userId` 在**登录成功时就已落盘**（见 `TokenStore.userId`），冷启动同帧可读，
     * 所以拿它当兜底正好。接口回来后 `authState` 变成 LoggedIn，这里的真值自然接管。
     */
    val loggedInId = (authState as? SessionRepository.AuthState.LoggedIn)?.user?.id
        ?: session.tokens.userId.takeIf { it > 0 && session.isLoggedIn }

    /**
     * 三个列表在**组合期**就从仓库取（`listFor` 是纯函数，重进主页拿到的还是同一份，
     * 数据还在）。
     *
     * 为什么不用 `remember { emptyList() }` 再在 LaunchedEffect 里赋值：那样重进主页会先渲染
     * 一帧"空列表"（还没发过帖子 / 转圈），随后才跳到真实内容 —— 就是用户看到的那下闪动。
     */
    var lists by remember(loggedInId) {
        mutableStateOf(
            if (loggedInId == null) {
                emptyList()
            } else {
                listOf(
                    posts.listFor(PostRepository.Source.UserPosts(loggedInId)),
                    posts.listFor(PostRepository.Source.Reposts),
                    posts.listFor(PostRepository.Source.Bookmarks),
                )
            }
        )
    }
    /**
     * 资料：**首帧直接用仓库缓存**，随后静默刷新。
     *
     * 为什么不是 `remember { null }` 再等接口：那样每次进主页第一帧的头像是空的，
     * 要等 `/users/:id` 回来才画上 —— 表现出来就是"头像每次进来都重新加载一次"
     * （用户实测反馈）。仓库是进程级单例，上次拿到的资料还在，首帧就能画对。
     */
    var profile by remember(loggedInId) {
        mutableStateOf(loggedInId?.let { users.cachedProfile(it) })
    }
    var profileError by remember { mutableStateOf<String?>(null) }
    var toast by remember { mutableStateOf<String?>(null) }

    /**
     * 是不是管理员账号 —— 决定「管理后台」入口画不画。
     *
     * 入口**只给管理员**（设计稿：「管理员账号管理后台入口，只有管理员账号才有」）：
     * 普通用户看到一个点了必然 403 的按钮是最糟的体验。
     * 以**会话里的登录用户**为准（`/auth/me` 返回的 role 是权威值），公开资料的 role 作为兜底。
     */
    val isAdmin = (authState as? SessionRepository.AuthState.LoggedIn)?.user?.isAdmin == true ||
        profile?.role == "admin"

    // 登录后拉资料；未登录清空。
    // refreshKey 变化 = 刚从编辑资料页保存回来，即使 profile 已经有值也要重拉（见参数注释）。
    LaunchedEffect(loggedInId, refreshKey) {
        if (loggedInId == null) {
            profile = null
            return@LaunchedEffect
        }
        when (val r = users.profile(loggedInId)) {
            is ApiResult.Success -> {
                profile = r.data
                profileError = null
            }
            // 已经有资料时，刷新失败就保持旧值（比把页面变成错误页好）
            is ApiResult.Failure -> if (profile == null) profileError = r.error.displayMessage
        }
        // 只补"从没加载过"的那一份（空列表也算加载过，见 ListState.loaded）
        lists.getOrNull(tabIndex)?.loadIfEmpty()
    }

    /**
     * 内容变了（发帖/编辑/删帖）→ **重拉当前这一份列表**。
     *
     * 这是"发布完回主页看不到新帖、要重启 App"的根因：三份列表缓存在仓库里，
     * 之前只有首次进入才拉（`loadIfEmpty`）。
     *
     * 只重拉当前 tab：另两份等真正切过去时再拉（切 tab 本来就会 `loadIfEmpty`），
     * 避免一次发帖触发三个请求。
     */
    LaunchedEffect(postsRefreshKey) {
        if (postsRefreshKey <= 0) return@LaunchedEffect
        lists.getOrNull(tabIndex)?.refresh()
    }

    // 兜底列表：Compose 要求 collectAsState() **无条件**调用，不能放在下面的 when 分支里
    val fallbackList = remember { posts.emptyList() }
    val currentList = lists.getOrNull(tabIndex) ?: fallbackList
    val currentState = currentList.state.collectAsState().value

    Box(modifier = Modifier.fillMaxSize().background(c.bgPage)) {
        if (loggedInId == null) {
            Column(
                modifier = Modifier.fillMaxSize(),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                KPlaceholder(
                    kind = KPlaceholderKind.Empty,
                    title = "未登录",
                    description = "登录后才能看到个人主页、转发与收藏",
                    action = { KButton("去登录", onClick = onRequireLogin) },
                )
            }
            return@Box
        }

        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(
                start = KSpacing.md,
                end = KSpacing.md,
                // 这里**不能**有 top：头部那一项自己挂 kTopBar（见 KWidgets.kTopBar）。
                // 原来这档 16dp 叠在头部的 statusBarsPadding 上，本页顶栏被压到状态栏下 24dp。
                bottom = KDimens.navScrollPadding + KSpacing.lg,
            ),
            // 网格行与行之间 8dp（作品方块的间距；头部块自己也带内距，不冲突）
            verticalArrangement = Arrangement.spacedBy(KSpacing.xs),
        ) {
            // ---- 头部：页头 / 资料 / 统计 / 按钮 / 标签 ----
            item {
                Column(
                    // 顶栏垂直位置的唯一来源（状态栏安全区 + KSpacing.xs）
                    modifier = Modifier.kTopBar(),
                    verticalArrangement = Arrangement.spacedBy(KSpacing.lg),
                ) {
                    KPageHeader(
                        title = "主页",
                        trailing = {
                            // 设置圆钮：主题 / 退出登录 在里面（首页与「分享主页」都在页面上，不重复放）。
                            // 弹层**不在这里画**：它必须画在悬浮导航胶囊之上，所以由 AppShell 在最外层
                            // 渲染（见 ProfileSettingsOverlay 的注释）。
                            KIconButton(icon = GlyphKind.Sliders, onClick = onOpenSettings)
                        },
                    )
                    // 资料区：头像 + 名字 / @用户名 / 简介
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(KSpacing.md),
                    ) {
                        Avatar(
                            url = profile?.let { users.avatarUrl(it) },
                            name = profile?.username ?: "我",
                            size = 64.dp,
                        )
                        Column(
                            modifier = Modifier.weight(1f),
                            verticalArrangement = Arrangement.spacedBy(KSpacing.xxs),
                        ) {
                            Text(
                                profile?.username ?: "…",
                                style = KType.overlayTitle,
                                color = c.textPrimary,
                            )
                            Text("@${profile?.username ?: ""}", style = KType.footnote, color = c.textMuted)
                            if (!profile?.bio.isNullOrBlank()) {
                                Text(
                                    profile?.bio ?: "",
                                    style = KType.body,
                                    color = c.textSecondary,
                                )
                            }
                        }
                    }

                    if (profileError != null) {
                        Text(profileError!!, style = KType.caption, color = c.danger)
                    }

                    // 统计：数值 17 SemiBold / 标签 12 muted（设计稿 §3.6）
                    Row(horizontalArrangement = Arrangement.spacedBy(KSpacing.xxl)) {
                        StatItem("帖子", profile?.postCount)
                        StatItem("粉丝", profile?.followersCount)
                        StatItem("关注", profile?.followingCount)
                    }

                    // 操作按钮：编辑资料（实心）+ 分享主页（白底描边），等宽各占一半
                    Row(horizontalArrangement = Arrangement.spacedBy(KSpacing.xs)) {
                        KButton(
                            "编辑资料",
                            onClick = onOpenEditProfile,
                            modifier = Modifier.weight(1f),
                            cornerRadius = KRadius.control,
                        )
                        KButton(
                            "分享主页",
                            onClick = {
                                shareText(
                                    context = context,
                                    text = "看看 ${profile?.username ?: ""} 的主页：$PROFILE_SHARE_BASE",
                                )
                            },
                            variant = KButtonVariant.Secondary,
                            modifier = Modifier.weight(1f),
                            cornerRadius = KRadius.control,
                        )
                    }

                    // 管理后台入口（设计稿「个人主页」）—— **只有管理员看得见**。
                    //
                    // 为什么在这里再判一次管理员，而不是只靠页面其他地方的 role：
                    // 这一行是整个 App 里唯一的管理入口，**误展示给普通用户 = 一个必然 403 的死按钮**。
                    // 所以取"会话里登录用户"的 role 为准（它来自 `/auth/me`，是权威值）；
                    // 公开资料接口的 `role` 作为兜底（两者不一致的极端情况以会话为准）。
                    if (isAdmin) {
                        AdminEntryRow(onClick = onOpenAdmin)
                    }

                    // 标签：纯文字三等分（设计稿不是分段控件），选中 accent + Bold
                    Row(modifier = Modifier.fillMaxWidth()) {
                        tabTitles.forEachIndexed { i, title ->
                            val selected = i == tabIndex
                            Text(
                                text = title,
                                style = if (selected) KType.bodyStrong else KType.body,
                                fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
                                color = if (selected) c.accent else c.textMuted,
                                textAlign = TextAlign.Center,
                                modifier = Modifier
                                    .weight(1f)
                                    .clip(RoundedCornerShape(KRadius.chip))
                                    .clickable(
                                        interactionSource = remember { MutableInteractionSource() },
                                        indication = null,
                                    ) {
                                        tabIndex = i
                                        scope.launch { lists.getOrNull(i)?.loadIfEmpty() }
                                    }
                                    .padding(vertical = KSpacing.xs),
                            )
                        }
                    }
                }
            }

            // ---- 作品网格：3 列方形，首图直出 ----
            val state = currentState
            when {
                state.loading && state.posts.isEmpty() -> item {
                    Box(Modifier.fillMaxWidth().padding(KSpacing.xxl), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(color = c.accent)
                    }
                }

                state.error != null && state.posts.isEmpty() -> item {
                    KPlaceholder(
                        kind = KPlaceholderKind.Error,
                        title = "加载失败",
                        description = state.error?.displayMessage,
                        action = { KButton("重试", onClick = { scope.launch { currentList.refresh() } }) },
                    )
                }

                // 三个 tab（作品/转发/收藏）为空时**不再渲染空态提示**
                // （用户要求去掉「还没有发过帖子 / 还没有转发过内容 / 还没有收藏」）：
                // 直接落到下面的分块渲染，空列表自然什么都不画。
                else -> state.posts.chunked(3).forEach { row ->
                    item(key = "row_${row.first().id}") {
                        Row(
                            // 删/发一条后整行重排走弹簧（M4）
                            modifier = Modifier.fillMaxWidth().animateItem(),
                            horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
                        ) {
                            row.forEach { post ->
                                WorkThumb(
                                    post = post,
                                    // 点格子 = 进**帖子详情页**（设计稿「个人主页」的作品网格；
                                    // 用户反馈："点击个人主页帖子应该打开帖子详情页"）
                                    onOpenPost = onOpenPost,
                                    // 长按 = 请求打开这条帖子的操作选单（编辑 / 删除）——
                                    // 首页卡片上的编辑入口已按用户要求撤掉，编辑改从这里进。
                                    // 选单由 AppShell 画（要盖住导航胶囊，见 onRequestPostMenu）
                                    onLongPress = {
                                        onRequestPostMenu(
                                            ComposerEditSource(
                                                id = post.id,
                                                description = post.description,
                                                images = post.images,
                                                location = post.location,
                                            )
                                        )
                                    },
                                    // 双击式看图交给详情页里的配图，这里不再直接开图片查看器
                                    onOpen = openViewer,
                                    modifier = Modifier.weight(1f),
                                )
                            }
                            // 最后一行人少时补空位撑住宽度，保持方形大小一致
                            repeat(3 - row.size) { Spacer(modifier = Modifier.weight(1f)) }
                        }
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
 * 作品操作选单（长按格子打开）：编辑 / 删除这条帖子。
 *
 * **为什么由 AppShell 在最外层调用**（与 [ProfileSettingsOverlay] 同一个理由）：
 * 底部导航胶囊是悬浮的、画在页面**之后**，画在 [ProfileScreen] 里的弹层永远压在胶囊下面
 * （用户实测反馈：「长按弹出的层级会被导航栏遮挡」）。
 *
 * 形态：底部小菜单（遮罩 + `surfaceRaised` + 上圆角 sheet），
 * 与设置弹层同一套层级与圆角，只是内容短得多。
 */
@Composable
fun ProfilePostMenu(
    post: ComposerEditSource,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
    onDismiss: () -> Unit,
) {
    val c = KTheme.colors
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(c.scrim)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClickLabel = "关闭操作菜单",
                onClick = onDismiss,
            ),
        contentAlignment = Alignment.BottomCenter,
    ) {
        Column(
            modifier = Modifier
                // 面板上滑（遮罩淡入在 AppShell）；与登录弹层同一套进出观感
                .motionSheetEnter()
                .fillMaxWidth()
                .clip(RoundedCornerShape(topStart = KRadius.sheet, topEnd = KRadius.sheet))
                .background(c.surfaceRaised)
                .navigationBarsPadding()
                .padding(KSpacing.lg),
            verticalArrangement = Arrangement.spacedBy(KSpacing.sm),
        ) {
            // 先给一句"这是哪条帖子"：长按选单最容易的错是按错格子
            Text(
                text = post.description.ifBlank { "这条帖子" }.take(24),
                style = KType.footnote,
                color = c.textMuted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            KButton(
                text = "编辑帖子",
                onClick = onEdit,
                modifier = Modifier.fillMaxWidth(),
                cornerRadius = KRadius.control,
            )
            KButton(
                text = "删除帖子",
                onClick = onDelete,
                variant = KButtonVariant.Danger,
                modifier = Modifier.fillMaxWidth(),
                cornerRadius = KRadius.control,
            )
        }
    }
}

/**
 * 设置弹层（设计稿「主页」右上角设置圆钮进来）。
 *
 * **为什么它是独立的一个 composable、由 AppShell 在最外层调用**（而不是像早先那样写在
 * [ProfileScreen] 里面）：底部导航胶囊是**悬浮**的，它画在 AppShell 根 `Box` 的**页面之后**
 * —— Compose 按调用顺序绘制，谁在后面谁在上层。弹层画在页面里，就永远在胶囊**下面**，
 * 观感是"设置项被导航栏挡住/压住"（用户实测反馈：「点设置层级被导航栏挡住了」）。
 *
 * 参照物是登录弹层 [LoginOverlay]：同一个根 Box 里、画在胶囊**之后**，
 * 于是遮罩能把页面**连胶囊一起**压暗。这里要的正是同一种层级。
 *
 * 只负责画面；状态与关闭逻辑（[onDismiss]）都在 AppShell 手里。
 */
@Composable
fun ProfileSettingsOverlay(
    themeMode: ThemePreference.Mode,
    onThemeChange: (ThemePreference.Mode) -> Unit,
    session: SessionRepository,
    onDismiss: () -> Unit,
    onLoggedOut: () -> Unit,
) {
    val c = KTheme.colors
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(c.scrim)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClickLabel = "关闭设置",
                onClick = onDismiss,
            ),
        contentAlignment = Alignment.BottomCenter,
    ) {
        Column(
            modifier = Modifier
                // 面板上滑（遮罩淡入在 AppShell）；与登录弹层同一套进出观感
                .motionSheetEnter()
                .fillMaxWidth()
                .clip(RoundedCornerShape(topStart = KRadius.sheet, topEnd = KRadius.sheet))
                .background(c.surfaceRaised)
                .navigationBarsPadding()
                .verticalScroll(rememberScrollState())
                .padding(KSpacing.lg),
            verticalArrangement = Arrangement.spacedBy(KSpacing.md),
        ) {
            Text("设置", style = KType.subtitle, color = c.textPrimary)
            ThemeModeRow(current = themeMode, onChange = onThemeChange)

            /**
             * 这里**只有主题与退出登录**两件事（09-18 用户定）：
             *  · 「分享主页」不在这里 —— 主页上「编辑资料 / 分享主页」那一排已经有了，
             *    设置里再放一个是重复入口（而且那一排分享的是**当前正在看**的主页，
             *    比这里只能分享自己的更符合直觉）；
             *  · 「私密文件夹」「检查更新」两个功能已删除（见 M7 的记录），不是隐藏。
             */
            // 管理后台入口**不在这里**：设计稿把它提到了页面上（编辑资料/分享主页那一排
            // 的下面），见 ProfileScreen 里的 AdminEntryRow。这里再放一次会出现两个入口，
            // 而用户从设计稿认的是页面上那一个。
            KButton(
                "退出登录",
                onClick = {
                    onDismiss()
                    session.logout()
                    onLoggedOut()
                },
                variant = KButtonVariant.Danger,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

/**
 * 作品网格的单格：首图方形直出，无图用 surfaceSunken 占位 + 标题首字。
 *
 * **点格子 = 进帖子详情页**（用户反馈：「点击个人主页帖子应该打开帖子详情页」）。
 * 之前这里点图进的是**图片查看器**，而且**只对有图的帖子**绑了点击 ——
 * 纯文字帖（或封面加载失败的帖子）点上去完全没反应，看起来就像"功能坏了"。
 *
 * 看大图的能力没有丢：详情页里的配图点开就是全屏查看器。
 *
 * @param onOpenPost 点格子 → 帖子详情（唯一的主交互）
 * @param onLongPress 长按格子 → 打开该帖的操作选单（编辑 / 删除）
 * @param onOpen 保留给"想直接看大图"的调用方；当前个人主页不再直接用它
 *
 * 可见性是 `internal` 而不是 `private`：他人主页（[UserProfileScreen]）用的是**同一个格子**，
 * 两处各画一遍迟早会分叉（一方改了圆角、另一方没改），而设计稿里这两页的作品网格是同一形态。
 */
@Composable
internal fun WorkThumb(
    post: PostUi,
    onOpenPost: (Long) -> Unit,
    onLongPress: () -> Unit,
    /** 第三个参数是帖子 id：查看器要按 `postImageKey(postId, page)` 声明共享元素（M5） */
    onOpen: (List<String>, Int, Long?) -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = KTheme.colors
    // 缩略图：图片帖用首图；**视频帖回落到视频封面**（此前只取 images，视频帖
    // 的格子永远显示「帖」占位 —— 用户实测"视频封面没有接上"）
    val cover = post.images.firstOrNull() ?: post.videoCoverUrl
    Box(
        modifier = modifier
            .aspectRatio(1f)
            .clip(RoundedCornerShape(KRadius.control))
            .background(c.surfaceSunken)
            // 点 = 详情，长按 = 操作选单。
            // 用 combinedClickable 而不是自己判时长：长按的系统标准时长/触感反馈交给它，
            // 也与全站其它长按入口（评论长按删、消息长按菜单）保持同一套手感。
            .combinedClickable(
                onLongClick = onLongPress,
                onClick = { onOpenPost(post.id) },
            ),
        contentAlignment = Alignment.Center,
    ) {
        if (cover != null) {
            AsyncImage(
                model = cover,
                contentDescription = post.title,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            Text(
                text = post.title.take(1).ifBlank { "帖" },
                style = KType.subtitle,
                color = c.textMuted,
            )
        }
    }
}

/**
 * 管理后台入口行（设计稿「个人主页」）。
 *
 * 形态：整宽卡片（`surfaceSubtle` 底，与页底差一档、读得出是个可点区域；**没有描边**，
 * 设计稿里它比「分享主页」那种白底描边按钮弱一档）+ 左侧 accent 盾牌 + 标题/副标题 + 右侧箭头。
 * 与设计稿逐项对齐：盾牌 20dp、标题 17、副标题 13 muted、ChevronRight 20 muted。
 *
 * **调用方必须只在管理员时渲染它**（见 ProfileScreen 里的 isAdmin）——
 * 这里不做权限判断，避免"组件自己藏自己"这种看不出入口为什么消失的写法。
 */
@Composable
private fun AdminEntryRow(onClick: () -> Unit, modifier: Modifier = Modifier) {
    val c = KTheme.colors
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(KRadius.row))
            .background(c.surfaceSubtle)
            .clickable(onClick = onClick)
            .padding(horizontal = KSpacing.md, vertical = KSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(KSpacing.sm),
    ) {
        Glyph(tint = c.accent, kind = GlyphKind.Shield, size = 20.dp)
        Column(
            modifier = Modifier.weight(1f),
            // 副标题贴着标题（设计稿里这两行是一组，与图标是 12 的间距）
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text("管理后台", style = KType.subtitle, color = c.textPrimary)
            Text("用户 · 帖子 · 公告", style = KType.caption, color = c.textMuted)
        }
        Glyph(tint = c.textMuted, kind = GlyphKind.ChevronRight, size = 20.dp)
    }
}

@Composable
private fun StatItem(label: String, value: Int?) {
    val c = KTheme.colors
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        // 数值 17 SemiBold / 标签 12 muted
        Text(
            text = (value ?: 0).toString(),
            style = KType.subtitle,
            color = c.textPrimary,
        )
        Text(label, style = KType.footnote, color = c.textMuted)
    }
}
