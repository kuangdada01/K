/**
 * ============================================================
 * 聊天页（ChatScreen）—— 自 MessagesScreen.kt 拆出（D2，纯移动）
 * ============================================================
 * 与 MessagesScreen（消息 tab 列表）是两个屏幕，此前共用一个 2600 行文件；
 * 本文件持有聊天屏与其专属子件（气泡/上下文菜单/输入区/日期分隔/骨架等）。
 * 会话列表/通知行/公告入口仍在 MessagesScreen.kt；CenteredState 两屏共用，
 * 以 internal 留在那边（同包可见）。
 * ============================================================
 */

package top.kuangdada.k.nativeapp.ui

import android.Manifest
import android.content.ClipData
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import android.os.Build
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.PathOperation
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.util.lerp
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalConfiguration
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import coil3.SingletonImageLoader
import coil3.compose.AsyncImage
import coil3.compose.SubcomposeAsyncImage
import coil3.compose.SubcomposeAsyncImageContent
import coil3.network.httpHeaders
import java.io.File
import kotlin.math.roundToInt
import androidx.core.content.ContextCompat
import kotlin.math.sqrt
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import top.kuangdada.k.core.data.ApiResult
import top.kuangdada.k.core.data.InboxStore
import top.kuangdada.k.core.data.MessageRepository
import top.kuangdada.k.core.data.RealtimeClient
import top.kuangdada.k.core.data.dayDividerText
import top.kuangdada.k.core.data.displayMessage
import top.kuangdada.k.core.data.image.ImageCompressor
import top.kuangdada.k.core.data.timeGapMillis
import top.kuangdada.k.core.designsystem.component.KButton
import top.kuangdada.k.core.designsystem.component.KButtonVariant
import top.kuangdada.k.core.designsystem.component.KEmojiButton
import top.kuangdada.k.core.designsystem.component.KEmojiPanel
import top.kuangdada.k.core.designsystem.component.KPlaceholder
import top.kuangdada.k.core.designsystem.component.KPlaceholderKind
import top.kuangdada.k.core.designsystem.component.KTextField
import top.kuangdada.k.core.designsystem.component.KTextFieldVariant
import top.kuangdada.k.core.designsystem.component.kShimmer
import top.kuangdada.k.core.designsystem.theme.KElevation
import top.kuangdada.k.core.designsystem.theme.KDimens
import top.kuangdada.k.core.designsystem.theme.KMotion
import top.kuangdada.k.core.designsystem.theme.KRadius
import top.kuangdada.k.core.designsystem.theme.KSpacing
import top.kuangdada.k.core.designsystem.theme.KTheme
import com.kyant.backdrop.backdrops.layerBackdrop
import com.kyant.backdrop.backdrops.rememberLayerBackdrop
import top.kuangdada.k.core.designsystem.theme.KType
import top.kuangdada.k.core.designsystem.theme.LocalAnimationsEnabled
import top.kuangdada.k.nativeapp.notify.SocialNotifier
import top.kuangdada.k.nativeapp.ui.viewer.rememberImageViewer

/**
 * 输入栏下方交换区里当前**显示哪一个**面板。
 *
 * 三态互斥：语音（按住说话）/ 表情 / 内嵌相册。原先用三个布尔量各自 `if` 判断，
 * 退场动画期间布尔量已经变 false、高度还在往回收，就会串台成另一个面板
 * （关语音时闪一下表情键盘）—— 这里收成一个单选量，配合"记住最后一次打开的"
 * 解决退场期间的渲染。
 */
private enum class ChatPanel { None, Voice, Emoji, Album }

/**
 * ============================================================
 * 聊天（沉浸态：隐藏底部导航）
 * ============================================================
 * 消息历史是**游标分页**：首屏拉最新 50 条，向上翻页传 `before_id` = 当前最旧一条的 id。
 */
