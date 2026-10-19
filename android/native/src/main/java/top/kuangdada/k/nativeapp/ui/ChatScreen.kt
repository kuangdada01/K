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

import android.content.ClipData
import android.content.Context
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.gestures.detectTapGestures
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
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
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
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
import kotlinx.coroutines.Dispatchers
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
import top.kuangdada.k.core.designsystem.component.KEmojiPanelHeight
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
    val pickChatImage = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia()
    ) { uri: Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            sending = true
            try {
                val file = withContext(Dispatchers.IO) {
                    copyUriToCache(context, uri)?.let { raw ->
                        ImageCompressor.compressFile(context, raw)?.also { raw.delete() } ?: raw
                    }
                }
                when {
                    file == null -> toast = "读取图片失败，请重试"
                    else -> when (
                        val r = messages.send(
                            partnerId,
                            "",
                            image = file,
                            quotedMessageId = replyTo?.raw?.id,
                        )
                    ) {
                        is ApiResult.Success -> {
                            items = items + r.data
                            replyTo = null
                            // reverseLayout 下新消息是 index 0：主动滚一次（与文字发送同）
                            listState.animateScrollToItem(0)
                        }
                        is ApiResult.Failure -> toast = r.error.displayMessage
                    }
                }
            } finally {
                sending = false
            }
        }
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
         * 上下翻聊天记录时**也**收起键盘（用户反馈：只有"点一下"能收，翻记录时不收）。
         *
         * 判据是**用户手指拖拽的起点**（[DragInteraction.Start]），不是
         * `listState.isScrollInProgress` —— 后者把**程序化滚动**也算进去，而发完消息
         * `animateScrollToItem(0)` 会自动滚到底：用它的话"发一条消息键盘就没了"，
         * 连发几条根本没法用。拖拽交互是 `scrollable` 里只有手指真的在拖才会发的事件，
         * 惯性甩动属于同一次拖拽（起点已经收过键盘，不需要重复收）。
         *
         * 列表是 `reverseLayout`，键盘收起只改动输入栏那一块的高度，列表内容位置不动，
         * 所以"收起键盘"本身不会让聊天记录跳 —— 这是敢在滚动里收键盘的前提。
         */
        LaunchedEffect(listState) {
            listState.interactionSource.interactions.collect { interaction ->
                if (interaction is DragInteraction.Start) {
                    // 用户动手了：从此不再自动贴底（判据见 ChatScreen 里 userDragged 的注释）
                    userDragged = true
                    keyboard?.hide()
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
            }
        }

        // 面板全高与 IME 全高同口径（都含导航栏那一条），网格内容再自己避让导航栏
        val panelHeightPx = if (lastImeBottomPx > 0) {
            lastImeBottomPx
        } else {
            navBottomPx + with(density) { KEmojiPanelHeight.toPx() }.roundToInt()
        }
        val panelGridHeightDp = with(density) { (panelHeightPx - navBottomPx).toDp() }

        /** 面板展开比例 0..1：0 = 收起，1 = 与键盘等高占满交换区 */
        val panelFraction = remember { Animatable(0f) }
        LaunchedEffect(emojiOpen) {
            if (emojiOpen) {
                if (!animationsEnabled) {
                    panelFraction.snapTo(1f)
                } else {
                    // 从键盘状态打开 → 瞬时占位（键盘滑走露出面板）；平时从底边长出。
                    // 事件期读取（effect 只在 emojiOpen 变化时跑一次），不订阅 IME
                    panelFraction.snapTo(if (ime.getBottom(density) > 0) 1f else 0f)
                    panelFraction.animateTo(1f, KMotion.spatialBounded<Float>())
                }
            } else {
                if (!animationsEnabled) panelFraction.snapTo(0f)
                else panelFraction.animateTo(0f, KMotion.spatialBounded<Float>())
            }
        }

        // 交换区高度（键盘/面板/导航栏三者取大）不再在组合期算 —— 见
        // ExchangeZone.kt：消费它的两个节点（下面的交换区 Box 与 toast 让位）
        // 都改用布局期读取的 modifier，动画期间整页不再重组。

        // 聚焦输入框而面板还开着 → 交接：等键盘升到面板等高再收面板（见上面总注释）
        LaunchedEffect(inputFocused) {
            if (!inputFocused || !emojiOpen) return@LaunchedEffect
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
            Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                when {
                    /**
                     * **有内容就先渲染**（缓存命中，或 SSE 已经刷过）：连加载失败也**不把已有消息
                     * 换成一张错误页** —— 刷新是后台动作，静默失败比"正在看的消息突然消失"好。
                     */
                    items.isNotEmpty() -> LazyColumn(
                        state = listState,
                        modifier = Modifier
                            .fillMaxSize()
                            // 点列表空白处：收键盘**并收起表情面板** —— 两个都挡内容，
                            // 用户点这里就是想说"我要看消息/我要打字了"
                            .pointerInput(Unit) {
                                detectTapGestures {
                                    keyboard?.hide()
                                    emojiOpen = false
                                }
                            },
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
                            text = "${target.raw.senderUsername}：${target.raw.content.ifBlank { "[图片]" }}",
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
                        KButton(
                            text = if (sending) "…" else "发送",
                            // 与输入框同一档圆角（详情页评论输入条同款）
                            cornerRadius = KRadius.control,
                            // **等高**（2026-09-25 反馈：发送按钮比文字框高）：与输入框的
                            // minHeight 一致（2026-10-19 紧凑化后为 36dp）；compact 的内边距
                            // 保证文字内容塞得进 36dp —— 不配它按钮会被内容撑回 44dp
                            compact = true,
                            minHeight = 36.dp,
                            onClick = {
                                if (input.value.isBlank()) {
                                    toast = "不能发空消息"
                                    return@KButton
                                }
                                scope.launch {
                                    sending = true
                                    val quoted = replyTo?.raw?.id
                                    when (val r = messages.send(partnerId, input.value.trim(), quotedMessageId = quoted)) {
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
                            },
                            // 设计稿里空输入时发送按钮也是实心 accent（不置灰）；
                            // 空内容点它由上面的 input.value.isBlank() 分支给一句提示，不会发出空消息。
                            enabled = !sending,
                        )
                    }

                    // 功能排（QQ 式：放在输入框**下面**，不再和输入框抢横向空间）：
                    // 表情 + 发图两钮之间 12dp（M6.24 反馈过"表情跟相册间距太小"，当时定的 8dp，
                    // 下移成独立行后可以松一档）。
                    // 尺寸史：2026-10-15 盒 28 → 10-18"图标小了，要跟输入框一样高"→ 盒/图标 40
                    // → 10-19"图标太大了"→ **盒 36 / 图标 28**（当前定稿，图标约占框高 3/4）。
                    // 10-19 再要求"功能放输入框下面"——尺寸不变，只改位置。
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(KSpacing.sm),
                    ) {
                        // 表情开关（笑脸）：点亮态 = 面板正开着。
                        // 盒 36dp / 图标 28dp —— 与输入框同高，图标留 4dp 呼吸位。
                        KEmojiButton(
                            active = emojiOpen,
                            boxSize = 36.dp,
                            iconSize = 28.dp,
                            onClick = {
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
                                        // 收键盘 + **清掉焦点**再去选图（2026-09-25 第三轮
                                        // 反馈的最终形态）：焦点不在了，从相册回来（无论选没
                                        // 选）系统都不会自动把 IME 弹起来 —— 之前"保留焦点
                                        // 让系统弹回"的版本，返回那一刻键盘重新升起，用户
                                        // 反馈"太突兀"。要打字就再点一下输入框。
                                        keyboard?.hide()
                                        focusManager.clearFocus()
                                        if (sending) {
                                            // 上一张还在传：multipart 并发两条容易乱序且看不清进度
                                            toast = "正在发送，请稍候"
                                        } else {
                                            pickChatImage.launch(
                                                PickVisualMediaRequest(
                                                    ActivityResultContracts.PickVisualMedia.ImageOnly,
                                                )
                                            )
                                        }
                                    },
                                )
                                .semantics { contentDescription = "发送图片" },
                            contentAlignment = Alignment.Center,
                        ) {
                            Glyph(
                                tint = if (imagePressed || sending) c.accentText else c.textSecondary,
                                // `photo`（Tabler，非 lucide）：lucide 的 image 系带 r=2 空心小圆、
                                // 24dp 下糊团（"锯齿"）；相机与 album 相继被否——最终选经典照片
                                // 造型（相框+山坡+实心太阳点，见 IconPathsExtra.kt / TABLER_PHOTO）
                                kind = GlyphKind.Photo,
                                size = 28.dp,
                            )
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
                        // —— 键盘/面板动画期间这里只重布局，不重组整页
                        .exchangeZoneHeight(density, ime, nav, panelHeightPx) { panelFraction.value }
                        .clipToBounds(),
                    contentAlignment = Alignment.BottomCenter,
                ) {
                    if (panelFraction.value > 0f) {
                        KEmojiPanel(
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
         * ★ `focusable = true` 是**必须**的：它负责"点菜单外面就关掉"
         * （`onDismissRequest` 只有可聚焦弹层才会收到），也负责菜单能拿到点击。
         *
         * 代价与对策（用户反馈："**输入法在唤醒的时候长按消息引用会退出输入法**"）：
         * 可聚焦弹层会把焦点从输入框抢走 → IME 随之收起。**这是系统行为，弹层里改不掉**，
         * 所以对策放在"引用"这个动作上 —— 见 `quoteMessage`：它会把焦点交还输入框
         * 并重新 `show()` 一次，用户看到的是"键盘闪了一下又回来了"。
         *
         * 为什么不干脆改成 `focusable = false` 让弹层不抢焦点：那样 `onDismissRequest`
         * 永远不会触发（点空白关不掉菜单），得自己加全屏透明遮罩层接管点击，
         * 反而多一个"遮罩会不会挡住气泡长按"的新问题，得不偿失。
         */
        properties = PopupProperties(focusable = true),
        onDismissRequest = onDismiss,
    ) {
        // 只有内容本身那么大（位置由 provider 定），点空白关闭交给 focusable + onDismissRequest
        /**
         * 弹出时的"弹性缩放"（M4）：从贴着气泡的那个角长出来，带一点过冲。
         *
         * 起点 0.86 而不是 0：长按菜单是"从手指下钻出来"的东西，从 0 放大像凭空出现；
         * 过冲用 [KMotion.pressSpec]（阻尼比 0.45）—— 与点赞同一个语义："手指施加了力"。
         * 首帧 `measured` 还是 false（卡片尺寸没量到，三角位置会闪），所以量到之后才开始弹。
         */
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

