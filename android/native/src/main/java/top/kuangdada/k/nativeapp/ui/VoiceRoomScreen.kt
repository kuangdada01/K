package top.kuangdada.k.nativeapp.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.snap
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import top.kuangdada.k.core.data.VoiceRepository
import top.kuangdada.k.core.data.model.VoiceRoom
import kotlinx.coroutines.launch
import top.kuangdada.k.core.data.ApiResult
import top.kuangdada.k.core.data.displayMessage
import top.kuangdada.k.core.designsystem.component.KBreathRing
import top.kuangdada.k.core.designsystem.component.KButton
import top.kuangdada.k.core.designsystem.component.KPlaceholder
import top.kuangdada.k.core.designsystem.component.KPlaceholderKind
import top.kuangdada.k.core.designsystem.component.KTextField
import top.kuangdada.k.core.designsystem.theme.KDimens
import top.kuangdada.k.core.designsystem.theme.KMotion
import top.kuangdada.k.core.designsystem.theme.KRadius
import top.kuangdada.k.core.designsystem.theme.KSpacing
import top.kuangdada.k.core.designsystem.theme.KTheme
import top.kuangdada.k.core.designsystem.theme.KType
import top.kuangdada.k.core.designsystem.theme.LocalAnimationsEnabled
import top.kuangdada.k.nativeapp.R
import top.kuangdada.k.nativeapp.voice.ChatReader
import top.kuangdada.k.nativeapp.voice.ShareRenderHolder
import top.kuangdada.k.nativeapp.voice.VoiceRoomController
import top.kuangdada.k.nativeapp.voice.rememberChatReader

/**
 * ============================================================
 * 语音房内（设计稿「语音房内 · 沉浸态」——**不显示底部导航**）
 * ============================================================
 * 设计稿形态：
 *  · 顶栏（**无底色**）：房间名（20 Bold）+ 一行状态；右上角 **× 圆钮**（退出房间，没有返回箭头）；
 *  · 「发言席」：**4 列白卡麦位**（头像 + 名字，状态点压在头像右下角；不足 8 个用「空位」补满）；
 *  · 「屏幕共享」：内缩圆角画面区；
 *  · 控制栏 6 个圆形按钮（50px，左右 16px）**固定在底部**：
 *    麦克风 = accent 实心（在麦）/ 扬声器 / 降噪 / 录制 = surface + 描边 /
 *    共享中 = accentSoft 高亮 / 退出 = dangerSoft。
 *
 * 用户补充的设计稿没有画的部分：**屏幕共享下方放文字聊天框** ——
 * 语音房里打字是真实需求（Web 版就有），这里收成一个卡片：消息列表 + 输入框。
 *
 * 语义色沿用设计稿 §3.4：状态点 `success`（在麦）/ `danger`（闭麦）/ `textMuted`（只听/空位）。
 * 麦位卡上**不再放**「在麦/闭麦/只听」文字与网络质量文字 —— 设计稿的卡只有头像和名字，
 * 状态由点的颜色表达（网络质量本身是成员自报的，挂在小卡上也很吵）。
 */