@Composable
fun ChatScreen(
    messages: MessageRepository,
    /**
     * 收件箱（导航角标读的那一份）。
     *
     * 聊天页需要它**只为一件事**：`history()` 会把这个会话的消息在服务端标记成已读，
     * 所以拉完历史要让角标跟着收掉（见 `loadInitial` 里的注释 —— 从通知直接进聊天页时，
     * 消息页从未进过组合，不补这一刀角标就会一直挂着）。
     */
    inbox: InboxStore,
    partnerId: Long,
    partnerName: String?,
    /** 对方的头像（会话列表带过来的绝对地址）；为空时用默认人像 */
    partnerAvatar: String? = null,
    /** 自己的头像（当前登录用户）；为空时用默认人像 */
    myAvatar: String? = null,
    /** SSE 事件流：对方发来新消息时，正在看的这条会话自己刷新出来 */
    realtime: RealtimeClient? = null,
    onBack: () -> Unit,
) {
    val c = KTheme.colors
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()

    /**
     * 这个会话上次拉到的首屏历史（仓库进程内缓存，没有则为 null）。
     *
     * 进来的那一刻先拿它把消息铺上：用户反馈「点进对话消息中间有个加载圈」——
     * 那一圈之所以去不掉，是因为每次进来都要等一次网络往返。有缓存时连"加载"这个状态
     * 都不会出现（见下面的 [loading] 初值），只在真的第一次打开时才走骨架。
     */
    val cachedHistory = remember(partnerId) { messages.cachedHistory(partnerId) }

    var items by remember {
        // 先用仓库里的进程内缓存**直接渲染**（重进同一个会话不空白、不出加载圈），随后静默刷新。
        // 与消息页的会话列表同一套做法；缓存由 MessageRepository.history 与下面的回写维护。
        mutableStateOf(cachedHistory?.first ?: emptyList())
    }
    var hasMore by remember { mutableStateOf(cachedHistory?.second ?: false) }
    var loading by remember { mutableStateOf(cachedHistory == null) }
    var sending by remember { mutableStateOf(false) }
    /** 内嵌相册面板：点相册图标在交换区展开最近照片，左下角「相册」才进系统全屏 */
    var albumOpen by remember { mutableStateOf(false) }
    /**
     * 相册「上滑松手发送」的拖拽预览（浮层画在整页层级，见 [AlbumDragOverlay]）。
     *
     * 拆成几个状态而不是一个对象：
     *  · [albumDragPainter] 只在按住/清空时变（低频）→ 用它决定浮层显隐，同时也交给
     *    相册面板把**那一格画成透明**（原位留空）；
     *    **是相册格子里那张已经解码好的位图**，不是 uri —— 浮层拿到什么画什么，
     *    不会再走一次取图/解码（用户："不需要重新加载一张"）；
     *  · [albumDragDx] / [albumDragDy] **每帧都变** → 只在浮层的 `graphicsLayer { }`
     *    里读，走绘制期读取、不进组合；否则拖着图每帧重组整个 ChatScreen
     *    （连消息 LazyColumn 的 item DSL 一起，帧率会直接塌）；
     *  · [albumDragReleased] 松手时为 true，浮层据此播"丢出去 / 落回相册"的退场。
     */
    var albumDragPainter by remember { mutableStateOf<Painter?>(null) }
    var albumDragDx by remember { mutableFloatStateOf(0f) }
    var albumDragDy by remember { mutableFloatStateOf(0f) }
    /** 松手了（或正在退场）：浮层播完"丢出去 / 落回相册"再回调清状态 */
    var albumDragReleased by remember { mutableStateOf(false) }
    /** 被按住那一格在屏幕上的矩形：浮图从**这里**被拎起来，而不是凭空出现在屏幕中央 */
    var albumDragBounds by remember { mutableStateOf(Rect.Zero) }
    /**
     * 输入内容。**刻意用 MutableState 而不是 `var input by`**：组合期唯一读它的地方
     * 是 [ChatInputField] 内部的 `input.value`（KTextField 的 value）—— 读取被圈在
     * 那个最小作用域里，打字时只有输入框重组，整页 body（含消息 LazyColumn）不动。
     * 其余对它的读写全在事件回调里（发送/选表情），事件期读取不参与组合。
     */
    val input = remember { mutableStateOf("") }
    var replyTo by remember { mutableStateOf<MessageRepository.MessageUi?>(null) }
    /**
     * 输入框的焦点句柄：**点「引用」要把焦点交给它**，IME 随之弹起，用户直接就能打字。
     *
     * 与详情页评论框同一套做法（见 `PostDetailScreen.inputFocusRequester`）。
     * `runCatching` 在真正的调用点上兜"节点还没附着"的极端时序，不会崩。
     */
    val inputFocusRequester = remember { androidx.compose.ui.focus.FocusRequester() }
    var error by remember { mutableStateOf<String?>(null) }
    var toast by remember { mutableStateOf<String?>(null) }
    var menuOpen by remember { mutableStateOf(false) }
    var confirmClear by remember { mutableStateOf(false) }

    /**
     * 发送图片（用户要求：聊天输入栏加发图功能）。
     *
     * 用系统 Photo Picker（`PickVisualMedia.ImageOnly`）而不是自绘相册：
     * 零存储权限，用户能拿到"最近/相册/文件"全部来源 —— 与发帖页选图同一条
     * 流水线：拷进 cacheDir（选择器的读权限是**临时的**）→ [ImageCompressor]
     * 本地压一道（失败回退原图，压缩是优化、绝不能变成"发不出图"）→
     * multipart 的 `image` 字段上传（服务端 content/image 至少其一即可）。
     *
     * 行为对齐微信：**选完立即作为独立消息发出**，输入框里正在打的字不动；
     * 引用条开着的话图片消息也带上引用，发出即消费（与文字发送同语义）。
     *
     * 上传期间复用 [sending]：发送按钮显示"…"，发图按钮忽略再次点击。
     * 选择器回调必须注册在组合作用域（它随页面存活，不会丢结果）。
     */
    val context = LocalContext.current

    /**
     * 发一张图片（选图后的公共流水线）：拷进 cacheDir → 本地压缩 → multipart 上传。
     *
     * 内嵌相册多选与系统全屏 Picker 都走这里，避免两套压缩/失败处理。
     */
    suspend fun sendImageUri(uri: Uri, quotedMessageId: Long?): Boolean {
        val file = withContext(Dispatchers.IO) {
            copyUriToCache(context, uri)?.let { raw ->
                ImageCompressor.compressFile(context, raw)?.also { raw.delete() } ?: raw
            }
        }
        if (file == null) {
            toast = "读取图片失败，请重试"
            return false
        }
        return when (
            val r = messages.send(
                partnerId,
                "",
                image = file,
                quotedMessageId = quotedMessageId,
            )
        ) {
            is ApiResult.Success -> {
                items = items + r.data
                true
            }
            is ApiResult.Failure -> {
                toast = r.error.displayMessage
                false
            }
        }
    }

    /**
     * 批量发图（内嵌相册最多 9 张；系统 Picker 也走这里）。
     *
     * 服务端一条消息只带一张图 → 逐张发成多条；引用只落在第一张上，
     * 发完统一滚到最新、关掉相册面板。
     */
    fun sendImageUris(uris: List<Uri>) {
        if (uris.isEmpty()) return
        if (sending) {
            toast = "正在发送，请稍候"
            return
        }
        scope.launch {
            sending = true
            var quoted = replyTo?.raw?.id
            var sent = 0
            try {
                for (uri in uris.take(9)) {
                    if (!sendImageUri(uri, quoted)) break
                    sent += 1
                    quoted = null // 引用只跟第一张
                }
                if (sent > 0) {
                    replyTo = null
                    albumOpen = false
                    listState.animateScrollToItem(0)
                }
            } finally {
                sending = false
            }
        }
    }

    /**
     * 系统全屏 Photo Picker：只有内嵌相册左下角「相册」才走这里。
     * 最多 9 张，不需要存储权限（拒绝相册权限时的兜底）。
     */
    val pickChatImage = rememberLauncherForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(9)
    ) { uris: List<Uri> ->
        sendImageUris(uris)
    }

    /**
     * ============================================================
     * 语音消息（2026-10-19，QQ 式）
     * ============================================================
     * 交互：长按麦克风开始 → 松开发送 / 上滑取消；录音时悬浮条显示实时波形与计时。
     * 录音器见 [VoiceRecorder]（MediaRecorder + 每 60ms 采 maxAmplitude 生成波形）。
     *
     * 发送走与图片同一条流水线：multipart 上传 → 成功后把服务端返回的消息追加到列表
     * （不做本地假气泡：60s 语音约 0.5MB，上传通常 1 秒内完成，失败用 toast 提示重录）。
     */
    val recorder = remember { VoiceRecorder(context) }
    DisposableEffect(recorder) { onDispose { recorder.cancel() } }
    var recordingVoice by remember { mutableStateOf(false) }
    var recordCancelZone by remember { mutableStateOf(false) }
    var sendingVoice by remember { mutableStateOf(false) }
    /** 最近 24 个振幅采样（录音悬浮条的实时波形） */
    var recordLevels by remember { mutableStateOf<List<Int>>(emptyList()) }
    /** QQ 式语音模式：功能排的麦克风是**开关**，打开后在下方显示「按住说话」大按钮 */
    var voiceMode by remember { mutableStateOf(false) }

    fun finishVoiceRecording() {
        if (!recordingVoice) return
        recordingVoice = false
        recordCancelZone = false
        val result = recorder.stop()
        if (result == null) {
            // <1 秒 / 编码失败：录音器已删除半截文件
            toast = "说话时间太短"
            return
        }
        sendingVoice = true
        scope.launch {
            val quoted = replyTo?.raw?.id
            when (
                val r = messages.send(
                    receiverId = partnerId,
                    content = "",
                    quotedMessageId = quoted,
                    audio = result.file,
                    audioDurationMs = result.durationMs,
                    audioWaveform = result.waveform,
                )
            ) {
                is ApiResult.Success -> {
                    items = items + r.data
                    replyTo = null
                    // reverseLayout：新消息在 index 0
                    listState.animateScrollToItem(0)
                }
                is ApiResult.Failure -> toast = r.error.displayMessage
            }
            result.file.delete()
            sendingVoice = false
        }
    }

    fun cancelVoiceRecording() {
        if (!recordingVoice) return
        recordingVoice = false
        recordCancelZone = false
        recorder.cancel()
        recordLevels = emptyList()
    }

    /** 关掉语音面板：正在录的话一并取消（面板都不在了，不该继续占麦克风） */
    fun closeVoiceMode() {
        if (recordingVoice) cancelVoiceRecording()
        voiceMode = false
    }

    fun startVoiceRecording(): Boolean {
        if (sendingVoice) {
            toast = "正在发送语音，请稍候"
            return false
        }
        if (!recorder.start(onMaxReached = { finishVoiceRecording() })) {
            toast = "录音启动失败，请稍后再试"
            return false
        }
        recordingVoice = true
        recordCancelZone = false
        recordLevels = emptyList()
        return true
    }

    val recordPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted: Boolean ->
        // 授权回调时手指通常已经抬起：这里**不自动开录**（否则没人松手，会一直录到 60s）。
        // 只提示用户再按一次，交互闭环更清楚。
        toast = if (granted) "麦克风已授权，请再按住说话" else "需要麦克风权限才能发送语音"
    }
    val hasRecordPermission = ContextCompat.checkSelfPermission(
        context,
        Manifest.permission.RECORD_AUDIO,
    ) == PackageManager.PERMISSION_GRANTED

    // 实时波形：录音期间每 60ms 取一次振幅（与录音器采样同频）
    LaunchedEffect(recordingVoice) {
        while (recordingVoice) {
            recordLevels = (recordLevels + recorder.level).takeLast(24)
            delay(60)
        }
    }

    /**
     * 语音播放：一个聊天页一个控制器 → 同一时间只播一条。
     * 鉴权头随 token 变化重建（否则续期后旧 token 会让语音 403）。
     */
    val voiceHeaders = messages.imageHeaders()
    val voicePlayer = remember(voiceHeaders) { VoicePlaybackController(context, voiceHeaders) }
    DisposableEffect(voicePlayer) { onDispose { voicePlayer.release() } }
    LaunchedEffect(voicePlayer) { voicePlayer.onError = { toast = it } }
    LaunchedEffect(voicePlayer.isPlaying, voicePlayer.currentId) {
        // 每帧刷新一次（60/120Hz）：进度竖线必须连续走，不能 100ms 跳一格
        while (voicePlayer.isPlaying) {
            withFrameNanos { voicePlayer.refreshPosition(it) }
        }
    }

    // 退到后台：语音暂停、录音取消（麦克风不能留在后台继续采）
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner, voicePlayer) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) {
                voicePlayer.pause()
                cancelVoiceRecording()
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    /**
     * 表情面板开合（用户要求：私信聊天加表情功能）。
     *
     * 面板是**内联在输入栏下方**的（不是 Popup）：它与输入栏同属一列，
     * 开合只推挤这一列的高度，消息列表的位置不受影响；Popup 则要自己算位置、
     * 还要处理点外面关闭，在沉浸态页面里更容易和顶栏浮层打架。
     */
    var emojiOpen by remember { mutableStateOf(false) }
    /**
     * 收起**所有**输入辅助面板（语音 / 表情 / 内嵌相册）。
     *
     * 点消息列表空白、上下滑动消息列表都走这里。此前点空白只写了 `emojiOpen = false`，
     * 语音/相册面板开着时点哪儿都收不掉 —— 就是用户反馈的「功能区不能点击其他地方收起」。
     *
     * **收起不是瞬间的**：三个开关关掉后，`panelFraction` 会 `animateTo(0f)` 把交换区
     * 高度缩回导航栏那一档，面板内容按 `lastOpenPanel` 继续画到高度归零为止（见上面的
     * 展开曲线）。所以调用方只管关开关，不用自己处理"闪一下就没"。
     */
    fun closeComposerPanels() {
        // 录音中要连麦克风一起停：面板都不在屏幕上了，不该继续占着麦克风
        closeVoiceMode()
        emojiOpen = false
        albumOpen = false
    }
    /**
     * 输入框的聚焦态。聚焦 = 要打字 → 面板给键盘让位，但**不是立刻撤** ——
     * 立刻撤的话面板先消失、输入栏先掉到屏幕底、再被升起的键盘顶回来，
     * 正是用户反馈的"点表情再点输入框，输入框从底下抬起，不自然"。
     * 让位走下面「键盘/表情交换区」的**等高交接**（等键盘升到面板等高才收面板）。
     *
     * 走 [MutableInteractionSource] 而不是给 KTextField 包 onFocusChanged：
     * 组件本身不暴露焦点回调，但它的 `interactionSource` 参数就是为这种
     * "调用方要自己读聚焦态"的场景留的口子（见 KTextField 的文档）。
     */
    val inputInteraction = remember { MutableInteractionSource() }
    val inputFocused by inputInteraction.collectIsFocusedAsState()

    /**
     * @param silent 静默刷新：**不显示骨架**。有缓存时走这条 —— 内容已经在屏幕上了，
     *   再闪一下骨架反而像"消息被重新加载了一遍"。
     */
    suspend fun loadInitial(silent: Boolean = false) {
        if (!silent) loading = true
        error = null
        when (val r = messages.history(partnerId)) {
            is ApiResult.Success -> {
                items = r.data.first
                hasMore = r.data.second
                /**
                 * ★ `history()` **有副作用**：服务端在 `listMessageHistory` 里会把对方发来的
                 * 消息标记成已读。所以这次拉取之后，"未读"这件事在服务端已经变了，
                 * 而导航胶囊的角标读的是 [inbox] 的快照 —— 不刷新它，角标就会一直挂着。
                 *
                 * 用户实测反馈（2026-10-07）：「通知栏点进去消息、退出后消息角标还在，
                 * 还要再点进消息页一次才消」—— 正是这一条：从通知进聊天页时消息页**从未进过组合**，
                 * 只有它挂载时才会对账；而这里补一次，任何入口进来都能把角标收掉。
                 */
                inbox.refresh()
            }
            is ApiResult.Failure -> error = r.error.displayMessage
        }
        loading = false
    }

    /**
     * 用户是否**主动拖动过**这个列表。
     *
     * 一旦拖过就不再自动贴底 —— 否则用户正在翻历史时会被新消息硬拽回底部。
     * 写入点复用下面那个已经在监听 `interactions` 的 collect（它本来用于"拖列表时收键盘"）。
     */
    var userDragged by remember { mutableStateOf(false) }

    /**
     * 进入这个会话：先用进程内缓存铺一屏、再静默刷新。
     *
     * ★ "贴底"**不在这里做**，见下面那个 `LaunchedEffect(items, userDragged)`。
     */
    LaunchedEffect(partnerId) { loadInitial(silent = items.isNotEmpty()) }

    /**
     * 把列表保持在底部（`reverseLayout` 下 index 0 就是最新一条）。
     *
     * ★ 判据是**"用户还没主动滚动过"**，而不是"只在拉完首屏钉一次"——
     * 上一版就是后者，用户复测**仍然不贴底**。原因是这个页面的首屏数据**多段到达**：
     *   ① 进页面先铺进程内缓存 → ② `loadInitial` 静默刷新的结果整体替换 →
     *   ③ 之后 SSE 还会再来一次。
     * 每次替换都会让 LazyColumn 重新测量，而滚动锚点锚的是"当时那个 item"——
     * 后面几段一到，锚点就漂了。只钉第 ② 步，第 ③ 步照样漂回去。
     *
     * 更关键的是**时机**：旧写法要等 `loadInitial()`（一次网络往返）返回才钉，
     * 而用户从"点进会话"到"网络返回"这段时间看到的位置就是错的；他若在这期间
     * 顺手往上滑一下（很自然会这么做），之后也没人再把列表拉回底部了。
     *
     * 所以改成"用户没动手之前**一直**贴底"，用户一拖就让位。
     * 用 `scrollToItem`（瞬时）而不是动画：这里要的就是"首帧就在底部"，
     * 动画反而会让用户看到列表自己滑一下。
     */
    LaunchedEffect(items, userDragged) {
        if (!userDragged && items.isNotEmpty()) {
            listState.scrollToItem(0)
        }
    }

    /**
     * 进会话 = 这条消息已经看到了：把它的通知栏提醒撤掉。
     *
     * `autoCancel` 只覆盖"**点了那条通知**进来"这一条路径 —— 从消息列表点进来、
     * 或从他人主页点私信进来时，那条通知会一直挂在通知栏，看着像"还没读"。
     */
    LaunchedEffect(partnerId) { SocialNotifier.clearMessage(context, partnerId) }

    /**
     * 本地改动（发送 / 撤回 / 清空 / 翻页）也**回写缓存**。
     *
     * 只在 [MessageRepository.history] 里写缓存的话，这些改动要等到"下一次真的拉了首屏"
     * 才进缓存 —— 中间重进会话会先闪出旧内容（最明显的是**已撤回的那条又出现一下**才消失）。
     */
    LaunchedEffect(items, hasMore) { messages.rememberHistory(partnerId, items, hasMore) }

    /**
     * SSE：**正在看的这条会话**来了新消息就自己刷出来（微信那种"对方发来立刻出现"）。
     *
     * 服务端对收发双方都推 `message` 事件，`from` 是发送者 —— 所以
     * `from == partnerId`（对方发来）或 `to == partnerId`（我在别的端发的）都该刷新。
     *
     * ★ 收到事件后**按 id 合并**而不是整体替换（2026-10-11 审查修复）：
     * 用户向上翻过几页历史后 items 里已有几百条更早的消息，`history()` 只回最新
     * 50 条 —— 整体替换会把翻页加载的历史冲掉、滚动锚点跳变。合并规则：
     *  · fresh 页里已有的 id → 按新数据原位更新（对齐撤回后的状态）；
     *  · 本地有、但 id ≥ fresh 最小 id 又不在 fresh 页里的 → 已被撤回/删除 → 移除；
     *  · id 更小的（翻页加载的更早历史）→ 保留。
     * fresh 的新消息 id 必然大于既有最大 id，两段拼接天然保持 oldest-first。
     */
    LaunchedEffect(realtime, partnerId) {
        if (realtime == null) return@LaunchedEffect
        realtime.events.collect { event ->
            if (event.isMessage && (event.from == partnerId || event.to == partnerId)) {
                when (val r = messages.history(partnerId)) {
                    is ApiResult.Success -> {
                        val fresh = r.data.first
                        val minFreshId = fresh.minOfOrNull { it.raw.id } ?: Long.MAX_VALUE
                        val freshById = fresh.associateBy { it.raw.id }
                        val existingIds = items.mapTo(HashSet()) { it.raw.id }
                        items = items
                            .filter { it.raw.id < minFreshId || it.raw.id in freshById }
                            .map { freshById[it.raw.id] ?: it } +
                            fresh.filter { it.raw.id !in existingIds }
                        hasMore = r.data.second
                    }
                    is ApiResult.Failure -> Unit // 静默：不打断正在输入的用户
                }
            }
        }
    }

    // 按自然日切分隔条（设计稿顶部那条「今天 14:32」）
    val entries = remember(items) { buildChatEntries(items) }

    /**
     * 这一段对话里的**全部图片**（时间正序）。
     *
     * 点开任意一张时把它整段交给查看器：聊天里翻图本该能左右滑着看完这段对话的图，
     * 只给一张的话用户看完还得退回来再点下一张。
     *
     * 不走 `postId` / 来源登记（那是帖子配图的几何飞行用的）——私信图片没有"九宫格来源格"
     * 这套东西，查看器会直接落位。
     *
     * ★ 必须取 [MessageRepository.MessageUi.imageUrl]（**已 resolveUrl 的绝对地址**），
     * 不是 `raw.imageUrl`：DTO 里那份是服务端给的相对路径（`/uploads/messages/…`），
     * 交给查看器就是"图片加载失败"（Coil 拿相对地址无法发起请求）。
     * 气泡自己一直用的是 `msg.imageUrl`，所以缩略图正常、全屏那张却挂 —— 两个字段不是一回事。
     */
    val chatImageUrls = remember(items) { items.mapNotNull { it.imageUrl } }
    // 点消息列表的空白处收起键盘（输入时键盘挡着半屏内容）
    val keyboard = LocalSoftwareKeyboardController.current
    // 私密图片必须带 JWT 头，查看器与保存都靠它
    //
    // **看图前收键盘**（2026-09-25 反馈：打字时点聊天里的图片，键盘压在
    // 全屏查看器上面，层级错乱）：IME 是系统窗口，**永远盖在应用内容之上**，
    // 查看器是本窗口内的覆盖层、盖不过它 —— 所以打开查看器前把键盘收掉
    // （见 onImageClick）。**关闭后不自动弹回**（同日反馈"退出不用再启用"）：
    // 看完图回到聊天页是安静的，要打字再点输入框 —— 与"发图按钮从相册回来
    // 键盘自动弹回"是两条刻意不同的路径。
    val openViewer = rememberImageViewer(topInsetPx = { 0f })
    /**
     * 离开这段对话时**注销它那一组图片来源**。
     *
     * 为什么必须清：来源表是全局的（挂在 Shell 上），气泡登记的是"这一格在窗口里的矩形"。
     * 页面退出后这些矩形已经不作数，若留在表里，下次从别的地方用同一个键查就会拿到过期位置。
     * （单格的 `removeToken` 在气泡被回收时也会走，但**不确定每种退出路径都会触发**——
     * 沉浸页整页移除时格子未必逐个 dispose 完，所以这里按"整组"再兜一次，幂等无害。）
     */
    val viewerOrigins = LocalViewerOrigins.current
    DisposableEffect(viewerOrigins, partnerId) {
        onDispose { viewerOrigins?.removeChatOrigins(partnerId) }
    }

    Box(modifier = Modifier.fillMaxSize().background(c.bgPage)) {
        // 顶栏真毛玻璃：Kyant0 的 backdrop 库。用法与注意事项见 BooksScreen 同段注释
        // （要点：backdrop 里先铺页底色；**不要加 vibrancy/colorFilter**，本机实测会打断效果链）。
        val canBlur = Build.VERSION.SDK_INT >= 31
        val pageBg = KTheme.colors.bgPage
        // 色膜厚度：决定"透出多少背后的颜色"。
        //  · 0.92 = 背后几乎全盖住（最稳，但颜色也看不出来）；
        //  · 0.85 = 当前值 —— 背后贡献 15%，能透出图片的色调，而**形状早就被 32dp 模糊糊没了**，
        //    所以透出来的是颜色、不是字。沸腾在重度模糊的色场上表现为缓慢的色彩漂移，不是"沸腾"。
        //  · 再往下调会更透，但残留细节会重新变得可辨、沸腾也会回来。
        val frostedTint = KTheme.colors.frosted.copy(alpha = 0.85f)
        // 玻璃源：**本页自己录**（内容列上挂 layerBackdrop）。顶栏在 shell 那层的内容里，
        // 采样 shell 那层会自引用（无限递归 → 原生崩溃），所以这里只用页面级的源；
        // 细节与理由见 rememberTopBarGlass 的注释。
        val backdrop = rememberLayerBackdrop(onDraw = rememberBackdropOnDraw(pageBg))
        // 焦点管理器：开表情面板时**清掉输入框焦点**（见 KEmojiButton 的 onClick）
        val focusManager = LocalFocusManager.current
        /**
         * 点「引用」的**唯一出口**（长按菜单那一项走这里）。
         *
         * 用户要求的两件事都落在这个函数里：
         *  1. **引用后自动聚焦输入框、唤起输入法** —— 引用完就是要接着打字，
         *     再让用户手动点一下输入框是多一步；语义与详情页点「回复」完全一致
         *     （见 `PostDetailScreen` 的 `onReply`）。
         *  2. **键盘已经开着时不许把它收掉** —— 长按菜单是 `Popup(focusable = true)`，
         *     弹出时本身会抢走焦点、把 IME 收掉；所以这里**必须重新把焦点交还输入框**
         *     并再 `show()` 一次（`requestFocus()` 在"焦点刚从别处回来"时
         *     不一定会自己弹 IME，少数机型尤其明显）。
         *
         * `requestFocus()` 必须**先于** `show()`：反过来的话，系统先按"当前聚焦节点"起 IME，
         * 那时焦点还在 Popup 上，等于白喊。
         *
         * `keyboard?.show()` 带 150ms 的等待：菜单刚 `dismiss` 时弹层窗口还在拆，
         * 同一帧喊 show 会被系统忽略（表现就是"还是不弹"）。这个延迟只在"引用"这一条
         * 用户动作上出现，看不见也不影响其它交互。
         */
        fun quoteMessage(target: MessageRepository.MessageUi) {
            replyTo = target
            runCatching { inputFocusRequester.requestFocus() }
            scope.launch {
                // 让菜单的退场先走完（Popup 窗口销毁是异步的），再喊起 IME
                kotlinx.coroutines.delay(KEYBOARD_SETTLE_MS)
                keyboard?.show()
            }
        }
        /**
         * 上下翻聊天记录时**也**收起键盘与输入辅助面板（用户反馈：只有"点一下"能收，
         * 翻记录时不收）。
         *
         * 判据是**用户手指拖拽的起点**（[DragInteraction.Start]），不是
         * `listState.isScrollInProgress` —— 后者把**程序化滚动**也算进去，而发完消息
         * `animateScrollToItem(0)` 会自动滚到底：用它的话"发一条消息键盘就没了"，
         * 连发几条根本没法用。拖拽交互是 `scrollable` 里只有手指真的在拖才会发的事件，
         * 惯性甩动属于同一次拖拽（起点已经收过键盘，不需要重复收）。
         *
         * 面板收起走 `panelFraction.animateTo(0f)`（约 300ms 弹簧），和手指的拖动并行，
         * 不是"一滑就啪一下没了"；列表是 `reverseLayout`，交换区变矮只是从底部让出空间，
         * 已有内容不会跟着跳。
         */
        LaunchedEffect(listState) {
            listState.interactionSource.interactions.collect { interaction ->
                if (interaction is DragInteraction.Start) {
                    // 用户动手了：从此不再自动贴底（判据见 ChatScreen 里 userDragged 的注释）
                    userDragged = true
                    keyboard?.hide()
                    closeComposerPanels()
                }
            }
        }
        // 顶栏的实际高度：列表的 contentPadding.top 按它让位 —— 滚到最顶上时最老的消息
        // 正好停在顶栏之下；平时消息从顶栏底下穿过（毛玻璃）
        // 顶栏高度：首帧先用估算值起步，实测值到达后覆盖。
        // 若从 0 起步，最老的消息会先顶到最上面、测量回来后才弹到顶栏之下 ——
        // 真机表现就是"刚进页面时顶栏高矮跳一下"（见 kTopBarHeightEstimatePx）。
        val estimatedTopBarPx = kTopBarHeightEstimatePx(bottomPadding = KSpacing.md)
        var measuredTopBarPx by remember { mutableIntStateOf(0) }
        val density = LocalDensity.current
        val topBarPx = if (measuredTopBarPx > 0) measuredTopBarPx else estimatedTopBarPx
        val topInset = with(density) { topBarPx.toDp() }

        /**
         * ============================================================
         * 键盘 / 表情面板「交换区」（QQ/微信式原地换位）
         * ============================================================
         * 输入栏下面的那片地方由两样东西轮流占据：键盘（系统窗口，盖在应用之上）
         * 或表情面板。老实现的两处别扭都出在"两边各自动画、谁也不管谁"：
         *
         *  · 面板开着点输入框：面板先瞬间撤掉 → 输入栏掉到屏幕底 → 键盘再把它
         *    顶起来（用户反馈的"输入框从底下抬起，不自然"）；
         *  · 键盘开着点笑脸：键盘收起与面板展开各走各的，输入栏先降后升。
         *
         * QQ/微信的做法是**面板与键盘等高、原地互换、输入栏纹丝不动**，照搬：
         *
         *  1. 面板高度 = 上一次键盘的全高（还没弹过键盘时退回 240dp + 导航栏）；
         *  2. 交换区高度 = max(IME 高, 面板高×展开比例, 导航栏高)。输入栏永远贴在
         *     交换区顶上，所以切换瞬间交换区高度不变，输入栏就不动；
         *  3. 面板→键盘：聚焦后面板**不撤**，等 IME 升到面板等高（键盘把面板完全
         *    盖住）才收 —— 全程输入栏不动；IME 根本不来（实体键盘等）由
         *    [IME_HANDOFF_TIMEOUT_MS] 兜底正常收起；
         *  4. 键盘→面板：面板**瞬时**占满交换区（此刻 IME 还没降完，max 取面板高），
         *    键盘向下滑走正好把面板露出来，输入栏同样不动。
         *
         * 为什么自己驱动展开比例、不用 AnimatedVisibility：交换区高度要拿
         * 面板的**实时高度**参与 max() 运算，AnimatedVisibility 只动画自己的子节点，
         * 外面拿不到中间值。
         */
        val animationsEnabled = LocalAnimationsEnabled.current
        // ★ 2026-09-28 重组优化：组合期**只捕获 insets 对象、不读值**。
        // 老实现在根作用域读 `WindowInsets.ime.getBottom()` —— 等于让整页订阅 IME 高度，
        // 键盘每一帧动画（120Hz 约 36 帧）都把整页 body（含消息 LazyColumn 的 item DSL）
        // 重组一遍。现在值改由 [exchangeZoneHeight] / [exchangeZoneBottomInset] 在
        // layout 期读取，每帧只重布局交换区那一个节点，不进 composition。
        val ime = WindowInsets.ime
        val nav = WindowInsets.navigationBars
        val navBottomPx = nav.getBottom(density)
        /** 键盘最近一次的**全高**（升起动画取最大值即终值）；面板与其等高才能原地换位 */
        var lastImeBottomPx by rememberSaveable { mutableIntStateOf(0) }
        /**
         * IME 高度的**镜像状态**（面板↔键盘交接等待用，见下面 LaunchedEffect(inputFocused)）。
         * 老实现靠"每次重组回写"喂它，根作用域因此被迫订阅 IME；现在改由下面的
         * snapshotFlow 在 IME 变化时直接喂 —— 组合期零参与。
         */
        var imeBottomState by remember { mutableIntStateOf(0) }
        LaunchedEffect(density) {
            // snapshotFlow 里读 insets 的底层快照状态：变化只触发这里重新发射，
            // 不触发任何重组（捕获的 ime/nav 是 WindowInsetsHolder 里的稳定单例）
            snapshotFlow { ime.getBottom(density) }.collect {
                imeBottomState = it
                if (it > lastImeBottomPx) lastImeBottomPx = it
                // 跨页共享：别的地方以后弹键盘，聊天页的面板也能按真实高度画
                if (it > 0) KeyboardHeightMemory.lastDp = with(density) { it.toDp().value }
            }
        }

        /**
         * 面板全高（与 IME 全高同口径，都含导航栏那一条）。
         *
         * **只认"键盘高度"这一种高度**（用户反馈："功能区有两种高度，只保留键盘唤起
         * 在点功能区的高度"）——以前没弹过键盘时退回 `导航栏 + 240dp`，和真实键盘高度
         * 差着一大截，同一个面板第一次点、弹过键盘后点会是两个高度。现在：
         *  1. 本次会话量到过键盘 → 用它；
         *  2. 本次没量到、但进程里别处量到过 → 用那个（[KeyboardHeightMemory]）；
         *  3. 完全没量到过（刚装好就点相册）→ 按屏高 42% 估一个，量级和常见键盘一致。
         */
        val panelHeightPx = when {
            lastImeBottomPx > 0 -> lastImeBottomPx
            KeyboardHeightMemory.lastDp > 0f ->
                with(density) { KeyboardHeightMemory.lastDp.dp.toPx() }.roundToInt()
            else -> (LocalConfiguration.current.screenHeightDp * density.density * 0.42f).roundToInt()
        }
        val panelGridHeightDp = with(density) { (panelHeightPx - navBottomPx).toDp() }

        /** 面板展开比例 0..1：0 = 收起，1 = 与键盘等高占满交换区 */
        val panelFraction = remember { Animatable(0f) }
        /** 面板全高（dp）：语音/相册面板按这个高度画，由交换区的 clipToBounds 裁剪 */
        val panelFullHeightDp = with(density) { panelHeightPx.toDp() }
        /** 该显示哪个面板（三选一）。见下方 [shownPanel] 为什么要留一个 last。 */
        val openPanel = when {
            voiceMode -> ChatPanel.Voice
            albumOpen -> ChatPanel.Album
            emojiOpen -> ChatPanel.Emoji
            else -> ChatPanel.None
        }
        /**
         * 关闭面板时布尔量先变 false，但高度还在 `panelFraction` 上做退场动画 ——
         * 这段时间必须继续画**刚才那个**面板。不留 last 的话，关语音的那一帧
         * 会落进"否则画表情面板"的分支，用户看到的就是"关语音闪一下表情键盘"。
         */
        var lastOpenPanel by remember { mutableStateOf(ChatPanel.None) }
        SideEffect { if (openPanel != ChatPanel.None) lastOpenPanel = openPanel }
        val shownPanel = if (openPanel != ChatPanel.None) openPanel else lastOpenPanel

        LaunchedEffect(emojiOpen, voiceMode, albumOpen) {
            /**
             * 三个面板共用**一条**展开曲线（2026-10-20）。
             *
             * 两次"跳"的根因：
             *  1. 交换区高度原来写成 `if (voiceMode || albumOpen) 1f else panelFraction.value`：
             *     开语音/相册是**一帧拉到满高**（输入栏瞬移上去），关的时候却有 animateTo(0)
             *     的退场动画 —— 进硬跳、出慢收，点一下就是"弹一下"；
             *  2. 语音模式下键盘是收着的（进语音时 hide + clearFocus），此时点表情，
             *     emoji 分支里 `if (ime.getBottom() > 0) 1f else 0f` 判到 IME=0，把已经
             *     满高的 panelFraction **写回 0** —— 于是「语音 → 表情」先塌到底再长回来。
             *     bd8bbb2 只冻结了进语音时的 fraction，没堵住 emoji 分支这条回写。
             *
             * 现在：高度只认 panelFraction（见交换区 Box）；打开时**从当前值动画到 1**
             * （已在 1 就原地不动，面板互切天然等高无缝）；只有"键盘正占着交换区"
             * 这一种情况才瞬时占满，否则面板会从键盘底下顶出来、输入栏跟着跳。
             */
            if (openPanel == ChatPanel.None) {
                if (!animationsEnabled) panelFraction.snapTo(0f)
                else panelFraction.animateTo(0f, KMotion.spatialBounded<Float>())
                return@LaunchedEffect
            }
            // 事件期读取 IME 高度（effect 每次开关只跑一次，不订阅键盘动画）
            val imeUp = ime.getBottom(density) > 0
            if (!animationsEnabled || imeUp) {
                panelFraction.snapTo(1f)
            } else {
                panelFraction.animateTo(1f, KMotion.spatialBounded<Float>())
            }
        }

        // 交换区高度（键盘/面板/导航栏三者取大）不再在组合期算 —— 见
        // ExchangeZone.kt：消费它的两个节点（下面的交换区 Box 与 toast 让位）
        // 都改用布局期读取的 modifier，动画期间整页不再重组。

        /**
         * 聚焦输入框而面板还开着 → 交接：等键盘升到面板等高再收面板。
         *
         * 语音面板与表情面板用**同一条**规则：直接收会让交换区高度瞬间掉到导航栏
         * 那一档、下一帧键盘又顶上来，用户看到的就是"点一下弹一下"。
         */
        LaunchedEffect(inputFocused) {
            if (!inputFocused) return@LaunchedEffect
            if (voiceMode || albumOpen) {
                withTimeoutOrNull(IME_HANDOFF_TIMEOUT_MS) {
                    snapshotFlow { imeBottomState }.first { it >= panelHeightPx }
                }
                if (voiceMode) closeVoiceMode() else albumOpen = false
                return@LaunchedEffect
            }
            if (!emojiOpen) return@LaunchedEffect
            withTimeoutOrNull(IME_HANDOFF_TIMEOUT_MS) {
                snapshotFlow { imeBottomState }.first { it >= panelHeightPx }
            }
            emojiOpen = false
        }

        Column(
            modifier = Modifier
                .fillMaxSize()
                // 玻璃源：栏的兄弟节点，且在栏之前绘制
                .then(if (canBlur) Modifier.layerBackdrop(backdrop) else Modifier),
        ) {
            /**
             * ★ **fillMaxWidth 必须有**（2026-10-15 用户实测："没有对话记录的提示在左边不是居中的"）。
             *
             * `weight(1f)` 在 Column 里只保证**主轴（高度）**占满，**宽度是包内容的** ——
             * 而下面的空态/错误占位是 wrap-content + `align(Center)`：盒子不占满宽度，
             * 水平方向就"无处可居中"，整块贴在左边（垂直方向因为盒子占了全高，是居中的 ——
             * 这正是这个 bug 的隐蔽之处：一半对一半不对）。骨架/消息列表分支是 fillMaxSize，
             * 宽度有没有都一样；补上之后对它们无感。
             */
            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    /**
                     * 点消息区空白 → 收键盘 + 收起**所有**输入辅助面板（语音/表情/相册）。
                     *
                     * 手势挂在**外层 Box** 上而不是列表上：这样"还没有消息"的空态、
                     * 加载骨架、加载失败三种分支也都能收（此前只有有消息的那条分支挂了
                     * 手势，新会话里面板开着就点不掉了）。
                     *
                     * 气泡/按钮自己的点击会消费事件，不会冒泡到这里 —— 点菜单、点头像
                     * 仍然走各自的行为，不会顺手把面板收掉。
                     *
                     * 收起有动画（`panelFraction` 弹簧回 0，约 300ms），不是瞬间消失。
                     */
                    .pointerInput(Unit) {
                        detectTapGestures {
                            keyboard?.hide()
                            closeComposerPanels()
                        }
                    },
            ) {
                when {
                    /**
                     * **有内容就先渲染**（缓存命中，或 SSE 已经刷过）：连加载失败也**不把已有消息
                     * 换成一张错误页** —— 刷新是后台动作，静默失败比"正在看的消息突然消失"好。
                     */
                    items.isNotEmpty() -> LazyColumn(
                        state = listState,
                        modifier = Modifier
                            .fillMaxSize(),
                        /**
                         * **reverseLayout**：最新一条是列表的 index 0、天然贴在底部。
                         *
                         * 不开的话只能"先渲染最旧一屏，再 animateScrollToItem 滚到底"——那正是
                         * 用户看到的**进会话先闪一下顶部、再自己跳到底部**（首帧内容还是错的）。
                         * 开了之后首帧就是最新消息，不需要任何滚动动画。
                         * 代价：列表顺序要反过来（[entries] 反转），"加载更早的消息"作为最后一项
                         * 出现在**视觉最上方**。
                         */
                        reverseLayout = true,
                        contentPadding = PaddingValues(
                            start = KSpacing.md,
                            end = KSpacing.md,
                            // top = 顶栏实际高：滚到最顶上时最老的消息停在顶栏之下；
                            // 平时消息从毛玻璃顶栏底下穿过
                            top = topInset + KSpacing.sm,
                            bottom = KSpacing.sm,
                        ),
                        verticalArrangement = Arrangement.spacedBy(KSpacing.xs),
                    ) {
                        items(
                            entries.asReversed(),
                            key = { it.key },
                            // 日期分隔条与气泡两种形态混排：声明槽位类型，滚动回收时
                            // 跨同类型复用（快速翻长会话历史少付一次组合成本）
                            contentType = { if (it is ChatEntry.Day) "day" else "bubble" },
                        ) { entry ->
                            when (entry) {
                                is ChatEntry.Day -> DayDivider(entry.text)
                                is ChatEntry.Bubble -> MessageBubble(
                                    msg = entry.msg,
                                    // 按图记忆（不按 messages 记）：鉴权头只在 token 变化时才变，
                                    // 而这个 item 的外层作用域重组高频（比如根作用域一次刷新就
                                    // 重跑整个 item DSL）—— 不记忆的话每条可见气泡都拿到新 Map
                                    // 实例、参数不等、全体跟着重组
                                    imageHeaders = remember(entry.msg.imageUrl) { messages.imageHeaders() },
                                    partnerAvatar = partnerAvatar,
                                    myAvatar = myAvatar,
                                    /**
                                     * 这一格的来源键与下标：与下面 `openViewer` 传的
                                     * **必须是同一套**（同一个 [chatImageOriginKey]、同一份
                                     * `chatImageUrls` 里的下标），否则飞行起点会指到别的格子上。
                                     */
                                    imageOriginKey = chatImageOriginKey(partnerId),
                                    imageOriginIndex = entry.msg.imageUrl
                                        ?.let { u -> chatImageUrls.indexOf(u) } ?: -1,
                                    // 语音消息：单例播放器（同一时间只播一条）+ 转写
                                    voice = voicePlayer,
                                    onTranscribe = { messages.transcribe(it) },
                                    onToast = { toast = it },
                                    /**
                                     * 点图片 → 全屏看图（用户反馈"聊天里的图点不开全屏"）。
                                     * 传**整段对话的图 + 这张的下标**：进去之后能左右滑着看完。
                                     * `msg.imageUrl` 是**已解析的绝对地址**（同 [chatImageUrls]），
                                     * 不能用 `raw.imageUrl` —— 那是相对路径，查看器会加载失败。
                                     */
                                    onImageClick = {
                                        val url = entry.msg.imageUrl
                                        if (!url.isNullOrBlank()) {
                                            // 看图前收键盘（IME 是系统窗口，会盖在查看器上，
                                            // 见 openViewer 的注释）；关掉查看器后**不**自动
                                            // 弹回（2026-09-25 反馈"退出不用再启用"），要打字
                                            // 用户自己会点输入框
                                            keyboard?.hide()
                                            openViewer(
                                                chatImageUrls,
                                                chatImageUrls.indexOf(url).coerceAtLeast(0),
                                                messages.imageHeaders(),
                                                /**
                                                 * ★ 传**虚拟来源键**而不是 null（用户反馈"聊天里的图点开是直接闪现，
                                                 * 没有详情页那种飞出来的动画"）。
                                                 *
                                                 * 第 4 个参数在查看器里叫 `postId`，但它真正的身份是
                                                 * **"去来源表里查哪一组格子"的键** —— 传 null 就等于
                                                 * `ViewerOrigins.of(null, n)` 直接返回空表，
                                                 * 查看器按设计退化成"直接落位"（见 `ImageViewerRequest.postId` 注释）。
                                                 *
                                                 * 私信图片没有帖子 id，所以用 [chatImageOriginKey] 造一个
                                                 * 落在负数区间的键：与帖子的正数 postId **共用同一张表、互不撞号**。
                                                 * 气泡那一格也已用同一个键 `registerViewerOrigin` 登记过。
                                                 */
                                                chatImageOriginKey(partnerId),
                                            )
                                        }
                                    },
                                    // 引用与撤回都在长按菜单里（气泡自身不带常显操作文字）
                                    onQuote = { quoteMessage(entry.msg) },
                                    onRecall = {
                                        scope.launch {
                                            val id = entry.msg.raw.id
                                            when (val r = messages.recall(id)) {
                                                is ApiResult.Success -> {
                                                    items = items.filterNot { it.raw.id == id }
                                                    toast = "已撤回"
                                                }
                                                is ApiResult.Failure -> toast = r.error.displayMessage
                                            }
                                        }
                                    },
                                    /**
                                     * 新消息 / 撤回时的重排走弹簧（M4）。
                                     *
                                     * 注意这个列表是 `reverseLayout = true`（最新消息在最下面），
                                     * `animateItem` 的位移是**在列表坐标系里**算的，所以"新消息挤进来"
                                     * 表现为旧消息整体往上让位 —— 正是聊天该有的观感。
                                     * 入场淡入用框架默认值：这里刻意不再叠一层自定义滑入，
                                     * 否则"让位 + 滑入"两套动画同时跑，观感会打架（§6 每屏最多一个抢注意力动效）。
                                     */
                                    modifier = Modifier.animateItem(),
                                )
                            }
                        }
                        // reverseLayout 下"最后一项"在视觉最上方 = 更早的消息
                        if (hasMore) {
                            item {
                                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                                    KButton(
                                        text = "加载更早的消息",
                                        onClick = {
                                            scope.launch {
                                                val oldest = items.firstOrNull()?.raw?.id
                                                when (val r = messages.history(partnerId, beforeId = oldest)) {
                                                    is ApiResult.Success -> {
                                                        items = r.data.first + items
                                                        hasMore = r.data.second
                                                    }
                                                    is ApiResult.Failure -> toast = r.error.displayMessage
                                                }
                                            }
                                        },
                                        variant = KButtonVariant.Ghost,
                                    )
                                }
                            }
                        }
                    }

                    /**
                     * 首次打开这个会话（没有任何缓存）才走骨架。
                     *
                     * 原来这里是页面正中一个 `CircularProgressIndicator`（用户反馈：
                     * 「点进对话消息中间有个加载圈」）。转圈只表达"在忙"，不表达"忙完长什么样"，
                     * 而且它居中、真实内容却贴着底部 —— 加载完是"中间一个圈 → 底部一片气泡"，
                     * 视觉上要跳一次。骨架按真实版式铺、**贴底**，与加载完的画面是连续的。
                     */
                    /**
                     * ⚠️ **不要在这里加 `.padding(top = topInset)`**（用户反馈："从别人个人主页
                     * 点私信进去，里面的提示还没有居中" —— 就是这两处）。
                     *
                     * 原因：`topInset` 是**顶栏高度**，而顶栏**根本不在这个 Box 里** ——
                     * 外层 `Column` 是「顶栏 / Box(weight(1f)) / 输入栏」三行，这个 Box
                     * 已经是"顶栏下面那一块"了。再减一次顶栏高度就是**凭空往下推**。
                     *
                     * 更隐蔽的是它推的量是**一半**：`align(Alignment.Center)` 先按 Box 中心
                     * 摆好，而 `padding(top = x)` 让内容盒变高 x → 居中时内容整体下移 **x/2**。
                     * 真机上就是"提示偏下小半格"，不是明显到一眼能说出原因的那种偏。
                     *
                     * 消息列表页那边（`CenteredState`）遇到过同一个问题，当时的教训是
                     * "得按列表视口 − 顶栏量出可用高度"；但**这里压根不需要**——
                     * 这个 Box 的边界已经排除了顶栏与输入栏，直接 `align(Center)` 就是准的。
                     */
                    loading -> Box(Modifier.fillMaxSize().padding(top = topInset)) { ChatSkeleton() }

                    error != null -> KPlaceholder(
                        kind = KPlaceholderKind.Error,
                        title = "消息加载失败",
                        description = error,
                        action = { KButton("重试", onClick = { scope.launch { loadInitial() } }) },
                        modifier = Modifier.align(Alignment.Center),
                    )

                    else -> KPlaceholder(
                        kind = KPlaceholderKind.Empty,
                        title = "还没有消息",
                        description = "打个招呼吧",
                        modifier = Modifier.align(Alignment.Center),
                    )
                }
                if (recordingVoice && !voiceMode) {
                    VoiceRecordingOverlay(
                        elapsedMs = recorder.elapsedMs,
                        levels = recordLevels,
                        cancelZone = recordCancelZone,
                        modifier = Modifier
                            .align(Alignment.BottomCenter)
                            .padding(bottom = KSpacing.sm),
                    )
                }
            }

            /**
             * 引用条（回复某条消息时出现）。
             *
             * 样式照用户给的参考图：**灰底圆角条**（不再是通栏色块）
             * + 「用户名：内容」单行省略 + 右侧一个圆形 ×。
             *
             * 位置**留在输入框之上**、不进输入框内部：引用内容可能很长，
             * 塞进输入框会和正在打的字抢位置，而输入框是单行、只能把它整条省略掉。
             * 单独一条则能给出"回复谁 + 引用什么"的完整上下文（超长才省略）。
             *
             * **带进出动画**（用户要求）：出现时展开 + 淡入，取消时收起 + 淡出 ——
             * 不再是瞬间出现/消失（那条会连带把输入栏整体推移，硬跳最容易被看成卡顿）。
             * 降级（系统关动画）时两端都是 `None`，状态变化本身不依赖动画也成立。
             */
            val replyAnimations = LocalAnimationsEnabled.current
            /**
             * 退场动画期间 `replyTo` 已经是 null，但这一条还要按原内容画完 ——
             * 不留住最后一个非空值，退场帧里就是一条**空条**（甚至 `!!` 直接崩）。
             */
            val shownReplyTo = rememberLastNonNull(replyTo)
            AnimatedVisibility(
                visible = replyTo != null,
                enter = if (replyAnimations) {
                    expandVertically(animationSpec = KMotion.spatial()) +
                        fadeIn(animationSpec = KMotion.effects())
                } else {
                    EnterTransition.None
                },
                exit = if (replyAnimations) {
                    shrinkVertically(animationSpec = KMotion.spatial()) +
                        fadeOut(animationSpec = KMotion.effects())
                } else {
                    ExitTransition.None
                },
            ) {
                shownReplyTo?.let { target ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = KSpacing.md, vertical = KSpacing.xs)
                            .clip(RoundedCornerShape(KRadius.control))
                            .background(c.surfaceRaised)
                            .padding(start = KSpacing.sm, end = KSpacing.xxs, top = KSpacing.xxs, bottom = KSpacing.xxs),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
                    ) {
                        Text(
                            // 「用户名：内容」—— 冒号而不是"回复 xxx："：这一条本身就在输入框上面，
                            // 不需要再解释一遍它在干嘛（参考图也是这个写法）
                            text = "${target.raw.senderUsername}：" + target.raw.content.ifBlank {
                                when {
                                    target.raw.hasAudio -> "[语音]"
                                    target.raw.hasImage -> "[图片]"
                                    else -> ""
                                }
                            },
                            style = KType.body,
                            color = c.textSecondary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        // 取消引用：小圆底 + 叉（见参考图）。`onClickLabel` 给读屏一句说明 ——
                        // 这个钮没有文字，不给说明等于"读屏用户听到一个无名按钮"
                        Box(
                            modifier = Modifier
                                .clip(CircleShape)
                                .clickable(onClickLabel = "取消引用") { replyTo = null }
                                .background(c.borderStrong)
                                .padding(KSpacing.xxs),
                        ) {
                            Glyph(tint = c.surface, kind = GlyphKind.Close, size = KDimens.navIcon)
                        }
                    }
                }
            }

            /**
             * 输入区 = 输入栏 + 键盘/表情交换区，整体挂在一层 surface 底里。
             *
             * 导航栏避让不再挂在 Column 上：交换区高度已经把导航栏算进 max() 里 ——
             * 面板开着时避让挂面板内容上、谁都不开时交换区自己就等于导航栏高，
             * 输入栏照样停在安全区之上（机制见上面「交换区」总注释）。
             *
             * background 与输入栏同色（surface）：交换区不管被谁占着，底下露出来的
             * 都是输入栏的底色，不会闪出一道页面底的细边。
             */
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(c.surface),
            ) {
                // 输入栏（QQ 式两行）：第一行「输入框 + 发送」，第二行「表情 / 相册」功能排。
                // 2026-10-19 用户要求「跟 QQ 一样，功能放输入框下面」——功能钮不再和输入框挤一行，
                // 输入框因此能占满整行宽度。
                // 圆角统一成**详情页那一档**（KRadius.control 小圆角），不再是胶囊 ——
                // 两处输入条看起来要像同一个组件（用户要求）。
                // 不再挂 imePadding：键盘高度已并入交换区，这里再挂会多让出一条导航栏
                // （ime 全高含导航栏，叠加等于把导航栏让了两次）。
                // 垂直留白收一档（sm → xs），配合输入框矮一档（36dp，见 KTextField 调用）：
                // 用户反馈"输入框高度小一点、上下留白间隙也小一点"。
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = KSpacing.md, vertical = KSpacing.xs),
                    // 两行之间 4dp：QQ 式输入栏（输入在上、功能钮在下）
                    verticalArrangement = Arrangement.spacedBy(KSpacing.xxs),
                ) {
                    // 第一行：输入框 + 发送（输入框独占剩余宽度）
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
                    ) {
                        Box(modifier = Modifier.weight(1f)) {
                            ChatInputField(
                                input = input,
                                placeholder = "说点什么…",
                                // 点「引用」时把焦点交给它（见 quoteMessage），IME 随之弹起
                                focusRequester = inputFocusRequester,
                                // 聚焦态同时喂给上面的 inputFocused（聚焦 = 面板向键盘交接让位）
                                interactionSource = inputInteraction,
                            )
                        }
                        // 参考图里空输入时发送键是**浅蓝禁用态**，有字才变实心；
                        // 与 KButton 的灰禁用不同，这里单独画一个（高度仍 36dp，与输入框齐平）
                        ChatSendButton(
                            sending = sending,
                            enabled = input.value.isNotBlank() && !sending,
                        ) {
                            if (input.value.isBlank()) {
                                toast = "不能发空消息"
                                return@ChatSendButton
                            }
                            scope.launch {
                                sending = true
                                val quoted = replyTo?.raw?.id
                                when (
                                    val r = messages.send(
                                        partnerId,
                                        input.value.trim(),
                                        quotedMessageId = quoted,
                                    )
                                ) {
                                    is ApiResult.Success -> {
                                        items = items + r.data
                                        input.value = ""
                                        replyTo = null
                                        // 发出去的消息在 reverseLayout 里是 index 0：
                                        // 主动滚一次，避免用户翻了旧消息后看不到自己刚发的那条
                                        listState.animateScrollToItem(0)
                                    }
                                    is ApiResult.Failure -> toast = r.error.displayMessage
                                }
                                sending = false
                            }
                        }
                    }

                    // 功能排（QQ 式通栏均分）：语音 / 表情 / 相册 各占 1/3，
                    // 图标在各自格子里居中 —— 参考图里 QQ 的 6 个功能是铺满整行的，
                    // 不是靠左挤成一串。这里只有 3 个真功能，就三等分。
                    // 功能排**锁定 44dp 高**：以后再加语音/拍摄/更多等入口，
                    // 只在等宽格子里多分一份，行高不会变（用户要求"等高，以后加功能也不跳"）。
                    // 每个格子 fillMaxHeight + 图标居中，不靠内容撑高。
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(44.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        // 语音开关：点亮（主题色）= 下方「按住说话」面板展开；
                        // 再点一次收起。录音手势在大按钮上，不在这个小图标上。
                        Box(
                            modifier = Modifier.weight(1f).fillMaxHeight(),
                            contentAlignment = Alignment.Center,
                        ) {
                            ToolbarMicButton(
                                active = voiceMode,
                                onClick = {
                                    if (voiceMode) {
                                        closeVoiceMode()
                                    } else {
                                        albumOpen = false
                                        emojiOpen = false
                                        keyboard?.hide()
                                        focusManager.clearFocus()
                                        voiceMode = true
                                    }
                                },
                            )
                        }
                        Box(
                            modifier = Modifier.weight(1f).fillMaxHeight(),
                            contentAlignment = Alignment.Center,
                        ) {
                            // 表情开关（笑脸）：点亮态 = 面板正开着。
                            // 盒 36dp / 图标 28dp —— 与输入框同高，图标留 4dp 呼吸位。
                            KEmojiButton(
                                active = emojiOpen,
                                boxSize = 36.dp,
                                iconSize = 28.dp,
                                onClick = {
                                    // 走 closeVoiceMode 而不是直接 `voiceMode = false`：
                                    // 录到一半切面板时要先停掉麦克风（面板都没了，还在录就是 bug）
                                    closeVoiceMode()
                                    albumOpen = false
                                    emojiOpen = !emojiOpen
                                    if (emojiOpen) {
                                        // 开面板 = 收起键盘，并**清掉输入框焦点**：
                                        //  · 键盘此刻还没降，交换区的 max() 会取面板高顶住输入栏，
                                        //    键盘滑走正好露出面板 —— 输入栏全程不动（见「交换区」总注释）；
                                        //  · 不收键盘的话 IME 占着半屏，面板直接被顶到屏幕外；
                                        //  · 不清焦点的话聚焦态的交接规则会把面板在下次焦点
                                        //    变化时秒收，连点笑脸关闭时的退场动画也没了。
                                        keyboard?.hide()
                                        focusManager.clearFocus()
                                    }
                                },
                            )
                        }
                        Box(
                            modifier = Modifier.weight(1f).fillMaxHeight(),
                            contentAlignment = Alignment.Center,
                        ) {
                            // 发图按钮（系统相册选一张、选完直接发出）：与表情钮同一套
                            // **盒 36dp + 图标 28dp**（图标略小于输入框，留呼吸位），
                            // 按下/发送中只换图标色（accentText），不垫底色。
                            // 图标用 Tabler photo（见 IconPathsExtra.kt）。
                            val imageInteraction = remember { MutableInteractionSource() }
                            val imagePressed by imageInteraction.collectIsPressedAsState()
                            // 尺寸与表情钮、输入框三者一致：盒 36dp
                            Box(
                                modifier = Modifier
                                    .size(36.dp)
                                    // 不垫按下底色（M6.24 用户要求"选中图标反色主题色……要遮罩干嘛"）：
                                    // 选中反馈统一走"**图标变主题色**"（见下面 Glyph 的 tint）。
                                    //（此前为圆形底色配了 clip(pill)，会把方形图标的四角切掉。）
                                    .clickable(
                                        interactionSource = imageInteraction,
                                        indication = null,
                                        onClick = {
                                            if (albumOpen) {
                                                albumOpen = false
                                            } else {
                                                // 相册图标是**开关**：展开内嵌最近照片，不再直接弹全屏。
                                                // 全屏入口在面板左下角的「相册」上。
                                                closeVoiceMode()
                                                emojiOpen = false
                                                keyboard?.hide()
                                                focusManager.clearFocus()
                                                albumOpen = true
                                            }
                                        },
                                    )
                                    .semantics { contentDescription = "相册" },
                                contentAlignment = Alignment.Center,
                            ) {
                                Glyph(
                                    tint = if (imagePressed || sending || albumOpen) c.accentText else c.textSecondary,
                                    // `photo`（Tabler，非 lucide）：lucide 的 image 系带 r=2 空心小圆、
                                    // 24dp 下糊团（"锯齿"）；相机与 album 相继被否——最终选经典照片
                                    // 造型（相框+山坡+实心太阳点，见 IconPathsExtra.kt / TABLER_PHOTO）
                                    kind = GlyphKind.Photo,
                                    size = 28.dp,
                                )
                            }
                        }
                    }
                }
                /**
                 * 键盘 / 表情交换区（QQ/微信式原地换位，机制见上面总注释）：
                 * 输入栏贴在它顶上，高度 = max(IME, 面板×展开比例, 导航栏)。
                 *
                 * 面板按展开比例裁在区内、**底边对齐**：展开时从屏幕底边向上长出、
                 * 收起时缩回底边 —— 与老实现的 expandFrom/shrinkTowards=Bottom 观感
                 * 一致，但高度参与了 max() 运算，面板↔键盘切换时输入栏不再跳。
                 *
                 * 面板内容自带导航栏避让：面板全高与 IME 全高同口径（都含导航栏
                 * 那一条），网格在内容层再让一次导航栏，手势条不会压住最后一排表情。
                 */
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        // 布局期读取交换区高度（max(IME, 面板×比例, 导航栏)，见 ExchangeZone.kt）
                        // —— 键盘/面板动画期间这里只重布局，不重组整页。
                        // 三个面板**一律**由 panelFraction 驱动：开是"从底边长出"、关是"缩回底边"，
                        // 进出同一条曲线，不再有"开语音一帧拉满"的硬跳。
                        .exchangeZoneHeight(density, ime, nav, panelHeightPx) { panelFraction.value }
                        .clipToBounds(),
                    contentAlignment = Alignment.BottomCenter,
                ) {
                    /**
                     * 面板都用**展开前的定高**画（底边对齐 + 外层 clipToBounds 裁剪）：
                     * 高度增长时整块从底边推上来，内容不跟着重排 —— 若用 fillMaxSize，
                     * 每帧高度变化都会让内容重新居中，看起来像"面板里的东西自己在滑"。
                     */
                    val panelModifier = Modifier
                        .fillMaxWidth()
                        .height(panelFullHeightDp)
                    // 三个开关都关了、且高度也收回到 0 → 才真正把内容移出组合
                    val panelGone = openPanel == ChatPanel.None && panelFraction.value <= 0f
                    if (!panelGone) {
                        when (shownPanel) {
                            ChatPanel.Voice -> VoiceInputPanel(
                                recording = recordingVoice,
                                elapsedMs = recorder.elapsedMs,
                                levels = recordLevels,
                                cancelZone = recordCancelZone,
                                onStart = {
                                    when {
                                        sendingVoice -> {
                                            toast = "正在发送语音，请稍候"
                                            false
                                        }
                                        !hasRecordPermission -> {
                                            recordPermission.launch(Manifest.permission.RECORD_AUDIO)
                                            false
                                        }
                                        else -> startVoiceRecording()
                                    }
                                },
                                onFinish = { finishVoiceRecording() },
                                onCancel = { cancelVoiceRecording() },
                                onCancelZoneChange = { recordCancelZone = it },
                                onTap = { toast = "长按说话" },
                                modifier = panelModifier,
                            )
                            ChatPanel.Album -> InlineAlbumPanel(
                                sending = sending,
                                onSend = { uris -> sendImageUris(uris) },
                                onOpenSystemGallery = {
                                    pickChatImage.launch(
                                        PickVisualMediaRequest(
                                            ActivityResultContracts.PickVisualMedia.ImageOnly,
                                        )
                                    )
                                },
                                modifier = panelModifier,
                                // 拖拽预览的浮层在整页层级画（见 AlbumDragOverlay）：
                                // 面板自己会被交换区 clipToBounds 裁掉，图抬不出面板
                                onDragPreviewStart = { painter, bounds ->
                                    albumDragPainter = painter
                                    albumDragBounds = bounds
                                    albumDragDx = 0f
                                    albumDragDy = 0f
                                    albumDragReleased = false
                                },
                                onDragPreviewMove = { dx, dy ->
                                    albumDragDx = dx
                                    albumDragDy = dy
                                },
                                // 松手后不立刻抹掉浮层：让它把"丢出去 / 落回相册"演完，
                                // 演完（onExitFinished）才清状态、格子才重新出现
                                onDragPreviewEnd = { albumDragReleased = true },
                                // 被拎走的那张：相册条里那一格画成透明，原位留空
                                draggedPainter = albumDragPainter,
                            )
                            // 表情面板自带 navigationBarsPadding，高度只算网格那一段
                            else -> KEmojiPanel(
                                onPick = { emoji ->
                                    // 追加到末尾（与 Web 端 onSelect 同语义）。面板**选完不关**：
                                    // 连发几个表情是常见操作，关掉每发一个都要重开一次
                                    // （Web 端选了即关是桌面端习惯，移动端不照搬）
                                    input.value += emoji
                                },
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .navigationBarsPadding(),
                                height = panelGridHeightDp,
                            )
                        }
                    }
                }
            }
        }

        // 顶栏浮层（毛玻璃）：返回 | 对方名字 | 「…」。消息从它底下穿过。
        // 画在内容层**之后** = 盖在内容之上；「清空聊天记录」的菜单跟着这个浮层走。
        Row(
            modifier = Modifier
                .fillMaxWidth()
                // 顶栏毛玻璃（统一写法，见 rememberTopBarGlass）。
                // 必须挂在 kTopBar（状态栏避让）的**左侧**：玻璃矩形才含状态栏那一条，
                // 滚到顶时最老的消息正好停在玻璃之下
                .then(
                    rememberTopBarGlass(
                        canBlur = canBlur,
                        backdrop = backdrop,
                        blurRadius = KGlassBlurRadius,
                        tint = frostedTint,
                        solid = KTheme.colors.frostedSolid,
                    )
                )
                // 量的是含状态栏的**整条**高：列表 contentPadding.top 按它让位，
                // 滚到顶时最老的消息正好停在玻璃之下
                .onSizeChanged { measuredTopBarPx = it.height }
                .kTopBar()
                .padding(start = KSpacing.md, end = KSpacing.md, bottom = KSpacing.md),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(KSpacing.md),
        ) {
            KIconButton(icon = GlyphKind.ChevronLeft, onClick = onBack)
            Text(
                text = partnerName?.ifBlank { null } ?: "用户$partnerId",
                style = KType.subtitle,
                color = c.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Box {
                KIconButton(icon = GlyphKind.More, onClick = { menuOpen = true })
                DropdownMenu(
                    expanded = menuOpen,
                    onDismissRequest = { menuOpen = false },
                    shape = RoundedCornerShape(KRadius.control),
                    containerColor = c.surfaceRaised,
                    tonalElevation = 0.dp,
                    shadowElevation = KElevation.raised,
                    border = BorderStroke(1.dp, c.borderSubtle),
                ) {
                    ChatMenuItem("清空聊天记录", c.danger) {
                        menuOpen = false
                        confirmClear = true
                    }
                }
            }
        }

        // 相册「上滑松手发送」浮层：盖在整页最上层（连顶栏一起）。
        // 压层只盖到**相册条上沿**为止 —— 相册条与它下面那排按钮留在原地可见，
        // 这样图看起来是"从相册里被拎出来的"，而不是整页先变白再凭空冒出一张
        AlbumDragOverlay(
            painter = albumDragPainter,
            bounds = albumDragBounds,
            offsetX = { albumDragDx },
            offsetY = { albumDragDy },
            released = albumDragReleased,
            onExitFinished = {
                albumDragPainter = null
                albumDragReleased = false
                albumDragDx = 0f
                albumDragDy = 0f
            },
        )

        if (toast != null) {
            // 聊天页是沉浸态，没有胶囊要避让，直接放在输入栏之上。
            // 让位跟着交换区走：键盘开着躲键盘、面板开着连面板一起躲（老实现只算了
            // 固定 240dp 的面板，键盘开着时提示其实压在键盘底下看不见）
            Box(
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    // 布局期让位（交换区高 + 96dp），与老 `.padding(bottom = …)` 视觉一致
                    .exchangeZoneBottomInset(density, ime, nav, panelHeightPx, { panelFraction.value }, 96.dp),
            ) {
                KToastInline(text = toast!!, onDismiss = { toast = null })
            }
        }

        // 清空聊天记录（顶栏「…」）：不可撤销，所以必须二次确认
        if (confirmClear) {
            KAlertDialog(
                title = "清空聊天记录",
                text = "与「${partnerName?.ifBlank { null } ?: "用户$partnerId"}」的全部消息会被删除，且不可恢复。",
                confirmText = "清空",
                danger = true,
                onDismissRequest = { confirmClear = false },
                onConfirm = {
                    confirmClear = false
                    scope.launch {
                        when (val r = messages.clearConversation(partnerId)) {
                            is ApiResult.Success -> {
                                items = emptyList()
                                hasMore = false
                                toast = "已清空"
                            }
                            is ApiResult.Failure -> toast = r.error.displayMessage
                        }
                    }
                },
            )
        }
    }
}

