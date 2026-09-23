package top.kuangdada.k.nativeapp.ui

import android.content.Context
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import top.kuangdada.k.core.data.ApiResult
import top.kuangdada.k.core.data.ComposerRepository
import top.kuangdada.k.core.data.displayMessage
import top.kuangdada.k.core.data.image.ImageCompressor
import top.kuangdada.k.core.data.isAcceptableVideoName
import top.kuangdada.k.core.data.resolveUrl
import top.kuangdada.k.core.designsystem.component.KButton
import top.kuangdada.k.core.designsystem.component.KButtonVariant
import top.kuangdada.k.core.designsystem.component.KTextField
import top.kuangdada.k.core.designsystem.component.KTextFieldVariant
import top.kuangdada.k.core.designsystem.theme.KRadius
import top.kuangdada.k.core.designsystem.theme.KSpacing
import top.kuangdada.k.core.designsystem.theme.KTheme
import top.kuangdada.k.core.designsystem.theme.KType

/**
 * ============================================================
 * 发布弹层（设计稿「发布弹层 · 全屏 sheet」，浅色/深色两套）
 * ============================================================
 * 设计稿逐项对照（这张稿子是**整块重画**的，与上一版差异很大）：
 *  1. **顶栏**：左「取消」（无底无框的纯文字按钮）、中「新帖子」（居中）、
 *     右「发布」（实心 accent 胶囊，实测 58×35，比常规按钮矮一档 → [KButton] 的 compact）；
 *  2. **头像行**：40dp 头像 + 昵称，**没有标题输入框**（上一版有，已按稿子去掉）；
 *  3. **正文块**：`surface` + `borderStrong` 描边的卡片，最小高 160dp；
 *     **表情按钮与字数计数在卡片内部底栏**（`28dp` 圆形表情钮 + `48 / 2000`），
 *     正文本身是**无底无框**的（外层已经是卡片，再套一层就是双层框 → KTextFieldVariant.Plain）；
 *  4. **媒体网格**：3 列方格 + 「＋图」/「＋视频」格（描边、无底），实测格宽 114dp（KGrid 三列等式）；
 *  5. **两个 chip**：话题 / 位置，再加一个「评论」chip 展开评论设置；
 *  6. **说明行**：`发布后 24 小时内可编辑；图片会自动压缩到长边 1440px。`
 *  7. 整层是「全屏 sheet」：顶部留 12dp 缝 + 24dp 圆角 + sheet 阴影，背后页面透出。
 *
 * 三个 chip 的**真实能力边界**（服务端 `POST /api/posts` 只收
 * `title / description / close_comments / pinned / images`）：
 *  · 话题 → 在光标处插入 `#`：服务端会从正文里 `extractTags()` 抽 `#话题` 入库，**真功能**；
 *  · 位置 → 服务端 posts.location 字段（migration 027），**真功能**；
 *  · 评论 → 展开评论开关，对应服务端的 **真实字段**（close_comments）。
 *  · ~~公开 / 可见范围~~ → **已移除**：服务端 posts 表没有可见范围字段，
 *    「仅自己可见」永远是"点了没用"的死按钮。用户反馈要求取消这一板块，
 *    于是不再展示（不做假 UI 的一贯原则）。原「公开」chip 现在只承载评论设置。
 *
 * 上传契约（已核对服务端 posts/crud.ts）：multipart 字段名 `images`（数组，最多 9 张）/
 * `title` / `description` / `close_comments`（**字符串** '0'/'1'，不是布尔 —— 传 true 会被
 * 当成非 '1'，从而静默变成"允许评论"）。
 *
 * 视频上传契约（已核对服务端 posts/media.ts）：图文帖与视频帖是**两套端点**，
 * 视频走 `POST /api/posts/video-temp`（临时目录，先传后编）→
 * `GET /api/posts/video-temp/status`（轮询转码）→ `POST /api/posts/video`
 * （用 `video_url` 把临时文件转正）。所以同一帖子里**图片与视频互斥**：混选必然丢一样。
 */
private const val MAX_LENGTH = 2000
private const val MAX_IMAGES = 9

/**
 * 头像行与顶栏之间额外拉开的距离。
 *
 * 用户反馈「头像离 top 栏太近了」：原先头像紧贴顶栏（只隔了父布局的 12dp），
 * 在深色主题 + 状态栏图标下方显得挤。这里按设计系统的 lg(20dp) 给一段呼吸空间，
 * 而不是给一个随手写的数字。
 */
private val HEADER_TOP_GAP = KSpacing.lg

/** 转码状态轮询间隔（服务端是串行 ffmpeg 队列，2.5s 足够且不至于打爆服务端） */
private val VIDEO_STATUS_POLL_INTERVAL_MS = 2500L

/** 转码等待上限：超过就提示用户"仍在处理"，不再无限转圈（服务端队列是串行的） */
private const val VIDEO_TRANSCODE_TIMEOUT_MS = 5 * 60 * 1000L

/** 表情面板（设计稿要求"表情直接在正文框里选"，所以面板画在卡片内部） */
private val COMPOSER_EMOJIS = listOf(
    "😀", "😄", "😁", "😆", "😅", "😂", "🙂", "😉",
    "😊", "😍", "🥰", "😘", "😜", "🤔", "🤗", "😎",
    "😭", "😢", "😅", "😳", "🥺", "😴", "🤯", "😱",
    "👍", "👎", "👏", "🙏", "💪", "🤝", "✌️", "👌",
    "❤️", "🔥", "🎉", "✨", "⭐", "💡", "📌", "✅",
)

/**
 * 编辑已有帖子时要带进来的内容。
 *
 * 服务端 `PUT /api/posts/:id` 的契约与创建不同：它用 **`keepImages`（JSON 数组字符串）**
 * 表示"保留哪些既有图片"，再配合 `images` 数组上传新图。
 * 所以编辑态要同时维护两份清单：既有图的 URL 与本次新选的文件。
 */
data class EditingPost(
    val id: Long,
    val description: String,
    val existingImages: List<String>,
    /** 位置（编辑态回填；空串=原本就没填） */
    val location: String = "",
    /** 进来就弹删除确认（个人主页长按 →「删除帖子」走这条） */
    val openDeleteConfirm: Boolean = false,
)

