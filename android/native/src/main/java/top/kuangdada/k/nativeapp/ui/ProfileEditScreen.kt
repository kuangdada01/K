package top.kuangdada.k.nativeapp.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import top.kuangdada.k.core.data.ApiResult
import top.kuangdada.k.core.data.SessionRepository
import top.kuangdada.k.core.data.UserRepository
import top.kuangdada.k.core.data.displayMessage
import top.kuangdada.k.core.data.image.ImageCompressor
import top.kuangdada.k.core.data.model.User
import top.kuangdada.k.core.designsystem.component.KButton
import top.kuangdada.k.core.designsystem.component.KTextField
import top.kuangdada.k.core.designsystem.component.KTextFieldVariant
import top.kuangdada.k.core.designsystem.theme.KDimens
import top.kuangdada.k.core.designsystem.theme.KRadius
import top.kuangdada.k.core.designsystem.theme.KSpacing
import top.kuangdada.k.core.designsystem.theme.KTheme
import top.kuangdada.k.core.designsystem.theme.KType

/**
 * ============================================================
 * 编辑资料（设计稿「编辑资料」）
 * ============================================================
 * 设计稿形态（自上而下，两套主题只差颜色，布局完全一致）：
 *  · 顶栏：左上 36px 圆形返回钮 + 「编辑资料」；
 *  · 头像区：**大圆头像（约占屏宽 1/4）+ 下方「更换头像」的 accent 文字**，整块可点；
 *  · 「昵称」标签 + 单行输入框（设计稿实测 60px 高 @ 780px 宽 ≈ 44dp，正好是全站触控目标下限）；
 *  · 「个人简介」标签 + **多行框**，右下角贴一个 `26/200` 计数器；
 *  · 「邮箱」标签 + **只读框**：设计稿里它的底色比页底浅、文字是弱化灰 —— 与上面两个可编辑框
 *    形成明确的"这一项不能改"的对比（邮箱是登录/找回密码的凭据，改它要走验证流程，本页不支持）；
 *  · 一行说明「昵称与简介随时可调整；邮箱用于登录与找回密码。」；
 *  · 底部全宽「保存」（实心 accent + 圆角 10，与设计稿一致，**不是胶囊**）。
 *
 * 三条契约（写死在这个文件里，改之前先看服务端）：
 *  1. 界面上的「昵称」= 服务端 `username`（PUT /api/users/me）。只有一个列，
 *     登录/注册/帖子署名共用，所以**重名会被服务端拒掉**（400「用户名已被占用」），
 *     这里原样把服务端文案弹给用户，不自造提示。
 *  2. 「邮箱」在 `GET /api/users/:id`（公开资料）里**根本不存在**，只有 `/auth/me` 与
 *     更新接口才返回 —— 所以这一项的值只能来自会话里的登录用户，取不到就整行不画
 *     （比画一个空框让人以为"邮箱丢了"好）。
 *  3. 简介上限：服务端 schema 是 500，但**设计稿的计数器写的是 200**，这里按设计稿
 *     卡在 200（文案与截断都以 200 为准，服务端不可能因此拒绝）。
 *
 * 保存/换头像成功后必须把服务端返回的用户对象交回 [SessionRepository.applyUser]：
 * 否则主页与帖子卡片上的署名、头像还是旧值（内存态不会自己刷新）。
 */
