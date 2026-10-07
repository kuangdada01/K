package top.kuangdada.k.nativeapp.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import top.kuangdada.k.core.data.AdminRepository
import top.kuangdada.k.core.data.ApiResult
import top.kuangdada.k.core.data.displayMessage
import top.kuangdada.k.core.data.model.AnnouncementDto
import top.kuangdada.k.core.data.relativeTime
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
 * 公告（设计稿「公告」——高亮消息 tab；消息页「通知」分段的数据源）
 * ============================================================
 * 设计稿要点：
 *  · **卡片式列表**；
 *  · 标题 **17px Bold** / 时间 **12px muted** / 正文 **15px 行高 24px**；
 *  · **未读数用 `--accent` 文字放在页头右侧**。
 *
 * 认证：`GET /api/announcements` **需要登录**（authMiddleware）—— 与 `/api/posts` 那种
 * 公开接口不同，所以未登录时要给明确的引导而不是空列表。
 *
 * 已读标记：`PUT /api/announcements/:id/read`（服务端只做单条已读，没有"全部已读"）。
 */
@Composable
fun AnnouncementsScreen(
    repo: AdminRepository,
    isLoggedIn: Boolean,
    onBack: () -> Unit,
    onRequireLogin: () -> Unit,
) {
    val c = KTheme.colors
    val scope = rememberCoroutineScope()

    var items by remember { mutableStateOf<List<AnnouncementDto>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var toast by remember { mutableStateOf<String?>(null) }
    var unread by remember { mutableIntStateOf(0) }

    suspend fun load() {
        loading = true
        error = null
        when (val r = repo.myAnnouncements()) {
            is ApiResult.Success -> {
                items = r.data
                unread = r.data.count { !it.read }
            }
            is ApiResult.Failure -> error = r.error.displayMessage
        }
        loading = false
    }

    LaunchedEffect(isLoggedIn) { if (isLoggedIn) load() else loading = false }

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
                    // 这个接口是 authMiddleware（必须登录），不是公开接口
                    description = "公告接口要求登录（/api/announcements 是 authMiddleware，不是 optionalAuth）",
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
                // 这里**不能**有 top：页头那一项自己挂 kTopBar（见 KWidgets.kTopBar）。
                // 原来这档 16dp 叠在页头的 statusBarsPadding 上，本页顶栏被压到状态栏下 24dp。
                bottom = KDimens.navScrollPadding + KSpacing.lg,
            ),
            verticalArrangement = Arrangement.spacedBy(KSpacing.sm),
        ) {
            item {
                Column(
                    // 顶栏垂直位置的唯一来源（状态栏安全区 + KSpacing.xs）
                    modifier = Modifier.kTopBar(),
                    verticalArrangement = Arrangement.spacedBy(KSpacing.sm),
                ) {
                    KPageHeader(
                        title = "公告",
                        subtitle = if (items.isEmpty()) null else "共 ${items.size} 条",
                        trailing = {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
                            ) {
                                // 未读数用 accent 文字放页头右侧（设计稿明确要求）
                                if (unread > 0) {
                                    Text(
                                        text = "$unread 条未读",
                                        style = KType.footnote,
                                        color = c.accent,
                                    )
                                }
                                KButton("返回", onClick = onBack, variant = KButtonVariant.Ghost)
                            }
                        },
                    )
                }
            }

            when {
                loading && items.isEmpty() -> item {
                    Box(Modifier.fillMaxWidth().padding(KSpacing.xxl), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(color = c.accent)
                    }
                }

                error != null && items.isEmpty() -> item {
                    KPlaceholder(
                        kind = KPlaceholderKind.Error,
                        title = "公告加载失败",
                        description = error,
                        action = { KButton("重试", onClick = { scope.launch { load() } }) },
                    )
                }

                items.isEmpty() -> item {
                    KPlaceholder(
                        kind = KPlaceholderKind.Empty,
                        title = "还没有公告",
                        description = "管理员发布后会出现在这里",
                    )
                }

                else -> items(items, key = { it.id }) { a ->
                    AnnouncementCard(
                        row = a,
                        onRead = {
                            if (a.read) return@AnnouncementCard
                            scope.launch {
                                when (val r = repo.markAnnouncementRead(a.id)) {
                                    is ApiResult.Success -> {
                                        items = items.map {
                                            if (it.id == a.id) it.copy(isRead = 1) else it
                                        }
                                        unread = items.count { !it.read }
                                    }
                                    is ApiResult.Failure -> toast = r.error.displayMessage
                                }
                            }
                        },
                        // 已读状态变化 / 新公告插入时的重排走弹簧（M4）
                        modifier = Modifier.animateItem(),
                    )
                }
            }
        }

        if (toast != null) {
            KToast(text = toast!!, onDismiss = { toast = null }, modifier = Modifier.align(Alignment.BottomCenter))
        }
    }
}

/**
 * 公告卡片。
 *
 * 排版按设计稿：标题 17px Bold / 时间 12px muted / 正文 **15px 行高 24px**。
 * 未读的卡片左侧加一条 accent 竖条（比整卡变色更克制，也不会破坏"卡片式列表"的统一观感）。
 *
 * **无阴影**（09-18 用户要求，与消息页的公告入口/会话/通知行同一条规矩）：
 * 卡片是实心 `surface`，落在 `bgPage` 上的明度差已经够；列表里上下贴着的卡片再各自投影，
 * 会在缝隙处叠出一圈灰边。
 */
@Composable
private fun AnnouncementCard(row: AnnouncementDto, onRead: () -> Unit, modifier: Modifier = Modifier) {
    val c = KTheme.colors
    androidx.compose.material3.Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(KRadius.card),
        color = c.surface,
        onClick = onRead,
    ) {
        Row(modifier = Modifier.fillMaxWidth()) {
            // 未读左侧竖条：用 fillMaxHeight 跟随行高，避免写死高度（写死会在长文公告上露出来）
            if (!row.read) {
                Box(
                    modifier = Modifier
                        .width(3.dp)
                        .fillMaxHeight()
                        .background(c.accent),
                )
            }
            Column(
                modifier = Modifier.padding(KSpacing.md),
                verticalArrangement = Arrangement.spacedBy(KSpacing.xxs),
            ) {
                Text(
                    text = row.title,
                    style = KType.subtitle, // 17px Bold
                    color = c.textPrimary,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(KSpacing.xs)) {
                    Text(
                        text = row.fromUsername ?: "管理员",
                        style = KType.footnote, // 12px
                        color = c.textMuted,
                    )
                    Text(
                        text = relativeTime(row.createdAt),
                        style = KType.footnote,
                        color = c.textMuted,
                    )
                    if (row.targetUserId != null) {
                        Text("定向", style = KType.footnote, color = c.accent)
                    }
                }
                Text(
                    text = row.content,
                    // 正文 15px **行高 24px**（设计稿 §3.3.1 公告页明确）
                    style = KType.body.copy(lineHeight = 24.sp),
                    color = c.textSecondary,
                )
            }
        }
    }
}
