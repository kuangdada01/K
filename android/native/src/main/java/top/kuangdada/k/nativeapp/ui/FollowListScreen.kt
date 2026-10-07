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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import top.kuangdada.k.core.data.ApiResult
import top.kuangdada.k.core.data.FriendRepository
import top.kuangdada.k.core.data.UserRepository
import top.kuangdada.k.core.data.displayMessage
import top.kuangdada.k.core.data.model.UserProfile
import top.kuangdada.k.core.designsystem.component.KButton
import top.kuangdada.k.core.designsystem.component.KButtonVariant
import top.kuangdada.k.core.designsystem.component.KPlaceholder
import top.kuangdada.k.core.designsystem.component.KPlaceholderKind
import top.kuangdada.k.core.designsystem.component.KTextField
import top.kuangdada.k.core.designsystem.theme.KRadius
import top.kuangdada.k.core.designsystem.theme.KSpacing
import top.kuangdada.k.core.designsystem.theme.KTheme
import top.kuangdada.k.core.designsystem.theme.KType

/**
 * ============================================================
 * 关注 / 粉丝列表（设计稿之外的补充页：从个人主页的「关注 / 粉丝」统计点进来）
 * ============================================================
 * 2026-10-03 用户要求：「粉丝和关注不能点击查看 —— 谁关注了他 / 他关注了谁，
 * 共同关注的优先显示」。这一页就是那个"点进去"：
 *
 *  · 两个标签：**关注**（他关注了谁）/ **粉丝**（谁关注了他），进页时落在来源统计对应的那个；
 *  · 排序在**服务端**做（共同关注优先：互关 → 我关注了 Ta → Ta 关注了我 → 用户名），
 *    客户端只按返回顺序展示 —— 翻页窗口按服务端顺序切，本地重排必然把跨页顺序弄乱；
 *  · 每行行尾一个关注按钮，四个态与 Web 弹窗对齐并多一档：
 *    互相关注 / 已关注（点了取关）、回关（对方关注了我）/ 关注（点了关注）；
 *  · 搜索走服务端 `?q=`（300ms 防抖，与 Web 弹窗同一节奏），分页滚动到底自动加载下一页。
 *
 * 数据走 `FriendRepository.list(...)`（分页形状 —— 老形状没有关系字段，排序也不对）。
 * 每行点进那个人的主页（[onOpenUser]）：AppShell 的 openUserProfile 会处理"点自己 → 主页 tab"。
 */
/** 每页条数（服务端上限 50；App 用 30，信息密度与加载速度的折中） */
private const val FOLLOW_PAGE_SIZE = 30

/** 单个标签（关注 / 粉丝）的分页列表状态：两份独立，切标签互不干扰 */
private class FollowTabState(val kind: FriendRepository.FollowListKind) {
    var users by mutableStateOf<List<FriendRepository.FollowUser>>(emptyList())
    var page by mutableIntStateOf(0)
    var hasMore by mutableStateOf(false)
    /** 至少成功拉过一次（决定能不能触发"加载更多"与错误占位） */
    var loaded by mutableStateOf(false)
    var loading by mutableStateOf(false)
    var loadingMore by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)

    /** 搜索框的实时值（输入框跟着它走） */
    var query by mutableStateOf("")
    /** 已提交给服务端的搜索词（与 query 不同 = 有未防抖完的输入） */
    var committedQuery by mutableStateOf("")

    /**
     * 重拉第一页（搜索词用 [committedQuery]）。
     *
     * 失败时**保留旧列表**（只记 error）：整块闪空比"看着旧数据 + 一句错误"更糟。
     * @return 错误文案（null = 成功），调用方拿去弹 toast
     */
    suspend fun reload(friends: FriendRepository, targetId: Long): String? {
        loading = true
        val r = friends.list(
            targetId = targetId,
            kind = kind,
            page = 1,
            query = committedQuery.takeIf { it.isNotBlank() },
        )
        when (r) {
            is ApiResult.Success -> {
                users = r.data.users
                page = 1
                hasMore = r.data.hasMore
                error = null
            }
            is ApiResult.Failure -> error = r.error.displayMessage
        }
        loaded = true
        loading = false
        return (r as? ApiResult.Failure)?.error?.displayMessage
    }

    /** 追加下一页。翻页失败**不打断浏览**（返回文案由调用方弹 toast），旧页照常可看 */
    suspend fun loadMore(friends: FriendRepository, targetId: Long): String? {
        if (loadingMore || !hasMore || page <= 0) return null
        loadingMore = true
        val r = friends.list(
            targetId = targetId,
            kind = kind,
            page = page + 1,
            query = committedQuery.takeIf { it.isNotBlank() },
        )
        when (r) {
            is ApiResult.Success -> {
                users = users + r.data.users
                page = r.data.page
                hasMore = r.data.hasMore
            }
            is ApiResult.Failure -> Unit
        }
        loadingMore = false
        return (r as? ApiResult.Failure)?.error?.displayMessage
    }
}