@Composable
fun VoiceRoomScreen(
    voice: VoiceRepository,
    controller: VoiceRoomController,
    room: VoiceRoom,
    onBack: () -> Unit,
    /**
     * 能不能清空房间聊天记录（设计稿「文字聊天 → 清空」）。
     *
     * = 房间创建者或管理员（由 AppShell 判断，它手上有会话与房间对象）。
     * 这里只决定**画不画那个按钮**：真正的权限在服务端（非创建者调用会 403）。
     */
    canClearChat: Boolean = false,
    /**
     * 能不能删除房间（「…」菜单里的标红项）。
     *
     * = 房间创建者或管理员（由 AppShell 判断）。删除走服务端 DELETE（真正权限在那边）；
     * 访客建的房由建房响应里下发一次的所有权令牌鉴权（仓库层进程内留存）。
     */
    canDelete: Boolean = false,
) {
    val c = KTheme.colors
    val context = androidx.compose.ui.platform.LocalContext.current
    val state by controller.state.collectAsState()
    var input by remember { mutableStateOf("") }
    /**
     * 是否**正在**全屏观看别人的屏幕共享（用户要求"手机能全屏别人的共享"）。
     *
     * M6.17 起全屏是**独立宿主 Activity**（[top.kuangdada.k.nativeapp.ShareFullscreenActivity]），
     * 这个值只表达"画面此刻在全屏宿主手里"：房间这边据此把内联槽位留成空槽。
     * 真正的画面交接由 [ShareRenderHolder] 完成（渲染器实例与解码链全程只有一份）。
     */
    var shareFullscreen by remember { mutableStateOf(false) }
    // 共享结束/换人共享时自动退出全屏：否则会停在一块黑底上（轨已不在，全屏里什么都没有）。
    // **由房间侧通知宿主**而不是宿主自己订阅状态：宿主是纯 View 的 Activity，拿不到控制器；
    // 而房间页一直活着（全屏 Activity 只是压在它上面），状态一定在这里先变
    LaunchedEffect(state.remoteVideoTrack) {
        if (state.remoteVideoTrack == null) {
            ShareRenderHolder.requestClose("共享已结束")
            shareFullscreen = false
        }
    }

    // ------------------------------------------------------------------
    // 屏幕共享渲染层：**整场共享只有一个渲染器**（M6.15 单份渲染 + M6.17 Surface 交接）
    // ------------------------------------------------------------------
    /**
     * 渲染器活在**组合之外**（[ShareRenderHolder]），这里只负责"谁来持有它"。
     *
     * 为什么不能留在组合里：`AndroidView` 的 `onRelease` **拿不到取消的机会**（它没有返回值），
     * 页面一离开组合就 `release()` + GL Surface 销毁 —— 那正是"进/退全屏各等一次首帧"的来源。
     * 交给持有者之后，全屏宿主只要 `removeView` / `addView` 就能把**同一个**渲染器接过去。
     *
     * 绑轨放在组合里（而不是点击时）：`state.remoteVideoTrack` 一变就要换渲染器
     * （旧 sink 绑的是旧轨），而比例的四个来源也在同一个 State 上 —— 一处更新，两个宿主同时生效。
     */
    state.remoteVideoTrack?.let { track ->
        ShareRenderHolder.bindTrack(
            track = track,
            // 共享者声明的采集尺寸（进房/开始共享时就已知）：比例的最高优先来源
            declared = state.remoteShareSize,
            // 会话接收探针给出的比例（State 里的字段：它一到就重组，画面框才会把留边收掉）
            probed = state.remoteVideoAspect,
            // 复用会话的 EGL 上下文（有则不再新建），避免反复开关共享堆积 GL 上下文/线程
            eglContext = controller.sessionEglContext(),
        )
    }

    /** 画面比例（持有者发布的**那一个**值：内联槽位与全屏宿主都读它） */
    val shareAspect = ShareRenderHolder.aspect
    /**
     * 首帧是否已出图 —— 只决定"（等待画面…）"这几个字**去不去掉**。
     *
     * 用持有者的计数器（换渲染器时归零）而不是页面自己的 `remember(track)`：
     * 进/退全屏时页面不重启组合，这个值本来也不会丢，但换人共享时必须重新变回"等待画面"。
     *
     * 刻意不参与任何几何计算：上一版把"挂 sink"的前提写成"渲染器自己量到了帧尺寸"，
     * 而不挂 sink 就永远量不到 → 死锁 → 永远没画面（真机 `View=0x0 解码尺寸=0x0`）。
     * 规矩：**任何门控条件都不许依赖"只有挂了渲染器才会产生的状态"**。
     */
    val shareHasFrame = ShareRenderHolder.firstFrameTick > 0
    /** 共享者名字（进全屏时传给宿主，用于它那边的日志与提示） */
    val sharerName = if (state.selfSharing) "我"
    else state.peers.firstOrNull { it.userId == state.sharingUserId }?.username ?: "有人"

    /**
     * 进全屏：**先把画面交出去，再开宿主**。
     *
     * 顺序不能反：宿主 `onCreate/onResume` 里就 `addView`，而 `addView` 对"已有父"的 View 会抛
     * `IllegalStateException`。这里 detach 之后渲染器处于"无父"状态，谁先拿到都不会打架。
     */
    fun enterFullscreen() {
        if (state.remoteVideoTrack == null) return
        ShareRenderHolder.detach()
        shareFullscreen = true
        val intent = android.content.Intent(context, top.kuangdada.k.nativeapp.ShareFullscreenActivity::class.java)
            .putExtra(top.kuangdada.k.nativeapp.ShareFullscreenActivity.EXTRA_SHARER, sharerName)
        context.findActivity()?.startActivity(intent)
    }

    /**
     * 退全屏回来后把画面接回内联槽位。
     *
     * 为什么必须监听生命周期而不是靠组合重跑：全屏期间房间页**一直活着**（只是被压住），
     * 不会重新进入组合 —— 只靠 `AndroidView.update` 是接不回来的。
     * `onResume` 一定晚于全屏宿主的 `onPause`（那里已经 `detach`），所以这里不会撞到"已有父"。
     */
    val lifecycleOwner = androidx.lifecycle.compose.LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = androidx.lifecycle.LifecycleEventObserver { _, event ->
            if (event == androidx.lifecycle.Lifecycle.Event.ON_RESUME) shareFullscreen = false
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    /**
     * **有共享画面在播时保持屏幕常亮**（用户报告："这个房间看直播会触发手机自动熄屏"）。
     *
     * 用 `View.keepScreenOn` 而不是 `WakeLock` 权限：与 [top.kuangdada.k.nativeapp.ui.VideoPlayerScreen]
     * 播放长视频时是同一套（系统按"这个界面有内容要看"处理，页面不可见时自动失效，
     * 不存在忘记释放导致整机不睡的问题）。全屏宿主自己也挂了这个标记（那边是独立的窗口）。
     *
     * 触发条件绑"有画面在播"（别人共享中，或自己正在共享）而不是"在房间里"：
     * 纯语音的房间不该把屏幕钉亮 —— 那是白耗电。
     */
    KeepScreenOn(active = state.remoteVideoTrack != null || state.selfSharing)
    /** 清空的二次确认（破坏性操作，与消息页「清空聊天记录」同一套 AlertDialog 写法） */
    var confirmClearChat by remember { mutableStateOf(false) }
    /** 右上角「…」菜单（删除房间 / 离开房间，详情页同款组件） */
    var roomMenuOpen by remember { mutableStateOf(false) }
    /** 删除房间的二次确认（破坏性操作，同上写法） */
    var confirmDeleteRoom by remember { mutableStateOf(false) }
    /** 删除失败等需要一句话反馈的场景（房内没有常驻 toast 位，就地起一个） */
    var deleteToast by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    /** 聊天朗读（设计稿右上角的「朗读」开关）：只念**新收到**的消息，不念历史、不念自己 */
    val chatReader = rememberChatReader()
    val lastChat = state.chat.lastOrNull()
    LaunchedEffect(lastChat?.id) {
        val m = lastChat ?: return@LaunchedEffect
        if (m.live && !m.isMine) chatReader.speak(m.username, m.content)
    }

    // 录制计时（与 Web 版的"已录秒数"一致；只在 interval 回调里更新，避免渲染期读时钟）
    var recordSeconds by remember { mutableIntStateOf(0) }
    LaunchedEffect(state.recording, state.recordStartedAt) {
        val startedAt = state.recordStartedAt
        if (!state.recording || startedAt == null) {
            recordSeconds = 0
            return@LaunchedEffect
        }
        while (true) {
            recordSeconds = ((System.currentTimeMillis() - startedAt) / 1000).toInt()
            kotlinx.coroutines.delay(1000)
        }
    }

    // 录制结束：提示成品位置 + 弹出系统分享面板（录完最常见的动作就是发出去）
    LaunchedEffect(state.recordedFile) {
        val file = state.recordedFile ?: return@LaunchedEffect
        controller.shareRecording(file)
    }

    // 麦克风权限：必须在 WebRTC 启动前拿到（否则 AudioRecord 无效，只表现为"本地静音"）
    var micAsked by remember { mutableStateOf(false) }
    // 通知权限：Android 13+ 没有它，前台服务的通知不显示 —— 服务仍在跑，
    // 但用户看不到也退不掉（通知栏里那条"退出房间"是唯一的兜底出口）。
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { grants ->
        val mic = grants[android.Manifest.permission.RECORD_AUDIO] == true
        controller.join(micGranted = mic)
    }

    // ---- 屏幕共享：先要系统授权（MediaProjection 必须由用户点确认）----
    val projectionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val data = result.data
        if (result.resultCode == android.app.Activity.RESULT_OK && data != null) {
            controller.startShare(data)
        }
    }
    val projectionManager = remember {
        context.getSystemService(android.media.projection.MediaProjectionManager::class.java)
    }

    LaunchedEffect(Unit) {
        if (!micAsked) {
            micAsked = true
            permissionLauncher.launch(
                arrayOf(
                    android.Manifest.permission.RECORD_AUDIO,
                    android.Manifest.permission.POST_NOTIFICATIONS,
                )
            )
        }
    }

    // 离开页面时必须退房：不退的话 WebSocket 与麦克风会一直占着
    // （服务端还有"同 IP 并发连接上限"，泄漏几条就再也进不了房）
    DisposableEffect(Unit) {
        onDispose {
            // 全屏宿主还活着时**不许**销毁渲染器（那是它的画面）；那种情况下只退房，
            // 宿主会收到 requestClose 自己退场，渲染器留到下一场共享重建
            if (!shareFullscreen) ShareRenderHolder.release()
            controller.leave()
        }
    }

    fun leaveRoom() {
        controller.leave()
        onBack()
    }

    /**
     * 进小窗观看（原生画中画）。
     *
     * 与 Web 端「小窗模式」同语义：画面浮在桌面上，可以边看共享边用别的 App。
     * 用**系统 PiP**而不是应用内浮窗：应用内浮窗一退出房间页就没了，
     * 而"小窗"的价值恰恰在于能离开这个页面。
     *
     * 三个必须处理的点：
     *  1. `supportsPictureInPicture` 与 `resizeableActivity` 必须在清单里开
     *     （漏了不报错，只是 `enterPictureInPictureMode` 静默返回 false）；
     *  2. **比例**取共享画面的真实比例（`setAspectRatio`），否则竖屏共享在小窗里会留大片黑边；
     *  3. 失败时给一句人话（部分设备/系统设置禁用了 PiP），而不是点了没反应。
     */
    fun enterPip() {
        val activity = context as? android.app.Activity ?: return
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.O) {
            android.widget.Toast.makeText(context, "系统版本不支持小窗", android.widget.Toast.LENGTH_SHORT).show()
            return
        }
        val ratio = controller.remoteVideoAspect().takeIf { it > 0.05f } ?: (16f / 9f)
        val ok = runCatching {
            val params = android.app.PictureInPictureParams.Builder()
                .setAspectRatio(android.util.Rational((ratio * 1000).toInt(), 1000))
                .build()
            activity.enterPictureInPictureMode(params)
        }.getOrDefault(false)
        if (!ok) {
            android.widget.Toast.makeText(context, "当前无法进入小窗（系统可能已禁用）", android.widget.Toast.LENGTH_SHORT).show()
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(c.bgPage),
    ) {
        Column(modifier = Modifier.fillMaxSize()) {
            // ---- 顶栏（无底色）：房间名 + 人数/状态 | × 退出圆钮 ----
            // 垂直位置走全 App 同一条 [kTopBar]（状态栏安全区 + KSpacing.xs）：这里**只写左右与下边距**，
            // 上边距再写一次就是两处叠加（顶栏位置不一致的根因就是这种叠加）。
            //
            // 下边距取 KSpacing.md 而不是原来的 KSpacing.xs：房间名与人数是**一组**，
            // 组内间距（见下面 Column 的 KSpacing.xxs）必须明显小于"这一组 ↔ 麦位"，
            // 否则三行会读成三个等距的东西（改之前正是如此）。16dp 也正好对齐 KPageHeader
            // 系页面的既有节奏：页头自身下内边距 8 + 列表间隔 12 = 20。
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .kTopBar()
                    .padding(start = KSpacing.md, end = KSpacing.md, bottom = KSpacing.md),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(
                    modifier = Modifier.weight(1f),
                    /**
                     * 房间名（房间的标识）+「N 人在线 · 状态」是**一组**信息，用最小一档
                     * KSpacing.xxs（4dp）—— 与同一个 App 里同构的信息对保持一致：
                     * 房间列表卡的 `VoiceRoomCard`、个人主页的「用户名 + @用户名」
                     * （`ProfileScreen`）用的都是这一档。
                     *
                     * 改之前这里**没有任何间距来源**（既没有 spacedBy 也没有 Spacer，
                     * 也不是同一个 Text 拼出来的）：两行之间只剩字体行高留白 ——
                     * 20/28 那档出约 4dp、12/17 那档出约 2.5dp，合计约 6.5dp；
                     * 而顶栏到麦位是 8dp 下内边距 + 2.5dp ≈ 10.5dp。两者只差 4dp，
                     * 于是"房间名—人数"与"人数—麦位"看上去几乎等距，读不出层级 ——
                     * 用户反馈的"房间 ID 和人数的上下间距"就是这里。
                     */
                    verticalArrangement = Arrangement.spacedBy(KSpacing.xxs),
                ) {
                    Text(
                        text = room.name,
                        style = KType.overlayTitle,
                        color = c.textPrimary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        // 设计稿：有人在共享时这里写「共享中」，否则写连接状态
                        // （人数 + 状态，与设计稿「8 人在线 · 共享中」同构）
                        text = "${state.peers.size + 1} 人在线 · " +
                            if (state.sharingUserId > 0 || state.selfSharing) "共享中" else phaseText(state.phase),
                        style = KType.footnote,
                        color = c.textMuted,
                    )
                }
                // 右上角「…」（详情页同款组件）：删除房间（创建者/管理员，标红）+ 离开房间
                Box {
                    KIconButton(icon = GlyphKind.More, onClick = { roomMenuOpen = true })
                    DropdownMenu(
                        expanded = roomMenuOpen,
                        onDismissRequest = { roomMenuOpen = false },
                        containerColor = c.surfaceRaised,
                        shape = RoundedCornerShape(KRadius.control),
                    ) {
                        if (canDelete) {
                            ChatMenuItem("删除房间", c.danger) {
                                roomMenuOpen = false
                                confirmDeleteRoom = true
                            }
                        }
                        ChatMenuItem("离开房间", c.textPrimary) {
                            roomMenuOpen = false
                            leaveRoom()
                        }
                    }
                }
            }

            // ---- 内容：发言席 / 屏幕共享 / 房间聊天（可滚动；控制栏固定在底部）----
            val scrollState = rememberScrollState()
            // 键盘收起器：点房间内容空白处把键盘收起（键盘挡着聊天输入）
            val keyboard = LocalSoftwareKeyboardController.current
            Column(
                modifier = Modifier
                    .weight(1f)
                    .verticalScroll(scrollState)
                    .imePadding()
                    // 点房间内容空白处收起键盘
                    .pointerInput(Unit) { detectTapGestures { keyboard?.hide() } }
                    .padding(horizontal = KSpacing.md),
                verticalArrangement = Arrangement.spacedBy(KSpacing.lg),
            ) {
                if (state.error != null) {
                    Text(state.error!!, style = KType.caption, color = c.danger)
                }
                if (!state.hasTurn) {
                    Text(
                        // 只有 STUN 时对称 NAT 会连不上；把原因说清楚，别让用户对着"连接中"一直等
                        text = "服务端未配置 TURN：双方都在对称 NAT 后可能连不上音频（信令仍正常）",
                        style = KType.tiny,
                        color = c.accent,
                    )
                }

                // ---- 麦位（M6 起：**一排 5 个、平均分布**；不再有「发言席」小标题）----
                // 用户要求：取消「发言席」字样、取消呼吸圈，改成**有人说话就把边框点亮**
                // （与 Web 端同一语义：`VoicePage.module.css` 的 `.speaking { border-color: success }`）。
                val me = VoiceRoomController.PeerUi(
                    userId = state.selfUserId,
                    username = state.selfUsername.ifBlank { "我" },
                    avatarUrl = null,
                    muted = !state.micEnabled,
                    listener = false,
                    sharing = state.selfSharing,
                )
                // 自己排在最前；**有多少显示多少，不用「空位」凑数** ——
                // 空位卡是常驻噪声，真正有用的信息只有"现在谁在"。
                val seats: List<VoiceRoomController.PeerUi> = buildList {
                    add(me)
                    addAll(state.peers)
                }
                // 有人进/出时，整块麦位区的高度变化走弹簧（M6）而不是"一行突然长出来"。
                // 注意这**不是**座位级的入场动画：座位是"固定列的 Row 里有多少画多少"，
                // 有人进来会把后面的人挤动 —— 那需要固定麦位数（服务端给）或改成 lazy 网格，
                // 属于下一轮的事（见文档 M6 记录）。
                BoxWithConstraints(modifier = Modifier.fillMaxWidth()) {
                    /**
                     * 每行 5 个、**按可用宽度平均分**（用户要求"一排平均分布 5 个人"）。
                     *
                     * 为什么用 `BoxWithConstraints` 实测宽度而不是写死一个常量（原来是
                     * `KGrid.voiceSeatCard`，按 390dp 参考屏算的 4 列）：5 列时那个等式在别的
                     * 屏宽上除不尽，余量会全堆在右边（设计稿 §4.6 记过这个坑）。
                     * 实测宽度算出来的 5 等分在任何屏上都是"平均分布"。
                     */
                    val seatWidth = (maxWidth - KSpacing.xs * (SEATS_PER_ROW - 1)) / SEATS_PER_ROW
                    Column(
                        modifier = Modifier.animateContentSize(),
                        verticalArrangement = Arrangement.spacedBy(KSpacing.xs),
                    ) {
                        seats.chunked(SEATS_PER_ROW).forEach { rowSeats ->
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
                            ) {
                                rowSeats.forEach { seat ->
                                    VoiceSeatCard(
                                        peer = seat,
                                        isSelf = seat.userId == state.selfUserId,
                                        speaking = seat.userId in state.speakingUserIds,
                                        modifier = Modifier.width(seatWidth),
                                    )
                                }
                            }
                        }
                    }
                }

                // ---- 屏幕共享（**没人共享就整段隐藏**，不放占位 —— 空占位是无信息的装饰）----
                if (state.remoteVideoTrack != null) {
                    Column(verticalArrangement = Arrangement.spacedBy(KSpacing.xs)) {
                        /**
                         * 标题行 + 三个观看控制按钮（声音 / 全屏 / 小窗，语义与 Web 端舞台控制一致）。
                         *
                         * **按钮必须在画面矩形之外**：`SurfaceView` 会在窗口上挖洞，盖在它上面的
                         * Compose 元素会**根本画不出来**（这不是推测：本工程 `styles.xml` 里为
                         * ExoPlayer 换 `texture_view` 时已经实测记录过同一条）。原来那三个图标画在
                         * 画面框的右上角，正好落在洞里 —— 点击有反应但看不见。移到标题行右侧后
                         * 它们才真的可见；三个按钮的图标、active 语义、点击行为一字未改。
                         */
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text("屏幕共享", style = KType.footnote, color = c.textMuted)
                            Spacer(Modifier.weight(1f))
                            Row(horizontalArrangement = Arrangement.spacedBy(KSpacing.xs)) {
                                // 只在共享方**真的带了声音**时才画：否则点了什么都不会发生
                                if (state.shareHasAudio) {
                                    ShareOverlayButton(
                                        // 只有一个音量图形（Glyph 里没有静音版），
                                        // 开/关靠**高亮状态**表达 —— 与 Web 端同一个语义
                                        icon = GlyphKind.Volume,
                                        active = !state.shareAudioMuted,
                                        label = if (state.shareAudioMuted) "开启共享声音" else "关闭共享声音",
                                        onClick = { controller.toggleShareAudio() },
                                    )
                                }
                                ShareOverlayButton(
                                    icon = GlyphKind.Maximize,
                                    active = false,
                                    label = "全屏观看",
                                    onClick = { enterFullscreen() },
                                )
                                ShareOverlayButton(
                                    icon = GlyphKind.Monitor,
                                    active = false,
                                    label = "小窗观看",
                                    onClick = {
                                        // **先进全屏宿主再进小窗**：系统小窗显示的是"整个 Activity
                                        // 当前的样子"，而房间页是可滚动的一整页 —— 不切视图的话，
                                        // 共享画面可能根本不在可视区，小窗里就看不到画面。
                                        // 全屏宿主同样支持 PiP（它就是一个普通的 Activity）。
                                        enterFullscreen()
                                        enterPip()
                                    },
                                )
                            }
                        }
                        Text(
                            text = if (shareHasFrame) "$sharerName 正在共享屏幕"
                            else "$sharerName 正在共享屏幕（等待画面…）",
                            style = KType.caption,
                            color = c.accent,
                            // 单行 + 省略号：首帧到达时这几个字会变短，一旦折行数变化，
                            // 下面的槽位整体上移 —— 表现就是"等到首帧画面跳一下"。
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        /**
                         * 内联槽位 = **几何锚点 + 点击区**，画面本身不画在这里。
                         *
                         * M6.17 的结构（层级务必按这个顺序想）：
                         *   Box（这一层）      ← 按**画面比例**定尺寸，只负责"画面该在哪儿、多大"
                         *    └ ShareRenderView ← 透明壳，它里面的 FrameLayout 才是渲染器的父，**黑底画在那儿**
                         *
                         * 为什么壳在这里、容器在里面：`SurfaceView` 挖的"洞"的边界就是**它自己的容器**，
                         * 所以黑底必须画在容器的外层（[ShareRenderView] 里的 FrameLayout），
                         * 而**这里（洞的上面一层）绝不能加任何不透明底色** —— M6.16 真机事故：
                         * 进来时这里有 `.background(Color(0xFF10131A))`，画面整块黑掉。
                         *
                         * 比例跟着 [shareAspect] 走（不再固定 16:9）：这样退全屏回来时槽位与画面同比例，
                         * 不会因为"槽位 16:9、画面 16:10"而先撑开再收回 —— 那是用户报的"退出全屏跳一下"。
                         */
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .aspectRatio(shareAspect)
                                .clip(RoundedCornerShape(KRadius.card))
                                // 点画面 = 全屏观看（用户要求"手机不能全屏别人的共享"）
                                .clickable { enterFullscreen() },
                        ) {
                            ShareRenderView(
                                // 全屏期间不画：画面在全屏宿主手里，这边留一个同尺寸的空槽
                                // —— 天然不可能出现"两份渲染"，也不需要任何显隐动画
                                active = !shareFullscreen,
                                modifier = Modifier.fillMaxSize(),
                            )
                        }
                    }
                }

                // ---- 文字聊天（设计稿「文字聊天」卡片：标题 + 朗读 + 清空 / 消息行 / 输入行）----
                RoomChatPanel(
                    messages = state.chat,
                    input = input,
                    onInputChange = { input = it },
                    // 输入框聚焦（键盘弹出）时滚到内容底部：否则键盘把聊天输入挡住，
                    // 用户看不见自己打的字（用户实测"输入框固定、看不见打了什么"）
                    onInputFocused = {
                        scope.launch { scrollState.animateScrollTo(scrollState.maxValue) }
                    },
                    onSend = {
                        controller.sendChat(input)
                        input = ""
                    },
                    reader = chatReader,
                    canClear = canClearChat,
                    onClear = { confirmClearChat = true },
                )

                Spacer(Modifier.height(KSpacing.sm))
            }

            /**
             * ---- 控制栏：50px 圆形按钮，**只有图标、没有文字**（设计稿），固定底部 ----
             *
             * 顺序：麦克风 / 降噪 / 共享 / 录制 / 离开。
             *
             * 布局用**等分格**（每个钮各占 1/5 宽、内容居中），而不是 `SpaceEvenly` 那种
             * "均分间隙"：五个钮的中心恰好落在 1/10、3/10、5/10、7/10、9/10 处，
             * 换机型、换字号都不会挤成一坨（用户要求"5 个平均分布"）。
             *
             * 设计稿上还有「音乐」和「麦克风音量」两个钮 —— 这两个**到现在也没做**：
             *  · 音乐模式要重建 `AudioSource`（关掉 AEC/NS）并换掉各条连接的发送轨，属于真的音频链路改动；
             *  · Android 的 WebRTC **没有麦克风增益接口**（Web 端是 WebAudio 的 GainNode 做的）。
             * 按本工程既有原则（"点了没反应的按钮比不放更让人困惑"），宁可不画，也不摆空壳。
             *
             * 「离开」是这一轮新加的（用户要求）：出口原来只有右上角那个 × / 「…」菜单，
             * 底部这一排才是用户下意识会去找的地方。动作与菜单里那条**共用 [leaveRoom]**。
             */
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .navigationBarsPadding()
                    .padding(horizontal = KSpacing.md, vertical = KSpacing.sm),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // 麦克风：在麦用 accent 实心，闭麦用 surface + border
                ControlSlot {
                    VoiceControlButton(
                        icon = GlyphKind.Mic,
                        active = state.micEnabled,
                        onClick = { controller.toggleMic() },
                        contentDescription = if (state.micEnabled) "关闭麦克风" else "打开麦克风",
                    )
                }
                /**
                 * **没有「扬声器」按钮**（按用户要求去掉）。
                 *
                 * 原来那个按钮是 `onClick = { }` 的空壳（点了没有任何反应），
                 * 而音频本来就默认走扬声器 —— 摆一个点不动的按钮比不放更容易让人困惑。
                 * 音量由系统音量键控制（WebRTC 用的是媒体音量流）。
                 */
                // 降噪：WebRTC 的 APM（AEC + NS + AGC）常态开启，所以这里是"已开启"的只读指示
                ControlSlot {
                    VoiceControlButton(
                        icon = GlyphKind.Voice,
                        active = true,
                        onClick = { },
                        contentDescription = "降噪（WebRTC 音频处理链常态开启）",
                    )
                }
                // 屏幕共享：本端已在共享则再点是停止；否则先要系统授权（MediaProjection）
                ControlSlot {
                    VoiceControlButton(
                        icon = GlyphKind.Monitor,
                        /**
                         * **只在本端自己在共享时点亮**（M6.7，用户实测反馈：
                         * "别人显示屏幕共享，自己这边屏幕共享按钮亮了"）。
                         *
                         * 原来写的是 `selfSharing || sharingUserId > 0` —— 那把"别人在共享"也当成了
                         * 这个按钮的激活态 ✗：按钮表达的是**"我这端开着共享"**，
                         * "有人在共享"由下面那块共享画面自己说明（画面就在那儿，不需要按钮再说一遍）。
                         */
                        active = state.selfSharing,
                        onClick = {
                            if (state.selfSharing) {
                                controller.stopShare()
                            } else {
                                val intent = projectionManager?.createScreenCaptureIntent()
                                if (intent != null) projectionLauncher.launch(intent)
                            }
                        },
                        contentDescription = if (state.selfSharing) "停止屏幕共享" else "共享屏幕",
                    )
                }
                // 录制：全房间混音（远端各路 + 开麦时的自己）→ MP3 / AAC。
                // 录制中按钮上叠一个秒数（设计稿的按钮没有文字，但"正在录"必须看得出来），
                // 外面再套一圈**呼吸环** —— 静止看一眼就知道它还在录（见 VoiceControlButton 的 breathing）
                ControlSlot {
                    VoiceControlButton(
                        icon = GlyphKind.Dot,
                        active = state.recording,
                        danger = state.recording,
                        onClick = { controller.toggleRecording() },
                        contentDescription = if (state.recording) "停止录制（已录 ${recordSeconds}s）" else "录制房间声音",
                        badge = if (state.recording) "${recordSeconds}s" else null,
                        breathing = state.recording,
                    )
                }
                // 离开房间：与右上角「…」里那一条同一个动作（danger 配色 = 会退出这个页面）
                ControlSlot {
                    VoiceControlButton(
                        icon = GlyphKind.LogOut,
                        active = false,
                        danger = true,
                        onClick = { leaveRoom() },
                        contentDescription = "离开房间",
                    )
                }
            }
        }

        /**
         * 注：**全屏观看的浮层已经不在这里了**（M6.17）。
         *
         * 原来这里是"整屏 Box + 手势 + 提示"的浮层，画面靠根节点上那个渲染器按
         * `lerp(内联矩形, 整屏矩形, 进度)` 画出来。它有三个治不好的毛病（用户实测）：
         *  ① 全屏浮层与渲染层在**同一棵 Compose 树**里，谁在上谁在下直接决定画面死活
         *     （M6.16 就是在这里把画面盖成全黑的）；
         *  ② 进出全屏要跑一段几何动画，动画期间每帧重组，比例一变就是"跳一下"；
         *  ③ 它终究只是"原地放大"，与系统状态栏/导航栏、旋转、分屏全都纠缠在一起。
         *
         * 现在全屏 = **独立宿主 Activity**（`ShareFullscreenActivity`），
         * 渲染器由 [ShareRenderHolder] 交过去，黑边由宿主的窗口底色提供 —— 见那两处的注释。
         */

        if (state.phase == VoiceRoomController.Phase.Preparing ||
            state.phase == VoiceRoomController.Phase.Connecting
        ) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(c.scrim),
                contentAlignment = Alignment.Center,
            ) {
                KPlaceholder(
                    kind = KPlaceholderKind.Loading,
                    title = when (state.phase) {
                        VoiceRoomController.Phase.Preparing -> "正在准备音频…"
                        else -> "正在连接语音服务…"
                    },
                    description = "远端音频已接通 ${state.audioConnected} 路",
                )
            }
        }

        /**
         * 清空聊天记录的二次确认（设计稿的「清空」是破坏性操作，与消息页「清空聊天记录」
         * 用同一套 `AlertDialog` 写法，含确认键的 danger 文字色）。
         */
        if (confirmClearChat) {
            AlertDialog(
                onDismissRequest = { confirmClearChat = false },
                title = { Text("清空聊天记录", style = KType.subtitle, color = c.textPrimary) },
                text = {
                    Text(
                        text = "确定清空本房间的全部聊天记录吗？清空后不可恢复。",
                        style = KType.body,
                        color = c.textSecondary,
                    )
                },
                confirmButton = {
                    Text(
                        text = "清空",
                        style = KType.bodyStrong,
                        color = c.danger,
                        modifier = Modifier
                            .clip(RoundedCornerShape(KRadius.pill))
                            .clickable {
                                confirmClearChat = false
                                controller.clearChat()
                            }
                            .padding(horizontal = KSpacing.sm, vertical = KSpacing.xxs),
                    )
                },
                dismissButton = {
                    Text(
                        text = "取消",
                        style = KType.body,
                        color = c.textSecondary,
                        modifier = Modifier
                            .clip(RoundedCornerShape(KRadius.pill))
                            .clickable { confirmClearChat = false }
                            .padding(horizontal = KSpacing.sm, vertical = KSpacing.xxs),
                    )
                },
                containerColor = c.surface,
            )
        }

        /**
         * 删除房间的二次确认（破坏性操作，与清空聊天记录同一套写法）。
         * 确认后走服务端 DELETE；成功即退场（离开组合时 DisposableEffect 会退房），
         * 语音房列表回来时会重拉，房间自然消失。
         */
        if (confirmDeleteRoom) {
            AlertDialog(
                onDismissRequest = { confirmDeleteRoom = false },
                title = { Text("删除房间", style = KType.subtitle, color = c.textPrimary) },
                text = {
                    Text(
                        text = "房间「${room.name}」会被删除，房内成员会被请出，且不可恢复。",
                        style = KType.body,
                        color = c.textSecondary,
                    )
                },
                confirmButton = {
                    Text(
                        text = "删除",
                        style = KType.bodyStrong,
                        color = c.danger,
                        modifier = Modifier
                            .clip(RoundedCornerShape(KRadius.pill))
                            .clickable {
                                confirmDeleteRoom = false
                                scope.launch {
                                    when (val r = voice.deleteRoom(room.id)) {
                                        is ApiResult.Success -> onBack()
                                        is ApiResult.Failure -> deleteToast = r.error.displayMessage
                                    }
                                }
                            }
                            .padding(horizontal = KSpacing.sm, vertical = KSpacing.xxs),
                    )
                },
                dismissButton = {
                    Text(
                        text = "取消",
                        style = KType.body,
                        color = c.textSecondary,
                        modifier = Modifier
                            .clip(RoundedCornerShape(KRadius.pill))
                            .clickable { confirmDeleteRoom = false }
                            .padding(horizontal = KSpacing.sm, vertical = KSpacing.xxs),
                    )
                },
                containerColor = c.surface,
            )
        }

        deleteToast?.let { msg ->
            KToast(
                text = msg,
                onDismiss = { deleteToast = null },
                modifier = Modifier.align(Alignment.BottomCenter),
            )
        }
    }
}