/**
 * 聊天首屏的内容骨架（M7）。
 *
 * 形态直接对着真实气泡铺：左右交替（对方在左、自己在右，都带头像）、长短不一，
 * 并且**贴底** —— 真实列表是 `reverseLayout`，最新一条在最下面。
 * 这样从骨架切到真内容时版式是连续的；转圈那种"中间一个环 → 底部一片气泡"的跳变就没有了。
 *
 * 微光由 `kShimmer` 内部按 [LocalAnimationsEnabled] 门控，并带 `contentDescription`
 * 把"加载中"交给读屏（§6：动效不能是唯一信号）。
 */
@Composable
private fun ChatSkeleton() {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .semantics { contentDescription = "加载中" }
            // 与真实列表同一套内外边距，骨架 → 真内容时位置不跳
            .padding(horizontal = KSpacing.md, vertical = KSpacing.sm),
        verticalArrangement = Arrangement.spacedBy(KSpacing.sm, Alignment.Bottom),
    ) {
        // (是不是自己的, 气泡宽度占可用宽度的比例, 气泡高)
        listOf(
            Triple(false, 0.62f, 48.dp),
            Triple(true, 0.44f, 48.dp),
            Triple(false, 0.70f, 68.dp),
            Triple(true, 0.52f, 48.dp),
            Triple(false, 0.38f, 48.dp),
        ).forEach { (mine, fraction, bubbleHeight) ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start,
                verticalAlignment = Alignment.Bottom,
            ) {
                if (!mine) {
                    Box(Modifier.size(KDimens.avatarCard).kShimmer(CircleShape))
                    Spacer(Modifier.width(KSpacing.xs))
                }
                Box(
                    modifier = Modifier
                        // 比例是对"整行宽"算的，加上头像（40 + 8）也不会越过行宽（最长 0.70）
                        .fillMaxWidth(fraction)
                        .height(bubbleHeight)
                        .kShimmer(RoundedCornerShape(KRadius.row)),
                )
                if (mine) {
                    Spacer(Modifier.width(KSpacing.xs))
                    Box(Modifier.size(KDimens.avatarCard).kShimmer(CircleShape))
                }
            }
        }
    }
}

