package top.kuangdada.k.nativeapp.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.snap
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
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
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import top.kuangdada.k.core.data.VoiceRepository
import top.kuangdada.k.core.data.model.VoiceRoom
import kotlin.math.roundToInt
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import top.kuangdada.k.core.data.ApiResult
import top.kuangdada.k.core.data.CHAT_TTS_CLOUD_VOICES
import top.kuangdada.k.core.data.CHAT_TTS_SYSTEM_VOICE_KEY
import top.kuangdada.k.core.data.displayMessage
import top.kuangdada.k.core.designsystem.component.KBreathRing
import top.kuangdada.k.core.designsystem.component.KButton
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
import top.kuangdada.k.nativeapp.voice.ShareQuality
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
 *
 * ⚠️ **偏离设计稿的一处（用户实测要求）**：控制栏的麦克风按钮**闭麦时是 `danger` 实心（红）**，
 * 设计稿写的是 surface + 描边。理由是那一排本来就有好几个 surface + 描边的静态钮（降噪/共享），
 * 闭麦混在里面只像"没点亮、暂时不可用"，而它实际是"我现在说不出话"。
 * 麦位卡上的闭麦状态点用 `danger`，按钮与它现在同色 —— 两处说的是同一件事。
 */
// 键盘跟随滚动（聊天输入行贴键盘）用到的 `WindowInsets.ime` 仍标着 @ExperimentalLayoutApi ——
// 按本工程惯例函数级 opt-in（同 TaggedText 的用法），不为它改全局编译参数。
@OptIn(ExperimentalLayoutApi::class)
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
    /**
     * 对局象棋的状态（单独一个 StateFlow，不进 [state]）。
     *
     * 这里只用来回答一个问题：**现在能不能显示成员卡上的「对弈」入口**
     * （[chessIdle]）——所以只把这一个 Boolean **map** 出来收集：对局期间
     * 走子/棋钟等高频广播每条都会发新 state，全量收集的话每一次走子都会
     * 重组整个语音房（麦位、共享区、聊天 LazyColumn 全部跟着重跑）。
     * collectAsState 写回的是结构相等的 Boolean，值不翻转就不触发重组；
     * 棋盘面板（ChessGamePanel）自己会再 collect 全量，两边互不牵连。
     *
     * `initial = false`：不读 `state.value`（组合期读 .value 是 Compose lint 错误）。
     * 行为等价 —— 这段组合开始时面板必然是关的：进房新建控制器、离房 leave()
     * 都会 chess.reset()，不存在"组合重建时面板已开"的场景。
     */
    val chessPanelOpen by remember(controller.chess) {
        controller.chess.state.map { it.showPanel }
    }.collectAsState(initial = false)
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
     *
     * @param enterPip 顺带进小窗（画中画）。**由宿主自己执行**（M6.18）：系统要求
     *   "调用 `enterPictureInPictureMode` 的 Activity 必须前台且 resumed"—— 在房间页对
     *   MainActivity 调用时，前台已经/即将是宿主，必然失败；而且小窗显示的是"整个 Activity
     *   当前的样子"，房间页直接进只会看到可滚动的一整页（共享画面多半不在可视区）。
     */
    fun enterFullscreen(enterPip: Boolean = false) {
        if (state.remoteVideoTrack == null) return
        ShareRenderHolder.detach()
        shareFullscreen = true
        val intent = android.content.Intent(context, top.kuangdada.k.nativeapp.ShareFullscreenActivity::class.java)
            .putExtra(top.kuangdada.k.nativeapp.ShareFullscreenActivity.EXTRA_SHARER, sharerName)
            .putExtra(top.kuangdada.k.nativeapp.ShareFullscreenActivity.EXTRA_ENTER_PIP, enterPip)
        context.findActivity()?.startActivity(intent)
    }

    /**
     * 宿主（全屏 / 小窗）**真正退场后**把画面接回内联槽位。
     *
     * 判据用 [ShareRenderHolder.hostAlive]（宿主 onStart/onStop 维护），**不是** MainActivity 的
     * ON_RESUME —— M6.18 真机实测的坑：**PiP 是悬浮窗，系统会把宿主下面的 MainActivity
     * 恢复前台**，房间页一收到 ON_RESUME 就复位 `shareFullscreen`，内联槽位随即把渲染器
     * 从小窗里**抢回来**（症状：小窗是黑的、房间页内联槽位却在播）。
     * 而宿主的 onStop 只在**真正退场**时到达（PiP 期间它 paused 但 started，系统不回调
     * onStop），所以这个标记能准确区分"退全屏回来了"与"小窗还开着"。
     *
     * 时序：宿主退场 `onPause`（detach）→ `onStop`（标记翻 false）→ 房间页本效果重组
     * `shareFullscreen=false` → 内联槽位 attach。**detach 一定先于 attach**，不会撞"已有父"。
     */
    LaunchedEffect(ShareRenderHolder.hostAlive) {
        if (!ShareRenderHolder.hostAlive) shareFullscreen = false
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
    /**
     * 需要说一句话给用户听的地方（删除房间失败 / 对局提示）。
     * 房内没有常驻 toast 位，就地起一个 —— **两处共用一个**：各起一个会叠在一起。
     */
    var pageToast by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    // 对局象棋的提示（对方拒绝邀请/求和/悔棋、非法走子被拒…）：
    // 对齐 Web 端 useChessGame 里的 showToast，文案本身就是服务端给的可读原因
    LaunchedEffect(Unit) {
        controller.chess.messages.collect { pageToast = it }
    }
    /**
     * 聊天朗读（设计稿右上角的「朗读」开关 + 音色下拉）：只念**新收到**的消息，
     * 不念历史、不念自己；点某一条可手动念（不受开关限制，与 Web 端同口径）。
     *
     * 音色下拉里有「系统语音」与云端复刻音色（走服务端 `/api/tts`，Key 不出服务端）；
     * 云端失败时由朗读器回调这里提示（对齐 Web 端的 showToast），复用页内那个 toast 位。
     */
    val chatReader = rememberChatReader(voice)
    LaunchedEffect(chatReader) {
        chatReader.onMessage = { pageToast = it }
    }
    val lastChat = state.chat.lastOrNull()
    LaunchedEffect(lastChat?.id) {
        val m = lastChat ?: return@LaunchedEffect
        if (m.live && !m.isMine) chatReader.speakIncoming(m.id, m.username, m.content)
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
            // 全屏/小窗宿主还活着时**不许**销毁渲染器（那是它的画面），而且必须先请它退场：
            // **小窗悬浮时用户能点到房间页的"离开房间"**（全屏铺满时点不到）—— 不通知的话
            // 宿主会留在 PiP 里显示最后几帧，房间却已经退了，没人再管它。
            // 宿主不在听（没进过全屏/小窗）时是空操作。
            if (ShareRenderHolder.hostAlive) ShareRenderHolder.requestClose("离开房间")
            if (!shareFullscreen) ShareRenderHolder.release()
            controller.leave("离开房间页面")
        }
    }

    fun leaveRoom() {
        controller.leave("用户退出房间")
        onBack()
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
                        // （人数 + 状态，与设计稿「8 人在线 · 共享中」同构）。
                        //
                        // 连接阶段（未 Joined）**只写「正在连接…」、不报人数**：
                        // 2026-10 起进房即呈现完整房间、连接在房内静默进行 ——
                        // 这一行就是那个"静默加载"的进度表达（旧版是整屏遮罩）。
                        text = when {
                            state.sharingUserId > 0 || state.selfSharing -> "${state.peers.size + 1} 人在线 · 共享中"
                            state.phase == VoiceRoomController.Phase.Idle ||
                                state.phase == VoiceRoomController.Phase.Preparing ||
                                state.phase == VoiceRoomController.Phase.Connecting -> "正在连接…"
                            else -> "${state.peers.size + 1} 人在线 · ${phaseText(state.phase)}"
                        },
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

            /*
             * 键盘跟随滚动（M6.21；M6.22 起"逐帧跟随"是**唯一动源**）：让聊天输入行**始终贴在键盘上沿**。
             *
             * 为什么不能在"聚焦"那一刻只滚一次（第一版）：点输入框时键盘**还没弹出** ——
             * 那次 `scrollTo(maxValue)` 算的是"没有键盘时的底部"，输入行停在屏幕底缘；
             * 键盘随后弹出（异步、带 ~200ms 动画）把它原样盖住 ——
             * 用户实测"唤醒输入法看不到打了什么字"就是这条时序。
             *
             * 为什么底部补偿不能直接上 `imePadding()`（第二版）：滚动列的底**不在屏幕底** ——
             * 它下面还有"控制栏 + 系统导航条"那一段（键盘弹出时控制栏被键盘盖住、只剩空白）。
             * `imePadding()` 把**整键盘高**都补进内容底部，滚到底时输入行就停在"键盘顶再往上
             * 这么一段"的位置 —— 用户看到的"输入框和键盘之间空隙过大"就是它。
             *
             * 为什么还要再扣"输入框 → 内容底"的尾巴（第三版）：滚到底对齐的是**内容底**，
             * 而输入框之下还有：聊天卡内底部留白（KSpacing.md，见 RoomChatPanel 的
             * `.padding(KSpacing.md)`）+ 卡片与末尾 Spacer 的间距（滚动列的 spacedBy，KSpacing.lg）
             * + 末尾 Spacer（KSpacing.sm）—— 这三段会把输入框从键盘顶"顶上去"。
             * 2026-10-14 真机像素实测（截图逐行扫描）：tail = 16 + 20 + 12 = 48dp，正好等于
             * 当时残余的间隙宽度；⚠️ **改动这三处留白时必须同步改下面这个表达式**，
             * 否则输入框又会离键盘多一条缝。
             *
             * 第四版校准：纯按 tail 扣净后输入框会**贴死/压过**键盘顶（用户实测"太过了"），
             * 用户要的是"**输入框的下边框露在键盘上方、之间留一点点**"。所以再返还
             * [COMPOSER_LIFT_DP]（多轮实测收敛：6 → 12 → 18 → 20dp）——下边框完整可见、
             * 又几乎没有空白感。
             *
             * 第五版（M6.22，用户检查"输入法动画是不是跟评论页不一样"）：评论页/消息页是
             * "底部固定输入栏 + 键盘高度驱动平移"（见 ChatScreen / PostDetailScreen 的交换区），
             * 房间页的输入框长在滚动内容里，只能靠滚动 —— 此前"聚焦先滚一次 + 键盘跟随"
             * 两条动源叠加出两段动画，观感与评论页的"一段干净跟随"差得更远。
             * 现在**去掉聚焦时那次主动滚动**（[RoomChatPanel] 里不再有 onInputFocused），
             * 只保留这里的逐帧跟随。
             *
             * 补偿公式 = max(0, 键盘高 − 滚动列底到窗口底的距离 − tail + [COMPOSER_LIFT_DP])。
             * 键盘弹出不改变滚动列底到窗口底的距离（窗口不 resize），量一次即可。
             *
             * 跟随：键盘打开期间持续观察 `scrollState.maxValue`（底部补偿随键盘动画逐帧变化），
             * 逐帧 `scrollTo` —— 输入行贴着键盘上沿滑动；键盘收起即停。
             * 只在 maxValue 变化时动作，**不会**把正在手动翻聊天记录的用户拽回底部。
             */
            val density = LocalDensity.current
            val windowHeightPx = LocalWindowInfo.current.containerSize.height
            // 滚动列底 → 窗口底 的距离（= 控制栏 + 导航条；键盘弹出不会改变它）
            var bottomChromePx by remember { mutableIntStateOf(0) }
            // 输入框底 → 滚动内容底 的"尾巴"（三段设计常量，见上面的注释；改动要同步）
            val composerTailPx = with(density) { (KSpacing.md + KSpacing.lg + KSpacing.sm).roundToPx() }
            // 返还量：让输入框（含下边框）停在键盘顶**上方一点**，而不是贴死（见第四版校准）
            val composerLiftPx = with(density) { COMPOSER_LIFT_DP.dp.roundToPx() }
            val imePx = WindowInsets.ime.getBottom(density)
            val keyboardOverlapPx =
                (imePx - bottomChromePx - composerTailPx + composerLiftPx).coerceAtLeast(0)
            val keyboardOpen = keyboardOverlapPx > 0
            LaunchedEffect(keyboardOpen) {
                if (!keyboardOpen) return@LaunchedEffect
                snapshotFlow { scrollState.maxValue }.collect { scrollState.scrollTo(it) }
            }
            Column(
                modifier = Modifier
                    .weight(1f)
                    // 实测"滚动列底 → 窗口底"的距离（初帧为 0，首轮布局后即为真值）
                    .onGloballyPositioned { coords ->
                        val bottomInWindow = coords.positionInWindow().y + coords.size.height
                        bottomChromePx = (windowHeightPx - bottomInWindow).roundToInt().coerceAtLeast(0)
                    }
                    .verticalScroll(scrollState)
                    // 底部补偿 = "键盘侵占滚动列的部分"（见上面的长注释；全额 imePadding()
                    // 会把控制栏 + 导航条那段也补出来，滚到底就多一条空白）
                    .padding(bottom = with(density) { keyboardOverlapPx.toDp() })
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
                        color = c.accentText,
                    )
                }

                // ---- 麦位（M6 起：**一排 5 个、平均分布**；不再有「发言席」小标题）----
                // 用户要求：取消「发言席」字样、取消呼吸圈，改成**有人说话就把边框点亮**
                // （与 Web 端同一语义：`VoicePage.module.css` 的 `.speaking { border-color: success }`）。
                val me = VoiceRoomController.PeerUi(
                    userId = state.selfUserId,
                    username = state.selfUsername.ifBlank { "我" },
                    // 自己的头像来自 `joined` 的 self.avatar（服务端校正后的身份）。
                    // 这里曾经写死 null，表现就是"房间里只有我没头像"（用户实测反馈）。
                    avatarUrl = state.selfAvatarUrl,
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
                /**
                 * 房间里此刻"没有对局、没有待应答邀请" → 成员卡上显示「对弈」入口。
                 *
                 * 判据与 Web 端 `chessIdle` 完全相同（那边是 `!game && !invite && !outgoing`）：
                 * 对局进行中或已有未决邀请时**不画**入口 —— 否则点了只会拿到一句
                 * "本房间已有对局进行中 / 已有待处理的邀请"，是典型的"看着能点其实不能点"。
                 */
                val chessIdle = !chessPanelOpen
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
                                        // 只有"别人 + 当前空闲"才给对弈入口（Web 端 MemberCard 同判据）
                                        onChallenge = if (seat.userId != state.selfUserId && chessIdle) {
                                            { controller.chess.inviteUser(seat.userId, seat.username, "red") }
                                        } else {
                                            null
                                        },
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
                         * 标题行 + 「共享声音」开关（M6.20：全屏 / 小窗已移进画面右上角，见下）。
                         *
                         * 声音开关**继续留在画面矩形之外**：`SurfaceView` 会在窗口上挖洞，
                         * 洞区域里的普通 Compose 元素会被"剪掉"、根本画不出来（本工程两次实测：
                         * ExoPlayer 的进度条/遮罩、以及曾经画在画面右上角的那排按钮"能点但看不见"）。
                         * 画面里的两个按钮用 **Popup（独立子窗口）** 绕开了这个限制 —— 见画面框处的注释；
                         * 声音开关是低频操作，放在标题行更省画面像素，不动它。
                         *
                         * （M6.18 那次"把按钮移进画面"的尝试因真机"画面显示不全"被回退 ——
                         *  后来查明那是**进房黑带**这个独立 bug 背的锅（与 Popup 无关，见
                         *  M6.19 的黑带修复），M6.20 复查通过后重新启用。）
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
                            }
                        }
                        /**
                         * 档位选择（**仅共享者本人可见**，2026-10-15 用户要求"手机投屏要有画质帧率选择"）：
                         * 极清 1080p60 / 流畅 1080p30 / 省流 720p30 —— 档位键/码率/标签与 Web 端
                         * 「质量档位」同一套（见 ShareQuality）。
                         *
                         * 点选立即生效（会话侧重应用发送参数）并记忆（下次进房沿用）。
                         * 另起一行而不是塞进标题行：三档全标签（画质 + 帧率）在竖屏宽度下放不下标题行。
                         */
                        if (state.selfSharing) {
                            Row(horizontalArrangement = Arrangement.spacedBy(KSpacing.xs)) {
                                ShareQuality.entries.forEach { q ->
                                    ShareQualityChip(
                                        label = q.label,
                                        selected = q == state.shareQuality,
                                        onClick = { controller.setShareQuality(q) },
                                    )
                                }
                            }
                        }
                        Text(
                            text = when {
                                // 编码受限自动降档时把原因说清（否则用户会觉得"设置自己丢了"）
                                state.selfSharing && state.shareQualityAuto ->
                                    "我 正在共享屏幕（编码受限，已自动切为 ${state.shareQuality.label}）"
                                shareHasFrame -> "$sharerName 正在共享屏幕"
                                else -> "$sharerName 正在共享屏幕（等待画面…）"
                            },
                            style = KType.caption,
                            color = c.accentText,
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
                            /**
                             * 画面**里面**右上角的「全屏 / 小窗」（M6.20，用户要求与 Web 端一致：
                             * Web 的 `.controls` 就是 absolute `top:10px right:10px`）。
                             *
                             * ⚠️ 为什么必须是 **Popup（独立子窗口）** 而不是普通 Compose 叠加：
                             * 画面框里是 `SurfaceViewRenderer`（SurfaceView）—— 它在窗口上"挖洞"，
                             * 洞区域内的窗口绘制（Compose 或原生 View）会被**剪掉**（本工程两次实测：
                             * ExoPlayer 的进度条/遮罩、"能点但看不见"的旧版这排按钮）。
                             * Popup 是**独立窗口**、合成在宿主窗口之上（与 Dialog/Toast 能盖住视频
                             * 同一个机制），不受洞影响 —— 因此不必把渲染器换成 TextureView
                             *（保住 Surface 交接、不引入额外的 GPU 拷贝与性能风险）。
                             *
                             * 只在画面确实在**本页内联槽位**时显示：全屏 / 小窗期间画面在宿主
                             * 手里，若还画着，就会浮在房间页上空空如也的画面框上。
                             */
                            if (!shareFullscreen) {
                                ShareInlineControlsPopup(
                                    onFullscreen = { enterFullscreen() },
                                    onPip = {
                                        // **开宿主、由宿主自己缩进小窗**（M6.18）：系统要求
                                        // `enterPictureInPictureMode` 的调用者是前台且 resumed 的
                                        // Activity —— 房间里对 MainActivity 调（旧实现）必然失败，
                                        // 而且小窗显示的是"整个 Activity 当前的样子"：宿主窗口里
                                        // 才只有共享画面（房间页直接进只会看到一整页可滚动 UI）。
                                        enterFullscreen(enterPip = true)
                                    },
                                )
                            }
                        }
                    }
                }

                // ---- 对战象棋（**屏幕共享舞台正下方**，与 Web 端 `VoiceRoomView` 的插点一致）----
                // 面板自己在"无对局、无邀请、无待应答"时返回空 —— 那一档什么都不占，
                // 所以这里可以无条件调用，不需要外面再写一遍同样的判据。
                ChessGamePanel(
                    chess = controller.chess,
                    selfUserId = state.selfUserId,
                )

                // ---- 文字聊天（设计稿「文字聊天」卡片：标题 + 朗读 + 清空 / 消息行 / 输入行）----
                RoomChatPanel(
                    messages = state.chat,
                    input = input,
                    onInputChange = { input = it },
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
                    // 用户要求「下面的按钮上升一点」：底边距比顶边距多一档（sm → lg），
                    // 整排按钮离屏幕底边（导航栏）高 8dp，与上方聊天卡片的间距不变
                    .padding(start = KSpacing.md, end = KSpacing.md, top = KSpacing.sm, bottom = KSpacing.lg),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                /**
                 * 麦克风：**在麦 = accent 实心；闭麦 = danger 实心（红）**。
                 *
                 * 原来是"闭麦 = surface + 描边"——与「降噪」（常亮）以外的静态按钮长得一样，
                 * 而这一排的其它钮本来就是 surface + 描边，于是**闭麦看起来只是"没点亮"**。
                 * 用户实测反馈要"闭麦变红"：说不出话是这一排里最要紧的一件事，
                 * 得用一个不需要学习的信号（实心红）说出来 —— 见 [VoiceControlButton] 的 `muted`。
                 */
                ControlSlot {
                    VoiceControlButton(
                        icon = GlyphKind.Mic,
                        active = state.micEnabled,
                        muted = !state.micEnabled,
                        onClick = { controller.toggleMic() },
                        contentDescription = if (state.micEnabled) "关闭麦克风" else "打开麦克风",
                    )
                }
                /**
                 * **没有「扬声器」按钮**（按用户要求去掉）。
                 *
                 * 音频由 VoiceAudioRouter 自动选择：已连接耳机优先，无耳机时用扬声器。
                 * 设备连接/断开时自动切换，音量由系统音量键控制。
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

        /**
         * ⚠️ 这里原来有一层「连接阶段全屏遮罩」（Preparing/Connecting 时整屏 scrim +
         * KPlaceholder「正在准备音频… / 正在连接语音服务…」）—— 2026-10 按用户反馈移除：
         * 进房即呈现完整房间（房间名 / 麦位 / 聊天 / 控制栏），连接在**房内静默进行**，
         * 进度由顶栏的「正在连接…」状态行表达（见上方头部那一行 Text 的 when 分支）。
         *
         * 别再把它加回来 —— 整屏遮挡会把"进房"读成一个"加载页"，连接完成的瞬间
         * 又是一次整屏切换，这正是用户说的"加载过程很割裂"。
         */

        /**
         * 清空聊天记录的二次确认（设计稿的「清空」是破坏性操作，与消息页「清空聊天记录」
         * 用同一套 `AlertDialog` 写法，含确认键的 danger 文字色）。
         */
        if (confirmClearChat) {
            KAlertDialog(
                title = "清空聊天记录",
                text = "确定清空本房间的全部聊天记录吗？清空后不可恢复。",
                confirmText = "清空",
                danger = true,
                onDismissRequest = { confirmClearChat = false },
                onConfirm = {
                    confirmClearChat = false
                    controller.clearChat()
                },
            )
        }

        /**
         * 删除房间的二次确认（破坏性操作，与清空聊天记录同一套写法）。
         * 确认后走服务端 DELETE；成功即退场（离开组合时 DisposableEffect 会退房），
         * 语音房列表回来时会重拉，房间自然消失。
         */
        if (confirmDeleteRoom) {
            KAlertDialog(
                title = "删除房间",
                text = "房间「${room.name}」会被删除，房内成员会被请出，且不可恢复。",
                confirmText = "删除",
                danger = true,
                onDismissRequest = { confirmDeleteRoom = false },
                onConfirm = {
                    confirmDeleteRoom = false
                    scope.launch {
                        when (val r = voice.deleteRoom(room.id)) {
                            is ApiResult.Success -> onBack()
                            is ApiResult.Failure -> pageToast = r.error.displayMessage
                        }
                    }
                },
            )
        }

        pageToast?.let { msg ->
            KToast(
                text = msg,
                onDismiss = { pageToast = null },
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
    /**
     * 「对弈」入口（非 null 才画）。
     *
     * 与 Web 端 `MemberCard` 同一个门控：**自己不给、房间有对局/未决邀请时不给**
     * （见调用点 `chessIdle` 的注释）。点击 → 向该成员发起象棋邀请，发起者固定执红
     * （Web 端快捷邀请也是这个口径，见 `docs/voice-chess-plan.md` 的一期差异说明）。
     */
    onChallenge: (() -> Unit)? = null,
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
            /**
             * 左右各留一档内边距（4dp）。
             *
             * 加在**文字上**而不是卡片上：麦位卡只有约 65dp 宽、头像就占 48dp，
             * 给整张卡加左右内边距会在窄屏（360dp 档）上把头像挤到裁切。
             * 只收窄文字的可排宽度，正好做到用户要的"两边留点空白、超出隐藏"。
             */
            modifier = Modifier.padding(horizontal = KSpacing.xxs),
        )
        // 「对弈」：邀请这位成员下一盘象棋。
        // 只用描边胶囊 + 文字（房间控制条那几个是圆形图标钮，这里塞不下图标 ——
        // 麦位卡只有 ~60dp 宽，加图标必然换行）。字色 accent 表达"可点的动作"，
        // 与「朗读 / 清空」那两个标题行小按钮同一套视觉语言。
        if (onChallenge != null) {
            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(KRadius.pill))
                    .border(1.dp, c.accentBorder, RoundedCornerShape(KRadius.pill))
                    .clickable { onChallenge() }
                    .padding(horizontal = KSpacing.xs, vertical = 1.dp),
            ) {
                Text("对弈", style = KType.tiny, color = c.accentText, maxLines = 1)
            }
        }
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
    reader: ChatReader,
    canClear: Boolean,
    onClear: () -> Unit,
) {
    val c = KTheme.colors
    val listState = rememberLazyListState()
    /** 音色下拉是否展开（与房间「…」菜单同一套 DropdownMenu 写法） */
    var voiceMenuOpen by remember { mutableStateOf(false) }

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
        // ---- 标题行：图标 + 标题 + 朗读开关 + 音色下拉 + 清空 ----
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
                // 系统引擎不可用且当前选的还是系统语音时置灰；切到云端音色即可用
                enabled = reader.ttsSupported,
                onClick = { reader.toggle() },
            )
            // 朗读音色下拉（紧挨朗读按钮右侧，与 Web 端 VoiceChatPanel 的位置一致）：
            // 系统语音（零成本）/ 云端复刻音色（走服务端 /api/tts，Key 与厂商音色 ID 都在服务端）。
            // 系统语音不可用的机型上那一项标「不支持」但**不置灰整个下拉** ——
            // 否则用户切不到云端音色（Web 端同样是"选项置灰、下拉可用"）。
            Box {
                ChatHeaderButton(
                    icon = null,
                    // 「▾」是文字不是图标：设计系统的图标表与 lucide 一一校验过，不为一个箭头开新图标
                    label = "${reader.voiceLabel} ▾",
                    active = false,
                    enabled = true,
                    onClick = { voiceMenuOpen = true },
                )
                DropdownMenu(
                    expanded = voiceMenuOpen,
                    onDismissRequest = { voiceMenuOpen = false },
                    containerColor = c.surfaceRaised,
                    shape = RoundedCornerShape(KRadius.control),
                ) {
                    ChatMenuItem(
                        text = if (reader.systemSupported) "系统语音" else "系统语音（不支持）",
                        color = if (reader.voiceKey == CHAT_TTS_SYSTEM_VOICE_KEY) c.accentText else c.textPrimary,
                    ) {
                        voiceMenuOpen = false
                        reader.chooseVoice(CHAT_TTS_SYSTEM_VOICE_KEY)
                    }
                    CHAT_TTS_CLOUD_VOICES.forEach { v ->
                        ChatMenuItem(
                            text = v.label,
                            color = if (reader.voiceKey == v.key) c.accentText else c.textPrimary,
                        ) {
                            voiceMenuOpen = false
                            reader.chooseVoice(v.key)
                        }
                    }
                }
            }
            if (canClear) {
                ChatHeaderButton(
                    // 用户要求：清空左边不要三个点（原 GlyphKind.More 的 ⋯），只留文字
                    icon = null,
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
                    // 聚焦时**不再**主动滚一次（M6.22）：那次"第一下"与键盘弹起后的逐帧跟随
                    // 叠加会呈现出两段动画（用户实测"跟评论页的输入法动画不一样"）——
                    // 现在跟随是唯一动源，见 VoiceRoomScreen 里 `keyboardOpen` 的长注释。
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
 *
 * `icon` 可为 null：用户要求「清空左边三个点不要」—— 「清空」只留文字，
 * 图标（[GlyphKind.More] 的 ⋯）去掉后按钮仍保留 pill 描边与点击语义。
 */
@Composable
private fun ChatHeaderButton(
    icon: GlyphKind?,
    label: String,
    active: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    val c = KTheme.colors
    val fg = when {
        !enabled -> c.textMuted
        active -> c.accentText
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
        if (icon != null) {
            Glyph(tint = fg, kind = icon, size = 13.dp)
        }
        Text(label, style = KType.tiny, color = fg)
    }
}

/**
 * 一条聊天消息：头像 + 「名字（我） 时间」+ 内容。
 *
 * 点一行 = 朗读这一条（与 Web 端 `onClick={() => tts.handleSpeakMessage(m)}` 同一语义）——
 * 所以即使"新消息自动朗读"关着，也能手动念一条。
 *
 * ⚠️ 可点判据是 [ChatReader.ttsSupported]（**当前所选音色**能不能用），不是"系统引擎在不在"：
 * 系统引擎不可用但选了云端音色时，这里必须仍然可点（Web 端同口径）。
 */
@Composable
private fun ChatMessageRow(
    msg: VoiceRoomController.ChatUi,
    reader: ChatReader,
    modifier: Modifier = Modifier,
) {
    val c = KTheme.colors
    // 正在念的这条：整行高亮 + 名字后标「合成中…」。
    // 云端首段有 2~5 秒静默期，缺了这个反馈用户会以为"点了没反应"而反复点 ——
    // 2026-09-28 的事故（11 秒 20+ 次请求把上游并发槽打满）就是这么来的。
    // 再点一下这一条 = 停止（与 Web 端 handleSpeakMessage 同口径）。
    val speaking = reader.speakingMsgId == msg.id
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(KRadius.row))
            .background(if (speaking) c.accentSoft else Color.Transparent)
            .clickable(enabled = reader.ttsSupported) {
                reader.speak(msg.id, msg.username, msg.content)
            }
            .padding(horizontal = KSpacing.xs, vertical = 2.dp),
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
                // 只有"等云端返回"这一段才显示；出声之后高亮还在（表示这条正在念）
                if (speaking && reader.synthesizing) {
                    Text("合成中…", style = KType.tiny, color = c.accentText)
                }
            }
            Text(
                text = msg.content,
                style = KType.caption,
                color = if (msg.isMine) c.accentText else c.textPrimary,
            )
        }
    }
}

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
 *
 * 注：这段 KDoc 原先**悬在 [ControlSlot] 上面**（连着两个 KDoc，Kotlin 只认紧邻的那个），
 * 等于按钮自己的说明从来没人看得到 —— 顺手挪回它该在的位置。
 */