/**
 * 麦位卡（设计稿「组件 麦位」：头像 / 状态点 / 名称）。
 *
 * 卡片是白色圆角（radius 14），里面只有头像与名字 —— 状态由**压在头像右下角的点**表达：
 * `success` 在麦 / `danger` 闭麦 / `textMuted` 只听。
 *
 * **M6 起两处变化（用户要求）**：
 *  1. **去掉「呼吸环」** —— 它原本表达"在麦"，但用户要的是"谁在说话"，于是改成
 *     **有人说话就把整张卡的边框点亮**（`success` 色 + 粗一档），与 Web 端
 *     `.speaking { border-color: var(--success) }` 同一语义；
 *  2. **头像居中**：原来那个 `Box` 没写 `contentAlignment`（默认 `TopStart`），
 *     环（62dp）在中间、头像（48dp）却贴在左上角 —— 截图里一眼就能看出来"图标不居中"。
 *     现在没有环比它大了，`Box` 直接按头像尺寸居中，状态点也就落回头像右下角。
 */
@Composable
private fun VoiceSeatCard(
    peer: VoiceRoomController.PeerUi,
    isSelf: Boolean,
    speaking: Boolean,
    modifier: Modifier = Modifier,
) {
    val c = KTheme.colors
    val animationsEnabled = LocalAnimationsEnabled.current
    val statusColor = when {
        peer.listener -> c.textMuted       // 只听（无麦克风权限）
        peer.muted -> c.danger             // 闭麦
        else -> c.success                  // 在麦
    }
    // 状态点颜色走过渡（M6）：直接切会"跳"，而 effects 档阻尼比 1.0、不过冲（颜色过冲会显脏）
    val dotColor by animateColorAsState(
        targetValue = statusColor,
        animationSpec = if (animationsEnabled) KMotion.effects() else snap(),
        label = "seatDotColor",
    )
    // 说话时点亮边框：颜色也走同一档过渡，避免"啪"地闪一下
    val borderColor by animateColorAsState(
        targetValue = if (speaking) c.success else c.borderSubtle,
        animationSpec = if (animationsEnabled) KMotion.effects() else snap(),
        label = "seatBorderColor",
    )
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(KRadius.row))
            .background(c.surface)
            .border(
                width = if (speaking) 1.5.dp else 1.dp,
                color = borderColor,
                shape = RoundedCornerShape(KRadius.row),
            )
            .padding(vertical = KSpacing.sm),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(KSpacing.xxs),
    ) {
        /**
         * `contentAlignment = Center` 是**必须的**：头像比容器小的时候，
         * Box 默认是 `TopStart` —— 那样头像会贴在左上角（M6 之前就踩了这个，用户截图反馈"图标不居中"）。
         */
        Box(contentAlignment = Alignment.Center) {
            // 没有头像时用**人像图标**而不是首字：设计稿里所有无头像的麦位都是同一个
            // 中性人像（首字会把"2""H"这种字符放大成视觉噪声，且各人大小不一）
            Avatar(
                url = peer.avatarUrl,
                name = peer.username,
                size = KDimens.voiceSeat,
                glyph = GlyphKind.User,
            )
            if (peer.sharing) {
                Box(
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .clip(RoundedCornerShape(KRadius.pill))
                        .background(c.accent)
                        .padding(horizontal = 4.dp),
                ) {
                    Text("共享", style = KType.tiny, color = c.onAccent, fontSize = 9.sp)
                }
            }
            // 状态点：压住头像右下角（容器不裁剪，避免被切成月牙）
            Box(
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .size(14.dp)
                    .clip(CircleShape)
                    .background(dotColor)
                    .border(2.dp, c.surface, CircleShape),
            )
        }
        Text(
            text = if (isSelf) "${peer.username}（我）" else peer.username,
            style = KType.footnote,
            color = c.textPrimary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Center,
        )
    }
}