/**
 * 长按菜单项。只改内边距与文字色，其余交给 M3（触控高度 48dp、涟漪、语义）——
 * M3 默认的 `contentPadding` 是 12/16，配上 15sp 文字会让一个三项菜单比气泡还占地方。
 */
@Composable
internal fun ChatMenuItem(text: String, color: Color, onClick: () -> Unit) {
    DropdownMenuItem(
        text = { Text(text, style = KType.body, color = color) },
        onClick = onClick,
        contentPadding = PaddingValues(horizontal = KSpacing.lg, vertical = KSpacing.xs),
    )
}

/**
 * 长按菜单里的一项。
 * [danger] = 危险动作（撤回），文字走 `danger` 色。
 */
private data class ChatMenuAction(
    val label: String,
    val danger: Boolean = false,
    val onClick: () -> Unit,
)

/**
 * 聊天气泡的长按菜单（形态对齐 Web 版 `ChatContextMenu.module.css`）。
 *
 * 为什么不用 M3 的 `DropdownMenu`：它没有"指向锚点的小三角"，也没法定制横排 + 竖线分隔；
 * 而且它固定把菜单压在锚点下方（会盖住被长按的那条气泡）。这里用 `Popup` 自己定位：
 *  · 卡片浮在气泡**上方**（上方放不下才翻到下方），有一个小三角指向气泡水平中心；
 *  · 三项**横排**，中间 1dp 竖线隔开；
 *  · 卡片视觉与全项目一致：`surfaceRaised` 底 + 1dp `borderSubtle` + 10dp 圆角 + `raised` 阴影。
 *
 * @param anchor 气泡在**窗口坐标系**里的矩形（`boundsInWindow()`）
 */
