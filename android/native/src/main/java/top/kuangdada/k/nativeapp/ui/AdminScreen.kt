package top.kuangdada.k.nativeapp.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import kotlinx.coroutines.launch
import top.kuangdada.k.core.data.AdminRepository
import top.kuangdada.k.core.data.ApiResult
import top.kuangdada.k.core.data.displayMessage
import top.kuangdada.k.core.data.model.AdminAnnouncementRow
import top.kuangdada.k.core.data.model.AdminPostRow
import top.kuangdada.k.core.data.model.AdminUserRow
import top.kuangdada.k.core.data.relativeTime
import top.kuangdada.k.core.designsystem.component.KButton
import top.kuangdada.k.core.designsystem.component.KPlaceholder
import top.kuangdada.k.core.designsystem.component.KPlaceholderKind
import top.kuangdada.k.core.designsystem.component.KTextField
import top.kuangdada.k.core.designsystem.theme.KDimens
import top.kuangdada.k.core.designsystem.theme.KRadius
import top.kuangdada.k.core.designsystem.theme.KSpacing
import top.kuangdada.k.core.designsystem.theme.KTheme
import top.kuangdada.k.core.designsystem.theme.KType

/**
 * ============================================================
 * 管理后台（设计稿「管理后台」三屏：用户 / 帖子 / 公告）
 * ============================================================
 * 形态完全照设计稿重排（上一版是"表头 + 表格行"的三层表格，与设计稿不符）：
 *  · 顶栏：圆形返回钮 + 「管理后台」，**公告段右上角多一个实心 + 圆钮**（进新建公告）；
 *  · 分段控件「用户 | 帖子 | 公告」（全圆药丸轨道 + 白色选中段）；
 *  · **搜索框**（药丸，带放大镜，无「搜索」按钮 —— 服务端搜索由输入防抖触发）；
 *  · 列表：**一张张白卡片**，每张左边一个图标/缩略图（56dp 圆角），中间主副两行，右边一个操作药丸；
 *  · 列表下方一行灰色统计：「共 128 位用户 · 已封禁 2」/「共 256 篇帖子 · 今日新增 8」/
 *    「共 12 条公告 · 全部用户可见」。
 *
 * 三种行的高亮内容（设计稿逐项对齐）：
 *  · 用户：昵称 17 + 「管理员 · @kuangdada · 已封禁」13；操作 = 解禁（accentSoft 底）或 封禁（dangerSoft 底）
 *  · 帖子：标题 17 + 「作者 · 时间 · N 条评论」13；操作 = 删除（dangerSoft 底）；
 *    左侧是**首图缩略图**，没有图（纯文字帖）时退化成浅绿占位块
 *  · 公告：标题 17 + 「作者 · 时间 · 全部用户/指定用户」13；操作 = 删除；左侧是浅绿喇叭图标块
 *
 * 服务端的权限与业务校验（客户端不能假装）：不能删除/封禁/重置管理员账号、不能删自己、
 * 封禁天数只允许 1/7/30/365 —— 这些都在服务端兜底，客户端把错误文案原样展示。
 */