@Composable
fun ComposerScreen(
    composer: ComposerRepository,
    /** 当前登录用户的头像（已解析成绝对地址）与昵称 —— 设计稿头像行要用 */
    myAvatar: String?,
    myName: String,
    onClose: () -> Unit,
    onPosted: () -> Unit,
    /**
     * 删除成功后的收尾。**与 [onPosted] 刻意分开**：发布成功要把用户带到首页看结果，
     * 而删除成功应该**退出到主页并刷新列表**（用户要求）——
     * 删完停在原处是最糟的：如果是从那条帖子的详情页进来编辑的，pop 回去正好是
     * **一个已经被删掉的详情页**（界面上是「帖子加载失败 HTTP 404」）。
     */
    onDeleted: () -> Unit = onPosted,
    /** null = 新建；非 null = 编辑该帖 */
    editing: EditingPost? = null,
    /**
     * 删帖（只在编辑态出现）。**suspending**：调用方（AppShell）要等它的结果 ——
     * 成功才关页面，失败要把服务端文案留在这一页上，不能让用户以为删掉了。
     *
     * 为什么由外面注入而不是在这里直接用仓库：本页只拿到 [ComposerRepository]（发布/编辑用），
     * 删帖属于 `PostRepository`；从签名上传一个函数，比在这里再引一个仓库干净，
     * 也与本页其它"动作交给调用方"的写法一致（`onClose` / `onPosted` 都是这样）。
     */
    onDeleteRequest: (suspend (postId: Long) -> ApiResult<Unit>)? = null,
) {
    val c = KTheme.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val focusRequester = remember { FocusRequester() }

    var text by remember { mutableStateOf(TextFieldValue(editing?.description.orEmpty())) }
    // 位置：chip 上显示已选地点；空串 = 不带位置（服务端 posts.location，上限 60 字符）。
    // **只能从地图选点来**（GPS 定位 + 图钉），不提供手输地址的入口。
    var location by remember { mutableStateOf(editing?.location.orEmpty()) }
    var showLocationPicker by remember { mutableStateOf(false) }
    var closeComments by remember { mutableStateOf(false) }
    var showEmojiPanel by remember { mutableStateOf(false) }
    var showCommentsPanel by remember { mutableStateOf(false) }
    var tip by remember { mutableStateOf<String?>(null) }
    var submitting by remember { mutableStateOf(false) }
    /** 删除确认弹窗是否打开 */
    var confirmDelete by remember { mutableStateOf(false) }
    // 从"个人主页长按 → 删除帖子"进来时，直接弹确认（见 ComposerEditSource.openDeleteConfirm）：
    // 用户已经明确表达了要删，再让他自己在编辑页里找那个 chip 是多余的
    LaunchedEffect(editing?.id) {
        if (editing?.openDeleteConfirm == true) confirmDelete = true
    }
    /** 正在删除（防重复点击 + 按钮文案反馈） */
    var deleting by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var pickHint by remember { mutableStateOf<String?>(null) }

    // ---- 视频（视频帖与图文帖互斥：服务端是两套端点，混选必然丢一样）----
    /** 本地已选视频（cacheDir 里的副本，上传与重试用它） */
    var pickedVideo by remember { mutableStateOf<File?>(null) }
    /** 上传时使用的原始文件名（**必须带白名单扩展名**，服务端按扩展名判定） */
    var pickedVideoName by remember { mutableStateOf("") }
    /** 临时视频路径（服务端返回的相对路径，如 `/uploads/temp/temp-….mp4`） */
    var tempVideoUrl by remember { mutableStateOf<String?>(null) }
    /** 上传百分比；null = 还没有上传任务（含上传已完成） */
    var videoProgress by remember { mutableStateOf<Int?>(null) }
    /** 转码是否完成（true 才允许发布：未转码完的 HEVC/4K 在部分机型播不出来） */
    var videoReady by remember { mutableStateOf(false) }
    var videoError by remember { mutableStateOf<String?>(null) }
    /** 上传协程；发布前要等它结束，取消时要取消它 */
    var videoJob by remember { mutableStateOf<Job?>(null) }

    // ---- 视频封面（设计稿：发布页显示视频画面 + 时长 + 「选封面」，点开滑出选封面面板）----
    /** 首帧落成的 cache 文件（发布页那块大图用）；抽不到就是 null，界面退回"文件名 + 状态" */
    var videoFrame by remember { mutableStateOf<File?>(null) }
    /** 视频时长（毫秒）；抽不到就不画时长胶囊 */
    var videoDurationMs by remember { mutableStateOf<Long?>(null) }
    /**
     * **已确认**的封面文件（null = 用默认）。
     *
     * 默认那条路径什么也不用做：服务端在 `cover` 缺失时会用 ffmpeg 从视频自动截首帧 ——
     * 也就是设计稿说的"点完成才确认封面，不然默认第一帧是封面"。
     * 只有用户在面板里真的挑了（某一帧 / 相册里的一张图）才会多传这一张。
     */
    var pickedCover by remember { mutableStateOf<File?>(null) }
    /** 选封面面板开着没有 */
    var showCoverPanel by remember { mutableStateOf(false) }

    // 编辑态：服务端返回的相对路径原样回传（**不要**拼成绝对地址，服务端按相对路径匹配）
    val keptImages = remember { mutableStateListOf<String>().also { it.addAll(editing?.existingImages.orEmpty()) } }

    // 本次新选的图片（相册 uri 先拷进 cacheDir，再本地压缩，再作为 multipart 上传）
    val picked = remember { mutableStateListOf<File>() }

    /**
     * 取消当前视频（含清理服务端的临时文件）。
     *
     * 清理是**必须**的：temp 目录按用户计配额（1GB），放弃的视频不清会一直占着，
     * 用户下次选视频会遇到"临时视频空间不足"却找不到原因（服务端 24h TTL 才回收）。
     */
    fun clearVideo() {
        videoJob?.cancel()
        videoJob = null
        // 本地副本一并删掉：cacheDir 里的 300MB 副本不清会一直占着手机存储
        pickedVideo?.delete()
        pickedVideo = null
        pickedVideoName = ""
        videoProgress = null
        videoReady = false
        videoError = null
        // 封面与首帧跟着这条视频走：换了视频，旧的帧/封面都失效
        videoFrame?.delete()
        videoFrame = null
        videoDurationMs = null
        pickedCover?.delete()
        pickedCover = null
        showCoverPanel = false
        val remote = tempVideoUrl
        tempVideoUrl = null
        if (remote != null) {
            scope.launch { composer.discardTempVideo(remote) }
        }
    }

    /**
     * 选完视频就把**首帧与时长**取出来（设计稿那块"视频画面 + 0:42"）。
     *
     * 抽帧是解码，所以整个 [VideoFrames] 都在 IO 线程；抽不到（编码不支持 / 文件坏了）
     * 就保持 null —— 界面退回原来那种"文件名 + 上传状态"的格子，发布流程不受影响。
     */
    LaunchedEffect(pickedVideo) {
        val file = pickedVideo
        if (file == null) {
            videoFrame = null
            videoDurationMs = null
            return@LaunchedEffect
        }
        videoDurationMs = VideoFrames.durationMs(file)
        videoFrame = VideoFrames.firstFrameFile(file)
    }

    /**
     * 轮询临时视频转码状态。
     *
     * 三种结局都要有出路：`done` 放行发布；`missing` 报错并要求重选（临时文件被
     * TTL 或别人清掉了）；网络抖动按"还没好"继续轮询 —— **一次失败不能判死上传**。
     * 超过 [VIDEO_TRANSCODE_TIMEOUT_MS] 就停止轮询（服务端队列是串行的，
     * 大视频排队可能很久），提示仍在后台处理，不把用户永远锁在"处理中"。
     *
     * 位置必须在 [uploadPickedVideo] **之前**：Kotlin 的局部函数不像类成员那样
     * 可以前向引用，写在后面会直接报 "Unresolved reference"。
     */
    suspend fun pollTranscode(url: String) {
        val startedAt = System.currentTimeMillis()
        while (true) {
            when (val st = composer.tempVideoStatus(url)) {
                is ApiResult.Success -> {
                    if (st.data.isDone) {
                        videoReady = true
                        return
                    }
                    if (st.data.isMissing) {
                        videoError = "视频已失效，请重新选择"
                        tempVideoUrl = null
                        return
                    }
                }
                is ApiResult.Failure -> Unit
            }
            if (System.currentTimeMillis() - startedAt > VIDEO_TRANSCODE_TIMEOUT_MS) {
                videoError = "视频仍在后台处理，可以稍等或重新选择"
                return
            }
            delay(VIDEO_STATUS_POLL_INTERVAL_MS)
        }
    }

    /** 把已拷进 cache 的视频传到临时目录；成功后接上转码轮询（顺序不能反） */
    fun uploadPickedVideo() {
        val file = pickedVideo ?: return
        if (!isAcceptableVideoName(pickedVideoName)) {
            // 提前拦截：服务端一定 400，不如在这里给人话
            videoError = "暂不支持这种视频格式（支持 mp4/mov/avi/webm/mkv/flv/wmv）"
            return
        }
        videoError = null
        videoReady = false
        videoProgress = 0
        videoJob = scope.launch {
            when (val up = composer.uploadTempVideo(file, pickedVideoName) { pct ->
                videoProgress = pct
            }) {
                is ApiResult.Success -> {
                    tempVideoUrl = up.data
                    videoProgress = null
                    // 上传完成 → 等后台转码。轮询期间保持"处理中"，转码完才能发布。
                    pollTranscode(up.data)
                }
                is ApiResult.Failure -> {
                    videoProgress = null
                    videoError = "视频上传失败：${up.error.displayMessage}"
                }
            }
            videoJob = null
        }
    }

    /**
     * 选完视频后的入库流程：拷进 cacheDir → 后台上传到临时目录 → 轮询转码状态。
     *
     * 为什么选完就传，而不是等点「发布」再传：视频可能要传几分钟，
     * 让上传与"写正文 / 挑位置"并行，用户点发布时通常已经传完了。
     */
    fun acceptVideo(uri: Uri, displayName: String?) {
        // 换视频：先把上一条的临时文件清掉，别在服务端堆草稿
        clearVideo()
        // 视频与图片不能同帖（服务端 /posts 与 /posts/video 是两套端点）。
        // 放在"真的选了视频"这一刻才清，而不是打开选择器时 —— 用户打开又取消不该丢图。
        val droppedImages = picked.size + keptImages.size
        picked.clear()
        keptImages.clear()
        scope.launch {
            val copied = withContext(Dispatchers.IO) { copyVideoToCache(context, uri, displayName) }
            if (copied == null) {
                videoError = "读取视频失败，请重新选择"
                return@launch
            }
            pickedVideo = copied
            pickedVideoName = copied.name
            pickHint = if (droppedImages > 0) {
                "已切换到视频，$droppedImages 张图片已移除（图文帖与视频帖不能混排）"
            } else {
                null
            }
            uploadPickedVideo()
        }
    }

    /**
     * 选封面面板里「从相册选一张图作为封面」的**草稿**（还没点「完成」）。
     *
     * 草稿放父层而不是面板内部：相册选择器是 `rememberLauncherForActivityResult`，
     * 它的回调必须在**组合作用域**里注册（面板随时会被卸载，注册在里面会丢结果）。
     */
    var coverGalleryDraft by remember { mutableStateOf<File?>(null) }
    val pickCoverImage = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia()
    ) { uri: Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            // 与发帖选图同一条流水线：先拷进 cacheDir（Photo Picker 的读权限是临时的），再压一道
            val file = withContext(Dispatchers.IO) {
                copyToCache(context, uri)?.let { raw ->
                    ImageCompressor.compressFile(context, raw)?.also { raw.delete() } ?: raw
                }
            }
            if (file != null) coverGalleryDraft = file else videoError = "读取封面图失败，请重新选择"
        }
    }

    val pickImages = rememberLauncherForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(MAX_IMAGES)
    ) { uris: List<Uri> ->        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        // 视频与图片不能同帖：服务端 /posts（图片）与 /posts/video 是两套端点。
        // 这里选图 = 表达"要发图文帖"，所以把已选视频连同服务端临时文件一起清掉。
        if (pickedVideo != null) clearVideo()
        scope.launch {
            // 两步：先把 content:// 拷进 cacheDir（Photo Picker 的读权限是临时的，
            // 直接持有 uri 会在"选完图放置一会儿再发布"时失败），再压一道。
            val (files, compressedCount) = withContext(Dispatchers.IO) {
                val raw = uris.mapNotNull { copyToCache(context, it) }
                var compressed = 0
                val ready = raw.map { file ->
                    val smaller = ImageCompressor.compressFile(context, file)
                    if (smaller != null) {
                        compressed += 1
                        // 压缩成功就丢掉原图，避免 cache 里堆两份
                        file.delete()
                        smaller
                    } else {
                        file
                    }
                }
                ready to compressed
            }
            picked.clear()
            picked.addAll(files.take(MAX_IMAGES))
            pickHint = buildString {
                append("已选 ${picked.size} 张")
                if (compressedCount > 0) append("，其中 $compressedCount 张已本地压缩")
                append("；服务端还会压到长边 1440px")
            }
        }
    }

    /**
     * 选视频：只选一个（服务端一个视频帖只带一个视频）。
     *
     * 用系统的 Photo Picker（`PickVisualMedia.VideoOnly`）而不是自绘相册：
     * 不需要任何存储权限，且用户能拿到"最近/相册/文件"全部来源。
     * 视频**不做本地压缩**（手机上重编码视频不现实），大文件靠服务端转码与分片容错。
     * 用户取消选择时 [uri] 为 null，这里直接返回 —— 什么都不清、什么都不改。
     */
    val pickVideo = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia()
    ) { uri: Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        acceptVideo(uri, context.contentResolver.queryDisplayName(uri))
    }

    /** 在光标处插入（表情面板用：设计稿要求"表情直接在正文框里选"） */
    fun insertAtCursor(snippet: String) {
        val start = text.selection.min.coerceIn(0, text.text.length)
        val end = text.selection.max.coerceIn(start, text.text.length)
        val next = text.text.substring(0, start) + snippet + text.text.substring(end)
        if (next.length > MAX_LENGTH) return
        text = TextFieldValue(
            text = next,
            selection = TextRange(start + snippet.length),
        )
    }

    /** 追加到正文末尾（话题 `#` 用：用户要求"#关键词放文本后面"，不要插在光标处） */
    fun appendToEnd(snippet: String) {
        val next = text.text + snippet
        if (next.length > MAX_LENGTH) return
        text = TextFieldValue(text = next, selection = TextRange(next.length))
    }

    // 离开发布页时的兜底清理：**放弃的视频必须在服务端删掉**。
    //
    // 为什么必须有这一步：temp 目录按用户算配额（1GB，见 server 的 chunkUploadRegistry），
    // 放弃的视频不清会一直占着，用户下次选视频会撞上"临时视频空间不足"却找不到原因
    // （服务端只有 24h TTL 会兜底回收）。
    // 用 rememberUpdatedState 而不是 remember 快照：清理函数在 onDispose 那一刻读到的是
    // **最新的** tempVideoUrl（选完视频才有的），而 `remember { tempVideoUrl }` 会把首次组合的
    // null 永久钉住 —— 那个写法看起来对、实际什么都不删，是这类清理最常见的坑。
    val latestTempVideoUrl by rememberUpdatedState(tempVideoUrl)
    DisposableEffect(Unit) {
        onDispose {
            // 本地副本直接删（300MB 的 cache 不删会一直占手机存储）
            pickedVideo?.delete()
            videoJob?.cancel()
            latestTempVideoUrl?.let { url -> scope.launch { composer.discardTempVideo(url) } }
        }
    }

    // 外层：**背景铺满全屏**（含状态栏区域）。
    //
    // 为什么不再做"顶部留 12dp 缝 + 圆角 + sheet 阴影"：设计稿标题写的是「全屏 sheet」，
    // 浅色稿里缝与页面同色根本看不出来，而深色稿那点色差在真机上表现为
    // **状态栏区域突出一块**（用户实测反馈"发布页面背景不是全屏"）。
    // 全屏铺底后，状态栏只剩系统图标浮在页面色上，与设计稿一致。
    Box(modifier = Modifier.fillMaxSize().background(c.bgPage)) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .background(c.bgPage)
                // 这里**不再**有 statusBarsPadding：状态栏安全区跟着顶栏走（下面的 kTopBar），
                // 挂在整页容器上会让"顶栏位置"变成两处（容器一处 + 顶栏一处）各自的取值。
                .navigationBarsPadding()
                .imePadding(),
        ) {
            // ---- 顶栏：取消 / 新帖子 / 发布 ----
            // 垂直位置走全 App 同一条 kTopBar（见 KWidgets.kTopBar），这里只写左右与下边距
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .kTopBar()
                    .padding(start = KSpacing.md, end = KSpacing.md, bottom = KSpacing.xs),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // 取消：红色按钮（设计系统的「危险按钮」= dangerSoft 底 + danger 字）。
                // 用户要求「取消要有红色背景」，所以不再是纯文字；compact 与右侧「发布」同高。
                KButton(
                    text = "取消",
                    onClick = onClose,
                    variant = KButtonVariant.Danger,
                    compact = true,
                )
                Text(
                    text = if (editing == null) "新帖子" else "编辑帖子",
                    style = KType.subtitle,
                    color = c.textPrimary,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.weight(1f),
                )
                KButton(
                    text = if (submitting) "提交中…" else if (editing == null) "发布" else "保存",
                    onClick = {
                        error = null
                        val hasVideo = pickedVideo != null
                        if (text.text.isBlank() && picked.isEmpty() && keptImages.isEmpty() && !hasVideo) {
                            error = "至少写点文字、留一张图或选一个视频"
                            return@KButton
                        }
                        scope.launch {
                            submitting = true
                            // 视频三条前置：**等上传结束**（点发布时可能还在传）→
                            // 确认拿到 temp url → 等转码完成。顺序不能反：轮询要有 url 才有意义。
                            if (hasVideo) {
                                videoJob?.join()
                                if (tempVideoUrl == null) {
                                    submitting = false
                                    error = videoError ?: "视频还没上传成功，请稍候或重新选择"
                                    return@launch
                                }
                                // 转码没结束时**不拦**发布：文件本体已经在服务端了（可播，
                                // 只是编码可能不是最通用的 H.264）。服务端在把临时文件转正时
                                // 会再入队一次转码，所以发出去的帖子迟早是通用格式 ——
                                // 为这个把用户按在"处理中"几分钟是更糟的体验。
                            }

                            val result = when {
                                // 视频帖：服务端是独立端点，只收 video_url + description + close_comments。
                                // 位置与标题在这个端点上没有对应字段，所以视频帖不带位置（不做假提交）。
                                hasVideo && editing == null -> composer.createVideoPost(
                                    videoUrl = tempVideoUrl!!,
                                    description = text.text.trim(),
                                    closeComments = closeComments,
                                    // 用户在「选封面」面板里挑了才传（null = 服务端自动截首帧，
                                    // 也就是"默认第一帧"那条路径，见 pickedCover 的注释）
                                    cover = pickedCover,
                                )
                                // 编辑既有帖子：服务端 PUT 只处理图文帖的图片，视频帖没有编辑端点
                                editing != null -> composer.updatePost(
                                    postId = editing.id,
                                    description = text.text.trim(),
                                    // keepImages 是 **JSON 数组字符串**，服务端按它决定保留哪些既有图
                                    keepImages = keptImages.toList(),
                                    newImages = picked.toList(),
                                    location = location.trim(),
                                    closeComments = closeComments,
                                )
                                else -> composer.createPost(
                                    title = "",
                                    // 服务端把正文映射到 description（title 是独立可选字段）
                                    description = text.text.trim(),
                                    location = location.trim(),
                                    images = picked.toList(),
                                    closeComments = closeComments,
                                )
                            }
                            submitting = false
                            when (result) {
                                // 发布成功：临时视频已被服务端**移入正式目录**。
                                // 离开页面时的兜底清理会照常发一次 DELETE /video-temp，
                                // 但那种情况下文件已不在 temp，服务端返回 404 —— 无副作用。
                                is ApiResult.Success -> onPosted()
                                is ApiResult.Failure -> error = result.error.displayMessage
                            }
                        }
                    },
                    compact = true,
                    enabled = !submitting,
                )
            }

            Column(
                modifier = Modifier
                    .weight(1f)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = KSpacing.md)
                    // 整块内容整体下移：用户反馈「头像离 top 栏太近了」。
                    // 注意 padding 必须在 verticalScroll **之后**：写反了滚动内容会被裁掉顶部。
                    .padding(top = HEADER_TOP_GAP),
                verticalArrangement = Arrangement.spacedBy(KSpacing.sm),
            ) {
                // ---- 头像行：40dp 头像 + 昵称 ----
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(KSpacing.sm),
                ) {
                    Avatar(
                        url = myAvatar,
                        name = myName,
                        size = top.kuangdada.k.core.designsystem.theme.KDimens.avatarCard,
                    )
                    Text(
                        text = myName.ifBlank { "我" },
                        style = KType.subtitle,
                        color = c.textPrimary,
                    )
                }

                // ---- 正文卡片：正文（无底无框）+ 表情面板 + 底栏（表情钮 / 字数） ----
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 160.dp)
                        .clip(RoundedCornerShape(KRadius.card))
                        .background(c.surface)
                        .border(1.dp, c.borderStrong, RoundedCornerShape(KRadius.card))
                        .padding(KSpacing.sm),
                    verticalArrangement = Arrangement.spacedBy(KSpacing.xs),
                ) {
                    KTextField(
                        value = text,
                        onValueChange = { if (it.text.length <= MAX_LENGTH) text = it },
                        // 正文区最小高 = 卡片最小高 160 − 上下内边距 24 − 底栏 28 − 间距 8 = 100dp。
                        // 这样空白状态下**底栏正好落在卡片底边**（设计稿：表情在卡片左下角、
                        // 占位文字在卡片左上角）；早期用 weight(fill=false)，底栏会浮在卡片中间，
                        // 下方留一块空白（用户实测反馈）。
                        // 这里刻意不用 `weight`：外层是可滚动的 Column，主轴约束无限，
                        // weight 在这种父容器里会被压成 0 高（Compose 的已知坑）。
                        modifier = Modifier.heightIn(min = 100.dp),
                        placeholder = "分享点什么…",
                        singleLine = false,
                        variant = KTextFieldVariant.Plain,
                        focusRequester = focusRequester,
                    )

                    if (showEmojiPanel) {
                        Column(verticalArrangement = Arrangement.spacedBy(KSpacing.xxs)) {
                            COMPOSER_EMOJIS.chunked(8).forEach { row ->
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.spacedBy(KSpacing.xxs),
                                ) {
                                    row.forEach { emoji ->
                                        Box(
                                            modifier = Modifier
                                                .weight(1f)
                                                .height(34.dp)
                                                .clip(RoundedCornerShape(KRadius.chip))
                                                .clickable { insertAtCursor(emoji) },
                                            contentAlignment = Alignment.Center,
                                        ) {
                                            Text(emoji, style = KType.subtitle)
                                        }
                                    }
                                    // 最后一行不足 8 个：补空位，保持列宽一致
                                    repeat(8 - row.size) { Spacer(Modifier.weight(1f)) }
                                }
                            }
                        }
                    }

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        // 表情按钮：28dp 圆形凹陷底 + 小表情（设计稿实测约 28dp）
                        Box(
                            modifier = Modifier
                                .size(28.dp)
                                .clip(RoundedCornerShape(percent = 50))
                                .background(c.surfaceSunken)
                                .clickable { showEmojiPanel = !showEmojiPanel },
                            contentAlignment = Alignment.Center,
                        ) {
                            Text("😊", style = KType.body)
                        }
                        Spacer(Modifier.weight(1f))
                        // 计数形态就是设计稿写的 `48 / 2000`；接近上限时变色提醒
                        Text(
                            text = "${text.text.length} / $MAX_LENGTH",
                            style = KType.caption,
                            color = if (text.text.length > MAX_LENGTH - 50) c.danger else c.textMuted,
                        )
                    }
                }

                // ---- 媒体网格：3 列方格 + 「＋图」/「＋视频」格；选了视频则换成视频块（设计稿）----
                MediaTiles(
                    keptImages = keptImages.toList(),
                    files = picked.toList(),
                    videoName = pickedVideoName.takeIf { pickedVideo != null },
                    videoState = videoStateText(
                        hasLocal = pickedVideo != null,
                        progress = videoProgress,
                        ready = videoReady,
                        error = videoError,
                    ),
                    videoFrame = videoFrame,
                    // 时长文本复用 `formatClock`（VideoPlayer.kt 里那个全工程共用的实现）——
                    // 别再写第二份：同名的两个重载会让调用点静默解析到另一个（这一轮真踩过）
                    videoDuration = videoDurationMs?.let { formatClock(it) },
                    onAddImage = {
                        pickImages.launch(
                            PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                        )
                    },
                    onAddVideo = {
                        pickVideo.launch(
                            PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.VideoOnly)
                        )
                    },
                    onRemoveKept = { url -> keptImages.remove(url) },
                    onRemoveFile = { file -> picked.remove(file) },
                    onRemoveVideo = { clearVideo() },
                    onPickCover = { showCoverPanel = true },
                )

                Spacer(Modifier.height(KSpacing.sm))

                // ---- 话题 / 位置 / 评论 ----
                Row(horizontalArrangement = Arrangement.spacedBy(KSpacing.xs)) {
                    ComposerChip(
                        label = "话题",
                        selected = false,
                        onClick = {
                            // 追加到正文末尾（不是光标处）：服务端从正文 extractTags() 解析 `#话题`
                            appendToEnd("#")
                            focusRequester.requestFocus()
                            tip = "在 # 后面直接写话题名；发布后可在搜索里按话题聚合。"
                        },
                    )
                    ComposerChip(
                        // 选了位置就把地点当 chip 文案（过长截断）；再点一次重新选点
                        label = location.ifBlank { "位置" },
                        selected = location.isNotBlank(),
                        onClick = { showLocationPicker = true },
                    )
                    ComposerChip(
                        // 原来这里叫「公开」，展开的是一个**只有评论是真功能**的面板。
                        // 用户要求「公开取消可见范围」，于是可见范围板块整体删除，
                        // chip 直接叫「评论」，它对应的就是唯一的真实字段 close_comments。
                        label = "评论",
                        selected = showCommentsPanel,
                        onClick = { showCommentsPanel = !showCommentsPanel },
                    )
                    /**
                     * 删除帖子 —— **只在编辑已有帖子时出现**（新建时没有可删的东西）。
                     *
                     * 位置按用户要求："评论右边"。放在同一排 chip 的最右，视觉上属于
                     * 同一组"这条帖子的设置"，但用危险色与其它 chip 区分开：
                     * 它不是一个"开关"，而是不可撤销的破坏性动作。
                     */
                    if (editing != null && onDeleteRequest != null) {
                        ComposerChip(
                            label = if (deleting) "删除中…" else "删除帖子",
                            selected = false,
                            danger = true,
                            onClick = { if (!deleting) confirmDelete = true },
                        )
                    }
                }

                if (showCommentsPanel) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(KRadius.row))
                            .background(c.surface)
                            .border(1.dp, c.borderStrong, RoundedCornerShape(KRadius.row))
                            .padding(KSpacing.sm),
                        verticalArrangement = Arrangement.spacedBy(KSpacing.xs),
                    ) {
                        Text("评论", style = KType.footnote, color = c.textMuted)
                        Row(horizontalArrangement = Arrangement.spacedBy(KSpacing.xs)) {
                            ComposerChip(
                                label = "允许评论",
                                selected = !closeComments,
                                onClick = { closeComments = false },
                            )
                            ComposerChip(
                                label = "关闭评论",
                                selected = closeComments,
                                onClick = { closeComments = true },
                            )
                        }
                    }
                }

                // ---- 说明行（设计稿原文）；上面几个动作产生的提示覆盖在同一行 ----
                Text(
                    text = tip ?: "发布后 24 小时内可编辑；图片会自动压缩到长边 1440px。",
                    style = KType.caption,
                    color = c.textMuted,
                )
                if (pickHint != null) {
                    Text(pickHint!!, style = KType.footnote, color = c.textMuted)
                }
                // 视频的状态/错误独立一行：它在网格里已经有角标，这里给的是**可执行的说明**
                //（失败原因、转码中、格式不支持），错误用危险色，避免被当成普通提示划过去
                videoError?.let { Text(it, style = KType.caption, color = c.danger) }
                if (pickedVideo != null && videoError == null) {
                    Text(
                        text = "视频发布后由服务端自动转码并生成封面，可在播放页查看。",
                        style = KType.footnote,
                        color = c.textMuted,
                    )
                }
                if (error != null) {
                    Text(error!!, style = KType.caption, color = c.danger)
                }
                Spacer(Modifier.height(KSpacing.xxl))
            }
        }

        // 地图选点层：整屏盖住发布弹层；返回键先关它再退弹层（BackHandler 在内层生效）
        if (showLocationPicker) {
            androidx.activity.compose.BackHandler { showLocationPicker = false }
            LocationPickerScreen(
                hasLocation = location.isNotBlank(),
                onDismiss = { showLocationPicker = false },
                onConfirm = { picked ->
                    location = picked
                    showLocationPicker = false
                },
            )
        }

        /**
         * 选封面面板（设计稿第二张：从下往上滑出）。
         *
         * 「完成」才写 [pickedCover]；关掉面板（下滑 / 点遮罩 / 返回）什么都不改 ——
         * 也就是设计稿说的"点完成才确认封面，不然默认第一帧是封面"。
         */
        val videoForCover = pickedVideo
        if (showCoverPanel && videoForCover != null) {
            CoverPickerSheet(
                video = videoForCover,
                durationMs = videoDurationMs,
                initialCover = pickedCover,
                galleryDraft = coverGalleryDraft,
                onPickGallery = {
                    pickCoverImage.launch(
                        PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                    )
                },
                onDismiss = { showCoverPanel = false },
                onDone = { cover ->
                    pickedCover = cover
                    showCoverPanel = false
                },
            )
        }

        /**
         * 删帖二次确认。
         *
         * **必须二次确认**：服务端是物理删除（帖子 + 评论/点赞/通知 + 磁盘上的图片视频），
         * 没有任何回收站可以撤销 —— 一次误触就永久没了。
         * 与消息页「清空聊天记录」用同一套 `AlertDialog` 写法（含确认键的 danger 文字色）。
         */
        if (confirmDelete && editing != null && onDeleteRequest != null) {
            AlertDialog(
                onDismissRequest = { if (!deleting) confirmDelete = false },
                title = { Text("删除帖子", style = KType.subtitle, color = c.textPrimary) },
                text = {
                    Text(
                        "这条帖子会被永久删除，它的评论、点赞和图片视频也一并清除，且不可恢复。",
                        style = KType.body,
                        color = c.textSecondary,
                    )
                },
                confirmButton = {
                    Text(
                        text = if (deleting) "删除中…" else "删除",
                        style = KType.bodyStrong,
                        color = c.danger,
                        modifier = Modifier
                            .clip(RoundedCornerShape(KRadius.control))
                            .clickable(enabled = !deleting) {
                                scope.launch {
                                    deleting = true
                                    error = null
                                    when (val r = onDeleteRequest(editing.id)) {
                                        // 成功：交回调用方退出到主页并刷新列表
                                        is ApiResult.Success -> {
                                            confirmDelete = false
                                            onDeleted()
                                        }
                                        // 失败：留住页面，把服务端文案显示在表单里，
                                        // 并把弹窗关掉 —— 否则用户对着一个"删除"按钮反复点也看不出发生了什么
                                        is ApiResult.Failure -> {
                                            confirmDelete = false
                                            error = r.error.displayMessage
                                        }
                                    }
                                    deleting = false
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
                            .clickable(enabled = !deleting) { confirmDelete = false }
                            .padding(horizontal = KSpacing.sm, vertical = KSpacing.xs),
                    )
                },
                containerColor = c.surface,
            )
        }
    }
}