@Composable
private fun ChatContextMenu(
    anchor: Rect,
    actions: List<ChatMenuAction>,
    onDismiss: () -> Unit,
) {
    val c = KTheme.colors
    val density = LocalDensity.current
    val windowSize = LocalWindowInfo.current.containerSize
    val animationsEnabled = LocalAnimationsEnabled.current

    val gapPx = with(density) { KSpacing.xs.toPx() }          // 气泡与菜单之间的缝（指针的尖端落在这里）
    val marginPx = with(density) { KSpacing.xs.toPx() }       // 距屏幕边缘的最小留白
    val arrowWPx = with(density) { 12.dp.toPx() }
    val arrowHPx = with(density) { 6.dp.toPx() }
    val arrowHDp = 6.dp
    val cornerPx = with(density) { KRadius.control.toPx() }

    var cardSize by remember { mutableStateOf(IntSize.Zero) }
    val measured = cardSize.width > 0

    // 优先放消息**上方**（指针在卡片下边）；上方放不下才翻到下方（指针在卡片上边）。
    // cardSize 现在把指针的 6dp 也算在内（见下面形状），所以这里不用再单减一次 arrowHPx。
    val menuAbove = cardSize.height > 0 && anchor.top - gapPx - cardSize.height >= marginPx
    // 卡片左上角（窗口坐标，仅用于算指针位置）：这里必须与下面 PopupPositionProvider 的算法一致
    val cardX = if (!measured) 0f else (anchor.center.x - cardSize.width / 2f)
        .coerceIn(marginPx, (windowSize.width - cardSize.width - marginPx).coerceAtLeast(marginPx))
    // 指针中心：对准消息中心，但不许跑到卡片圆角外面去
    val arrowCx = if (!measured) 0f else (anchor.center.x - cardX).coerceIn(
        cornerPx + arrowWPx / 2f,
        (cardSize.width - cornerPx - arrowWPx / 2f).coerceAtLeast(cornerPx + arrowWPx / 2f),
    )

    // 非 focusable 弹层收不到 onDismissRequest —— 用一层透明遮罩接"点空白关闭"。
    // 遮罩单独一个 Popup（不抢焦点 → 输入法不退出），菜单 Popup 在它之后创建、盖在它上面。
    Popup(
        popupPositionProvider = remember {
            object : PopupPositionProvider {
                override fun calculatePosition(
                    anchorBounds: IntRect,
                    windowSize: IntSize,
                    layoutDirection: LayoutDirection,
                    popupContentSize: IntSize,
                ): IntOffset = IntOffset.Zero
            }
        },
        properties = PopupProperties(focusable = false),
    ) {
        val scrimW = with(density) { windowSize.width.toDp() }
        val scrimH = with(density) { windowSize.height.toDp() }
        Box(
            modifier = Modifier
                .size(scrimW, scrimH)
                .pointerInput(Unit) { detectTapGestures { onDismiss() } },
        )
    }

    Popup(
        /**
         * 定位**必须**走 PopupPositionProvider（与 M3 的 DropdownMenu 同一套约定）：
         * 它拿到的 `anchorBounds` 是"应用窗口坐标系"，返回值也按同一套解释。
         *
         * 踩过的坑：这里一开始用"Popup 铺满窗口 + 返回 IntOffset.Zero + 卡片自己在内容里按窗口坐标偏移"，
         * 结果卡片整体被画低了 165px（= 本机状态栏高度）——弹层窗口的 (0,0) 是**屏幕**原点，
         * 而 `boundsInWindow()` 是**应用窗口**原点，该机型上两者差了整整一个状态栏。
         * 表现就是"菜单盖住被长按的那条消息"。改回官方约定后位置才对。
         */
        popupPositionProvider = remember(anchor, gapPx, marginPx) {
            object : PopupPositionProvider {
                override fun calculatePosition(
                    anchorBounds: IntRect,
                    windowSize: IntSize,
                    layoutDirection: LayoutDirection,
                    popupContentSize: IntSize,
                ): IntOffset {
                    val w = popupContentSize.width
                    val h = popupContentSize.height
                    val x = (anchorBounds.center.x - w / 2f)
                        .coerceIn(marginPx, (windowSize.width - w - marginPx).coerceAtLeast(marginPx))
                    val y = if (anchorBounds.top - gapPx - h >= marginPx) {
                        anchorBounds.top - gapPx - h // 气泡上方
                    } else {
                        anchorBounds.bottom + gapPx   // 上方放不下：翻到下方
                    }
                    return IntOffset(x.roundToInt(), y.roundToInt())
                }
            }
        },
        /**
         * ★ `focusable = false`：长按菜单**不能抢输入框焦点**。
         *
         * 用户反馈（2026-10-19）："长按触发弹窗不要退出输入法"。focusable=true 时
         * 弹层会抢走焦点 → IME 收起；改成 false 后键盘保持不动。
         *
         * 代价：`onDismissRequest` 不会触发、点空白关不掉。对策是前面那个
         * **非 focusable 的透明遮罩 Popup**（点一下就 onDismiss）+ 这里的
         * [BackHandler]（返回键关闭）。两者都不抢焦点。
         */
        properties = PopupProperties(focusable = false),
    ) {
        // 只有内容本身那么大（位置由 provider 定），点空白关闭交给 focusable + onDismissRequest
        /**
         * 弹出时的"弹性缩放"（M4）：从贴着气泡的那个角长出来，带一点过冲。
         *
         * 起点 0.86 而不是 0：长按菜单是"从手指下钻出来"的东西，从 0 放大像凭空出现；
         * 过冲用 [KMotion.pressSpec]（阻尼比 0.45）—— 与点赞同一个语义："手指施加了力"。
         * 首帧 `measured` 还是 false（卡片尺寸没量到，三角位置会闪），所以量到之后才开始弹。
         */
        // 非 focusable 弹层收不到返回键，自己接一下
        BackHandler { onDismiss() }

        val pop = remember { Animatable(0f) }
        LaunchedEffect(measured) {
            if (!measured) return@LaunchedEffect
            if (animationsEnabled) {
                pop.snapTo(0f)
                pop.animateTo(1f, KMotion.pressSpec)
            } else {
                pop.snapTo(1f)
            }
        }
        Column(
            modifier = Modifier
                .graphicsLayer {
                    // 绘制期读动画值：每帧只重绘，不重组
                    val p = if (animationsEnabled) pop.value else 1f
                    val s = 0.86f + 0.14f * p
                    scaleX = s
                    scaleY = s
                    alpha = if (measured) 1f else 0f
                    // 从"靠近锚点"的那个角长出来：菜单在上方 → 从底边长；指针在中 → 从中间长
                    transformOrigin = TransformOrigin(0.5f, if (menuAbove) 1f else 0f)
                },
        ) {
            // 菜单卡片：**一个形状**（圆角矩形 + 指向消息的小三角一体成型）。
            // 旧实现是"三角 + 矩形"两块拼的：三角自己描三条边、矩形自己描四条边，
            // 拼缝处叠出一条多余的线，阴影也只跟矩形走（用户反馈"小三角跟矩形框不是一体的"）。
            // 合成一个形状后，背景/描边/阴影都作用在同一个轮廓上，天然无缝。
            val menuShape = remember(menuAbove, arrowCx, cornerPx, arrowWPx, arrowHPx) {
                ChatMenuShape(
                    pointerUp = !menuAbove,
                    pointerCenterX = arrowCx,
                    pointerWidth = arrowWPx,
                    pointerHeight = arrowHPx,
                    radius = cornerPx,
                )
            }
            Box(
                modifier = Modifier
                    .shadow(KElevation.raised, menuShape)
                    .clip(menuShape)
                    .background(c.surfaceRaised)
                    .border(1.dp, c.borderSubtle, menuShape)
                    // 指针占掉的那 6dp 让给形状画（内容避让，别顶进三角里）
                    .padding(
                        top = if (!menuAbove) arrowHDp else 0.dp,
                        bottom = if (menuAbove) arrowHDp else 0.dp,
                    )
                    .onSizeChanged { cardSize = it },
            ) {
                Row(
                    modifier = Modifier.height(IntrinsicSize.Min),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    actions.forEachIndexed { index, action ->
                        if (index > 0) {
                            Box(
                                modifier = Modifier
                                    .width(1.dp)
                                    .fillMaxHeight()
                                    .padding(vertical = KSpacing.xs)
                                    .background(c.borderSubtle),
                            )
                        }
                        Text(
                            text = action.label,
                            style = KType.body,
                            color = if (action.danger) c.danger else c.textPrimary,
                            modifier = Modifier
                                .clickable(onClick = action.onClick)
                                .padding(horizontal = KSpacing.lg, vertical = KSpacing.sm),
                        )
                    }
                }
            }
        }
    }
}

