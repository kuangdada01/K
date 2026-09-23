package top.kuangdada.k.nativeapp.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import top.kuangdada.k.core.data.ApiResult
import top.kuangdada.k.core.data.FriendRepository
import top.kuangdada.k.core.data.PostRepository
import top.kuangdada.k.core.data.SessionRepository
import top.kuangdada.k.core.data.UserRepository
import top.kuangdada.k.core.data.displayMessage
import top.kuangdada.k.core.data.model.UserProfile
import top.kuangdada.k.core.designsystem.component.KButton
import top.kuangdada.k.core.designsystem.component.KButtonVariant
import top.kuangdada.k.core.designsystem.component.KPlaceholder
import top.kuangdada.k.core.designsystem.component.KPlaceholderKind
import top.kuangdada.k.core.designsystem.theme.KDimens
import top.kuangdada.k.core.designsystem.theme.KRadius
import top.kuangdada.k.core.designsystem.theme.KSpacing
import top.kuangdada.k.core.designsystem.theme.KTheme
import top.kuangdada.k.core.designsystem.theme.KType

/**
 * ============================================================
 * 他人主页（设计稿「他人资料页」）
 * ============================================================
 * 从**首页帖子卡片的头像 / 昵称**或**帖子详情里的作者行**点进来（[AppDestination.UserProfileDest]）。
 *
 * 设计稿形态（自下往上都没变过的部分与 [ProfileScreen] 一致，只有操作区与标签不同）：
 *  · 顶栏：圆形返回钮 + **圆形「…」钮**（设计稿里是三个点，不是主页那把滑块）——
 *    「…」里是**设置弹层**（主题 / 分享主页 / 退出登录），
 *    与自己的主页共用同一个 [ProfileSettingsOverlay]，由 AppShell 画在导航胶囊**之上**
 *    （理由见那个 composable 的注释：画在页面里的弹层永远压在悬浮胶囊下面）；
 *  · 资料区：头像 64 + 名字 20 Bold / @用户名 / 简介；
 *  · 统计：帖子 / 粉丝 / 关注（数值 17 SemiBold / 标签 12 muted）；
 *  · 操作区：**关注（实心）+ 私信（白底描边）两个等宽按钮** —— 这就是本页与自己的主页
 *    最大的差别（那边是「编辑资料 + 分享主页」，绝不该出现在别人主页上）；
 *  · 标签：**「帖子 | 转发」两个**（纯文字三等分那一排的形态，选中 accent + Bold）；
 *  · 作品：3 列方形网格，点格子进帖子详情。
 *
 * **「转发」标签的数据来自 `GET /api/users/:id/reposts`**（本轮新加的服务端端点）。
 * 在这一条落地之前，他人主页要么画一个点开恒为空的「转发」，要么干脆不画 ——
 * 两条都不好（前者让人以为加载失败，后者与设计稿对不上）。
 * 注意它与「我的转发」（`/api/posts/reposts/me`）**不是一个端点**：那个只有登录用户能看，
 * 这个是公开的，且登录时服务端会按**观察者**算 liked / reposted 状态（否则点开别人的
 * 转发列表，所有心都是空的，用户会以为自己的点赞丢了）。
 *
 * **长按作品不弹「编辑 / 删除」**：这里的帖子**不是我的**，服务端也必然 403。
 * 入口只在"这条帖子确实属于当前登录用户"时才给（自己点自己头像会切到主页 tab，
 * 见 AppShell 的 openUserProfile，所以正常也走不到这里；这是兜底）。
 */