@Composable
fun AdminScreen(
    repo: AdminRepository,
    onBack: () -> Unit,
    /** 公告段右上角「+」→ 新建公告页 */
    onNewAnnouncement: () -> Unit = {},
    /** 从新建公告页返回时自增，用于重新拉列表（新公告要立刻出现在列表里） */
    refreshKey: Int = 0,
) {
    val c = KTheme.colors
    val scope = rememberCoroutineScope()

    // 「用户 / 帖子 / 公告」选中项：同样要 rememberSaveable —— 进新建公告页再返回时，
    // 用 remember 会被重置回「用户」（三个列表各自的分页游标本来也会跟着乱）。
    var tab by rememberSaveable { mutableIntStateOf(0) }
    var query by remember { mutableStateOf("") }
    var page by remember { mutableIntStateOf(1) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var toast by remember { mutableStateOf<String?>(null) }

    var users by remember { mutableStateOf<List<AdminUserRow>>(emptyList()) }
    var posts by remember { mutableStateOf<List<AdminPostRow>>(emptyList()) }
    var announcements by remember { mutableStateOf<List<AdminAnnouncementRow>>(emptyList()) }
    var totalPages by remember { mutableIntStateOf(1) }
    var total by remember { mutableIntStateOf(0) }
    /**
     * 待确认的破坏性操作（null = 没有弹窗）。
     *
     * 管理后台的每个操作都直接打服务端，**没有撤销入口**：
     * 删用户会级联删掉他的帖子/图片/私信，删帖子会删掉评论与媒体文件。
     * 误触一次就是永久丢失 —— 所以删/封禁一律先弹确认（用户要求）。
     */
    var pending by remember { mutableStateOf<AdminConfirm?>(null) }
    /** 当前页里的封禁人数（用户段的"已封禁 N"来自这里） */
    var bannedOnPage by remember { mutableIntStateOf(0) }
    /** 今日新增帖数（帖子段的"今日新增 N"来自这里） */
    var todayPosts by remember { mutableIntStateOf(0) }

    suspend fun load() {
        loading = true
        error = null
        val q = query.takeIf { it.isNotBlank() }
        when (tab) {
            0 -> when (val r = repo.users(page, q)) {
                is ApiResult.Success -> {
                    users = r.data.items
                    totalPages = r.data.totalPages
                    total = r.data.total
                    bannedOnPage = r.data.items.count { it.isBannedNow() }
                }
                is ApiResult.Failure -> error = r.error.displayMessage
            }
            1 -> when (val r = repo.posts(page, q)) {
                is ApiResult.Success -> {
                    posts = r.data.items
                    totalPages = r.data.totalPages
                    total = r.data.total
                    todayPosts = r.data.items.count { isToday(it.createdAt) }
                }
                is ApiResult.Failure -> error = r.error.displayMessage
            }
            else -> when (val r = repo.announcements(page, q)) {
                is ApiResult.Success -> {
                    announcements = r.data.items
                    totalPages = r.data.totalPages
                    total = r.data.total
                }
                is ApiResult.Failure -> error = r.error.displayMessage
            }
        }
        loading = false
    }

    // refreshKey 变化 = 刚从新建公告页回来，要重拉（否则新公告不出现在列表里）
    LaunchedEffect(tab, page, refreshKey) { load() }

    /**
     * 搜索防抖：输入停下 400ms 才发请求。
     *
     * 为什么不做成"敲一下搜一次"：搜索是**服务端**做的（客户端只有当前页 20 行，
     * 本地过滤会搜不到其他页的内容），每个字符一个请求既费流量又容易被限流。
     *
     * [lastSearched] 必须 `remember`：它记录"上一次真正发出去的词"，
     * 否则每次重组（例如翻页、弹 toast）都会重新延迟 400ms 再搜一次。
     */
    var lastSearched by remember { mutableStateOf(query) }
    LaunchedEffect(query) {
        if (query == lastSearched) return@LaunchedEffect
        kotlinx.coroutines.delay(400)
        lastSearched = query
        page = 1
        load()
    }

    Box(modifier = Modifier.fillMaxSize().background(c.bgPage)) {
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(
                start = KSpacing.md,
                end = KSpacing.md,
                // 这里**不能**有 top：顶栏那一项自己挂 kTopBar（见 KWidgets.kTopBar）。
                // 原来这档 16dp 叠在顶栏里的 statusBarsPadding 上，本页顶栏被压到状态栏下 24dp。
                bottom = KSpacing.lg,
            ),
            verticalArrangement = Arrangement.spacedBy(KSpacing.sm),
        ) {
            // ---- 顶栏 + 分段 + 搜索 ----
            item {
                Column(
                    // 顶栏垂直位置的唯一来源（状态栏安全区 + KSpacing.xs）
                    modifier = Modifier.kTopBar(),
                    verticalArrangement = Arrangement.spacedBy(KSpacing.sm),
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(KSpacing.sm),
                    ) {
                        KIconButton(icon = GlyphKind.ChevronLeft, onClick = onBack)
                        Text(
                            text = "管理后台",
                            style = KType.subtitle,
                            color = c.textPrimary,
                            modifier = Modifier.weight(1f),
                        )
                        // 「+」只在公告段出现（设计稿第三屏右上角）——那是"新建公告"的入口
                        if (tab == 2) {
                            PlusIconButton(onClick = onNewAnnouncement)
                        }
                    }

                    KSegmentedTabs(
                        options = listOf("用户", "帖子", "公告"),
                        selectedIndex = tab,
                        onSelect = { tab = it; page = 1 },
                    )

                    AdminSearchField(
                        value = query,
                        onValueChange = { query = it },
                        placeholder = when (tab) {
                            0 -> "搜索昵称 / @用户名"
                            1 -> "搜索帖子标题 / 作者"
                            else -> "搜索公告标题"
                        },
                    )
                }
            }

            when {
                loading -> item {
                    Box(Modifier.fillMaxWidth().padding(KSpacing.xxl), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(color = c.accent)
                    }
                }

                error != null -> item {
                    KPlaceholder(
                        kind = KPlaceholderKind.Error,
                        title = "加载失败",
                        description = error,
                        action = { KButton("重试", onClick = { scope.launch { load() } }) },
                    )
                }

                else -> when (tab) {
                    // ---------------- 用户 ----------------
                    0 -> if (users.isEmpty()) {
                        item { KPlaceholder(kind = KPlaceholderKind.Empty, title = "没有用户", description = null) }
                    } else {
                        items(users, key = { it.id }) { u ->
                            UserCard(
                                row = u,
                                avatar = repo.avatarUrl(u.avatar),
                                onBan = { days ->
                                    // 封禁**可逆**（能解禁），但会立刻把用户踢下线，
                                    // 仍然值得一次确认 —— 用户要求"删/封禁都要弹窗"
                                    pending = AdminConfirm.BanUser(id = u.id, name = u.username, days = days)
                                },
                                onUnban = {
                                    scope.launch {
                                        when (val r = repo.unban(u.id)) {
                                            is ApiResult.Success -> { toast = "已解禁"; load() }
                                            is ApiResult.Failure -> toast = r.error.displayMessage
                                        }
                                    }
                                },
                                onDelete = { pending = AdminConfirm.DeleteUser(id = u.id, name = u.username) },
                                // 删/封禁之后整列表重排走弹簧（M4）
                                modifier = Modifier.animateItem(),
                            )
                        }
                        item {
                            ListFooter("共 $total 位用户 · 已封禁 $bannedOnPage")
                        }
                    }

                    // ---------------- 帖子 ----------------
                    1 -> if (posts.isEmpty()) {
                        item { KPlaceholder(kind = KPlaceholderKind.Empty, title = "没有帖子", description = null) }
                    } else {
                        items(posts, key = { it.id }) { p ->
                            PostCardRow(
                                row = p,
                                cover = repo.resolve(p.coverPath),
                                onDelete = {
                                    pending = AdminConfirm.DeletePost(id = p.id, name = p.title.ifBlank { p.description })
                                },
                                modifier = Modifier.animateItem(),
                            )
                        }
                        item {
                            ListFooter("共 $total 篇帖子 · 今日新增 $todayPosts")
                        }
                    }

                    // ---------------- 公告 ----------------
                    else -> if (announcements.isEmpty()) {
                        item { KPlaceholder(kind = KPlaceholderKind.Empty, title = "没有公告", description = null) }
                    } else {
                        items(announcements, key = { it.id }) { a ->
                            AnnouncementCardRow(
                                row = a,
                                onDelete = {
                                    pending = AdminConfirm.DeleteAnnouncement(id = a.id, name = a.title)
                                },
                                modifier = Modifier.animateItem(),
                            )
                        }
                        item { ListFooter("共 $total 条公告 · 全部用户可见") }
                    }
                }
            }

            // ---- 翻页（服务端分页；设计稿没画，但 20 条一页必须能翻到下一页）----
            if (totalPages > 1) {
                item {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.Center,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        KButton(
                            text = "上一页",
                            onClick = { if (page > 1) page -= 1 },
                            variant = top.kuangdada.k.core.designsystem.component.KButtonVariant.Ghost,
                            enabled = page > 1,
                        )
                        Spacer(Modifier.width(KSpacing.sm))
                        Text("第 $page / $totalPages 页", style = KType.caption, color = c.textMuted)
                        Spacer(Modifier.width(KSpacing.sm))
                        KButton(
                            text = "下一页",
                            onClick = { if (page < totalPages) page += 1 },
                            variant = top.kuangdada.k.core.designsystem.component.KButtonVariant.Ghost,
                            enabled = page < totalPages,
                        )
                    }
                }
            }
        }

        if (toast != null) {
            KToast(text = toast!!, onDismiss = { toast = null }, modifier = Modifier.align(Alignment.BottomCenter))
        }

        /**
         * 破坏性操作的二次确认。
         *
         * 抽成一个 sealed 类型（而不是给每处各写一个 `AlertDialog`）的原因：
         * 四个操作的文案、危险色、确认按钮都不一样，但**触发位置只有这一个** ——
         * 分散写的话，将来加第五个操作很容易漏掉弹窗（这正是本轮要修的问题）。
         */
        pending?.let { p ->
            AlertDialog(
                onDismissRequest = { pending = null },
                title = { Text(p.title, style = KType.subtitle, color = c.textPrimary) },
                text = { Text(p.message, style = KType.body, color = c.textSecondary) },
                confirmButton = {
                    Text(
                        text = p.confirmText,
                        style = KType.bodyStrong,
                        color = c.danger,
                        modifier = Modifier
                            .clip(RoundedCornerShape(KRadius.control))
                            .clickable {
                                pending = null
                                scope.launch {
                                    when (val r = p.run(repo)) {
                                        is ApiResult.Success -> { toast = p.doneText; load() }
                                        is ApiResult.Failure -> toast = r.error.displayMessage
                                    }
                                }
                            }
                            .padding(horizontal = KSpacing.sm, vertical = KSpacing.xs),
                    )
                },
                dismissButton = {
                    Text(
                        text = "取消",
                        style = KType.body,
                        color = c.textMuted,
                        modifier = Modifier
                            .clip(RoundedCornerShape(KRadius.control))
                            .clickable { pending = null }
                            .padding(horizontal = KSpacing.sm, vertical = KSpacing.xs),
                    )
                },
                containerColor = c.surface,
            )
        }
    }
}