@Composable
private fun VoiceControlButton(
    icon: GlyphKind,
    active: Boolean,
    onClick: () -> Unit,
    contentDescription: String,
    danger: Boolean = false,
    /**
     * **闭麦警示态**：实心 `danger` 底 + `onAccent` 图标，并在图标上叠一道斜杠（用户实测要求"闭麦变红"）。
     *
     * 为什么不复用 [danger]（录制中）：那一个是 `dangerSoft` 底 + `danger` 图标 + 呼吸环，
     * 底色近乎浅灰 —— 在这一排里读作"浅色按钮"，表达不出"我现在说不出话"。
     * 而"实心红 = 我这个麦克风是关的"是行业里最不需要学习的形状（会议软件都对得上）。
     * 两个都是红，但一个实心一个浅底，且录制那边还有呼吸环与秒数角标，不会混。
     */
    muted: Boolean = false,
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
        // 闭麦优先于其它一切：它是"我说不出话"这个事实，不能被别的语义盖住
        muted -> c.danger
        danger -> c.dangerSoft
        active -> c.accent
        else -> c.surface
    }
    val fg = when {
        muted -> c.onAccent
        danger -> c.danger
        active -> c.onAccent
        else -> c.textPrimary
    }
    Box(contentAlignment = Alignment.Center) {
        if (breathing) {
            KBreathRing(
                color = c.danger,
                /**
                 * ★ **环不许参与布局**（2026-10-15 用户实测："录音打开会触发跳动"）。
                 *
                 * 症状的成因：环比按钮大一圈（原来直接按 50dp + 8dp = 58dp 的实体尺寸
                 * 去参与测量），录制开关一切换，这一格就从 50dp ⇄ 58dp 地变高 ——
                 * 整条控制栏被顶起 8dp、上方内容列跟着收 8dp，整块界面跳一下。
                 *
                 * 解法：尺寸交给 `matchParentSize()`（= 按钮的 50dp 画布，不再撑大布局），
                 * 环按半径比例**越过画布边界绘制**（绘制默认不裁剪，与涟漪/阴影同一机制）。
                 * 半径换算照原视觉：原 58dp 画布下半径 0.86×29 ≈ 25dp（= 按钮边缘）→ 29dp；
                 * 现在画布 25dp 半径，取 base 1.0（25dp 起）+ growth 0.16（扩到 29dp，
                 * 仍是 58dp 直径的外扩量）。
                 */
                modifier = Modifier.matchParentSize(),
                ringSize = KDimens.voiceControl,
                baseRadiusRatio = 1.0f,
                maxGrowth = 0.16f,
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
                    // 描边只属于"未激活的浅底按钮"那一档；闭麦是实心红，再套一圈浅色描边就脏了
                    if (!active && !danger && !muted) {
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
            if (muted) {
                /**
                 * 闭麦再叠一道斜杠（lucide `mic-off` 的读法）。
                 *
                 * 只靠底色说话，对色觉障碍的用户等于没说；而"带斜杠的麦克风"是唯一
                 * 不需要学习的写法 —— Web 端这一格用的也是 `MicOff` 图标。
                 *
                 * 画在**图标自己的 20dp 画布**上（与 [Glyph] 同尺寸），斜线两端各留 10%
                 * 内缩：lucide 的斜杠是 24 网格里的 2→22，这里等比缩下来正好压满图标框，
                 * 再大就会顶到圆形按钮的内沿。线宽**取 24 网格里的 2**（= Glyph 的描边宽度），
                 * 不然斜杠会比麦克风本身粗一圈。
                 */
                Canvas(modifier = Modifier.size(KDimens.navIcon)) {
                    val inset = size.minDimension * 0.1f
                    drawLine(
                        color = fg,
                        start = Offset(inset, inset),
                        end = Offset(size.width - inset, size.height - inset),
                        strokeWidth = size.minDimension * (2f / 24f),
                        cap = StrokeCap.Round,
                    )
                }
            }
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
 * 共享画面右上角的「全屏 / 小窗」按钮组（M6.20，用户要求与 Web 端舞台一致：
 * Web 的 `.controls` 就是 absolute `top:10px right:10px`、间距 8px、34px 圆钮）。
 *
 * ⚠️ 为什么是 **Popup（独立子窗口）** 而不是普通 Compose 叠加：画面框里是
 * `SurfaceViewRenderer`（SurfaceView）—— 它在窗口上"挖洞"，洞区域内的窗口绘制
 * 会被**剪掉**（本工程两次实测：ExoPlayer 的进度条/遮罩、M6.15 时画在这里的旧按钮
 * "能点但看不见"）。Popup 是**独立窗口**、合成在宿主窗口之上（与 Dialog/Toast
 * 能盖住视频是同一个机制），不受洞影响 —— 于是不必把渲染器换成 TextureView，
 * 保住了 Surface 交接与渲染性能。
 *
 * 位置：用 [PopupPositionProvider] 锚在**画面框**（声明它的那个 composable）的右上角 ——
 * 10dp 内缩、按内容宽度右对齐（`anchorBounds` 与返回值都是**窗口坐标系像素**）。
 * `focusable = false`：不抢输入焦点（不打断聊天输入/键盘），按钮之外的触摸照常
 * 落到下面的画面框（点画面 = 全屏）。
 *
 * @param onFullscreen 点「全屏」
 * @param onPip 点「小窗」
 */
@Composable
private fun ShareInlineControlsPopup(
    onFullscreen: () -> Unit,
    onPip: () -> Unit,
) {
    val padPx = with(LocalDensity.current) { 10.dp.roundToPx() }
    Popup(
        popupPositionProvider = remember(padPx) {
            object : PopupPositionProvider {
                override fun calculatePosition(
                    anchorBounds: IntRect,
                    windowSize: IntSize,
                    layoutDirection: LayoutDirection,
                    popupContentSize: IntSize,
                ): IntOffset = IntOffset(
                    x = anchorBounds.right - popupContentSize.width - padPx,
                    y = anchorBounds.top + padPx,
                )
            }
        },
        properties = PopupProperties(focusable = false),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ShareOverlayButton(
                icon = GlyphKind.Maximize,
                active = false,
                label = "全屏观看",
                onClick = onFullscreen,
            )
            ShareOverlayButton(
                icon = GlyphKind.PictureInPicture,
                active = false,
                label = "小窗观看",
                onClick = onPip,
            )
        }
    }
}

/**
 * 共享观看的控制圆钮（声音 / 全屏 / 小窗三类共用）。
 *
 * 形态对齐 Web 端舞台控件：**半透明黑底圆钮 + 白图标** —— 白图标在任何底色上都读得出来，
 * 半透明黑底则让圆钮在浅色主题下也有明确的边界（深色主题下基本只剩图标本身）。
 *
 * 位置变迁（都记在这里，别再翻回去）：
 *  · M6.15：从画面框右上角 → 共享块标题行右侧（画面矩形之外）—— 当时画面内是
 *    SurfaceView 的"洞"，普通 Compose 元素画不出来（那排钮"能点但看不见"）；
 *  · M6.20：全屏 / 小窗**回到画面里**（用户要求与 Web 端一致）—— 关键是改用
 *    **Popup 子窗口**承载（见 [ShareInlineControlsPopup]），不再受洞限制；
 *    声音开关留在标题行（低频操作，且它要在两种宿主状态下都常驻）。
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

/**
 * 共享档位小胶囊（仅共享者可见，见共享舞台里的档位行）。
 *
 * 选中态 = accent 底 + onAccent 字（与底栏"激活"按钮同一套语义色，深浅主题都过对比度）；
 * 未选中 = 描边胶囊 + textPrimary 字。整颗胶囊都是点击区。
 * 颜色规则与 [VoiceControlButton] 的 active 档一致 —— 换配色只改令牌，不改这里。
 */
@Composable
private fun ShareQualityChip(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
) {
    val c = KTheme.colors
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(KRadius.pill))
            .then(
                if (selected) {
                    Modifier.background(c.accent)
                } else {
                    Modifier.border(1.dp, c.borderStrong, RoundedCornerShape(KRadius.pill))
                }
            )
            .clickable(onClick = onClick)
            .padding(horizontal = KSpacing.sm, vertical = KSpacing.xs)
            // 读屏能说出"哪一个当前选中"
            .semantics { this.contentDescription = if (selected) "$label（当前）" else label },
    ) {
        Text(
            text = label,
            style = KType.footnote,
            color = if (selected) c.onAccent else c.textPrimary,
            maxLines = 1,
        )
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
 * 键盘弹出时，输入框（含下边框）停在键盘顶**上方**多少 dp。
 *
 * 不是 0 —— 纯按 tail 扣净后输入框会**贴死/压过**键盘顶（用户实测反馈"太过了"），
 * 用户要的是"**下边框露在键盘上方、之间留一点点**"。收敛轨迹（实测）：
 * 6dp → 12dp → 18dp → 20dp（用户指定）。如需再调，只动这一个数。
 */
private const val COMPOSER_LIFT_DP = 20

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
