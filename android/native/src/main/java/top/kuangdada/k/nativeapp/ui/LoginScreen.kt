package top.kuangdada.k.nativeapp.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import top.kuangdada.k.core.data.ApiError
import top.kuangdada.k.core.data.ApiResult
import top.kuangdada.k.core.data.SessionRepository
import top.kuangdada.k.core.data.displayMessage
import top.kuangdada.k.core.designsystem.component.KButton
import top.kuangdada.k.core.designsystem.component.KTextField
import top.kuangdada.k.core.designsystem.motion.motionSheetEnter
import top.kuangdada.k.core.designsystem.theme.KDimens
import top.kuangdada.k.core.designsystem.theme.KElevation
import top.kuangdada.k.core.designsystem.theme.KRadius
import top.kuangdada.k.core.designsystem.theme.KSpacing
import top.kuangdada.k.core.designsystem.theme.KTheme
import top.kuangdada.k.core.designsystem.theme.KType

/**
 * ============================================================
 * 登录 / 注册 / 重置密码 · **覆盖态弹层**
 * ============================================================
 * 设计稿 §3.3.1 映射表最后一行：登录弹层是**覆盖态** —— 遮罩 `scrim` 压暗底下的页面
 * （连底部导航一起压暗），弹层底 `surfaceRaised` + `radius.sheet`(24) + 浮层阴影。
 *
 * 浮层的三件事都由调用方（AppShell）配合完成，这里只负责画面：
 *  · **底下那页照常渲染** —— AppShell 用 `AppNavigator.previous` 取到它；
 *  · **返回键关闭** —— 它是压栈目标，AppShell 的 `PredictiveBackHandler` 走 `navigator.pop()`；
 *  · **淡入淡出 + 面板上滑** —— 遮罩的淡入淡出在 AppShell 的 `AnimatedVisibility`，
 *    面板上滑是本文件里 `Modifier.motionSheetEnter()`（两者分工，避免双重淡入）；
 *  · **登录成功 / 点遮罩** 都调 `onDismiss`（同样是 pop）。
 *
 * 三个模式共用一个弹层（切换只换标题/字段/按钮文案，弹层不重建、不闪）：
 *   · [AuthMode.Login]    登录
 *   · [AuthMode.Register] 注册（用户名 + 邮箱 + 验证码 + 密码）
 *   · [AuthMode.Forgot]   重置密码（邮箱 + 验证码 + 新密码 + 确认新密码）——
 *     之前「忘记密码」只是发一条重置验证码就没了下文，用户拿不到真正改密码的入口。
 *
 * 覆盖服务端的 5 个认证接口：login / register / send-code / forgot-password / reset-password。
 *
 * 三个必须照搬服务端约束的地方（否则用户只会看到"没反应"）：
 *  1. **验证码 60 秒内不能重发**（`authRepo.hasRecentCode`），所以按钮要做倒计时；
 *     1 小时最多 5 次、15 分钟最多 10 次登录尝试，超了服务端回 400/429，文案要原样展示。
 *  2. **防邮箱枚举**：`forgot-password` 对未注册邮箱也返回成功文案 —— UI 不要自作聪明提示"该邮箱未注册"。
 *  3. **验证码是两种**：注册走 `send-code`、重置密码走 `forgot-password`，**不是同一个接口**，
 *     发送按钮必须按模式分流（拿错验证码会一直校验失败）。
 */
private enum class AuthMode { Login, Register, Forgot }