/**
 * 管理后台里需要二次确认的操作。
 *
 * 每个子类自己提供文案与"怎么执行"——调用方只负责把它塞进 `pending`，
 * 弹窗与执行只有一处实现（见 [AdminScreen] 末尾）。
 */
private sealed interface AdminConfirm {
    /** 弹窗标题 */
    val title: String

    /** 主体说明：必须写清"会造成什么后果"，而不是只问一句"确定吗" */
    val message: String

    /** 确认按钮文案（带具体动作，避免只有一个"确定"） */
    val confirmText: String

    /** 成功后的提示 */
    val doneText: String

    suspend fun run(repo: AdminRepository): ApiResult<*>

    data class BanUser(val id: Long, val name: String, val days: Int) : AdminConfirm {
        override val title = "封禁用户"
        override val message =
            "「$name」将被封禁 $days 天：期间只能浏览，不能发帖、评论或发私信。"
        override val confirmText = "封禁 $days 天"
        override val doneText = "已封禁 $days 天"
        override suspend fun run(repo: AdminRepository) = repo.ban(id, days)
    }

    data class DeleteUser(val id: Long, val name: String) : AdminConfirm {
        override val title = "删除用户"
        override val message =
            "「$name」的账号、全部帖子、图片视频与私信都会被永久删除，且不可恢复。"
        override val confirmText = "删除"
        override val doneText = "已删除"
        override suspend fun run(repo: AdminRepository) = repo.deleteUser(id)
    }