@Composable
fun ProfileEditScreen(
    users: UserRepository,
    session: SessionRepository,
    /** 会话里的登录用户（昵称/简介的首帧值 + 只读邮箱的来源）。null = 未登录 */
    user: User?,
    onBack: () -> Unit,
    onSaved: () -> Unit,
    onRequireLogin: () -> Unit,
) {
    val c = KTheme.colors
    val baseUrl = session.api.baseUrl

    // 用服务端返回的最新值做初值：进页面时它一定比 UserProfile 新（那是上一次拉取的结果）
    var nickname by remember { mutableStateOf(user?.username.orEmpty()) }
    var bio by remember { mutableStateOf(user?.bio.orEmpty()) }
    // 当前头像地址（换头像成功后立即换成服务端给的新地址，不必等重进页面）
    var avatarUrl by remember { mutableStateOf(resolveAvatar(user?.avatar, baseUrl)) }

    var saving by remember { mutableStateOf(false) }
    var uploading by remember { mutableStateOf(false) }
    /**
     * 这一次进来有没有换过头像。
     *
     * 为什么必须单独记：换头像是**选完就立刻上传生效**的（`POST /api/users/avatar`
     * 是独立接口，服务端当场落库），「保存」按钮管不到它。不记这个标记的话，
     * "只换了头像、没动昵称/简介"会被 [dirty] 判成"什么都没改"，点保存弹「内容没有变化」
     * —— 文案是错的，用户会以为头像没保存成功（实测反馈）。
     */
    var avatarChanged by remember { mutableStateOf(false) }
    var toast by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    /**
     * 选头像：系统 Photo Picker（**不要任何存储权限**）。
     *
     * 选中后先本地压一道再上传，两个理由：
     *  · 手机原图动辄 5–10MB，弱网下上传体验极差（服务端最终也只留长边 512）；
     *  · 服务端按「扩展名 + mimetype」双校验，[ImageCompressor.compressToFile] 的产物
     *    固定是 `.jpg` + jpeg —— 正是最不容易被判成非法类型的那种。
     * 压缩返回 null（不需要压 / 格式是 GIF / 压缩失败）时**回退原图**：
     * 压缩只是优化，绝不能变成"换不了头像"。
     */
    val pickAvatar = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia()
    ) { uri ->
        if (uri == null || uploading) return@rememberLauncherForActivityResult
        scope.launch {
            uploading = true
            toast = null
            // 三步都在 IO 上：拷 content://（Photo Picker 的读权限是临时的）→ 必要时本地压 → multipart 上传
            val selected: AvatarPick = withContext(Dispatchers.IO) {
                val compressed = ImageCompressor.compressToFile(context, uri, purpose = "avatar")
                if (compressed != null) {
                    // compressToFile 的产物固定是 .jpg + jpeg，正好是服务端最不挑的一种
                    val uploaded = users.uploadAvatar(compressed, mimeType = "image/jpeg")
                    compressed.delete()
                    AvatarPick.Uploaded(uploaded)
                } else {
                    // 不需要压（小图）/ 格式是 GIF / 压缩失败 → 回退原图，扩展名与 MIME 一起带过去
                    val picked = copyPickedImageToCache(context, uri, prefix = "avatar")
                    if (picked == null) {
                        AvatarPick.Unreadable
                    } else {
                        val uploaded = users.uploadAvatar(picked.file, mimeType = picked.mimeType)
                        picked.file.delete()
                        AvatarPick.Uploaded(uploaded)
                    }
                }
            }
            when (selected) {
                AvatarPick.Unreadable -> toast = "读取图片失败，请换一张试试"
                is AvatarPick.Uploaded -> when (val r = selected.result) {
                    is ApiResult.Success -> {
                        avatarUrl = resolveAvatar(r.data.avatar, baseUrl)
                        // 头像换了要立刻反映到全 App（帖子卡片、聊天页、主页）
                        session.applyUser(r.data)
                        avatarChanged = true
                        toast = "头像已更新"
                    }
                    is ApiResult.Failure -> toast = r.error.displayMessage
                }
            }
            uploading = false
        }
    }

    val nicknameTrimmed = nickname.trim()
    // 只用来判断"要不要真的发请求"（保存按钮点下去时用），**不再用来禁用按钮** ——
    // 见下面保存按钮那段注释：禁用态会让按钮变成设计稿之外的浅灰色
    val dirty = nicknameTrimmed != user?.username.orEmpty() || bio != user?.bio.orEmpty()

    Box(modifier = Modifier.fillMaxSize().background(c.bgPage)) {
        if (user == null) {
            // 资料编辑要登录态：邮箱、以及"改的是谁"都依赖它
            Column(
                modifier = Modifier.fillMaxSize(),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                top.kuangdada.k.core.designsystem.component.KPlaceholder(
                    kind = top.kuangdada.k.core.designsystem.component.KPlaceholderKind.Empty,
                    title = "未登录",
                    description = "登录后才能编辑资料",
                    action = { KButton("去登录", onClick = onRequireLogin) },
                )
            }
            return@Box
        }

        Column(modifier = Modifier.fillMaxSize()) {
            // ---- 顶栏：圆形返回钮 + 页面标题（与帖子详情/聊天页同款，见 PostDetailScreen）----
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
                Text("编辑资料", style = KType.subtitle, color = c.textPrimary)
            }

            Column(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = KSpacing.md)
                    .padding(top = KSpacing.md, bottom = KSpacing.xl),
                verticalArrangement = Arrangement.spacedBy(KSpacing.lg),
            ) {
                // ---- 头像 + 更换头像（整块可点）----
                Column(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Box(
                        modifier = Modifier
                            .clip(CircleShape)
                            .clickable(
                                interactionSource = remember { MutableInteractionSource() },
                                indication = null,
                                enabled = !uploading,
                                onClickLabel = "更换头像",
                            ) {
                                pickAvatar.launch(
                                    PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                                )
                            },
                        contentAlignment = Alignment.Center,
                    ) {
                        Avatar(
                            url = avatarUrl,
                            name = nickname.ifBlank { "我" },
                            // 设计稿实测：头像直径 ≈ 屏宽的 1/4（190/780）→ 390pt 上约 95dp
                            size = 96.dp,
                            // 无头像时设计稿画的是**人像图标**（不是名字首字），
                            // 这里用 glyph 把人像补齐
                            glyph = GlyphKind.User,
                            bg = c.surfaceSubtle,
                            fg = c.accent,
                        )
                        if (uploading) {
                            // 上传中：同一位置上压一层页底色 + 转圈（不改变头像尺寸，避免布局跳动）
                            Box(
                                modifier = Modifier
                                    .size(96.dp)
                                    .clip(CircleShape)
                                    .background(c.bgPage.copy(alpha = 0.72f)),
                                contentAlignment = Alignment.Center,
                            ) {
                                CircularProgressIndicator(color = c.accent, modifier = Modifier.size(28.dp))
                            }
                        }
                    }
                    Spacer(Modifier.height(KSpacing.xs))
                    Text(
                        text = if (uploading) "上传中…" else "更换头像",
                        style = KType.body,
                        color = c.accent,
                        modifier = Modifier.clickable(enabled = !uploading) {
                            pickAvatar.launch(
                                PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                            )
                        },
                    )
                }

                // ---- 昵称 ----
                Column(verticalArrangement = Arrangement.spacedBy(KSpacing.xs)) {
                    FieldLabel("昵称")
                    KTextField(
                        value = nickname,
                        // 直接在这里截断：挨个分支去拦"超长"只会让用户看到字打不进去却没解释
                        onValueChange = { nickname = it.take(NICKNAME_MAX) },
                        singleLine = true,
                        enabled = !saving,
                        keyboardOptions = KeyboardOptions(
                            capitalization = KeyboardCapitalization.None,
                            imeAction = ImeAction.Next,
                        ),
                    )
                }

                // ---- 个人简介（多行 + 右下角计数器）----
                Column(verticalArrangement = Arrangement.spacedBy(KSpacing.xs)) {
                    FieldLabel("个人简介")
                    BioField(
                        value = bio,
                        onValueChange = { bio = it.take(BIO_MAX) },
                        limit = BIO_MAX,
                        enabled = !saving,
                    )
                }

                // ---- 邮箱（只读）----
                // 取不到邮箱（公开资料接口不带这个字段，只有 /auth/me 有）时整块不画
                val email = user.email.takeIf { it.isNotBlank() }
                if (email != null) {
                    Column(verticalArrangement = Arrangement.spacedBy(KSpacing.xs)) {
                        FieldLabel("邮箱")
                        ReadOnlyField(email)
                    }
                }

                Text(
                    text = "昵称与简介随时可调整；邮箱用于登录与找回密码。",
                    style = KType.caption,
                    color = c.textMuted,
                )
            }

            // ---- 底部保存 ----
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(c.bgPage)
                    .navigationBarsPadding()
                    .padding(horizontal = KSpacing.md, vertical = KSpacing.md),
            ) {
                KButton(
                    text = if (saving) "保存中…" else "保存",
                    /**
                     * **不做 `enabled = 有改动`**：`KButton` 的禁用态是浅灰面 + 弱化字
                     * （[top.kuangdada.k.core.designsystem.theme.KColors.disabledSurface]），
                     * 而设计稿上这个按钮**恒为深绿实心**。进页面还没改任何东西时按钮变灰，
                     * 与设计稿直接对不上（用户实测反馈："保存按钮应该是深绿色背景"）。
                     *
                     * 改成"看起来永远可点、点下去再判"：这也是移动端表单的常规做法 ——
                     * 灰掉的按钮不给理由，用户只会怀疑"我是不是没填对"。
                     * 所以下面在 onClick 里分别给出"昵称不能为空"和"内容没有变化"的提示。
                     */
                    onClick = {
                        if (saving) return@KButton
                        when {
                            nicknameTrimmed.isEmpty() -> toast = "昵称不能为空"
                            /**
                             * 只换过头像（昵称/简介一个字没动）：头像在上传那一刻就已经存好了，
                             * 这里**直接返回主页**即可 —— 不要再弹「内容没有变化」让人以为白换了，
                             * 也不必发一个没有任何字段变化的 PUT。
                             */
                            !dirty && avatarChanged -> onSaved()
                            !dirty -> toast = "内容没有变化"
                            else -> scope.launch {
                                saving = true
                                toast = null
                                when (val r = users.updateProfile(nicknameTrimmed, bio)) {
                                    is ApiResult.Success -> {
                                        // 会话里的用户对象是署名/头像的唯一来源，必须就地替换
                                        session.applyUser(r.data)
                                        onSaved()
                                    }
                                    is ApiResult.Failure -> toast = r.error.displayMessage
                                }
                                saving = false
                            }
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                    // 设计稿的保存按钮是 10dp 圆角（不是胶囊）—— 与登录页主按钮同款
                    cornerRadius = KRadius.control,
                )
            }
        }

        if (toast != null) {
            KToast(
                text = toast!!,
                onDismiss = { toast = null },
                modifier = Modifier.align(Alignment.BottomCenter),
            )
        }
    }
}