@Composable
fun LoginOverlay(
    session: SessionRepository,
    /** 关闭弹层（点遮罩、登录成功、返回键都走它） */
    onDismiss: () -> Unit,
    onAuthenticated: () -> Unit = onDismiss,
) {
    val c = KTheme.colors
    val scope = rememberCoroutineScope()

    var mode by remember { mutableStateOf(AuthMode.Login) }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var confirmPassword by remember { mutableStateOf("") }
    var username by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }

    var submitting by remember { mutableStateOf(false) }
    var sendingCode by remember { mutableStateOf(false) }
    var codeCooldown by remember { mutableIntStateOf(0) }
    var error by remember { mutableStateOf<String?>(null) }
    var hint by remember { mutableStateOf<String?>(null) }

    // 验证码倒计时（服务端同邮箱 60 秒内拒绝重发）
    LaunchedEffect(codeCooldown) {
        if (codeCooldown > 0) {
            delay(1000)
            codeCooldown -= 1
        }
    }

    /** 切模式：清掉上一模式留下的提示；验证码倒计时保留（同一邮箱 60s 内重发仍会被服务端拒） */
    fun switchMode(target: AuthMode) {
        mode = target
        error = null
        hint = null
    }

    fun handleFailure(e: ApiError) {
        error = e.displayMessage
    }

    /** 卡片形状：圆角与描边必须同一个 shape，否则描边会被圆角裁出缺口 */
    val cardShape = RoundedCornerShape(KRadius.sheet)

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(c.scrim)
            // 点遮罩关闭（不做水波纹：遮罩本身不是可点的控件）
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClickLabel = "关闭登录",
                onClick = onDismiss,
            )
            // 键盘弹起时把弹层顶上来，而不是被键盘盖住
            .imePadding(),
        contentAlignment = Alignment.Center,
    ) {
        Surface(
            modifier = Modifier
                // 面板上滑（遮罩的淡入在 AppShell 的 AnimatedVisibility 里）—— 设计稿的"弹层进出"
                .motionSheetEnter()
                .fillMaxWidth()
                .padding(horizontal = KSpacing.xl)
                // 吃掉落在弹层上的点击，否则会穿透到遮罩上把弹层关掉
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                    onClick = {},
                )
                // 设计稿：卡片除了浮层阴影还有 1px 描边 —— 浅色的 surfaceRaised 是纯白，
                // 阴影在浅底上偏弱，靠描边把圆角边缘描清楚
                .border(1.dp, c.borderSubtle, cardShape),
            shape = cardShape,
            color = c.surfaceRaised,
            shadowElevation = KElevation.sheet,
        ) {
            Column(
                modifier = Modifier
                    // 小屏 / 横屏 / 键盘占位大时，弹层内部自己滚，不顶出屏幕
                    .verticalScroll(rememberScrollState())
                    .padding(KSpacing.xl),
                verticalArrangement = Arrangement.spacedBy(KSpacing.md),
            ) {
                Text(
                    text = when (mode) {
                        AuthMode.Login -> "K"
                        AuthMode.Register -> "创建账号"
                        AuthMode.Forgot -> "重置密码"
                    },
                    style = KType.overlayTitle,
                    color = c.textPrimary,
                )
                Text(
                    text = when (mode) {
                        AuthMode.Login -> "登录后即可发布、私信与加入语音房"
                        AuthMode.Register -> "需要邮箱验证码；验证码 60 秒内不可重复发送"
                        AuthMode.Forgot -> "输入注册邮箱与验证码，设置新密码"
                    },
                    style = KType.caption,
                    color = c.textMuted,
                )

                if (mode == AuthMode.Register) {
                    KTextField(
                        value = username,
                        onValueChange = { username = it },
                        placeholder = "用户名（3-30 字）",
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
                    )
                }

                KTextField(
                    value = email,
                    onValueChange = { email = it },
                    placeholder = "邮箱",
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Email,
                        imeAction = ImeAction.Next,
                    ),
                )

                if (mode != AuthMode.Login) {
                    // 验证码行：输入框 + **同高、同圆角**的小图标按钮（KRadius.control 对齐输入框）。
                    // 设计稿只画了登录态，注册/重置态沿用同一套输入框规格；
                    // 倒计时期间图标位换成剩余秒数 —— 弹层宽度有限，放不下「获取验证码(60s)」这种长文案。
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            // IntrinsicSize.Min 让两侧各自量内容后取较小者 → 图标按钮与输入框等高
                            .height(IntrinsicSize.Min),
                        horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(Modifier.weight(1f)) {
                            KTextField(
                                value = code,
                                onValueChange = { code = it },
                                placeholder = "6 位验证码",
                                keyboardOptions = KeyboardOptions(
                                    keyboardType = KeyboardType.Number,
                                    imeAction = ImeAction.Next,
                                ),
                            )
                        }
                        CodeSendButton(
                            cooldown = codeCooldown,
                            enabled = !sendingCode && codeCooldown == 0,
                            onClick = {
                                error = null
                                hint = null
                                if (email.isBlank()) {
                                    error = "请先填写邮箱"
                                    return@CodeSendButton
                                }
                                scope.launch {
                                    sendingCode = true
                                    // ★ 两种验证码不是同一个接口：注册走 send-code，重置密码走 forgot-password
                                    val result = if (mode == AuthMode.Forgot) {
                                        session.forgotPassword(email)
                                    } else {
                                        session.sendCode(email)
                                    }
                                    sendingCode = false
                                    when (result) {
                                        is ApiResult.Success -> {
                                            hint = result.data.ifBlank {
                                                if (mode == AuthMode.Forgot) "重置验证码已发送至邮箱"
                                                else "验证码已发送至邮箱"
                                            }
                                            codeCooldown = 60
                                        }
                                        is ApiResult.Failure -> handleFailure(result.error)
                                    }
                                }
                            },
                        )
                    }
                }

                KTextField(
                    value = password,
                    onValueChange = { password = it },
                    placeholder = when (mode) {
                        AuthMode.Login -> "密码"
                        AuthMode.Register -> "密码（至少 6 位）"
                        AuthMode.Forgot -> "新密码（至少 6 位）"
                    },
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Password,
                        imeAction = if (mode == AuthMode.Forgot) ImeAction.Next else ImeAction.Done,
                    ),
                )

                if (mode == AuthMode.Forgot) {
                    KTextField(
                        value = confirmPassword,
                        onValueChange = { confirmPassword = it },
                        placeholder = "确认新密码",
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(
                            keyboardType = KeyboardType.Password,
                            imeAction = ImeAction.Done,
                        ),
                    )
                }

                if (mode == AuthMode.Login) {
                    // 忘记密码：右对齐的小链接，收在密码字段下方 —— 进入重置密码表单
                    Text(
                        text = "忘记密码",
                        style = KType.caption,
                        color = c.textSecondary,
                        textAlign = TextAlign.End,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(KRadius.chip))
                            .clickable(
                                interactionSource = remember { MutableInteractionSource() },
                                indication = null,
                                onClick = { switchMode(AuthMode.Forgot) },
                            )
                            .padding(vertical = KSpacing.xxs),
                    )
                }

                if (hint != null) {
                    Text(hint!!, style = KType.caption, color = c.success)
                }
                if (error != null) {
                    Text(error!!, style = KType.caption, color = c.danger)
                }

                // 设计稿的表单主按钮：**始终实心主题色**（全宽 + 圆角 10）。
                // 不用「字段为空就变灰」的禁用态 —— 那会让按钮看起来不是主题色（真机上已反馈）；
                // 改成点了再校验，就地给出明确提示。
                KButton(
                    text = when {
                        submitting -> "请稍候…"
                        mode == AuthMode.Login -> "登录"
                        mode == AuthMode.Register -> "注册并登录"
                        else -> "重置密码"
                    },
                    onClick = {
                        if (submitting) return@KButton
                        error = null
                        hint = null
                        if (mode == AuthMode.Register && username.isBlank()) {
                            error = "请先填写用户名"
                            return@KButton
                        }
                        if (email.isBlank()) {
                            error = "请先填写邮箱"
                            return@KButton
                        }
                        if (mode != AuthMode.Login && code.isBlank()) {
                            error = "请先填写验证码"
                            return@KButton
                        }
                        if (password.isBlank()) {
                            error = if (mode == AuthMode.Forgot) "请先填写新密码" else "请先填写密码"
                            return@KButton
                        }
                        if (mode == AuthMode.Forgot) {
                            if (password.length < 6) {
                                error = "新密码至少 6 位"
                                return@KButton
                            }
                            if (password != confirmPassword) {
                                error = "两次输入的密码不一致"
                                return@KButton
                            }
                        }
                        scope.launch {
                            submitting = true
                            // 三个接口返回类型不同（login/register 回 AuthResponse，reset-password 只回提示文案），
                            // 不能收进同一个 val result，否则泛型会被推成 Any
                            when (mode) {
                                AuthMode.Login -> when (val r = session.login(email, password)) {
                                    is ApiResult.Success -> onAuthenticated()
                                    is ApiResult.Failure -> handleFailure(r.error)
                                }
                                AuthMode.Register -> when (
                                    val r = session.register(username, email, password, code)
                                ) {
                                    is ApiResult.Success -> onAuthenticated()
                                    is ApiResult.Failure -> handleFailure(r.error)
                                }
                                AuthMode.Forgot -> when (
                                    val r = session.resetPassword(email, code, password)
                                ) {
                                    is ApiResult.Success -> {
                                        // 重置成功**不自动登录**：接口只回提示不发 token，
                                        // 回登录表单让用户用新密码进来（邮箱沿用已填的）
                                        password = ""
                                        confirmPassword = ""
                                        code = ""
                                        switchMode(AuthMode.Login)
                                        hint = r.data.ifBlank { "密码已重置，请用新密码登录" }
                                    }
                                    is ApiResult.Failure -> handleFailure(r.error)
                                }
                            }
                            submitting = false
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                    cornerRadius = KRadius.control,
                )

                // 设计稿的脚注形态：居中的强调色文字链（弹层里唯一的三级动作）
                OverlayTextLink(
                    text = when (mode) {
                        AuthMode.Login -> "还没有账号？注册"
                        AuthMode.Register -> "已有账号？登录"
                        AuthMode.Forgot -> "返回登录"
                    },
                    color = c.accent,
                    onClick = {
                        switchMode(
                            when (mode) {
                                AuthMode.Login -> AuthMode.Register
                                AuthMode.Register -> AuthMode.Login
                                AuthMode.Forgot -> AuthMode.Login
                            },
                        )
                    },
                )
            }
        }
    }
}