    data class DeletePost(val id: Long, val name: String) : AdminConfirm {
        override val title = "删除帖子"
        override val message =
            "「${name.take(20)}」及其评论、点赞与图片视频都会被永久删除，且不可恢复。"
        override val confirmText = "删除"
        override val doneText = "已删除"
        override suspend fun run(repo: AdminRepository) = repo.deletePost(id)
    }

    data class DeleteAnnouncement(val id: Long, val name: String) : AdminConfirm {
        override val title = "删除公告"
        override val message = "公告「${name.take(20)}」会被永久删除，所有用户都不再看到它。"
        override val confirmText = "删除"
        override val doneText = "已删除"
        override suspend fun run(repo: AdminRepository) = repo.deleteAnnouncement(id)
    }
}

/**
 * 实心 accent 圆钮 + 「＋」（设计稿公告段右上角）。
 * 与页头那个 36dp 描边圆钮（[KIconButton]）区分开：这是**主操作**，所以是实心。
 */
@Composable
private fun PlusIconButton(onClick: () -> Unit) {
    val c = KTheme.colors
    Box(
        modifier = Modifier
            .size(KDimens.iconButton)
            .clip(RoundedCornerShape(percent = 50))
            .background(c.accent)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        // 图标跟 onAccent 反色（深色主题下 accent 是浅金，白图标只有 3.6:1）
        Glyph(tint = c.onAccent, kind = GlyphKind.Plus, size = 20.dp)
    }
}

/**
 * 药丸搜索框（设计稿：左侧放大镜 + 提示文案，**没有搜索按钮**）。
 *
 * `KTextField` 支持 `leading`，把放大镜放进去即可 —— 不再自绘一个 Row 包一层，
 * 否则聚焦态描边与输入区会错位。
 */