/**
 * 文字聊天卡片（设计稿：标题行「💬 文字聊天 + 朗读 + 清空」/ 消息行「头像 + 名字 时间 + 内容」/ 输入行）。
 *
 * 与 Web 端 `VoiceChatPanel` 同一套语义与排版：
 *  · 消息行有**头像**（26dp）与**时间**（今天只显示时分，跨天带日期）；
 *  · 自己的消息名字后面带「（我）」（Web 端也是这么标的）；
 *  · 自己的气泡文字用 accent 色区分（原生这边不做左右分栏 —— 房间公屏是所有人一条流水）；
 *  · 输入框 500 字上限（服务端与 Web 端同口径）；
 *  · 「清空」只在房间创建者/管理员可见，且要二次确认（破坏性操作）。
 */
@Composable
private fun RoomChatPanel(
    messages: List<VoiceRoomController.ChatUi>,
    input: String,
    onInputChange: (String) -> Unit,
    onSend: () -> Unit,
    /** 输入框聚焦时回调（宿主滚到内容底部，让输入框露出键盘上方） */
    onInputFocused: () -> Unit,
    reader: ChatReader,
    canClear: Boolean,
    onClear: () -> Unit,
) {
    val c = KTheme.colors
    val listState = rememberLazyListState()

    // 新消息到达自动滚到最新（不然用户看到的是最旧的几条，会以为消息发不出去）
    LaunchedEffect(messages.size) {
        if (messages.isNotEmpty()) listState.scrollToItem(messages.lastIndex)
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(KRadius.card))
            .background(c.surface)
            .padding(KSpacing.md),
        verticalArrangement = Arrangement.spacedBy(KSpacing.xs),
    ) {
        // ---- 标题行：图标 + 标题 + 朗读开关 + 清空 ----
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(KSpacing.xxs),
        ) {
            Glyph(tint = c.textMuted, kind = GlyphKind.Chat, size = 15.dp)
            Text("文字聊天", style = KType.footnote, color = c.textMuted)
            Spacer(Modifier.weight(1f))
            ChatHeaderButton(
                icon = GlyphKind.Volume,
                label = if (reader.enabled) "朗读开" else "朗读",
                active = reader.enabled,
                enabled = reader.supported,
                onClick = { reader.toggle() },
            )
            if (canClear) {
                ChatHeaderButton(
                    icon = GlyphKind.More,
                    label = "清空",
                    active = false,
                    enabled = true,
                    onClick = onClear,
                )
            }
        }

        if (messages.isEmpty()) {
            Text("还没有消息，说点什么吧～", style = KType.tiny, color = c.textMuted)
        }
        LazyColumn(
            state = listState,
            modifier = Modifier
                .fillMaxWidth()
                .height(150.dp),
            verticalArrangement = Arrangement.spacedBy(KSpacing.xs),
        ) {
            items(messages, key = { it.id }) { msg ->
                // animateItem 是 LazyItemScope 的扩展：必须在 items 里取，不能挪进下面的组件
                ChatMessageRow(msg = msg, reader = reader, modifier = Modifier.animateItem())
            }
        }
        // 输入行与上方（标题/消息）之间用一条分隔线隔开（用户反馈：输入框要和头部/内容分开）
        HorizontalDivider(color = c.borderSubtle)
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = KSpacing.xxs),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
        ) {
            Box(Modifier.weight(1f)) {
                KTextField(
                    value = input,
                    // 500 字上限与服务端/Web 端一致（占位符里也写明了，不让人打完才被截）
                    onValueChange = { if (it.length <= VoiceRoomController.CHAT_MAX_CHARS) onInputChange(it) },
                    // 占位符只写"该输什么"：**不暴露实现细节**（原来的
                    // "（服务端 400ms 节流）"是给开发者看的，用户看到只会莫名其妙）
                    placeholder = "说点什么…（500 字以内）",
                    shape = RoundedCornerShape(KRadius.control),
                    // 聚焦时通知宿主滚到内容底部：否则键盘把聊天输入挡住，
                    // 用户看不见自己打的字（用户实测"输入框固定、看不见打了什么"）
                    modifier = Modifier.onFocusChanged { if (it.isFocused) onInputFocused() },
                )
            }
            KButton(
                text = "发送",
                onClick = onSend,
                enabled = input.isNotBlank(),
                // 圆角与输入框一致（小圆角），不再是胶囊
                cornerRadius = KRadius.control,
            )
        }
    }
}