/**
 * 只读字段（邮箱）。
 *
 * 为什么不用 `KTextField(enabled = false)`：那个组件的容器色与文字色是按"可编辑"定的
 * —— 底色是 `surface`（与上面两个可编辑框一模一样）、文字是 `textPrimary`（最实的一档），
 * 结果就是**三个框长得一样**，用户会去点邮箱框然后发现点不动。
 * 设计稿里这一项的底色比页底浅一档、文字是弱化灰，明显是"只读"的那一档；
 * `KColors` 没有「凹陷色」令牌（决策 Q6 取消了它），所以这里用 [KColors.surfaceSubtle]
 * ——它在浅色下 = surfaceSunken（比页底深）、深色下 = surfaceRaised（比页底浅），
 * 两套主题里都是"看得出是个面、但比可编辑的卡片弱一档"。
 *
 * 高度对齐可编辑框（[KDimens.minTouchTarget]），三行字段的节奏才一致。
 */
@Composable
private fun ReadOnlyField(value: String) {
    val c = KTheme.colors
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(KRadius.control))
            .background(c.surfaceSubtle)
            .defaultMinSize(minHeight = KDimens.minTouchTarget)
            .padding(horizontal = KSpacing.md, vertical = KSpacing.sm),
        contentAlignment = Alignment.CenterStart,
    ) {
        Text(
            text = value,
            style = KType.body,
            color = c.textMuted,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** 昵称上限 —— 与服务端 schema 同值（shared/src/schemas/user.ts：1-30 字符） */
private const val NICKNAME_MAX = 30

/**
 * 「选头像」这一步的结果。
 *
 * 为什么不用 `ApiResult<User>?` 表达：null 分不清**两种完全不同的失败** ——
 * 图片根本没读出来（要用户"换一张"）和网络上传失败（要用户"重试"）。
 * 文案给错，用户就会去做错误的动作。
 */
private sealed interface AvatarPick {
    /** 已经走到上传这一步（成功/失败都在里面） */
    data class Uploaded(val result: ApiResult<User>) : AvatarPick

    /** 本地读不出这张图（权限/流异常）—— 重试同一张也没用 */
    data object Unreadable : AvatarPick
}

/**
 * 简介上限 —— **按设计稿的计数器**（200），刻意小于服务端的 500。
 * 计数器上的数字就是这个值，改它必须同时改设计稿的文案。
 */
private const val BIO_MAX = 200

/** 表单标签：设计稿里它比正文更"实"，且与输入框贴得比字段之间更近（4/12） */
@Composable
private fun FieldLabel(text: String) {
    Text(text = text, style = KType.bodyStrong, color = KTheme.colors.textPrimary)
}

/**
 * 个人简介输入框：**只有一个框** —— 外层卡片（`surface` 底 + `borderStrong`/`focusRing` 描边
 * + 10dp 圆角，与昵称框同款），内层是无容器的多行输入，计数器固定在框内右下角。
 *
 * **内层必须显式传 `variant = Plain`**（这正是这个函数存在的最大理由）：
 * `KTextField` 默认是 `Outlined`，它会自己再画一层 `surface` 底 + 描边 + 内边距 ——
 * 套在外层这张卡里就成了「卡片里再套一个框」的两个框（用户实测反馈："个人简介的文本框
 * 是一个不是两个"）。`Plain` 完全不画容器（不裁剪/不填底/不描边/不留内边距），
 * 圆角与内边距全部由这里负责。
 *
 * 为什么不用 `KTextField(Outlined) + trailing` 来省掉外层卡片：计数器要停在**框内右下角**
 * 且不随正文行数浮动，而 `trailing` 是让整个输入区变成 Row 的右侧一列 —— 正文窄一截，
 * 计数器还会跟着 Row 的垂直对齐跑。
 */
@Composable
private fun BioField(
    value: String,
    onValueChange: (String) -> Unit,
    limit: Int,
    enabled: Boolean,
) {
    val c = KTheme.colors
    val shape = RoundedCornerShape(KRadius.control)

    // 正文一行到底占多高 —— 直接取字体自己的 lineHeight（KType.body 是 15sp/22sp）。
    // 只用来算「空框最少多高」，真正的行数由 minLines 交给 BasicTextField 自己处理。
    val localDensity = LocalDensity.current
    val lineHeightDp = with(localDensity) {
        val lh = KType.body.lineHeight
        (if (lh != TextUnit.Unspecified) lh else KType.body.fontSize * 1.5f).toDp()
    }

    // 聚焦反馈自己来：Plain 不带描边，也就没有"聚焦变 2dp 焦点环"这件事。
    // 取值与 KTextFieldContainer 的 Outlined 分支逐字对齐（1dp borderStrong → 2dp focusRing），
    // 这样简介框与昵称框的聚焦表现完全一致。
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val borderColor = if (focused) c.focusRing else c.borderStrong
    val borderWidth = if (focused) 2.dp else 1.dp

    // 点框内任何一处（包括正文区右侧与下方那两块空白）都要能聚焦 —— 否则"框看着很大，
    // 但只有文字那一小块能点"，是个很别扭的手感。
    val focusRequester = remember { FocusRequester() }

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(c.surface)
            .border(borderWidth, borderColor, shape)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                enabled = enabled,
                onClickLabel = "编辑个人简介",
            ) { focusRequester.requestFocus() },
        contentAlignment = Alignment.TopStart,
    ) {
        KTextField(
            value = value,
            onValueChange = onValueChange,
            singleLine = false,
            enabled = enabled,
            variant = KTextFieldVariant.Plain,
            placeholder = "介绍一下自己…",
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Default),
            // 把聚焦态交给外层：描边是外层画的，它得知道里面聚焦了没有
            interactionSource = interaction,
            focusRequester = focusRequester,
            /**
             * **空框至少 [BLANK_LINES] 行 —— 靠 `minLines`，不是靠给容器加高度。**
             *
             * 这是这一处反复改不对的根因：`BasicTextField` **按自己的内容与 `minLines` 撑高，
             * 完全不看外面套的高度约束**。所以给外层加 `height` / `heightIn` / `requiredHeight`
             * 全都无效（真机上量过：框高始终是"一行 + 内边距"，与不加时一模一样），
             * 高度只会撑起容器、把文字和计数器摊在上下两头，看起来仍是单行框。
             *
             * `minLines = 2` 才是真正让编辑区**空着也占两行**的那个开关。
             */
            minLines = BLANK_LINES,
            modifier = Modifier
                .fillMaxWidth()
                // 与 minLines 配套的最小高度：minLines 管"排版占几行"，这里保证容器也真的这么高。
                // 用 defaultMinSize 而不是 requiredHeight —— 后者会把框钉死，正文写多了不涨。
                .defaultMinSize(minHeight = lineHeightDp * BLANK_LINES)
                .padding(
                    start = KSpacing.md,
                    // 右侧给计数器让出一块宽度，避免长文本与它重叠
                    end = 56.dp,
                    top = KSpacing.sm,
                    bottom = KSpacing.sm,
                ),
        )

        // 计数器：正文区之下的那一行（不再与正文抢高度）
        Text(
            text = "${value.length}/$limit",
            style = KType.caption,
            color = c.textMuted,
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .padding(end = KSpacing.md, bottom = KSpacing.xs),
        )
    }
}

/**
 * 简介框空着时要留几行 —— 设计稿是多行框（"个人简介文本框应该留 2 行空白，不是一行"）。
 *
 * 只影响**空框的初始高度**：写满之后框会自己长高，与这个常量无关。
 */
private const val BLANK_LINES = 2

/**
 * 把公开资料里的头像相对路径（`/uploads/avatars/x.jpg`）拼成绝对地址。
 *
 * 复用 [top.kuangdada.k.core.data.resolveUrl]（已经是 http(s) 的原样返回）；
 * 为什么不用 `UserRepository.avatarUrl`：那个要一个 `UserProfile`，
 * 而换完头像后我们手上只有更新接口返回的 `User`。
 */
private fun resolveAvatar(path: String?, baseUrl: String): String? =
    top.kuangdada.k.core.data.resolveUrl(path, baseUrl)
