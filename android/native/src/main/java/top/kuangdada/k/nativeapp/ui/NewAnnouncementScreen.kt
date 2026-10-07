package top.kuangdada.k.nativeapp.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import top.kuangdada.k.core.data.AdminRepository
import top.kuangdada.k.core.data.ApiResult
import top.kuangdada.k.core.data.displayMessage
import top.kuangdada.k.core.data.model.AdminUserRow
import top.kuangdada.k.core.designsystem.component.KButton
import top.kuangdada.k.core.designsystem.component.KTextField
import top.kuangdada.k.core.designsystem.theme.KRadius
import top.kuangdada.k.core.designsystem.theme.KSpacing
import top.kuangdada.k.core.designsystem.theme.KTheme
import top.kuangdada.k.core.designsystem.theme.KType

/**
 * ============================================================
 * 新建公告（设计稿「新建公告」）
 * ============================================================
 * 自上而下：
 *  · 顶栏：圆形返回钮 + 「新建公告」；
 *  · 「标题」单行框（设计稿里的示例文案是标题，**不是占位符** —— 这里用占位符"公告标题"）；
 *  · 「内容」多行框 + 右下角计数器（设计稿 68/1000）；
 *  · 「发送范围」两选项**单选卡**：
 *      · 全部用户 / 所有人都能在消息页看到
 *      · 指定用户 / 只发给一个指定账号，别人看不到
 *    选中项 = `accent` 2dp 描边 + 实心圆点；未选中 = `surface` 底 + 描边 + 空心圆。
 *  · 说明文案：「发布后不可编辑，只能删除；发送范围发布后也不能改。」；
 *  · 底部全宽「发布」。
 *
 * 三条与服务端对齐的约束（改之前先看 shared/src/schemas/admin.ts 的 announcementSchema）：
 *  1. `title` 1–200、`content` 1–5000。**设计稿只画了 1000 的计数器**，
 *     这里就按设计稿卡 1000（比服务端严，服务端不可能因此拒绝）；
 *  2. `target_user_id` 为空 = 全体公告（服务端 notifyAllUsers），非空 = 定向 ——
 *     所以"指定用户"必须真的拿到一个 id，不能拿用户名糊过去；
 *  3. 发布后**不能编辑**（服务端没有 PUT），只能删。所以这里是"发布即返回列表"。
 */