/**
 * 聊天卡片标题行里的小按钮（朗读 / 清空）。
 *
 * 形态照设计稿：**胶囊描边 + 图标 + 文字**，开启时用 accentSoft 高亮。
 * 不可用（如系统没有 TTS 引擎）时整体降透明度并吞掉点击 —— 与 Web 端 `disabled` 同语义。
 */
@Composable
private fun ChatHeaderButton(
    icon: GlyphKind,
    label: String,
    active: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    val c = KTheme.colors
    val fg = when {
        !enabled -> c.textMuted
        active -> c.accent
        else -> c.textSecondary
    }
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(KRadius.pill))
            .background(if (active) c.accentSoft else androidx.compose.ui.graphics.Color.Transparent)
            .border(1.dp, c.borderSubtle, RoundedCornerShape(KRadius.pill))
            .clickable(enabled = enabled, onClick = onClick)
            .semantics { contentDescription = label }
            .padding(horizontal = KSpacing.xs, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Glyph(tint = fg, kind = icon, size = 13.dp)
        Text(label, style = KType.tiny, color = fg)
    }
}

/**
 * 一条聊天消息：头像 + 「名字（我） 时间」+ 内容。
 *
 * 点一行 = 朗读这一条（与 Web 端 `onClick={() => tts.handleSpeakMessage(m)}` 同一语义）——
 * 所以即使"新消息自动朗读"关着，也能手动念一条。
 */