@Composable
private fun AdminSearchField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
) {
    val c = KTheme.colors
    KTextField(
        value = value,
        onValueChange = onValueChange,
        placeholder = placeholder,
        shape = RoundedCornerShape(KRadius.pill),
        leading = { Glyph(tint = c.textMuted, kind = GlyphKind.Search, size = 18.dp) },
    )
}

/** 列表下方的统计行（设计稿里那三行灰字） */
@Composable
private fun ListFooter(text: String) {
    Text(
        text = text,
        style = KType.caption,
        color = KTheme.colors.textMuted,
        modifier = Modifier.fillMaxWidth().padding(top = KSpacing.xs),
        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
    )
}

/**
 * 行内操作药丸（设计稿右侧那个小圆角按钮）。
 *
 * 内边距比 `KButton(compact)` 还收一档：设计稿实测药丸宽约 55dp（"封禁"两字 + 左右各 10dp），
 * 用 `KSpacing.md(16)` 会撑到 70dp，卡片右侧被占掉一大块、主标题的可读宽度变窄。
 *
 * @param danger true = `dangerSoft` 底 + `danger` 字（封禁/删除）；false = `accentSoft` 底 + `accent` 字（解禁）
 */
@Composable
private fun ActionPill(
    text: String,
    danger: Boolean,
    onClick: () -> Unit,
) {
    val c = KTheme.colors
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(KRadius.pill))
            .background(if (danger) c.dangerSoft else c.accentSoft)
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = KSpacing.xs),
    ) {
        Text(
            text = text,
            style = KType.caption,
            color = if (danger) c.danger else c.accent,
        )
    }
}

/** 列表行的公共外壳：白卡片 + 行内间距（三种行共用，保证节奏一致） */
@Composable
private fun AdminRowCard(
    modifier: Modifier = Modifier,
    content: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit,
) {
    val c = KTheme.colors
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(KRadius.row))
            .background(c.surface)
            .padding(horizontal = KSpacing.sm, vertical = KSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(KSpacing.sm),
        content = content,
    )
}

/**
 * 用户卡片：头像 + 昵称/「角色 · @用户名 · 状态」+ 封禁/解禁 药丸。
 *
 * @param onDelete **长按**卡片触发（带确认）：设计稿这一屏只画了封禁/解禁，
 *   但"删除用户"是既有的管理能力，不能在重排时丢掉 —— 长按是列表里放"低频破坏性操作"
 *   的常规位置（与个人主页长按作品同一套手势）。
 */
@Composable
private fun UserCard(
    row: AdminUserRow,
    avatar: String?,
    onBan: (Int) -> Unit,
    onUnban: () -> Unit,
    onDelete: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = KTheme.colors
    val banned = row.isBannedNow()
    // 封禁天数只允许 1/7/30/365（服务端 schema 校验），所以给固定档位而不是输入框
    var expandBan by remember { mutableStateOf(false) }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(KRadius.row))
            .background(c.surface)
            .combinedClickable(onLongClick = onDelete, onClick = {})
    ) {
        AdminRowCard {
            // 用户列表的头像用 56dp（设计稿实测 56px @390pt），比会话列表那档(48)大一号：
            // 这一页每行是一个"账号"，头像是主视觉
            Avatar(
                url = avatar,
                name = row.username,
                size = 56.dp,
                glyph = GlyphKind.User,
                bg = c.surfaceSubtle,
                fg = c.accent,
            )
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Text(
                    text = row.username,
                    style = KType.subtitle,
                    color = c.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                // 「管理员 · @kuangdada · 正常」——角色与用户名后缀是弱化的，**状态单独用语义色**
                // （设计稿里"正常"是灰、"已封禁"是红，不是整行一个颜色）
                Row(horizontalArrangement = Arrangement.spacedBy(KSpacing.xxs)) {
                    Text(
                        text = if (row.isAdmin) "管理员" else "成员",
                        style = KType.caption,
                        color = c.textMuted,
                    )
                    Text("·", style = KType.caption, color = c.textMuted)
                    Text(
                        text = "@${row.username}",
                        style = KType.caption,
                        color = c.textMuted,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text("·", style = KType.caption, color = c.textMuted)
                    Text(
                        text = if (banned) "已封禁" else "正常",
                        style = KType.caption,
                        color = if (banned) c.danger else c.textMuted,
                    )
                }
            }
            if (banned) {
                ActionPill(text = "解禁", danger = false, onClick = onUnban)
            } else {
                ActionPill(text = "封禁", danger = true, onClick = { expandBan = !expandBan })
            }
        }
        // 展开的封禁档位（设计稿没有这一段，但它替代了原来常驻的「删除」，
        // 是既有能力，不能因为重排设计稿就丢掉）
        if (expandBan) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = KSpacing.sm)
                    .padding(bottom = KSpacing.sm),
                horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("封禁时长", style = KType.footnote, color = c.textMuted)
                listOf(1, 7, 30, 365).forEach { days ->
                    Box(
                        modifier = Modifier
                            .clip(RoundedCornerShape(KRadius.pill))
                            .background(c.dangerSoft)
                            .border(1.dp, c.danger, RoundedCornerShape(KRadius.pill))
                            .clickable { onBan(days); expandBan = false }
                            .padding(horizontal = KSpacing.sm, vertical = KSpacing.xxs),
                    ) {
                        Text("$days 天", style = KType.footnote, color = c.danger)
                    }
                }
                Text(
                    "取消",
                    style = KType.footnote,
                    color = c.textMuted,
                    modifier = Modifier.clickable { expandBan = false },
                )
            }
        }
    }
}