/**
 * 设计稿的 chip：药丸、最小高 35dp、左右 12dp；选中 = accentSoft 底 + accent 字 + accentBorder 描边。
 *
 * @param danger 危险动作（删帖）：`dangerSoft` 底 + `danger` 字 + `danger` 描边。
 *   与"选中态"是两码事 —— 它不可切换、也没有"关闭"状态，所以不走 [selected]。
 */
@Composable
private fun ComposerChip(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    danger: Boolean = false,
) {
    val c = KTheme.colors
    val shape = RoundedCornerShape(KRadius.pill)
    Box(
        modifier = Modifier
            .heightIn(min = top.kuangdada.k.core.designsystem.theme.KDimens.compactControl)
            // 位置可能很长（上限 60 字符）→ chip 自己封顶宽度并省略，别把整行挤爆
            .widthIn(max = 180.dp)
            .clip(shape)
            .background(if (danger) c.dangerSoft else if (selected) c.accentSoft else c.surface)
            .border(
                width = 1.dp,
                color = when {
                    danger -> c.danger
                    selected -> c.accentBorder
                    else -> c.borderStrong
                },
                shape = shape,
            )
            .clickable(onClick = onClick)
            .padding(horizontal = KSpacing.sm),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            style = KType.caption.copy(fontWeight = FontWeight.Medium),
            color = when {
                danger -> c.danger
                selected -> c.accent
                else -> c.textPrimary
            },
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * 媒体区。
 *
 * 两种形态：
 *  · **没有视频**：3 列方格（设计稿 §4.6 的等式 3×114+2×8=358），宽度用 [BoxWithConstraints]
 *    按真实可用宽度算，不用 `weight(1f)` —— 否则最后一行只有 2 个格子时会被拉宽。
 *    格子种类：既有图（服务端 URL）/ 新选图（本地 File）/「＋图」/「＋视频」；
 *  · **选了视频**：整块换成设计稿那个**视频块**（见 [VideoBlock]）—— 视频帖不能带图片，
 *    所以这时不再给任何加图入口，只留"换视频"（右上角 ×）与「选封面」。
 *
 * 为什么「＋视频」在选了视频后消失：服务端一个视频帖只能带一个视频
 * （`POST /posts/video` 的 `video_url` 是单值），再点一次没有意义 ——
 * 换视频要先用「×」删掉当前的（[onRemoveVideo]），这也让"先删再选"成为唯一路径，
 * 不会出现"以为换了、其实旧视频还在上传"的状态错乱。
 */
@Composable
private fun MediaTiles(
    keptImages: List<String>,
    files: List<File>,
    /** 已选视频的文件名（null = 没有视频）；只用来显示，不上传 */
    videoName: String?,
    /** 视频状态文案（上传百分比 / 转码中 / 失败）；null 表示不用显示角标 */
    videoState: String?,
    /** 首帧（null = 还没抽出来 / 抽不出来）：视频块的大图用它 */
    videoFrame: File?,
    /** 时长文本（「0:42」；null = 不知道，不画那个胶囊） */
    videoDuration: String?,
    onAddImage: () -> Unit,
    onAddVideo: () -> Unit,
    onRemoveKept: (String) -> Unit,
    onRemoveFile: (File) -> Unit,
    onRemoveVideo: () -> Unit,
    onPickCover: () -> Unit,
) {
    BoxWithConstraints(modifier = Modifier.fillMaxWidth()) {
        val gap = KSpacing.xs
        val tile = (maxWidth - gap * 2) / 3
        Column(verticalArrangement = Arrangement.spacedBy(gap)) {
            if (videoName != null) {
                VideoBlock(
                    name = videoName,
                    frame = videoFrame,
                    duration = videoDuration,
                    state = videoState,
                    onPickCover = onPickCover,
                    onRemove = onRemoveVideo,
                )
            } else {
                val items = mutableListOf<MediaTile>()
                keptImages.forEach { items += MediaTile.Kept(it) }
                files.forEach { items += MediaTile.Local(it) }
                if (keptImages.size + files.size < MAX_IMAGES) items += MediaTile.AddImage
                items += MediaTile.AddVideo
                items.chunked(3).forEach { row ->
                    Row(horizontalArrangement = Arrangement.spacedBy(gap)) {
                        row.forEach { item ->
                            when (item) {
                                is MediaTile.Kept -> ImageTile(
                                    tile,
                                    model = resolveUrl(item.url, composerBaseUrl),
                                ) { onRemoveKept(item.url) }
                                is MediaTile.Local -> ImageTile(tile, model = item.file) {
                                    onRemoveFile(item.file)
                                }
                                MediaTile.AddImage -> AddTile(tile, "＋", "图片", onAddImage)
                                MediaTile.AddVideo -> AddTile(tile, "▶", "视频", onAddVideo)
                            }
                        }
                        repeat(3 - row.size) { Spacer(Modifier.size(tile)) }
                    }
                }
            }
        }
    }
}

/**
 * 视频块（设计稿第一张：视频画面 + 左下角时长胶囊 + 右下角「选封面」+ 右上角 ×）。
 *
 * 几个刻意的取舍：
 *  · **16:9 通栏**（不再是一格方块）：视频是"看"的内容，方块里那一帧几乎看不出拍了什么；
 *  · 首帧抽不出来时（老编码/坏文件）退回"文件名 + 上传状态"的文字块 ——
 *    宁可信息少，也不要摆一张纯黑的假画面；
 *  · **× 是"移除"而不是"换一个"**：换视频 = 移除后重新选（[onRemoveVideo] →
 *    `clearVideo()` 会连服务端临时文件一起清掉）。这样不会出现"旧视频还在传、新视频又传一份"；
 *  · 时长胶囊与「选封面」都压在画面之上，用同一套浮层配色（半透明黑 + 白字 / 白底黑字），
 *    在任何封面上都读得出来。
 *
 * @param state 上传/转码状态文案（null = 一切正常，不显示）
 */
@Composable
private fun VideoBlock(
    name: String,
    frame: File?,
    duration: String?,
    state: String?,
    onPickCover: () -> Unit,
    onRemove: () -> Unit,
) {
    val c = KTheme.colors
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .aspectRatio(16f / 9f)
            .clip(RoundedCornerShape(KRadius.row))
            .background(c.surfaceSunken),
    ) {
        if (frame != null) {
            AsyncImage(
                model = frame,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            // 抽不到首帧：给文件名 + 状态（原来那种格子的信息，别丢）
            Column(
                modifier = Modifier.align(Alignment.Center).padding(KSpacing.md),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(KSpacing.xxs),
            ) {
                Text(name, style = KType.caption, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("视频已选好", style = KType.tiny, color = c.textMuted)
            }
        }
        // 左下角：时长（0:42）
        if (duration != null) {
            Text(
                text = duration,
                style = KType.tiny,
                color = Color.White,
                modifier = Modifier
                    .align(Alignment.BottomStart)
                    .padding(KSpacing.xs)
                    .clip(RoundedCornerShape(KRadius.pill))
                    .background(Color.Black.copy(alpha = 0.45f))
                    .padding(horizontal = KSpacing.xs, vertical = 2.dp),
            )
        }
        // 右下角：选封面（白底黑字胶囊 —— 它是这块上的**主操作**，比时长更醒目）
        Text(
            text = "选封面",
            style = KType.caption,
            color = Color.Black,
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .padding(KSpacing.xs)
                .clip(RoundedCornerShape(KRadius.pill))
                .background(Color.White.copy(alpha = 0.92f))
                .clickable(onClick = onPickCover)
                .padding(horizontal = KSpacing.md, vertical = KSpacing.xxs),
        )
        // 右上角：×（移除这条视频 —— 换视频的唯一路径，见上面注释）
        RemoveBadge(onRemove)
        // 上传/转码状态压在顶部中间，不挡两角的操作
        if (state != null) {
            Text(
                text = state,
                style = KType.tiny,
                color = Color.White,
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .padding(KSpacing.xs)
                    .clip(RoundedCornerShape(KRadius.pill))
                    .background(Color.Black.copy(alpha = 0.55f))
                    .padding(horizontal = KSpacing.xs, vertical = 2.dp),
            )
        }
    }
}

/** 媒体网格里一个格子的种类（用 sealed 而不是字符串标签：新增种类时编译器会提醒 unhandled） */
private sealed interface MediaTile {
    data class Kept(val url: String) : MediaTile
    data class Local(val file: File) : MediaTile
    data object AddImage : MediaTile
    data object AddVideo : MediaTile
}

@Composable
private fun ImageTile(size: androidx.compose.ui.unit.Dp, model: Any?, onRemove: () -> Unit) {
    val c = KTheme.colors
    Box(
        modifier = Modifier
            .size(size)
            .clip(RoundedCornerShape(KRadius.row))
            .background(c.surfaceSunken),
    ) {
        AsyncImage(
            model = model,
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = Modifier.fillMaxSize(),
        )
        RemoveBadge(onRemove)
    }
}

/**
 * 选封面面板（设计稿第二张，从下往上滑出）。
 *
 * 结构：标题「选择封面」+ 右上角「完成」（**胶囊 + 主题色**，用户要求）/
 * 大图预览 / 一排抽帧缩略图（左右滑动挑一帧）/ 提示 / 「从相册选一张图作为封面」。
 *
 * 三条语义（都直接对应设计稿上的字）：
 *  · **「点完成才确认封面」**：面板里改的只是**草稿**（[selectedAt] / 用不用相册那张），
 *    只有「完成」会回调 [onDone]；下滑/点遮罩/返回 = 什么都不改；
 *  · **「不然默认第一帧是封面」**：什么都没挑时预览就是第一帧，且 [onDone] 之外
 *    上游的 `pickedCover` 一直是 null → 发布时不传 `cover` → 服务端自己截首帧；
 *  · **「左右滑动，从视频里挑一帧当封面」**：帧条是 `LazyRow`（[VideoFrames.STRIP_FRAMES] 帧等比分布）。
 *
 * 抽帧全在 IO（见 [VideoFrames]）；这里只处理"还没抽出来"的加载态 ——
 * 那几秒里给一行"正在读取视频…"，绝不显示假预览。
 *
 * @param galleryDraft 面板开着的时候用户从相册选的那张图（由父层持有：选择器必须在组合作用域里注册）
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CoverPickerSheet(
    video: File,
    durationMs: Long?,
    initialCover: File?,
    galleryDraft: File?,
    onPickGallery: () -> Unit,
    onDismiss: () -> Unit,
    onDone: (File?) -> Unit,
) {
    val c = KTheme.colors
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    // 抽帧是 suspend（IO），而点「完成」的回调是普通 lambda —— 所以这里要一个协程作用域
    val scope = rememberCoroutineScope()
    /** 抽出来的帧（null = 还在抽）；每一帧带它自己的时间点，供"上传时按那一帧再抽一张大图" */
    var frames by remember(video) { mutableStateOf<List<Pair<Long, File>>?>(null) }
    /** 当前选中的帧时间点（null = 还没选，预览用第一帧） */
    var selectedAt by remember(video) { mutableStateOf<Long?>(null) }
    /** 用户在面板里改成"用相册那张" */
    var useGallery by remember(video) { mutableStateOf(false) }
    /** 正在把选中的帧抽成上传用的大图 */
    var busy by remember(video) { mutableStateOf(false) }

    LaunchedEffect(video, durationMs) {
        frames = VideoFrames.stripFiles(video, durationMs)
    }
    // 面板打开时如果已经有确认过的封面（相册图），就当作用了相册那张
    LaunchedEffect(initialCover, galleryDraft) {
        if (galleryDraft != null || (initialCover != null && frames?.none { it.second == initialCover } == true)) {
            useGallery = true
        }
    }
    // 上次确认过的那一帧要把选中态带回来（重开面板时预览不该跳回第一帧）
    LaunchedEffect(frames, initialCover) {
        val stripNow = frames ?: return@LaunchedEffect
        if (selectedAt == null) selectedAt = stripNow.firstOrNull { it.second == initialCover }?.first
    }

    val strip = frames
    val currentFrame = strip?.firstOrNull { it.first == selectedAt }?.second
        ?: strip?.firstOrNull()?.second
    val preview = if (useGallery) (galleryDraft ?: initialCover) else (currentFrame ?: initialCover)

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = c.surface,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = KSpacing.md)
                .padding(bottom = KSpacing.md),
            verticalArrangement = Arrangement.spacedBy(KSpacing.xs),
        ) {
            // ---- 标题行：选择封面 | 完成（胶囊 + 主题色）----
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("选择封面", style = KType.subtitle, color = c.textPrimary)
                Spacer(Modifier.weight(1f))
                Text(
                    text = if (busy) "处理中…" else "完成",
                    style = KType.bodyStrong,
                    color = c.onAccent,
                    modifier = Modifier
                        .clip(RoundedCornerShape(KRadius.pill))
                        .background(if (busy) c.textMuted else c.accent)
                        .clickable(enabled = !busy) {
                            busy = true
                            // 面板里选的是**帧的时间点**，上传要的是那一帧的大图：
                            // 这里再抽一次（比缩略图宽），抽不到就退回默认（不传封面）
                            scope.launch {
                                if (useGallery) {
                                    onDone(galleryDraft ?: initialCover)
                                } else {
                                    val at = selectedAt ?: strip?.firstOrNull()?.first
                                    onDone(if (at != null) VideoFrames.coverFrameFile(video, at) else null)
                                }
                            }
                        }
                        .padding(horizontal = KSpacing.md, vertical = KSpacing.xs),
                )
            }

            // ---- 大图预览（已选画面）----
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .aspectRatio(16f / 9f)
                    .clip(RoundedCornerShape(KRadius.row))
                    .background(c.surfaceSunken),
                contentAlignment = Alignment.Center,
            ) {
                if (preview != null) {
                    AsyncImage(
                        model = preview,
                        contentDescription = null,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier.fillMaxSize(),
                    )
                } else {
                    Text("正在读取视频…", style = KType.caption, color = c.textMuted)
                }
            }

            // ---- 帧条：左右滑动挑一帧 ----
            if (strip != null && strip.isNotEmpty()) {
                LazyRow(horizontalArrangement = Arrangement.spacedBy(KSpacing.xxs)) {
                    items(strip, key = { it.first }) { (at, file) ->
                        val selected = !useGallery && (selectedAt ?: strip.first().first) == at
                        Box(
                            modifier = Modifier
                                .size(64.dp, 48.dp)
                                .clip(RoundedCornerShape(KRadius.row))
                                .background(c.surfaceSunken)
                                .border(
                                    width = if (selected) 2.dp else 1.dp,
                                    color = if (selected) c.accent else c.borderSubtle,
                                    shape = RoundedCornerShape(KRadius.row),
                                )
                                .clickable {
                                    useGallery = false
                                    selectedAt = at
                                },
                        ) {
                            AsyncImage(
                                model = file,
                                contentDescription = null,
                                contentScale = ContentScale.Crop,
                                modifier = Modifier.fillMaxSize(),
                            )
                        }
                    }
                }
                Text("左右滑动，从视频里挑一帧当封面", style = KType.tiny, color = c.textMuted)
            } else if (strip == null) {
                Text("正在读取视频…", style = KType.tiny, color = c.textMuted)
            }

            // ---- 从相册选一张图作为封面 ----
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(KRadius.row))
                    .background(c.accentSoft)
                    .clickable {
                        useGallery = true
                        onPickGallery()
                    }
                    .padding(vertical = KSpacing.sm),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Glyph(tint = c.accent, kind = GlyphKind.Image, size = 16.dp)
                Spacer(Modifier.size(KSpacing.xs))
                Text("从相册选一张图作为封面", style = KType.caption, color = c.accent)
            }
        }
    }
}