@Composable
private fun ChatMessageRow(
    msg: VoiceRoomController.ChatUi,
    reader: ChatReader,
    modifier: Modifier = Modifier,
) {
    val c = KTheme.colors
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(KRadius.row))
            .clickable(enabled = reader.supported) { reader.speak(msg.username, msg.content) }
            .padding(vertical = 1.dp),
        horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
    ) {
        Avatar(url = msg.avatarUrl, name = msg.username, size = 26.dp, glyph = GlyphKind.User)
        Column(modifier = Modifier.weight(1f)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(KSpacing.xxs),
            ) {
                Text(
                    text = if (msg.isMine) "${msg.username}（我）" else msg.username,
                    style = KType.tiny,
                    color = c.textSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (msg.timeText.isNotBlank()) {
                    Text(msg.timeText, style = KType.tiny, color = c.textMuted)
                }
            }
            Text(
                text = msg.content,
                style = KType.caption,
                color = if (msg.isMine) c.accent else c.textPrimary,
            )
        }
    }
}

/**
 * 控制按钮：**直径 50px**（设计稿：6 个按钮时必须降尺寸，否则 390px 宽下会低于触控目标下限）。
 * 语义色：在麦/激活 = `accent` 实心 + `onAccent` 图标；危险 = `dangerSoft`；
 * 共享中 = `accentSoft` 高亮（设计稿用它表达"这块正开着"）；
 * 其余 = `surface` + `borderStrong`（**不是凹陷色** —— 凹陷色与页底只有 1.04:1，读不出边界）。
 *
 * **M6.2：按设计稿去掉按钮下方的文字标签**（只有图标）。
 * 代价是"这个钮是什么"要靠语义与图标本身回答，所以每个按钮都补了
 * [contentDescription]（读屏可读、长按也能看到系统提示）；录制中额外叠一个秒数
 * [badge] —— 那是状态而不是标签，设计稿没有它，但"正在录"必须看得出来。
 */