/**
 * 长按菜单的形状：**圆角矩形 + 指向消息的小三角一体成型**。
 *
 * 三角的底边故意压进矩形 1px —— 两个 Path 取并集后，底边就不再是轮廓的一部分，
 * 描边只会画三角的两条斜边与矩形的其余边，接缝处不会有那条多余的线。
 *
 * @param pointerUp true = 指针在**顶部**（菜单翻到了消息下方时）
 * @param pointerCenterX 指针中心相对卡片左缘的像素（调用方已按圆角收口）
 */
private class ChatMenuShape(
    private val pointerUp: Boolean,
    private val pointerCenterX: Float,
    private val pointerWidth: Float,
    private val pointerHeight: Float,
    private val radius: Float,
) : Shape {
    override fun createOutline(size: Size, layoutDirection: LayoutDirection, density: Density): Outline {
        // 矩形：指针那一侧内缩 pointerHeight（那片留给三角）
        val rectTop = if (pointerUp) pointerHeight else 0f
        val rectBottom = if (pointerUp) size.height else size.height - pointerHeight
        val rectPath = Path().apply {
            addRoundRect(
                RoundRect(
                    Rect(0f, rectTop, size.width, rectBottom),
                    CornerRadius(radius),
                )
            )
        }
        val baseY = if (pointerUp) rectTop + 1f else rectBottom - 1f
        val tipY = if (pointerUp) 0f else size.height
        val cx = pointerCenterX.coerceIn(
            pointerWidth / 2f + radius,
            (size.width - pointerWidth / 2f - radius).coerceAtLeast(pointerWidth / 2f + radius),
        )
        val triPath = Path().apply {
            moveTo(cx - pointerWidth / 2f, baseY)
            lineTo(cx, tipY)
            lineTo(cx + pointerWidth / 2f, baseY)
            close()
        }
        // 取并集：矩形 + 三角 → 单一轮廓（描边/阴影都跟它走）
        val merged = Path().apply { op(rectPath, triPath, PathOperation.Union) }
        return Outline.Generic(merged)
    }
}

/**
 * 聊天输入框：**把对 [input] 的读取圈进这个最小作用域**。
 *
 * KTextField 的 `value` 在这里读 —— 打字时只有这一小块重组。若直接在 ChatScreen
 * 根作用域传 `value = input`，每敲一个字符都会让整页 body（含消息 LazyColumn 的
 * item DSL）跟着重组。发送/引用等处对 [input] 的读取都在事件回调里（事件期读取
 * 不参与组合），不受此影响。
 *
 * 参数刻意收窄：shape/variant/minHeight 是聊天页的固定样式，收进来而不是透传，
 * 调用点就不必每次把样式常量重新摆一遍。
 */
@Composable
private fun ChatInputField(
    input: MutableState<String>,
    placeholder: String,
    focusRequester: FocusRequester,
    interactionSource: MutableInteractionSource,
) {
    KTextField(
        value = input.value,
        onValueChange = { input.value = it },
        placeholder = placeholder,
        shape = RoundedCornerShape(KRadius.control),
        variant = KTextFieldVariant.Inset,
        // QQ/微信那类紧凑输入框：36dp 高、左右 12dp、上下 6dp。
        // 2026-10-19 用户："打字内部的高度间隙太大" —— 原来是 40dp + 上下 8dp + 左右 16dp，
        // 15sp 文字在框里上下各空 ~9dp，看着像"字浮在框中间"。高度与内边距一起收，
        // 文字才贴住边（高度约束压不住组件内部的 defaultMinSize，必须从这里传）。
        minHeight = 36.dp,
        horizontalPadding = KSpacing.sm,
        // 6dp 是刻意取在 xxs(4) 与 xs(8) 之间：微信输入框的上下留白大约就是这一档
        verticalPadding = 6.dp,
        focusRequester = focusRequester,
        interactionSource = interactionSource,
    )
}

/** 日期分隔条：居中、muted 小字（设计稿「今天 14:32」） */
@Composable
private fun DayDivider(text: String) {
    val c = KTheme.colors
    Box(
        modifier = Modifier.fillMaxWidth().padding(vertical = KSpacing.sm),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, style = KType.footnote, color = c.textMuted)
    }
}

/** 聊天列表项：日期分隔条 或 一条消息 */
private sealed interface ChatEntry {
    val key: String

    data class Day(override val key: String, val text: String) : ChatEntry
    data class Bubble(override val key: String, val msg: MessageRepository.MessageUi) : ChatEntry
}

/**
 * 把消息切成「分隔条 + 消息」的扁平列表。
 *
 * 分隔条规则与 web 移动端（`lib/chatRows.ts`）同一条：相邻两条**间隔超过 5 分钟**就插一条，
 * 最旧的一条总是带（跨天必然超过 5 分钟，所以不用再单独判 `isSameDay`）。
 * 文案取那条消息的时间（「今天 14:32」/「昨天 14:32」/「9月12日 14:32」）。
 * 气泡下不再带时间戳（web 移动端亦然），分隔条是唯一的时间信息。
 */
private fun buildChatEntries(items: List<MessageRepository.MessageUi>): List<ChatEntry> {
    val out = mutableListOf<ChatEntry>()
    items.forEachIndexed { index, msg ->
        val prev = items.getOrNull(index - 1)
        val gap = prev?.let { timeGapMillis(msg.raw.createdAt, it.raw.createdAt) }
        if (prev == null || (gap != null && gap > CHAT_TIME_GAP_MS)) {
            out += ChatEntry.Day("day-${msg.raw.id}", dayDividerText(msg.raw.createdAt))
        }
        out += ChatEntry.Bubble("msg-${msg.raw.id}", msg)
    }
    return out
}

/** 相邻消息超过这个间隔就插时间分隔条（与 web 的 `TIME_GAP_MS` 同值） */
private const val CHAT_TIME_GAP_MS = 5 * 60 * 1000L

/**
 * 这张图是否已经在 Coil 的**磁盘缓存**里（进程重启后仍在，内存缓存不管）。
 *
 * 同步做一次 LRU 哈希查找 + 文件 stat（亚毫秒级），组合期调用安全；快照读完立刻
 * close（开着快照会挡住后续写入/删除）。
 *
 * 键必须与 NetworkFetcher 的算法严格一致：磁盘键 = `options.diskCacheKey ?: url`
 * （coil-network-core 的 NetworkFetcher.kt），聊天图片的请求没钉显式键，所以就是
 * URL 本身 —— 这正是 fetcher 自己"磁盘快速路径"用的同一条 `openSnapshot(url)`。
 * 有一天若给聊天图片钉了显式 diskCacheKey，这里要同步改。
 */
private fun isImageDiskCached(context: Context, url: String?): Boolean {
    if (url.isNullOrBlank()) return false
    val snapshot = SingletonImageLoader.get(context).diskCache?.openSnapshot(url) ?: return false
    snapshot.close()
    return true
}

/**
 * 消息气泡（样式对齐 web 移动端的 MessageBubble）：
 *  · **头像贴在消息外侧**：对方的在左、自己的在右，与消息间距 8dp。
 *  · 文本消息：圆角统一 `radiusRow(14)`、内边距 16dp、**不是**旧版那种"一角切平"的气泡尾巴。
 *  · 图片消息：**裸图**（没有气泡底），圆角 10、等比缩进 65vw × 50vw 内 —— 与 web 的
 *    `.messageImage` 同一套（旧版是"彩色气泡里塞一张 180×180 方图"，多了一层壳）。
 *  · 引用条：气泡**外**跟着的一枚灰色小圆角条（`.messageQuote`），单行「名字: 内容」超出省略；
 *    引用纯图片时是「名字:」+ 24dp 缩略图。旧版塞在气泡里，观感是"气泡里还套一块"。
 *  · **气泡下不带时间**：时间信息只由分隔条给出（相邻消息间隔 > 5 分钟插一条，与 web 同规则）；
 *    复制/引用/撤回一律长按弹出（与 Web 版 ChatContextMenu 同一套项与顺序）。
 */