/**
 * 说明：原来这里有一个 [VideoTile]（"3 列网格里的一格 + 文件名 + 状态"）。
 * M6.6 按设计稿把它换成了整块 16:9 的 [VideoBlock]（首帧 + 时长 + 选封面 + ×），
 * 所以那个格子连同它"不显示首帧"的说明一起删掉了 ——
 * 现在的做法是 `MediaMetadataRetriever.getScaledFrameAtTime`（解码到指定宽度，不经过整张 4K 位图），
 * 并且抽帧全在 IO 线程，见 [VideoFrames] 的类注释。
 */

/** 右上角的红色「×」删除角标（图片格与视频格共用，保证两处点击区域一致） */
@Composable
private fun androidx.compose.foundation.layout.BoxScope.RemoveBadge(onRemove: () -> Unit) {
    val c = KTheme.colors
    Box(
        modifier = Modifier
            .align(Alignment.TopEnd)
            .padding(KSpacing.xxs)
            .size(22.dp)
            .clip(RoundedCornerShape(percent = 50))
            .background(c.danger)
            .clickable(onClick = onRemove),
        contentAlignment = Alignment.Center,
    ) {
        Text("×", style = KType.footnote, color = c.onAccent)
    }
}

@Composable
private fun AddTile(
    size: androidx.compose.ui.unit.Dp,
    symbol: String,
    label: String,
    onAdd: () -> Unit,
) {
    val c = KTheme.colors
    val shape = RoundedCornerShape(KRadius.row)
    Box(
        modifier = Modifier
            .size(size)
            .clip(shape)
            .border(1.dp, c.borderStrong, shape)
            .clickable(onClick = onAdd),
        contentAlignment = Alignment.Center,
    ) {
        // 设计稿是细「＋」（描边圆角方格里一个加号），不是实心按钮。
        // 视频格同理，只是符号换成 ▶ 并带上小字，避免"只能加图片"的观感。
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(KSpacing.xxs),
        ) {
            Text(symbol, style = KType.title, color = c.textMuted)
            Text(label, style = KType.footnote, color = c.textMuted)
        }
    }
}