@Composable
fun NewAnnouncementScreen(
    repo: AdminRepository,
    onBack: () -> Unit,
    /** 发布成功（返回列表并刷新） */
    onCreated: () -> Unit,
) {
    val c = KTheme.colors
    val scope = rememberCoroutineScope()

    var title by remember { mutableStateOf("") }
    var content by remember { mutableStateOf("") }
    // 发送范围：true = 指定用户（设计稿第二个选项），false = 全部用户（默认）
    var toSpecific by remember { mutableStateOf(false) }
    var targetQuery by remember { mutableStateOf("") }
    var target by remember { mutableStateOf<AdminUserRow?>(null) }
    var candidates by remember { mutableStateOf<List<AdminUserRow>>(emptyList()) }
    var searching by remember { mutableStateOf(false) }
    var publishing by remember { mutableStateOf(false) }
    var toast by remember { mutableStateOf<String?>(null) }

    /**
     * 指定用户搜索：**必须走服务端** `/api/admin/users/search`。
     *
     * 为什么不能像早先那样"只接受数字 ID"：设计稿的交互是"选一个账号"，
     * 要求管理员先去别处查出 ID 再回来手输，等于把这一步推给用户；
     * 而且输入按昵称找人是这里唯一自然的操作。服务端这个端点既支持用户名模糊、
     * 也支持按 id 精确查，正好覆盖两种用法。
     */
    LaunchedEffect(targetQuery, toSpecific) {
        if (!toSpecific || targetQuery.isBlank()) {
            candidates = emptyList()
            return@LaunchedEffect
        }
        searching = true
        // 输入防抖：每敲一个字就发请求既费流量也容易被服务端限流
        kotlinx.coroutines.delay(300)
        when (val r = repo.searchUsers(targetQuery.trim())) {
            is ApiResult.Success -> candidates = r.data
            is ApiResult.Failure -> candidates = emptyList()
        }
        searching = false
    }

    Box(modifier = Modifier.fillMaxSize().background(c.bgPage)) {
        Column(modifier = Modifier.fillMaxSize()) {
            // ---- 顶栏 ----
            // 垂直位置走全 App 同一条 kTopBar（见 KWidgets.kTopBar），这里只写左右与下边距
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .kTopBar()
                    .padding(start = KSpacing.md, end = KSpacing.md, bottom = KSpacing.xs),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(KSpacing.sm),
            ) {
                KIconButton(icon = GlyphKind.ChevronLeft, onClick = onBack)
                Text("新建公告", style = KType.subtitle, color = c.textPrimary)
            }

            Column(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = KSpacing.md)
                    .padding(top = KSpacing.sm, bottom = KSpacing.xl),
                verticalArrangement = Arrangement.spacedBy(KSpacing.lg),
            ) {
                // ---- 标题 ----
                Column(verticalArrangement = Arrangement.spacedBy(KSpacing.xs)) {
                    FieldLabel("标题")
                    KTextField(
                        value = title,
                        onValueChange = { title = it.take(TITLE_MAX) },
                        singleLine = true,
                        enabled = !publishing,
                        placeholder = "公告标题",
                    )
                }

                // ---- 内容（多行 + 计数器）----
                Column(verticalArrangement = Arrangement.spacedBy(KSpacing.xs)) {
                    FieldLabel("内容")
                    AnnouncementContentField(
                        value = content,
                        onValueChange = { content = it.take(CONTENT_MAX) },
                        enabled = !publishing,
                    )
                }

                // ---- 发送范围 ----
                Column(verticalArrangement = Arrangement.spacedBy(KSpacing.xs)) {
                    FieldLabel("发送范围")
                    ScopeOption(
                        selected = !toSpecific,
                        title = "全部用户",
                        subtitle = "所有人都能在消息页看到",
                        onClick = { toSpecific = false },
                    )
                    ScopeOption(
                        selected = toSpecific,
                        title = "指定用户",
                        subtitle = "只发给一个指定账号，别人看不到",
                        onClick = { toSpecific = true },
                    )

                    // 选了"指定用户"才出现的选择器：搜索 → 点一个账号定下来
                    if (toSpecific) {
                        Column(verticalArrangement = Arrangement.spacedBy(KSpacing.xs)) {
                            KTextField(
                                value = targetQuery,
                                onValueChange = {
                                    targetQuery = it.take(30)
                                    // 改了关键词就把已选的人清掉：否则会出现"搜的是别人、
                                    // 选中的还是上一个人"这种错发范围
                                    target = null
                                },
                                singleLine = true,
                                enabled = !publishing,
                                placeholder = "搜索昵称 / @用户名",
                                shape = RoundedCornerShape(KRadius.pill),
                            )
                            when {
                                searching -> Text("搜索中…", style = KType.caption, color = c.textMuted)
                                target != null -> {
                                    // 已选中：只显示这一个，避免候选列表继续干扰
                                    PickedUserRow(
                                        target = target!!,
                                        avatar = repo.avatarUrl(target!!.avatar),
                                        onClear = { target = null },
                                    )
                                }
                                candidates.isNotEmpty() -> candidates.forEach { u ->
                                    CandidateUserRow(
                                        user = u,
                                        avatar = repo.avatarUrl(u.avatar),
                                        onClick = { target = u },
                                    )
                                }
                                targetQuery.isNotBlank() -> Text(
                                    "没有找到匹配的账号",
                                    style = KType.caption,
                                    color = c.textMuted,
                                )
                                else -> Text(
                                    "输入昵称或 @用户名，从结果里选一个账号",
                                    style = KType.caption,
                                    color = c.textMuted,
                                )
                            }
                        }
                    }
                }
            }

            // ---- 底部发布 ----
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(c.bgPage)
                    .navigationBarsPadding()
                    .padding(horizontal = KSpacing.md, vertical = KSpacing.md),
            ) {
                KButton(
                    text = if (publishing) "发布中…" else "发布",
                    onClick = {
                        if (publishing) return@KButton
                        when {
                            title.isBlank() -> toast = "请填写标题"
                            content.isBlank() -> toast = "请填写内容"
                            // 选了"指定用户"却还没定人：不能默默降级成全体公告（那是发错范围）
                            toSpecific && target == null -> toast = "请选择要接收公告的账号"
                            else -> scope.launch {
                                publishing = true
                                toast = null
                                val r = repo.createAnnouncement(
                                    title = title.trim(),
                                    content = content.trim(),
                                    targetUserId = if (toSpecific) target?.id else null,
                                )
                                when (r) {
                                    is ApiResult.Success -> onCreated()
                                    is ApiResult.Failure -> toast = r.error.displayMessage
                                }
                                publishing = false
                            }
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                    cornerRadius = KRadius.control,
                )
            }
        }

        if (toast != null) {
            KToast(text = toast!!, onDismiss = { toast = null }, modifier = Modifier.align(Alignment.BottomCenter))
        }
    }
}

/** 标题上限 —— 与服务端 schema 同值（shared/src/schemas/admin.ts：200） */
private const val TITLE_MAX = 200

/**
 * 内容上限 —— **按设计稿的计数器**（1000），刻意小于服务端的 5000。
 * 计数器上的数字就是这个值，改它必须同时改设计稿的文案。
 */
private const val CONTENT_MAX = 1000

/** 表单分组标签（与「编辑资料」页同一档：15 Medium） */
@Composable
private fun FieldLabel(text: String) {
    Text(text = text, style = KType.bodyStrong, color = KTheme.colors.textPrimary)
}

/**
 * 公告内容多行框：外层容器画底与描边，内层 `Plain` 输入，计数器贴框内右下角。
 *
 * `minLines = BLANK_LINES` 让空框也占 4 行 —— 与「编辑资料」的简介框同一条经验：
 * `BasicTextField` 按自己的内容与 `minLines` 撑高，给外层加高度没用。
 */