@Composable
fun FollowListScreen(
    userId: Long,
    /** true = 直接落在「粉丝」标签（从"粉丝数"点进来的） */
    initialShowFollowers: Boolean,
    users: UserRepository,
    friends: FriendRepository,
    /** 当前登录用户 id（0 = 游客）。游客看不了列表（接口要登录），整页给"去登录"占位 */
    myUserId: Long,
    onBack: () -> Unit,
    onRequireLogin: () -> Unit,
    /** 点某一行 → 那个人的主页（点自己时 AppShell 会切回主页 tab） */
    onOpenUser: (Long) -> Unit,
) {
    val c = KTheme.colors
    val scope = rememberCoroutineScope()

    /**
     * 两个标签的状态（[userId] 变了就是另一个人，全部重建）。
     * `[0]` = 关注（他关注了谁）、`[1]` = 粉丝（谁关注了他）。
     */
    val tabs = remember(userId) {
        listOf(
            FollowTabState(FriendRepository.FollowListKind.Following),
            FollowTabState(FriendRepository.FollowListKind.Followers),
        )
    }
    var tabIndex by rememberSaveable(userId) { mutableIntStateOf(if (initialShowFollowers) 1 else 0) }
    val tab = tabs[tabIndex]

    /**
     * 顶栏标题用**对方的昵称**：告诉用户"这是谁的粉丝/关注"。
     * 仓库里通常已有缓存（就是从他的主页点进来的），首帧就有；没有再拉一次兜底。
     */
    var profile by remember(userId) { mutableStateOf<UserProfile?>(users.cachedProfile(userId)) }
    LaunchedEffect(userId) {
        when (val r = users.profile(userId)) {
            is ApiResult.Success -> profile = r.data
            is ApiResult.Failure -> Unit // 没有缓存时标题退化为"个人主页"，不值得报错
        }
    }

    var toast by remember { mutableStateOf<String?>(null) }
    /** 正在关注/取关的那一行（按钮禁用，防止连点造成"关注又取关"） */
    var busyId by remember { mutableStateOf<Long?>(null) }

    // ---- 数据触发 ----

    // 首次进入 / 切标签：只补"从没加载过"的那一份（切回来不重拉，保留滚动位置）
    LaunchedEffect(tabIndex, myUserId) {
        if (myUserId <= 0) return@LaunchedEffect
        val t = tabs[tabIndex]
        if (!t.loaded) t.reload(friends, userId)
    }

    // 搜索词变化：300ms 防抖后重查第一页（与 Web 弹窗同一节奏）。
    // committedQuery 相同（含首帧）就不重复打请求。
    LaunchedEffect(tabIndex, tab.query) {
        if (myUserId <= 0) return@LaunchedEffect
        val t = tabs[tabIndex]
        if (t.query.trim() == t.committedQuery) return@LaunchedEffect
        delay(300)
        t.committedQuery = t.query.trim()
        val err = t.reload(friends, userId)
        if (err != null) toast = err
    }

    // 滚动到底部附近自动加载下一页（Web 弹窗是"加载更多"按钮，移动端惯例是滚到底触发）
    val listState = rememberLazyListState()
    LaunchedEffect(listState, tabIndex, myUserId) {
        snapshotFlow {
            val info = listState.layoutInfo
            val last = info.visibleItemsInfo.lastOrNull()?.index ?: 0
            last >= info.totalItemsCount - 3
        }
            .distinctUntilChanged()
            .collect { nearEnd ->
                if (!nearEnd || myUserId <= 0) return@collect
                val t = tabs[tabIndex]
                if (!t.loaded || t.loading || t.loadingMore || !t.hasMore) return@collect
                val err = t.loadMore(friends, userId)
                if (err != null) toast = err
            }
    }

    // ---- 关注 / 取关 ----

    fun toggle(u: FriendRepository.FollowUser) {
        if (busyId != null) return
        scope.launch {
            busyId = u.id
            when (val r = friends.setFollowing(u.id, !u.isFollowing)) {
                is ApiResult.Success -> {
                    val isFollowing = r.data.isFollowing
                    // 同一个人可能同时出现在两个标签里，两份都改；
                    // isMutual 本地重推：我关注了他 && 他关注了我（follows_viewer 不受这次操作影响）。
                    // **不重排**：顺序是服务端按分页窗口给的，操作后重排会把行跳来跳去。
                    for (t in tabs) {
                        t.users = t.users.map {
                            if (it.id == u.id) {
                                it.copy(isFollowing = isFollowing, isMutual = isFollowing && it.followsViewer)
                            } else {
                                it
                            }
                        }
                    }
                }
                is ApiResult.Failure -> toast = r.error.displayMessage
            }
            busyId = null
        }
    }

    Box(modifier = Modifier.fillMaxSize().background(c.bgPage)) {
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(
                start = KSpacing.md,
                end = KSpacing.md,
                // 顶栏垂直位置由头部那一项的 kTopBar 给（与两个主页同一条规矩）
                bottom = KSpacing.xl,
            ),
            verticalArrangement = Arrangement.spacedBy(KSpacing.xs),
        ) {
            item(key = "header") {
                Column(
                    modifier = Modifier.kTopBar(),
                    verticalArrangement = Arrangement.spacedBy(KSpacing.lg),
                ) {
                    // 顶栏：返回 + 对方昵称（"谁的粉丝"一眼可读）
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
                    ) {
                        KIconButton(icon = GlyphKind.ChevronLeft, onClick = onBack)
                        Text(
                            text = profile?.username ?: "个人主页",
                            style = KType.title,
                            color = c.textPrimary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                    }

                    if (myUserId > 0) {
                        // 标签：关注 / 粉丝（与两个主页的纯文字标签同一形态）
                        Row(modifier = Modifier.fillMaxWidth()) {
                            listOf("关注", "粉丝").forEachIndexed { i, title ->
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
                                        ) { tabIndex = i }
                                        .padding(vertical = KSpacing.xs),
                                )
                            }
                        }

                        // 搜索：服务端 `?q=`（用户名模糊 + id 子串）。 placeholder 与 Web 弹窗一致
                        KTextField(
                            value = tab.query,
                            onValueChange = { tab.query = it },
                            modifier = Modifier.fillMaxWidth(),
                            placeholder = "搜索用户名",
                            singleLine = true,
                            leading = {
                                Glyph(tint = c.textMuted, kind = GlyphKind.Search, size = 18.dp)
                            },
                        )
                    }
                }
            }

            if (myUserId <= 0) {
                // 游客：列表接口都要登录，直接给占位（与个人主页未登录同一形态）
                item(key = "guest") {
                    KPlaceholder(
                        kind = KPlaceholderKind.Empty,
                        title = "未登录",
                        description = "登录后才能查看关注与粉丝",
                        action = { KButton("去登录", onClick = onRequireLogin) },
                    )
                }
            } else {
                val current = tabs[tabIndex]
                when {
                    current.loading && current.users.isEmpty() -> item(key = "loading") {
                        Box(Modifier.fillMaxWidth().padding(KSpacing.xxl), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator(color = c.accent)
                        }
                    }

                    current.error != null && current.users.isEmpty() -> item(key = "error") {
                        KPlaceholder(
                            kind = KPlaceholderKind.Error,
                            title = "加载失败",
                            description = current.error,
                            action = {
                                KButton("重试", onClick = { scope.launch { current.reload(friends, userId) } })
                            },
                        )
                    }

                    current.users.isEmpty() -> item(key = "empty") {
                        Box(Modifier.fillMaxWidth().padding(KSpacing.xxl), contentAlignment = Alignment.Center) {
                            Text(
                                text = if (current.committedQuery.isNotBlank()) {
                                    "未找到相关用户"
                                } else if (tabIndex == 0) {
                                    "还没有关注的人"
                                } else {
                                    "还没有粉丝"
                                },
                                style = KType.footnote,
                                color = c.textMuted,
                            )
                        }
                    }

                    else -> {
                        items(current.users, key = { it.id }) { u ->
                            FollowRow(
                                user = u,
                                isSelf = u.id == myUserId,
                                busy = busyId == u.id,
                                onToggle = { toggle(u) },
                                onOpenUser = { onOpenUser(u.id) },
                                avatarUrl = { path -> users.avatarUrl(path) },
                            )
                        }
                        if (current.loadingMore) {
                            item(key = "loadingMore") {
                                Box(Modifier.fillMaxWidth().padding(KSpacing.sm), contentAlignment = Alignment.Center) {
                                    CircularProgressIndicator(color = c.accent, modifier = Modifier.size(20.dp))
                                }
                            }
                        } else if (!current.hasMore) {
                            item(key = "end") {
                                Text(
                                    text = "没有更多了",
                                    style = KType.footnote,
                                    color = c.textMuted,
                                    textAlign = TextAlign.Center,
                                    modifier = Modifier.fillMaxWidth().padding(KSpacing.sm),
                                )
                            }
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
 * 列表的一行：头像 + 昵称 / 简介 + 行尾关注按钮。
 *
 * 行尾按钮的四个态（第一优先级在前）：
 *  · 互相关注 → 「互相关注」（Secondary，点了取关）；
 *  · 我关注了 Ta → 「已关注」（Secondary，点了取关）；
 *  · Ta 关注了我 → 「回关」（Primary，点了关注 —— 粉丝列表里最有用的一档）；
 *  · 其他 → 「关注」（Primary，点了关注）。
 * 与 Web 弹窗的"已关注/关注"两态同源，多出的两档来自服务端新给的 is_mutual / follows_viewer。
 */
@Composable
private fun FollowRow(
    user: FriendRepository.FollowUser,
    isSelf: Boolean,
    busy: Boolean,
    onToggle: () -> Unit,
    onOpenUser: () -> Unit,
    avatarUrl: (String?) -> String?,
) {
    val c = KTheme.colors
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(KRadius.row))
            .clickable(onClick = onOpenUser)
            .padding(horizontal = KSpacing.xs, vertical = KSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(KSpacing.sm),
    ) {
        Avatar(
            url = avatarUrl(user.avatarPath),
            name = user.username,
            size = 44.dp,
        )
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(
                text = user.username,
                style = KType.bodyStrong,
                color = c.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (user.bio.isNotBlank()) {
                Text(
                    text = user.bio,
                    style = KType.footnote,
                    color = c.textMuted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (!isSelf) {
            when {
                user.isMutual -> RowToggleButton(
                    text = "互相关注",
                    variant = KButtonVariant.Secondary,
                    enabled = !busy,
                    onClick = onToggle,
                )
                user.isFollowing -> RowToggleButton(
                    text = "已关注",
                    variant = KButtonVariant.Secondary,
                    enabled = !busy,
                    onClick = onToggle,
                )
                user.followsViewer -> RowToggleButton(
                    text = "回关",
                    variant = KButtonVariant.Primary,
                    enabled = !busy,
                    onClick = onToggle,
                )
                else -> RowToggleButton(
                    text = "关注",
                    variant = KButtonVariant.Primary,
                    enabled = !busy,
                    onClick = onToggle,
                )
            }
        } else {
            // 自己的那一行（自己的主页 tab 里不会再进这页，但粉丝列表里可能有自己的行）：
            // 没有关注按钮可言，占一个空位让头像/文字布局不偏
            Spacer(modifier = Modifier.width(64.dp))
        }
    }
}

/** 行尾小按钮：胶囊 + 紧凑高度（44dp 的行里放常规 44dp 按钮会把行撑爆） */
@Composable
private fun RowToggleButton(
    text: String,
    variant: KButtonVariant,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    KButton(
        text = text,
        onClick = onClick,
        variant = variant,
        enabled = enabled,
        compact = true,
        minHeight = 32.dp,
    )
}