/**
 * 视频格角标文案：[hasLocal] 有本地视频时的三种状态。
 * 单独抽出来是为了让状态判断**只有一处**（原来分散在 UI 里，容易出现两个地方判断不一致）。
 */
private fun videoStateText(
    hasLocal: Boolean,
    progress: Int?,
    ready: Boolean,
    error: String?,
): String? = when {
    !hasLocal -> null
    error != null -> "未就绪"
    progress != null -> "上传 $progress%"
    ready -> "已就绪"
    else -> "转码中"
}

/**
 * 媒体网格里既有图的基地址。
 *
 * 为什么不用 `session.api.baseUrl`：那个字段在 `KApi` 上，`ComposerScreen` 拿到的是
 * `ComposerRepository` 与 `SessionRepository`，为了一个字符串把 `KApi` 暴露到 UI 层不划算。
 * 这里直接从 `BuildConfig.DEFAULT_SERVER_URL` 取（`:core:data` 的 BuildConfig 与 :native 同源）——
 * 注意**只有展示需要绝对地址**；回传服务端的 `keepImages` 必须保持相对路径原样。
 */
private val composerBaseUrl: String
    get() = top.kuangdada.k.core.data.BuildConfig.DEFAULT_SERVER_URL

/**
 * 把相册返回的 `content://` 拷贝到 cacheDir。
 *
 * 为什么必须拷贝：multipart 上传需要真实文件；`content://` 不能直接当文件读，
 * 而且 Photo Picker 授予的读取权限是**临时的** —— 直接持有 uri 会在
 * "选完图后放置一会儿再点发布"时失败（进程/权限一失效就读不到了）。
 *
 * 返回 null 表示读取失败（调用方要给用户一句人话，而不是静默什么都没有）。
 */