@Composable
fun UserProfileScreen(
    userId: Long,
    posts: PostRepository,
    users: UserRepository,
    friends: FriendRepository,
    /**
     * 会话（**当前未直接使用**）。
     *
     * 刻意留着：本页与 [ProfileScreen] / [PostDetailScreen] 的入参形状保持一致，
     * 且"关注了对方 / 对方资料变了"要接 SSE（`RealtimeClient`）时就落在这一页 ——
     * 那时它由 `session` 或 `realtime` 驱动，不必再改 AppShell 的调用点。
     * 现在不引用它，是为了避免"看起来用了、其实读的是别的状态"这种误导。
     */
    session: SessionRepository,
    /** 当前登录用户 id（0 = 游客）。为 0 时关注/私信都先弹登录 */
    myUserId: Long,
    onBack: () -> Unit,
    onRequireLogin: () -> Unit,
    onOpenPost: (Long) -> Unit,
    /** 点「私信」→ 进与这个人的聊天（由 AppShell 推 ChatDest） */
    onOpenChat: (userId: Long, name: String?) -> Unit,
    /** 点右上角「…」→ 打开设置弹层（弹层由 AppShell 画，理由见文件头注释） */
    onOpenSettings: () -> Unit = {},
    /** 长按自己的作品 → 操作选单（只在"这条帖子是我的"时有值） */
    onRequestPostMenu: (ComposerEditSource) -> Unit = {},
    /** 帖子内容版本：发帖/编辑/删帖成功后由 Shell 透传 → 重拉这一页的作品列表 */
    postsRefreshKey: Int = 0,
) {
    val c = KTheme.colors
    val scope = rememberCoroutineScope()
    // 点作品格子只看详情，但"点图看大图"的能力保留在本页（与主页同一套查看器）
    val openViewer = top.kuangdada.k.nativeapp.ui.viewer.rememberImageViewerSimple()

    /**
     * 两份列表（**本页自己建**，不是仓库里按 source 复用的那份）：
     * `[0]` = 帖子（`GET /users/:id/posts`）、`[1]` = 转发（`GET /users/:id/reposts`）。
     *
     * 与 [ProfileScreen] 的取舍不同：主页那三份列表要跨页面存活（返回主页不能重拉、
     * 不能丢滚动位置），所以走 `posts.listFor(...)`；他人主页是**被推上来的二级页**，
     * 离开就销毁、每次进来都该拿最新数据（别人刚发的帖子要看得见）。
     * 用 `listFor` 反而会让"第二次进同一个人的主页"看到上一轮的旧列表。
     *
     * 为什么两份都建、却只 `loadIfEmpty()` **当前这一份**：建列表是纯内存操作，
     * 不带数据；而预拉另一份会在每次进主页时多打一个请求（大多数人只看帖子）。
     */
    val lists = remember(userId) {
        listOf(
            posts.newList(PostRepository.Source.UserPosts(userId)),
            posts.newList(PostRepository.Source.UserReposts(userId)),
        )
    }

    /**
     * 「帖子 / 转发」选中项。
     *
     * 用 `rememberSaveable` 而不是 `remember`：点作品格子进帖子详情后本页离开组合，
     * `remember` 会让"返回时跳回「帖子」"（用户明明在看「转发」）。Shell 的
     * `SaveableStateHolder` 只保存 `rememberSaveable` 系（与主页那三个标签同一个坑）。
     */
    var tabIndex by rememberSaveable(userId) { mutableIntStateOf(0) }

    /*
     * 两份列表的 state 都要**无条件** collect（Compose 不允许在 if/when 分支里调
     * `collectAsState`，也不能在 `map { }` 那种非 composable 的 lambda 里调）——
     * 所以这里老老实实各写一行，再用 `when (tabIndex)` 挑当前那一份。
     */
    val postsState = lists[0].state.collectAsState().value
    val repostsState = lists[1].state.collectAsState().value
    val currentState = if (tabIndex == 0) postsState else repostsState
    val currentList = if (tabIndex == 0) lists[0] else lists[1]

    /**
     * 资料：**首帧直接用仓库缓存**（用户上次看过这个人时留下的），随后静默刷新。
     *
     * 理由与主页同款：没有缓存时首帧头像是空的，要等 `/users/:id` 回来才画上，
     * 表现出来就是"每次进来头像都重新加载一次"。
     */
    var profile by remember(userId) { mutableStateOf(users.cachedProfile(userId)) }
    var profileError by remember(userId) { mutableStateOf<String?>(null) }
    var loadingProfile by remember(userId) { mutableStateOf(profile == null) }

    /**
     * 关注状态：**先读仓库缓存**（同一个人的主页可能从首页卡片、帖子详情、搜索结果
     * 三个入口进来），没缓存再发 `GET /friends/status/:id`。
     * 取值前判 `myUserId > 0` —— 游客没有关注状态可言，按钮直接按"未关注"画，
     * 点了先弹登录（少一次必然 401 的往返）。
     */
    var isFollowing by remember(userId, myUserId) {
        mutableStateOf(myUserId > 0 && friends.cachedStatus(userId) == true)
    }
    /** 关注请求在飞：按钮禁用，避免连点造成"关注又取关" */
    var followBusy by remember(userId) { mutableStateOf(false) }
    var toast by remember { mutableStateOf<String?>(null) }

    /**
     * 头像共享元素的目标端（见 [AvatarFlyer]）。
     *
     * [DisposableEffect] 是**必须的**，不是保险：点名状态如果留着，之后点"同一条帖子的卡片"
     * 进详情时源端会继续声明 key，头像会飞进帖子详情页（真机上就是这么错的）。
     * 放在 `onDispose`（而不是"点返回时"）是刻意的 —— 返回动画期间这一页还组合着，
     * 那一刻两头都要声明 key 才能飞回去；页面真正销毁时撤销，正好不影响返程飞行。
     */
    val flyer = rememberAvatarFlyer()
    DisposableEffect(flyer) { onDispose { flyer.clear() } }

    // 拉资料 + 关注状态 + 作品列表。
    // 三者互不依赖（关注状态失败不该让资料页变错误页），所以各自独立处理结果。
    LaunchedEffect(userId, myUserId) {
        // ---- 关注状态（仅登录用户）----
        if (myUserId > 0 && friends.cachedStatus(userId) == null) {
            when (val r = friends.status(userId)) {
                is ApiResult.Success -> isFollowing = r.data
                // 查状态失败**不报错**：按钮先按"未关注"画，用户点了真正的
                // 关注接口还会再走一次，那时才需要报错。这里弹一句错误只会打扰人。
                is ApiResult.Failure -> Unit
            }
        }

        // ---- 资料 ----
        when (val r = users.profile(userId)) {
            is ApiResult.Success -> {
                profile = r.data
                profileError = null
            }
            // 已经有缓存资料时，刷新失败保持旧值（比把整页变成错误页好）
            is ApiResult.Failure -> if (profile == null) profileError = r.error.displayMessage
        }
        loadingProfile = false

        // ---- 作品列表（只补"当前这一份"：建列表本身不发请求）----
        lists[0].loadIfEmpty()
    }

    // 内容变了（在这个人的主页里点进帖子→作者删了它 / 自己发帖）→ 重拉**当前这一份**
    LaunchedEffect(postsRefreshKey) {
        if (postsRefreshKey <= 0) return@LaunchedEffect
        currentList.refresh()
    }

    Box(modifier = Modifier.fillMaxSize().background(c.bgPage)) {
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(
                start = KSpacing.md,
                end = KSpacing.md,
                // 这里**不能**有 top：头部那一项自己挂 kTopBar（见 KWidgets.kTopBar）。
                // 原来这档 8dp 叠在头部的 statusBarsPadding 上，本页顶栏落在状态栏下 16dp。
                bottom = KSpacing.xl,
            ),
            verticalArrangement = Arrangement.spacedBy(KSpacing.xs),
        ) {
            // ---- 头部：顶栏 / 资料 / 统计 / 按钮 / 标签 ----
            item(key = "header") {
                Column(
                    // 顶栏垂直位置的唯一来源（状态栏安全区 + KSpacing.xs）
                    modifier = Modifier.kTopBar(),
                    verticalArrangement = Arrangement.spacedBy(KSpacing.lg),
                ) {
                    // 顶栏：返回 + 「…」（设计稿：这是二级页，不是主页 tab）
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            // 只写下边距：上边距由容器的 kTopBar 给
                            .padding(bottom = KSpacing.xs),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(KSpacing.md),
                    ) {
                        KIconButton(icon = GlyphKind.ChevronLeft, onClick = onBack)
                        Spacer(Modifier.weight(1f))
                        KIconButton(icon = GlyphKind.More, onClick = onOpenSettings)
                    }

                    // 资料区：头像 + 名字 / @用户名 / 简介
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(KSpacing.md),
                    ) {
                        Avatar(
                            url = profile?.let { users.avatarUrl(it) },
                            name = profile?.username ?: "",
                            size = 64.dp,
                            // 设计稿里没有头像时画的是**人像图标**（不是名字首字）。
                            // 资料还没到手时（首帧、且仓库没有缓存）传 null →
                            // Avatar 画名字首字会得到一个空字符串占位，很难看；
                            // 这一帧本来就只有几十毫秒，宁可它短暂空白。
                            glyph = GlyphKind.User.takeIf { profile != null },
                            bg = c.surfaceSubtle,
                            fg = c.accent,
                            /**
                             * 头像共享元素（M3 补完）：从信息流卡片 / 帖子详情页的头像飞过来。
                             *
                             * 目标端只需要 userId（发起端负责被"点名"，见 [AvatarShareState]）；
                             * 没有匹配的源端时它就是一个普通头像（深链直接进这一页的情况）。
                             */
                            sharedKey = avatarKey(userId).takeIf { flyer.isTarget(userId) },
                        )
                        Column(
                            modifier = Modifier.weight(1f),
                            verticalArrangement = Arrangement.spacedBy(KSpacing.xxs),
                        ) {
                            Text(
                                text = profile?.username ?: if (loadingProfile) "…" else "用户",
                                style = KType.overlayTitle,
                                color = c.textPrimary,
                            )
                            Text(
                                text = "@${profile?.username.orEmpty()}",
                                style = KType.footnote,
                                color = c.textMuted,
                            )
                            if (!profile?.bio.isNullOrBlank()) {
                                Text(profile?.bio.orEmpty(), style = KType.body, color = c.textSecondary)
                            }
                        }
                    }

                    // 资料加载失败且没有任何缓存 → 给一行可读的错误（不是整页错误页：
                    // 作品列表这时往往还能正常显示，把整页变成错误页反而更差）
                    if (profileError != null && profile == null) {
                        Text(profileError!!, style = KType.caption, color = c.danger)
                    }

                    // 统计：数值 17 SemiBold / 标签 12 muted
                    Row(horizontalArrangement = Arrangement.spacedBy(KSpacing.xxl)) {
                        StatItem("帖子", profile?.postCount)
                        StatItem("粉丝", profile?.followersCount)
                        StatItem("关注", profile?.followingCount)
                    }

                    // 操作区：关注（实心）+ 私信（白底描边），等宽各占一半。
                    //
                    // "已关注"用 Secondary（surface + borderStrong）而不是 Ghost：
                    // 设计稿这一态是**描边中性按钮**（金底只留给"未关注"这个主动作），
                    // 而且此时按钮的主语义已经变成"私信"，关注退居次要。
                    Row(horizontalArrangement = Arrangement.spacedBy(KSpacing.xs)) {
                        KButton(
                            text = if (isFollowing) "已关注" else "关注",
                            variant = if (isFollowing) KButtonVariant.Secondary else KButtonVariant.Primary,
                            enabled = !followBusy,
                            onClick = {
                                if (myUserId <= 0) {
                                    onRequireLogin()
                                    return@KButton
                                }
                                val next = !isFollowing
                                scope.launch {
                                    followBusy = true
                                    when (val r = friends.setFollowing(userId, next)) {
                                        is ApiResult.Success -> {
                                            isFollowing = r.data.isFollowing
                                            // 粉丝数用服务端返回的最新值回填 ——
                                            // 不回填的话"点了关注，粉丝数还是旧的"
                                            profile = profile?.copy(followersCount = r.data.followersCount)
                                            toast = if (r.data.isFollowing) "已关注" else "已取消关注"
                                        }
                                        is ApiResult.Failure -> toast = r.error.displayMessage
                                    }
                                    followBusy = false
                                }
                            },
                            modifier = Modifier.weight(1f),
                            cornerRadius = KRadius.control,
                        )
                        KButton(
                            text = "私信",
                            variant = KButtonVariant.Secondary,
                            onClick = {
                                if (myUserId <= 0) {
                                    onRequireLogin()
                                } else {
                                    // 昵称顺手带下去：聊天页顶栏要显示对方名字，
                                    // 而消息接口里只有 sender_username（见 ChatDest 的注释）
                                    onOpenChat(userId, profile?.username)
                                }
                            },
                            modifier = Modifier.weight(1f),
                            cornerRadius = KRadius.control,
                        )
                    }

                    // 标签：帖子 / 转发（设计稿上他人主页就是这两个）。
                    // 形态与主页那一排**逐字一致**（纯文字、等分、选中 accent + Bold）——
                    // 换成分段控件会让两个页面看起来不是一套设计。
                    Row(modifier = Modifier.fillMaxWidth()) {
                        listOf("帖子", "转发").forEachIndexed { i, title ->
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
                                        // 切过去时才拉那一份（见 lists 的注释：不预拉）
                                        scope.launch { lists[i].loadIfEmpty() }
                                    }
                                    .padding(vertical = KSpacing.xs),
                            )
                        }
                    }
                }
            }

            // ---- 作品网格：3 列方形（与他人主页一致）----
            when {
                currentState.loading && currentState.posts.isEmpty() -> item(key = "loading") {
                    Box(Modifier.fillMaxWidth().padding(KSpacing.xxl), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(color = c.accent)
                    }
                }

                currentState.error != null && currentState.posts.isEmpty() -> item(key = "error") {
                    KPlaceholder(
                        kind = KPlaceholderKind.Error,
                        title = "加载失败",
                        description = currentState.error?.displayMessage,
                        action = { KButton("重试", onClick = { scope.launch { currentList.refresh() } }) },
                    )
                }

                // 空列表不画大空态（与主页一致），但一行轻说明要留 ——
                // 整片网格什么都不画时，用户分不清"没有内容"和"页面坏了"
                currentState.loaded && currentState.posts.isEmpty() -> item(key = "empty") {
                    Box(Modifier.fillMaxWidth().padding(KSpacing.xxl), contentAlignment = Alignment.Center) {
                        Text(
                            text = if (tabIndex == 0) "还没有发过帖子" else "还没有转发过内容",
                            style = KType.footnote,
                            color = c.textMuted,
                        )
                    }
                }

                else -> currentState.posts.chunked(3).forEach { row ->
                    item(key = "row_${row.first().id}") {
                        Row(
                            // 删/发一条后整行重排走弹簧（M4）
                            modifier = Modifier.fillMaxWidth().animateItem(),
                            horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
                        ) {
                            row.forEach { post ->
                                val mine = myUserId > 0 && post.post.userId == myUserId
                                WorkThumb(
                                    post = post,
                                    onOpenPost = onOpenPost,
                                    onLongPress = {
                                        // 只有自己的帖子才给操作选单（别人的服务端必然 403）
                                        if (mine) {
                                            onRequestPostMenu(
                                                ComposerEditSource(
                                                    id = post.id,
                                                    description = post.description,
                                                    images = post.images,
                                                    location = post.location,
                                                )
                                            )
                                        }
                                    },
                                    // 大图入口保留给"想直接看图"的调用方；本页点格子是进详情
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

@Composable
private fun StatItem(label: String, value: Int?) {
    val c = KTheme.colors
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(
            text = (value ?: 0).toString(),
            style = KType.subtitle,
            color = c.textPrimary,
        )
        Text(label, style = KType.footnote, color = c.textMuted)
    }
}