@Composable
private fun MessageBubble(
    msg: MessageRepository.MessageUi,
    imageHeaders: Map<String, String>,
    partnerAvatar: String?,
    myAvatar: String?,
    /**
     * 这一格图片的来源登记键与下标（见 [chatImageOriginKey]）。
     *
     * 由上层算好传进来，而不是在这里就地算 —— 因为"这段对话里的第几张"要跟
     * 上层 `chatImageUrls`（打开查看器时用的同一份列表）严格同源，
     * 两个地方各算各的迟早会错位。
     *
     * `originKey == null` 表示不登记（例如这条消息的图不在 `chatImageUrls` 里）。
     */
    imageOriginKey: Long? = null,
    imageOriginIndex: Int = -1,
    /** 点图片：打开全屏查看器（图片消息才用得到） */
    onImageClick: () -> Unit,
    onQuote: () -> Unit,
    onRecall: () -> Unit,
    /** 语音消息：聊天页共享的播放控制器（同一条互斥、切条自动换源） */
    voice: VoicePlaybackController,
    /** 语音转文字（返回 ApiResult；结果由服务端缓存） */
    onTranscribe: suspend (Long) -> ApiResult<String>,
    /** 页面级 toast（转写失败等） */
    onToast: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = KTheme.colors
    val mine = msg.isMine
    val bubbleShape = RoundedCornerShape(KRadius.row)
    val bubbleBg = if (mine) c.accent else c.surface
    val bubbleFg = if (mine) c.onAccent else c.textPrimary
    var menu by remember { mutableStateOf(false) }
    // 气泡在窗口坐标系里的位置：长按菜单要据此定位（含指向气泡的小三角）
    var bubbleBounds by remember { mutableStateOf<Rect?>(null) }
    // 剪贴板与协程（M3 之后：LocalClipboard 的 setClipEntry 是挂起函数，需要一个 scope）
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()

    // 语音转写：气泡本身只显示「播放键 + 波形 + 秒数」，转文字收进长按菜单
    var voiceText by remember(msg.raw.id) {
        mutableStateOf(msg.audioText?.takeIf { it.isNotBlank() })
    }
    var showVoiceText by remember(msg.raw.id) { mutableStateOf(false) }
    var voiceTranscribing by remember(msg.raw.id) { mutableStateOf(false) }

    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start,
        verticalAlignment = Alignment.Top,
    ) {
        if (!mine) {
            Avatar(
                // 有头像就显示头像；没有（含深链进来拿不到头像）退化成默认人像
                url = partnerAvatar,
                name = msg.raw.senderUsername,
                // 设计稿「消息对话」实测头像 40dp（比会话列表行的 48 小一档）
                size = KDimens.avatarCard,
                glyph = GlyphKind.User,
                bg = c.surfaceSubtle,
                fg = c.textPrimary,
            )
            Spacer(Modifier.width(KSpacing.xs))
        }

        Column(
            horizontalAlignment = if (mine) Alignment.End else Alignment.Start,
            modifier = Modifier.widthIn(max = 280.dp),
        ) {
            // 外层 Box 只做长按菜单的锚点（菜单贴着消息弹出）
            Box {
                if (msg.imageUrl != null) {
                    // ---- 图片消息：对齐 web 移动端（MessageBubble.module.css 的 .messageImage）----
                    // web 是**裸图**：没有气泡底、圆角 12、等比缩进 65vw × 50vw 内；
                    // 旧版是"彩色气泡里再塞一张方图"，观感上多了一层壳。
                    // 私密图片必须带鉴权头，否则恒 403（表现为"图片永远白块"）。
                    val context = androidx.compose.ui.platform.LocalContext.current
                    val headers = coil3.network.NetworkHeaders.Builder().apply {
                        imageHeaders.forEach { (k, v) -> set(k, v) }
                    }.build()
                    /**
                     * 这张图是否已经在 Coil 的**磁盘缓存**里（进程重启后仍在）。
                     *
                     * 2026-10-16 用户反馈："已经看到过的图片重启 app 进入还是会触发图片
                     * 加载动画" —— 重启后内存缓存为空，磁盘命中也要**异步**取图/解码，
                     * 而聊天图片的请求默认走 `ImageLoading.gated`（在转场动画结束后才
                     * 开工，见 KApp.newImageLoader），于是 shimmer 从进页一直闪到动画结束。
                     *
                     * 磁盘里已有的图改走两条快速路：
                     *  · 请求换 `ImageLoading.immediate`（不等动画闸门，一两帧内就位）；
                     *  · 占位块**静置**（同底色、无 shimmer）—— 反正马上就是真图，
                     *    动画只会成为闪一下的杂讯（用户要求的"直接显示"）。
                     * 没缓存的图维持原样（shimmer + gated），不为新图牺牲转场帧率。
                     */
                    val imageDiskCached = remember(msg.imageUrl) {
                        isImageDiskCached(context, msg.imageUrl)
                    }
                    /**
                     * 图片消息的两个手势（与文字气泡**刻意不同**）：
                     *  · **单击 → 全屏看图**（用户反馈"聊天里的图片点不开全屏"）；
                     *  · **长按 → 底部弹层**（保存图片 / 引用 / 撤回）。
                     *
                     * 为什么图片不走文字那套"长按弹气泡旁的小菜单"：用户明确要求
                     * "长按图片/视频从下面弹出可保存的框"（2026-09-23），而文字气泡的
                     * 横排小菜单保持原样 —— 它没有"保存"这种主操作，弹层反而慢。
                     *
                     * 弹层宿主在 Shell（[LocalMediaSaveOpener]）：保存的进度与结果都在那里，
                     * 这里只负责"喊一声"，不重复实现一遍下载/落盘。
                     */
                    val mediaOpener = LocalMediaSaveOpener.current
                    /**
                     * 这一格的 painter：**额外 remember 一份**，只用来给来源登记读
                     * "这张图什么比例"。
                     *
                     * 为什么不能复用 `SubcomposeAsyncImage` 内部那个 painter：那个在
                     * `SubcomposeAsyncImageContent` 的 subcomposition 里，**外面拿不到**。
                     * 而 [registerViewerOrigin] 需要 painter 来算飞行落位帧的比例
                     * （否则退化成"铺满屏幕"再缩回，看着就是你说的"直接闪现"之后又跳一下）。
                     *
                     * 代价是多一份 painter 对象 —— 但 Coil 的请求**共用内存缓存**，
                     * 同一张图不会解码两次（这也是全项目所有 `registerViewerOrigin` 的既有做法）。
                     */
                    val originPainter = coil3.compose.rememberAsyncImagePainter(
                        model = coil3.request.ImageRequest.Builder(context)
                            .data(msg.imageUrl)
                            .httpHeaders(headers)
                            .build(),
                    )
                    Box(
                        modifier = Modifier
                            // 长按菜单要按图片在窗口里的真实位置定位（指针指向它）
                            .onGloballyPositioned { bubbleBounds = it.boundsInWindow() }
                            // 登记"这一格在哪 + 取景比例 + 圆角"：全屏查看器的进出场飞行靠它。
                            // 圆角必须与下面那行 `clip(...)` 一致（都是 KRadius.control）——
                            // 飞行图会从这个圆角变到全屏的直角。
                            .then(
                                if (imageOriginKey != null && imageOriginIndex >= 0) {
                                    Modifier.registerViewerOrigin(
                                        postId = imageOriginKey,
                                        index = imageOriginIndex,
                                        painter = originPainter,
                                        cornerRadius = KRadius.control,
                                    )
                                } else {
                                    Modifier
                                },
                            )
                            .combinedClickable(
                                onClick = onImageClick,
                                onLongClick = {
                                    val url = msg.imageUrl
                                    if (mediaOpener != null && !url.isNullOrBlank()) {
                                        mediaOpener(
                                            MediaSaveTarget(
                                                url = url,
                                                kind = MediaKind.Image,
                                                headers = imageHeaders,
                                                extraActions = buildList {
                                                    add(MediaSheetAction("引用") { onQuote() })
                                                    if (mine) {
                                                        add(
                                                            MediaSheetAction("撤回", danger = true) {
                                                                onRecall()
                                                            },
                                                        )
                                                    }
                                                },
                                            ),
                                        )
                                    }
                                },
                            ),
                    ) {
                        SubcomposeAsyncImage(
                            model = coil3.request.ImageRequest.Builder(context)
                                .data(msg.imageUrl)
                                .httpHeaders(headers)
                                // 磁盘里已有的图不等动画闸门（见上面 imageDiskCached 的注释）：
                                // 取图/解码直接在立即池跑，一两帧内就位，占位块只是闪现前的底色
                                .apply {
                                    if (imageDiskCached) {
                                        fetcherCoroutineContext(ImageLoading.immediate)
                                        decoderCoroutineContext(ImageLoading.immediate)
                                    }
                                }
                                .build(),
                            contentDescription = null,
                            modifier = Modifier.clip(RoundedCornerShape(KRadius.control)),
                        ) {
                            // 等比缩放：拿到真实宽高后按 aspectRatio 定尺寸，
                            // Fit 让图正好填满（等价于 web 的 max-width/max-height 等比缩放）。
                            // intrinsicSize 还没量出来（加载中）时先画占位块，量到后自动重组成真图。
                            val isz = painter.intrinsicSize
                            val ratio =
                                if (isz.width > 0f && isz.height > 0f) isz.width / isz.height else null
                            val winW = LocalWindowInfo.current.containerSize.width
                            val maxW = with(LocalDensity.current) { (winW * 0.65f).toDp() }
                            val maxH = with(LocalDensity.current) { (winW * 0.50f).toDp() }
                            if (ratio == null) {
                                Box(
                                    Modifier
                                        .size(180.dp)
                                        // 已看过（磁盘命中）：静置底色，不 shimmer —— shimmer 的
                                        // 扫光就是用户说的"加载动画"（2026-10-16 反馈）
                                        .clip(RoundedCornerShape(KRadius.control))
                                        .then(
                                            if (imageDiskCached) {
                                                Modifier.background(c.surfaceSunken)
                                            } else {
                                                Modifier.kShimmer(RoundedCornerShape(KRadius.control))
                                            },
                                        )
                                )
                            } else {
                                SubcomposeAsyncImageContent(
                                    modifier = Modifier
                                        .widthIn(max = maxW)
                                        .heightIn(max = maxH)
                                        .aspectRatio(ratio),
                                    contentScale = ContentScale.Fit,
                                )
                            }
                        }
                    }
                } else if (msg.hasAudio) {
                    // ---- 语音消息（QQ 式波形气泡）----
                    Box(
                        modifier = Modifier.onGloballyPositioned {
                            bubbleBounds = it.boundsInWindow()
                        },
                    ) {
                        VoiceMessageBubble(
                            msg = msg,
                            controller = voice,
                            onLongPress = { menu = true },
                        )
                    }
                    // 转写结果**另起一个文字气泡**（参考图：语音气泡下面单独一条白底文字）
                    if (showVoiceText) {
                        Spacer(Modifier.height(KSpacing.xxs))
                        Box(
                            modifier = Modifier
                                .widthIn(max = 260.dp)
                                .clip(bubbleShape)
                                .background(c.surface)
                                .padding(horizontal = KSpacing.sm, vertical = KSpacing.xs),
                        ) {
                            Text(
                                text = when {
                                    voiceTranscribing -> "转写中…"
                                    voiceText.isNullOrBlank() -> "[未识别到文字]"
                                    else -> voiceText.orEmpty()
                                },
                                style = KType.body,
                                color = c.textPrimary,
                            )
                        }
                    }
                } else {
                    // ---- 文本消息：原气泡 ----
                    Box(
                        modifier = Modifier
                            // 长按菜单要按气泡在窗口里的真实位置定位（指针指向它）
                            .onGloballyPositioned { bubbleBounds = it.boundsInWindow() }
                            // 气泡**至少**与头像同高：单行消息正好齐平。不能靠"内边距凑高度"——
                            // 文字行高是 sp（随系统字号缩放），dp 内边距怎么凑都会差出 1-2dp，
                            // 看起来就是"没对齐"；min 高度 + 文字垂直居中则永远严格齐平。
                            .heightIn(min = KDimens.avatarCard)
                            .clip(bubbleShape)
                            .background(bubbleBg)
                            .combinedClickable(
                                // 单击不做任何事（设计稿里气泡是"可长按"而不是"可点"）；
                                // 复制/引用/撤回全部收进长按菜单，界面上不再常显任何操作文字。
                                onClick = {},
                                onLongClick = { menu = true },
                            )
                            .padding(horizontal = KSpacing.sm),
                        contentAlignment = Alignment.CenterStart,
                    ) {
                        Text(
                            text = msg.raw.content,
                            style = KType.body,
                            // 自己的气泡是 accent 底 → 文字必须 onAccent（深色下 accent 是浅金）
                            color = bubbleFg,
                        )
                    }
                }

                // 长按菜单：自己画的浮层（横排 + 竖线分隔 + 指向气泡的小三角），
                // 视觉令牌与全项目一致；见 ChatContextMenu 的注释。
                if (menu && bubbleBounds != null) {
                    ChatContextMenu(
                        anchor = bubbleBounds!!,
                        actions = buildList {
                            // 语音消息：参考图的气泡不放大控制条，转文字/听筒切换放这里
                            if (msg.hasAudio) {
                                add(
                                    ChatMenuAction(
                                        if (showVoiceText) "收起文字"
                                        else if (voiceText != null) "看文字"
                                        else "转文字"
                                    ) {
                                        menu = false
                                        if (showVoiceText) {
                                            showVoiceText = false
                                        } else {
                                            val ready = voiceText
                                            if (ready != null) {
                                                showVoiceText = true
                                            } else {
                                                // 先把气泡撑出来显示「转写中…」，结果到了再替换
                                                showVoiceText = true
                                                scope.launch {
                                                    voiceTranscribing = true
                                                    when (val r = onTranscribe(msg.raw.id)) {
                                                        is ApiResult.Success -> voiceText = r.data
                                                        is ApiResult.Failure -> {
                                                            showVoiceText = false
                                                            onToast(r.error.displayMessage)
                                                        }
                                                    }
                                                    voiceTranscribing = false
                                                }
                                            }
                                        }
                                    }
                                )
                                add(
                                    ChatMenuAction(if (voice.speakerOn) "听筒播放" else "扬声器播放") {
                                        menu = false
                                        voice.toggleSpeaker()
                                    }
                                )
                            }
                            // 纯图片消息没有文字可复制，这一项就不出现（Web 版恒定显示，点了是空操作）
                            if (msg.raw.content.isNotBlank()) {
                                add(
                                    ChatMenuAction("复制") {
                                        menu = false
                                        // 旧写法 LocalClipboardManager.setText 已废弃；
                                        // 新 API 是挂起的 setClipEntry（见 PostDetailScreen 的同类改动）
                                        scope.launch {
                                            clipboard.setClipEntry(
                                                ClipEntry(
                                                    ClipData.newPlainText("聊天消息", msg.raw.content),
                                                ),
                                            )
                                        }
                                    }
                                )
                            }
                            add(
                                ChatMenuAction("引用") {
                                    menu = false
                                    onQuote()
                                }
                            )
                            if (mine) {
                                add(
                                    ChatMenuAction("撤回", danger = true) {
                                        menu = false
                                        onRecall()
                                    }
                                )
                            }
                        },
                        onDismiss = { menu = false },
                    )
                }
            }

            // 引用条：对齐 web 移动端（.messageQuote）—— **气泡外**的一枚灰色小圆角条，
            // 单行「名字: 内容」超出省略；引用的是纯图片时是「名字:」+ 24dp 缩略图。
            // 旧版把引用块塞在气泡里，观感是"气泡里还套一块"；web 上它是跟着气泡走的独立小条。
            if (msg.raw.quotedMessageId != null) {
                val imageQuote = msg.raw.quotedContent.isNullOrBlank() &&
                    !msg.raw.quotedImageUrl.isNullOrBlank()
                Row(
                    modifier = Modifier
                        .padding(top = KSpacing.xxs)
                        .clip(RoundedCornerShape(KRadius.chip))
                        .background(c.surfaceSubtle)
                        .padding(horizontal = KSpacing.xs, vertical = KSpacing.xxs),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
                ) {
                    if (imageQuote) {
                        Text(
                            text = "${msg.raw.quotedSenderUsername.orEmpty()}:",
                            style = KType.caption,
                            color = c.textSecondary,
                            maxLines = 1,
                        )
                        val context = androidx.compose.ui.platform.LocalContext.current
                        val headers = coil3.network.NetworkHeaders.Builder().apply {
                            imageHeaders.forEach { (k, v) -> set(k, v) }
                        }.build()
                        AsyncImage(
                            model = coil3.request.ImageRequest.Builder(context)
                                .data(msg.raw.quotedImageUrl)
                                .httpHeaders(headers)
                                .build(),
                            contentDescription = null,
                            contentScale = ContentScale.Crop,
                            // 引用缩略图不参与长按菜单，固定 24dp 方块即可
                            modifier = Modifier
                                .size(24.dp)
                                .clip(RoundedCornerShape(KRadius.chip)),
                        )
                    } else {
                        Text(
                            text = "${msg.raw.quotedSenderUsername.orEmpty()}: ${msg.raw.quotedPreview}",
                            style = KType.caption,
                            color = c.textSecondary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }

        if (mine) {
            Spacer(Modifier.width(KSpacing.xs))
            Avatar(
                url = myAvatar,
                name = msg.raw.senderUsername,
                size = KDimens.avatarCard,
                glyph = GlyphKind.User,
                bg = c.accent,
                fg = c.onAccent,
            )
        }
    }
}

/**
 * 聊天页内联提示。
 *
 * 与 [KToast] 的区别：那个会为导航胶囊留 101px，聊天页是沉浸态，用这个避免出现一块空白。
 */
@Composable
private fun KToastInline(text: String, onDismiss: () -> Unit) {
    val c = KTheme.colors
    LaunchedEffect(text) {
        kotlinx.coroutines.delay(1600)
        onDismiss()
    }
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(KRadius.row))
            .background(c.surfaceRaised)
            .padding(horizontal = KSpacing.md, vertical = KSpacing.xs),
    ) {
        Text(text, style = KType.caption, color = c.textPrimary)
    }
}

/**
 * 长按菜单退场后、再喊起输入法的等待时长。
 *
 * `Popup(focusable = true)` 关闭时弹层窗口是**异步拆掉**的：同一帧调
 * `keyboard.show()` 会被系统忽略（那时焦点还没真正回到本页的输入框上），
 * 表现就是"点了引用但键盘还是不弹"。150ms 足够让 popup 窗口销毁 + 焦点落回来，
 * 又短到用户完全感知不到。
 */
private const val KEYBOARD_SETTLE_MS = 150L

/**
 * 聚焦输入框后等 IME 升到表情面板等高的**交接超时**。
 *
 * 正常路径里 IME 三百毫秒左右就升到位，交接早就完成了；这个超时只兜
 * "IME 根本不会来"的场景（实体键盘、输入法被系统禁掉等）：到点按普通收起
 * 处理，面板自己缩回去，不会把输入栏永远架在半空。
 */
private const val IME_HANDOFF_TIMEOUT_MS = 600L

/**
 * Photo Picker 返回的 `content://` 拷进 cacheDir，返回落地的临时文件。
 *
 * 为什么必须拷：选择器给的是**临时读权限**，直接持有 uri 等"选完图放一会儿
 * 再上传"时会读不到（SecurityException）。与 ComposerScreen 的 copyToCache
 * 同一套做法 —— 那边是文件私有的 helper（composer/ 子目录），这里聊天单独
 * 一份（chat/ 子目录），互不干扰也不必为 6 行 IO 去抽公共模块。
 *
 * 文件名固定带 `.jpg`：multipart 文件名要过服务端的扩展名白名单
 * （imageFileFilter），而压缩器产物本来就是 jpg；GIF / 小图走原图回退时
 * 内容不是 jpg，但服务端收到后会用 sharp 统一再压一遍，不影响展示。
 *
 * @return 落地文件；拷贝失败（权限提前失效、磁盘满等）返回 null
 */
private fun copyUriToCache(context: Context, uri: Uri): File? = runCatching {
    val dir = File(context.cacheDir, "chat").apply { mkdirs() }
    val target = File(dir, "chat_${System.currentTimeMillis()}_${(0..9999).random()}.jpg")
    val input = context.contentResolver.openInputStream(uri) ?: return@runCatching null
    input.use { source ->
        target.outputStream().use { source.copyTo(it) }
    }
    target
}.getOrNull()

/**
 * 「最后一个非空值」：专门给**退场动画**用。
 *
 * `AnimatedVisibility(visible = replyTo != null)` 在退场期间内容仍在组合里，
 * 而那一刻 `replyTo` 已经被清成 null —— 不留住最后一个非空值，退场帧里就是一条**空条**
 * （或者 `!!` 直接崩）。与 AppShell 里那个同名工具同一个理由。
 */
@Composable
private fun <T : Any> rememberLastNonNull(value: T?): T? {
    val holder = remember { mutableStateOf<T?>(null) }
    LaunchedEffect(value) {
        if (value != null) holder.value = value
    }
    return value ?: holder.value
}



/**
 * 按住说话按钮（QQ 式功能排第一位）。
 *
 * 手势：按下 200ms 内抬起 = 普通点击（提示「长按说话」）；超过 200ms 进入录音，
 * 此后跟踪手指位置 —— 手指移到按钮上方 [CANCEL_DISTANCE_DP] 以外进入「松开取消」态。
 *
 * 为什么不用 `detectDragGesturesAfterLongPress`：它在"长按后没移动就松手"这条
 * 路径上不保证触发 `onDragEnd`，而这里**必须在松手时结束录音**（否则会一直录到 60s）。
 * 自己用 `awaitEachGesture` 逐事件读，抬起一帧就能收尾。
 */
@Composable
private fun ToolbarMicButton(
    active: Boolean,
    onClick: () -> Unit,
) {
    val c = KTheme.colors
    Box(
        modifier = Modifier
            .size(36.dp)
            .clip(CircleShape)
            .clickable(onClick = onClick)
            .semantics { contentDescription = if (active) "收起语音输入" else "语音输入" },
        contentAlignment = Alignment.Center,
    ) {
        Glyph(
            tint = if (active) c.accentText else c.textSecondary,
            kind = GlyphKind.Mic,
            size = 28.dp,
        )
    }
}

/**
 * 「按住说话」大按钮（QQ 语音面板里的蓝色圆形按钮）。
 *
 * 手势与之前小图标上的完全一致：按住 200ms 开录、松手发送、上滑 80dp 取消。
 * 现在只有这一个入口在录，所以取消距离常量继续复用。
 */
@Composable
private fun VoiceHoldButton(
    recording: Boolean,
    onStart: () -> Boolean,
    onFinish: () -> Unit,
    onCancel: () -> Unit,
    onCancelZoneChange: (Boolean) -> Unit,
    onTap: () -> Unit,
    modifier: Modifier = Modifier,
    diameter: Dp = 96.dp,
) {
    val c = KTheme.colors
    val cancelDistance = with(LocalDensity.current) { CANCEL_DISTANCE_DP.dp.toPx() }
    Box(
        modifier = modifier
            .size(diameter)
            .clip(CircleShape)
            .background(if (recording) Color(0xFFD9534F) else c.accent)
            .pointerInput(Unit) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    down.consume()
                    val upBeforeLongPress = withTimeoutOrNull(LONG_PRESS_MS) {
                        waitForUpOrCancellation()
                    }
                    if (upBeforeLongPress != null) {
                        onTap()
                        return@awaitEachGesture
                    }
                    if (!onStart()) return@awaitEachGesture

                    var cancelled = false
                    while (true) {
                        val event = awaitPointerEvent()
                        val change = event.changes.firstOrNull() ?: break
                        if (!change.pressed) {
                            if (cancelled) onCancel() else onFinish()
                            break
                        }
                        val inCancelZone = change.position.y < -cancelDistance
                        if (inCancelZone != cancelled) {
                            cancelled = inCancelZone
                            onCancelZoneChange(inCancelZone)
                        }
                        change.consume()
                    }
                }
            }
            .semantics { contentDescription = "按住说话" },
        contentAlignment = Alignment.Center,
    ) {
        Glyph(
            tint = c.onAccent,
            kind = GlyphKind.Mic,
            size = diameter * 0.42f,
        )
    }
}