private fun copyToCache(context: Context, uri: Uri): File? = runCatching {
    val dir = File(context.cacheDir, "composer").apply { mkdirs() }
    val target = File(dir, "pick_${System.currentTimeMillis()}_${(0..9999).random()}.jpg")
    writeUriTo(context, uri, target)
    target
}.getOrNull()

/**
 * 视频专用的拷贝：**必须保住扩展名**。
 *
 * 服务端 video 上传的 fileFilter 是「扩展名在白名单内 **且** mimetype 以 video 斜杠开头
 * 或等于 application/octet-stream」（server/src/routes/posts/media.ts）。Photo Picker 给的
 * `content://media/external/video/media/1234` 是**没有扩展名**的（最后一段是数字 id），
 * 所以必须从 MIME 反推一个：反推不出来时退回 `.mp4`。
 *
 * 为什么退 `.mp4` 而不是别的：服务端收到后会把文件统一改名成 `.mp4` 再后台转码
 * （`normalizeVideoToMp4`），所以**声明成 mp4 不会被"当成"mp4** —— 内容照原样转码，
 * 顶多是"上传了一个容器标错的文件"，比因为缺扩展名被 400 拒掉要好得多。
 */
private fun copyVideoToCache(context: Context, uri: Uri, displayName: String?): File? = runCatching {
    val dir = File(context.cacheDir, "composer").apply { mkdirs() }
    val rawExt = displayName?.substringAfterLast('.', "")
        ?.takeIf { it.isNotEmpty() && it.length <= 5 }
        ?.lowercase()
    val ext = rawExt
        ?: context.contentResolver.getType(uri)?.substringAfter('/', "")?.lowercase()
            ?.takeIf { it.isNotEmpty() && it.length <= 5 }
        ?: "mp4"
    val target = File(dir, "video_${System.currentTimeMillis()}_${(0..9999).random()}.$ext")
    writeUriTo(context, uri, target)
    target
}.getOrNull()

/** 打开 `content://` 并整段写入 [target]；中途失败回删，避免留下半个文件 */
private fun writeUriTo(context: Context, uri: Uri, target: File) {
    val input = context.contentResolver.openInputStream(uri)
        ?: error("openInputStream 返回 null：$uri")
    input.use { source ->
        target.outputStream().use { output -> source.copyTo(output) }
    }
}

/**
 * 相册条目在系统里的显示名（含扩展名）。
 *
 * 为什么不用 [android.net.Uri.getLastPathSegment]：Photo Picker 的 uri 是
 * `content://media/external/video/media/1234` 这种**以数字 id 结尾**的形式，
 * 拿到的"文件名"是一个纯数字，没有扩展名（见 [copyVideoToCache] 的说明）。
 * 查不到就返回 null，由调用方按 MIME 兜底。
 */
private fun android.content.ContentResolver.queryDisplayName(uri: Uri): String? = runCatching {
    query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
        if (c.moveToFirst()) c.getString(0) else null
    }
}.getOrNull()