/**
 * 控制栏里的一格：**占满 1/5 宽、内容居中**（见控制栏那段注释）。
 *
 * 抽出来是为了让"5 个平均分布"这件事只有一处实现 —— 以后加减按钮只用加/删一格，
 * 不用每处重复写 `weight` 与对齐方式。
 */
@Composable
private fun RowScope.ControlSlot(content: @Composable () -> Unit) {
    Box(modifier = Modifier.weight(1f), contentAlignment = Alignment.Center) { content() }
}

@Composable
private fun VoiceControlButton(
    icon: GlyphKind,
    active: Boolean,
    onClick: () -> Unit,
    contentDescription: String,
    danger: Boolean = false,
    /** 叠在按钮下缘的状态角标（目前只有录制秒数） */
    badge: String? = null,
    /**
     * 外圈**呼吸环**（见 [KBreathRing]）。
     *
     * 录制中开着它：录制这件事除了"按钮换成 danger 底色 + 一个秒数角标"之外没有别的反馈，
     * 静止看一眼容易以为没在录。环从按钮边缘缓慢外扩、同时淡出，
     * 把"正在进行中"表达出来 —— 与语音房麦位上那个环是**同一个组件**（设计系统里现成的）。
     */
    breathing: Boolean = false,
) {
    val c = KTheme.colors
    val bg = when {
        danger -> c.dangerSoft
        active -> c.accent
        else -> c.surface
    }
    val fg = when {
        danger -> c.danger
        active -> c.onAccent
        else -> c.textPrimary
    }
    Box(contentAlignment = Alignment.Center) {
        if (breathing) {
            KBreathRing(
                color = c.danger,
                // 比按钮大一圈：环顺着按钮外沿向外扩散，不会压在图标或角标上
                ringSize = KDimens.voiceControl + KSpacing.xs,
                // 比默认（0.38）实一点 —— 它要在深色房间底上被看见
                maxAlpha = 0.5f,
            )
        }
        Box(
            modifier = Modifier
                .size(KDimens.voiceControl)
                .clip(CircleShape)
                .background(bg)
                .then(
                    if (!active && !danger) {
                        Modifier.border(1.dp, c.borderStrong, CircleShape)
                    } else {
                        Modifier
                    }
                )
                .clickable(onClick = onClick)
                // 无文字按钮必须给读屏说明（缺了就是"M6.2 之后这排按钮说不出自己是什么"）
                .semantics { this.contentDescription = contentDescription },
            contentAlignment = Alignment.Center,
        ) {
            Glyph(tint = fg, kind = icon, size = KDimens.navIcon)
        }
        if (badge != null) {
            Text(
                text = badge,
                style = KType.tiny,
                color = c.textPrimary,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .clip(RoundedCornerShape(KRadius.pill))
                    .background(c.surface)
                    .padding(horizontal = 5.dp),
            )
        }
    }
}