/** 弹层里的次级文字链（居中等宽可点，命中区域比文字本身大） */
@Composable
private fun OverlayTextLink(text: String, color: Color, onClick: () -> Unit) {
    Text(
        text = text,
        style = KType.caption,
        color = color,
        textAlign = TextAlign.Center,
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(KRadius.chip))
            .clickable(onClick = onClick)
            .padding(vertical = KSpacing.xxs),
    )
}

/**
 * 「获取验证码」的小图标按钮。
 *
 * 设计要求：与验证码输入框**同高、同圆角** —— 所以面也用同一套（`surface` + `borderStrong` 1px、
 * [KRadius.control]），让它看起来是同一个表单家族，而不是旁边贴了个异形按钮。
 * 倒计时期间图标位换成剩余秒数（`footnote` 12px）。
 * 图标是 [GlyphKind.Mail] —— 验证码走邮箱，语义比抽象的"发送"更直白。
 * 调用方按模式分流接口（注册 send-code / 重置密码 forgot-password）。
 */
@Composable
private fun CodeSendButton(
    cooldown: Int,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    val c = KTheme.colors
    val shape = RoundedCornerShape(KRadius.control)
    Box(
        modifier = Modifier
            // 父 Row 用 IntrinsicSize.Min，这里 fillMaxHeight + 1:1 → 与输入框等高的正方形
            .fillMaxHeight()
            .aspectRatio(1f)
            .clip(shape)
            .background(c.surface)
            .border(1.dp, c.borderStrong, shape)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                enabled = enabled,
                onClickLabel = "获取验证码",
                onClick = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) {
        if (cooldown > 0) {
            Text("$cooldown", style = KType.footnote, color = c.textSecondary)
        } else {
            Glyph(
                tint = if (enabled) c.accent else c.textMuted,
                kind = GlyphKind.Mail,
                size = KDimens.navIcon,
            )
        }
    }
}