/** 帖子卡片：首图缩略图（无图退化占位）+ 标题/「作者 · 时间 · N 条评论」+ 删除药丸 */
@Composable
private fun PostCardRow(
    row: AdminPostRow,
    cover: String?,
    onDelete: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = KTheme.colors
    AdminRowCard(modifier = modifier) {
        ThumbBox(cover = cover)
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(
                text = row.title.ifBlank { row.description }.ifBlank { "(无标题)" },
                style = KType.subtitle,
                color = c.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = "${row.username} · ${relativeTime(row.createdAt)} · ${row.commentCount} 条评论",
                style = KType.caption,
                color = c.textMuted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        ActionPill(text = "删除", danger = true, onClick = onDelete)
    }
}

/** 公告卡片：喇叭图标块 + 标题/「作者 · 时间 · 范围」+ 删除药丸 */
@Composable
private fun AnnouncementCardRow(
    row: AdminAnnouncementRow,
    onDelete: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = KTheme.colors
    AdminRowCard(modifier = modifier) {
        // 公告没有配图，设计稿这里是一个浅绿方块 + 喇叭图标
        Box(
            modifier = Modifier
                .size(56.dp)
                .clip(RoundedCornerShape(KRadius.control))
                .background(c.surfaceSubtle),
            contentAlignment = Alignment.Center,
        ) {
            Glyph(tint = c.accent, kind = GlyphKind.Megaphone, size = 22.dp)
        }
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(
                text = row.title,
                style = KType.subtitle,
                color = c.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = buildString {
                    append("@${row.targetUsername ?: "管理员"}")
                    append(" · ")
                    append(relativeTime(row.createdAt))
                    append(" · ")
                    append(if (row.targetUserId == null) "全部用户" else "指定用户")
                },
                style = KType.caption,
                color = c.textMuted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        ActionPill(text = "删除", danger = true, onClick = onDelete)
    }
}

/**
 * 帖子缩略图（56dp 圆角方块）。
 *
 * 没有图时**不画空方块**（在列表里看起来像"加载失败"），而是退化成 `surfaceSubtle` 底 ——
 * 与设计稿一致：设计稿里三行都是浅绿占位块，说明它本来就没打算显示真图。
 * 有图时直出首图（更实用）；两者尺寸与圆角完全一致，不会因为有没有图而跳行高。
 */
@Composable
private fun ThumbBox(cover: String?) {
    val c = KTheme.colors
    Box(
        modifier = Modifier
            .size(56.dp)
            .clip(RoundedCornerShape(KRadius.control))
            .background(c.surfaceSubtle),
        contentAlignment = Alignment.Center,
    ) {
        if (cover != null) {
            AsyncImage(
                model = cover,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        }
    }
}

/** 时间戳是不是今天（帖子段的"今日新增"用；解析失败按"不是今天"处理，宁少不多） */
private fun isToday(iso: String, nowMillis: Long = System.currentTimeMillis()): Boolean {
    if (iso.isBlank()) return false
    val parsed = runCatching { java.time.Instant.parse(iso).toEpochMilli() }.getOrNull() ?: return false
    val zone = java.time.ZoneId.systemDefault()
    val a = java.time.Instant.ofEpochMilli(parsed).atZone(zone).toLocalDate()
    val b = java.time.Instant.ofEpochMilli(nowMillis).atZone(zone).toLocalDate()
    return a == b
}