@Composable
private fun AnnouncementContentField(
    value: String,
    onValueChange: (String) -> Unit,
    enabled: Boolean,
) {
    val c = KTheme.colors
    val shape = RoundedCornerShape(KRadius.control)
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val borderColor = if (focused) c.focusRing else c.borderStrong
    val borderWidth = if (focused) 2.dp else 1.dp

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(c.surface)
            .border(borderWidth, borderColor, shape),
        contentAlignment = Alignment.TopStart,
    ) {
        KTextField(
            value = value,
            onValueChange = onValueChange,
            singleLine = false,
            enabled = enabled,
            variant = top.kuangdada.k.core.designsystem.component.KTextFieldVariant.Plain,
            placeholder = "公告内容",
            minLines = 4,
            interactionSource = interaction,
            modifier = Modifier
                .fillMaxWidth()
                // 右侧给计数器留出宽度
                .padding(
                    start = KSpacing.md,
                    end = 88.dp,
                    top = KSpacing.sm,
                    bottom = KSpacing.sm,
                ),
        )
        Text(
            text = "${value.length}/$CONTENT_MAX",
            style = KType.caption,
            color = c.textMuted,
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .padding(end = KSpacing.md, bottom = KSpacing.xs),
        )
    }
}

/**
 * 发送范围单选卡。
 *
 * 形态（对齐设计稿）：整行卡片 + 左侧单选圆点 + 标题/副标题；选中项 `accent` 2dp 描边、
 * 圆点是**实心 accent 圆 + 中间留白点**，未选中是 `borderStrong` 空心圆、`surface` 底。
 */
@Composable
private fun ScopeOption(
    selected: Boolean,
    title: String,
    subtitle: String,
    onClick: () -> Unit,
) {
    val c = KTheme.colors
    val shape = RoundedCornerShape(KRadius.control)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(c.surface)
            .border(
                width = if (selected) 2.dp else 1.dp,
                color = if (selected) c.accent else c.borderStrong,
                shape = shape,
            )
            .clickable(onClick = onClick)
            .padding(horizontal = KSpacing.md, vertical = KSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(KSpacing.sm),
    ) {
        // 单选圆点：外圈 20dp。选中 = accent 外环 + accent 实心内点；未选中 = textMuted 空心
        Box(
            modifier = Modifier
                .size(20.dp)
                .clip(CircleShape)
                .border(
                    width = if (selected) 6.dp else 2.dp,
                    color = if (selected) c.accent else c.borderStrong,
                    shape = CircleShape,
                ),
            contentAlignment = Alignment.Center,
        ) {
            if (selected) {
                // 内点用页底色，形成"实心环 + 白心"的观感（设计稿就是这个样子）
                Box(
                    modifier = Modifier
                        .size(6.dp)
                        .clip(CircleShape)
                        .background(c.surface),
                )
            }
        }
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = KType.subtitle, color = c.textPrimary)
            Text(subtitle, style = KType.caption, color = c.textMuted)
        }
    }
}

/** 候选账号行（搜索结果）：头像 + 昵称 + @用户名 + 角色，点了就选中 */
@Composable
private fun CandidateUserRow(user: AdminUserRow, avatar: String?, onClick: () -> Unit) {
    val c = KTheme.colors
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(KRadius.row))
            .background(c.surface)
            .clickable(onClick = onClick)
            .padding(horizontal = KSpacing.md, vertical = KSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(KSpacing.sm),
    ) {
        Avatar(
            url = avatar,
            name = user.username,
            size = 36.dp,
            glyph = GlyphKind.User,
            bg = c.surfaceSubtle,
            fg = c.accent,
        )
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(user.username, style = KType.body, color = c.textPrimary)
            Text(
                text = "${if (user.isAdmin) "管理员" else "成员"} · @${user.username}",
                style = KType.footnote,
                color = c.textMuted,
            )
        }
    }
}

/** 已选中的接收账号：明确显示"发给谁"，并给一个清除入口 */
@Composable
private fun PickedUserRow(target: AdminUserRow, avatar: String?, onClear: () -> Unit) {
    val c = KTheme.colors
    val shape = RoundedCornerShape(KRadius.row)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(c.surface)
            .border(1.dp, c.accent, shape)
            .padding(horizontal = KSpacing.md, vertical = KSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(KSpacing.sm),
    ) {
        Avatar(
            url = avatar,
            name = target.username,
            size = 36.dp,
            glyph = GlyphKind.User,
            bg = c.surfaceSubtle,
            fg = c.accent,
        )
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(target.username, style = KType.body, color = c.textPrimary)
            Text("将只发给这个账号（#${target.id}）", style = KType.footnote, color = c.accent)
        }
        Text(
            text = "重选",
            style = KType.caption,
            color = c.textMuted,
            modifier = Modifier.clickable(onClick = onClear),
        )
    }
}