/**
 * 共享画面的三个观看控制钮（声音 / 全屏 / 小窗）。
 *
 * 形态对齐 Web 端舞台控件：**半透明黑底圆钮 + 白图标** —— 白图标在任何底色上都读得出来，
 * 半透明黑底则让圆钮在浅色主题下也有明确的边界（深色主题下基本只剩图标本身）。
 *
 * 位置经过一次搬迁（M6.15）：原来浮在**画面框的右上角**，而 `SurfaceView` 会在窗口上挖洞
 * ——盖在洞里的 Compose 元素根本画不出来，那三个钮其实是"能点但看不见"。
 * 现在它们排在共享块的标题行右侧（画面矩形之外），语义与点击行为一字未改。
 *
 * @param active 高亮态（共享声音开着 = 高亮），用 accent 底区分"当前是开还是关"
 */
@Composable
private fun ShareOverlayButton(
    icon: GlyphKind,
    active: Boolean,
    label: String,
    onClick: () -> Unit,
) {
    val c = KTheme.colors
    val bg =
        if (active) c.accent.copy(alpha = 0.92f)
        else androidx.compose.ui.graphics.Color.Black.copy(alpha = 0.45f)
    val fg = if (active) c.onAccent else androidx.compose.ui.graphics.Color.White
    Box(
        modifier = Modifier
            .size(34.dp)
            .clip(CircleShape)
            .background(bg)
            .clickable(onClick = onClick)
            // 无文字按钮必须给读屏说明
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Glyph(tint = fg, kind = icon, size = 18.dp)
    }
}

private fun phaseText(phase: VoiceRoomController.Phase): String = when (phase) {
    VoiceRoomController.Phase.Idle -> "未连接"
    VoiceRoomController.Phase.Preparing -> "准备中"
    VoiceRoomController.Phase.Connecting -> "连接中"
    VoiceRoomController.Phase.Joined -> "已连接"
    VoiceRoomController.Phase.Closed -> "已断开"
    VoiceRoomController.Phase.Failed -> "连接失败"
}

/**
 * 麦位每行几个（用户要求："一排平均分布 5 个人"）。
 *
 * 5 是"手机竖屏下还能看清头像与名字"的上限：390dp 屏、左右各 16dp 边距、4 个 8dp 间隙时，
 * 单卡 ≈ 65dp（头像 48dp + 两侧各 8dp）—— 再挤就该缩头像了。
 */
private const val SEATS_PER_ROW = 5

/**
 * **有画面在播时保持屏幕常亮**（`View.keepScreenOn`）。
 *
 * 用户报告："这个房间看直播会触发手机自动熄屏" —— 手机在放视频内容时却按"无操作"计时息屏，
 * 观感就是"看着看着黑了"。这里把 [active] 为真的期间挂上这个标记，系统会按
 * "该界面有内容需要观看"处理，**不进入息屏**。
 *
 * 为什么不用 `PowerManager.WakeLock`：那需要 WAKE_LOCK 权限，且必须自己保证释放
 * （漏一次就是整机不睡、耗电异常）；`keepScreenOn` 由系统随视图可见性自动失效，
 * 与 [top.kuangdada.k.nativeapp.ui.VideoPlayerScreen] 播放视频时用的是同一套。
 *
 * 全屏宿主是**另一个窗口**，那边的常亮由它自己挂（`FLAG_KEEP_SCREEN_ON`）——
 * 这个标记只作用于本窗口，不会跟着画面交接过去。
 */
@Composable
private fun KeepScreenOn(active: Boolean) {
    val view = LocalView.current
    DisposableEffect(view, active) {
        view.keepScreenOn = active
        onDispose { view.keepScreenOn = false }
    }
}