/**
 * QQ 式语音输入面板（占满键盘交换区）。
 *
 * 上方「按住说话」、中间大圆按钮、下方提示；录音中把提示换成实时波形 + 计时，
 * 进入取消区整块变红提示「松开取消」。
 */
@Composable
private fun VoiceInputPanel(
    recording: Boolean,
    elapsedMs: Long,
    levels: List<Int>,
    cancelZone: Boolean,
    onStart: () -> Boolean,
    onFinish: () -> Unit,
    onCancel: () -> Unit,
    onCancelZoneChange: (Boolean) -> Unit,
    onTap: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = KTheme.colors
    Box(
        modifier = modifier
            .fillMaxSize()
            .background(c.surface),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier
                .navigationBarsPadding()
                .padding(bottom = KSpacing.lg),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(KSpacing.sm),
        ) {
            Text(
                text = if (recording) formatVoiceDuration(elapsedMs.toInt()) else "按住说话",
                style = KType.subtitle,
                color = if (recording) c.accentText else c.textSecondary,
            )
            VoiceHoldButton(
                recording = recording,
                onStart = onStart,
                onFinish = onFinish,
                onCancel = onCancel,
                onCancelZoneChange = onCancelZoneChange,
                onTap = onTap,
            )
            if (recording) {
                LiveWaveform(
                    levels = levels,
                    modifier = Modifier.width(170.dp).height(26.dp),
                )
                Text(
                    text = if (cancelZone) "松开取消" else "松开发送 · 上滑取消",
                    style = KType.caption,
                    color = if (cancelZone) Color(0xFFD9534F) else c.textMuted,
                )
            } else {
                Text(
                    text = "松开发送 · 上滑取消",
                    style = KType.caption,
                    color = c.textMuted,
                )
            }
        }
    }
}

/** 录音实时波形（0..32767 的振幅 → 26dp 高的柱） */
@Composable
private fun LiveWaveform(levels: List<Int>, modifier: Modifier = Modifier) {
    val barColor = KTheme.colors.accentText
    Canvas(modifier = modifier) {
        val bars = levels.takeLast(24).let { src -> if (src.isEmpty()) List(24) { 0 } else src }
        val slot = size.width / bars.size
        val barW = (slot * 0.55f).coerceAtLeast(1f)
        bars.forEachIndexed { i, amp ->
            val norm = sqrt((amp / 32_767f).coerceIn(0f, 1f))
            val h = (size.height * (0.12f + norm * 0.88f)).coerceAtLeast(2f)
            drawRoundRect(
                color = barColor,
                topLeft = Offset(i * slot + (slot - barW) / 2f, (size.height - h) / 2f),
                size = Size(barW, h),
                cornerRadius = CornerRadius(barW / 2f),
            )
        }
    }
}

/**
 * 录音中的悬浮条：实时波形 + 计时 + 「松开发送 · 上滑取消」。
 *
 * 画在消息列表的底部（`align(BottomCenter)`），**不参与输入栏布局** ——
 * 否则录音开始的瞬间整条输入栏会往上跳一格。
 */
@Composable
private fun VoiceRecordingOverlay(
    elapsedMs: Long,
    levels: List<Int>,
    cancelZone: Boolean,
    modifier: Modifier = Modifier,
) {
    val c = KTheme.colors
    val bg = if (cancelZone) Color(0xFF8E2A2A) else Color.Black.copy(alpha = 0.82f)
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(KRadius.row))
            .background(bg)
            .padding(horizontal = KSpacing.md, vertical = KSpacing.sm),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(KSpacing.xxs),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(KSpacing.sm),
        ) {
            Canvas(modifier = Modifier.width(150.dp).height(26.dp)) {
                val bars = levels.takeLast(24).let { src ->
                    if (src.isEmpty()) List(24) { 0 } else src
                }
                val slot = size.width / bars.size
                val barW = (slot * 0.55f).coerceAtLeast(1f)
                bars.forEachIndexed { i, amp ->
                    val norm = sqrt((amp / 32_767f).coerceIn(0f, 1f))
                    val h = (size.height * (0.12f + norm * 0.88f)).coerceAtLeast(2f)
                    drawRoundRect(
                        color = Color.White.copy(alpha = 0.92f),
                        topLeft = Offset(i * slot + (slot - barW) / 2f, (size.height - h) / 2f),
                        size = Size(barW, h),
                        cornerRadius = CornerRadius(barW / 2f),
                    )
                }
            }
            Text(
                text = formatVoiceDuration(elapsedMs.toInt()),
                style = KType.body,
                color = Color.White,
            )
        }
        Text(
            text = if (cancelZone) "松开取消" else "松开发送 · 上滑取消",
            style = KType.caption,
            color = if (cancelZone) Color.White else Color.White.copy(alpha = 0.85f),
        )
    }
}

/** 进入「取消区」的位移（dp）：手指从按钮往上的距离 */
private const val CANCEL_DISTANCE_DP = 80

/** 长按判定（ms）：短于它算点击 */
private const val LONG_PRESS_MS = 200L


/**
 * 发送键（QQ 参考图样式）：空输入 = 半透明主题色禁用，有字 = 实心主题色。
 *
 * 不复用 KButton 是因为它的禁用态是灰色（设计系统统一），而参考图要的是
 * "同一主题色的浅色态"。高度 36dp，与输入框严格齐平。
 */
@Composable
private fun ChatSendButton(
    sending: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    val c = KTheme.colors
    Box(
        modifier = Modifier
            .height(36.dp)
            .clip(RoundedCornerShape(KRadius.control))
            .background(if (enabled) c.accent else c.accent.copy(alpha = 0.42f))
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = KSpacing.md),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = if (sending) "…" else "发送",
            style = KType.bodyStrong,
            color = c.onAccent,
        )
    }
}

/**
 * 相册「拎起来发送」的浮层（2026-10-20，按用户 QQ 参考视频第三次改）。
 *
 * 画在**整页层级**而不是相册面板里：面板被交换区的 `clipToBounds` 裁着，图抬不出去。
 *
 * 四条硬规则（改之前先读 —— 前三版都是踩在这上面被打回的）：
 *  1. **画的是同一张位图**。[painter] 来自相册格子（已经解码好、尺寸就是格子尺寸），
 *     这里只做位移/淡出。换成 `AsyncImage(model = uri)` 等于让 Coil 换个目标尺寸重新
 *     取图解码 —— 用户看到的就是"又重新加载了一张"，第一帧还是白的。
 *  2. **尺寸一点不变**。节点尺寸 = 格子尺寸，跟手期间不放大也不缩小
 *     （用户："上滑不用改变图片本身大小"）。唯一例外见 [fit]。
 *  3. **横竖都跟手**。位移直接用手指的累计位移，1:1，不加阻尼、不加轨道。
 *  4. **原位留空**。拎起来的那一格由相册面板自己画成透明（`InlineAlbumPanel` 的
 *     `draggedPainter`），所以这里看不到"后面还压着一张一样的图"；落回或发出去、
 *     退场动画播完把 painter 清空，格子才回来。
 *
 * 退场（松手）分两种：
 *  · 上滑够 [ALBUM_SEND_DISTANCE_DP] → **当丢出去**：继续向上飞 96dp 同时淡出（200ms）；
 *  · 没够 → **落回相册那一格**：位移与缩放都回到 0（180ms），落定才让格子重新出现。
 * 这两个动作是"丢出去"的手感来源 —— 上一版松手是直接消失，像图被删了。
 *
 * [offsetX] / [offsetY] 传 lambda 不传值：它们每帧都在变，只在 `graphicsLayer { }`
 * （绘制期）里读，不把整个聊天页（含消息 LazyColumn 的 item DSL）拖进每帧重组。
 *
 * 第一层那个透明 Box 顺便**吃掉所有触摸**：拖拽期间点别处不该穿透到底下的列表或按钮
 * （否则松手那一刻可能顺带走了一次"点空白收面板"）。
 */
@Composable
private fun AlbumDragOverlay(
    painter: Painter?,
    bounds: Rect,
    offsetX: () -> Float,
    offsetY: () -> Float,
    released: Boolean,
    onExitFinished: () -> Unit,
) {
    if (painter == null) return
    val c = KTheme.colors
    val density = LocalDensity.current
    val cfg = LocalConfiguration.current
    val screenWidthPx = cfg.screenWidthDp * density.density
    val screenHeightPx = cfg.screenHeightDp * density.density
    /** 被按住那一格的矩形。拿不到布局矩形（极端时序）时按屏幕中部一块兜底 */
    val hasBounds = bounds.width > 0f && bounds.height > 0f
    val cellWidth = if (hasBounds) bounds.width else screenWidthPx * 0.5f
    val cellHeight = if (hasBounds) bounds.height else screenHeightPx * 0.42f
    val cellLeft = if (hasBounds) bounds.left else (screenWidthPx - cellWidth) / 2f
    val cellTop = if (hasBounds) bounds.top else screenHeightPx * 0.58f
    /**
     * 「原尺寸」的唯一例外：格子在相册条里就比屏幕还宽/还高（横图很常见，格子宽 =
     * 面板高 × 比例）。这种图原尺寸拎起来会挂出屏幕两侧，于是按比例收进屏幕。
     * 收的动作跟着 150ms 的抬起动画一起做（不是"啪"地变小）；普通竖图/截图 fit = 1，
     * 全程一个像素都不变。
     */
    val fit = minOf(1f, screenWidthPx / cellWidth, screenHeightPx * 0.94f / cellHeight)

    /** 拎起来的程度：0 = 完全等同格子，1 = 完全浮起（只对 fit < 1 的图有可见差异） */
    val lift = remember(painter) { Animatable(0f) }
    /** 落回相册时把位移收回去：1 = 跟着手指，0 = 已回到格子原位 */
    val settle = remember(painter) { Animatable(1f) }
    /** 丢出去的退场：1 = 已经飞走并淡出 */
    val exit = remember(painter) { Animatable(0f) }
    val finishExit by rememberUpdatedState(onExitFinished)
    val sendPx = with(density) { ALBUM_SEND_DISTANCE_DP.dp.toPx() }
    val flyUpPx = with(density) { 96.dp.toPx() }

    LaunchedEffect(released, painter) {
        if (!released) {
            // 拎起来：普通图 fit = 1，这里什么都不会变；横图才看得见那一下"收进屏幕"
            lift.animateTo(1f, tween(durationMillis = 150, easing = FastOutSlowInEasing))
            return@LaunchedEffect
        }
        // 松手：先掐掉可能还在跑的抬起动画（同一个 Animatable 不能被两个动画抢）
        lift.stop()
        if (offsetY() <= -sendPx) {
            // 丢出去：一边往上飞一边淡出
            val flying = launch { lift.animateTo(1f, tween(durationMillis = 120)) }
            val fading = launch { exit.animateTo(1f, tween(durationMillis = 200, easing = FastOutSlowInEasing)) }
            flying.join()
            fading.join()
        } else {
            // 没滑够：落回相册那一格
            val back = launch { settle.animateTo(0f, tween(durationMillis = 180, easing = FastOutSlowInEasing)) }
            val down = launch { lift.animateTo(0f, tween(durationMillis = 180, easing = FastOutSlowInEasing)) }
            back.join()
            down.join()
        }
        finishExit()
    }

    /** 上滑多少 px 压层到满：比发送判定略长一点，滑到能松手时压层已经到底 */
    val rampPx = with(density) { (ALBUM_SEND_DISTANCE_DP * 1.15f).dp.toPx() }

    Box(modifier = Modifier.fillMaxSize()) {
        // 吃掉所有触摸（透明，不做视觉）
        Box(
            modifier = Modifier
                .fillMaxSize()
                .pointerInput(Unit) {
                    awaitPointerEventScope {
                        while (true) {
                            awaitPointerEvent().changes.forEach { it.consume() }
                        }
                    }
                },
        )
        /**
         * 压层：只有相册条**以上**这一块（参考图是浅底）。
         *
         * 浓度跟着**上滑距离**涨（横向拖动不压层，参考视频里左右挪图时背景是不变的），
         * 丢出去时跟着退场一起淡掉；落回相册时位移在收，压层也跟着退。
         */
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(with(density) { cellTop.coerceAtLeast(0f).toDp() })
                .graphicsLayer {
                    val progress = (-offsetY() * settle.value / rampPx).coerceIn(0f, 1f)
                    alpha = progress * (1f - exit.value)
                }
                .background(Color.White.copy(alpha = 0.72f)),
        )
        // 提示：纸飞机 + 松手发送（屏幕上方，和参考图一致；浅底上用深色才看得清）
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = (cfg.screenHeightDp * 0.2f).dp)
                .graphicsLayer {
                    val progress = (-offsetY() * settle.value / rampPx).coerceIn(0f, 1f)
                    alpha = progress * (1f - exit.value)
                },
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Glyph(tint = c.textPrimary, kind = GlyphKind.Send, size = 30.dp)
            Spacer(Modifier.height(KSpacing.xs))
            Text(text = "松手发送", style = KType.body, color = c.textPrimary)
        }
        // 拎在手上的那张图：**原尺寸**，横竖都跟手，丢出去时向上飞 + 淡出
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopStart) {
            Image(
                painter = painter,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier
                    .size(
                        with(density) { cellWidth.toDp() },
                        with(density) { cellHeight.toDp() },
                    )
                    // 缩放/位移挂在最外层：阴影跟着一起动
                    .graphicsLayer {
                        transformOrigin = TransformOrigin.Center
                        val s = lerp(1f, fit, lift.value)
                        // 丢出去时略收一点（6%），像被抛走的手感；其余时刻恒为原尺寸
                        val toss = 1f - 0.06f * exit.value
                        scaleX = s * toss
                        scaleY = s * toss
                        translationX = cellLeft + offsetX() * settle.value
                        translationY = cellTop + offsetY() * settle.value - flyUpPx * exit.value
                        alpha = 1f - exit.value
                    }
                    // 直角 + 阴影：和格子里的那张一模一样，只是"离了地"
                    .shadow(8.dp),
            )
        }
    }
}
