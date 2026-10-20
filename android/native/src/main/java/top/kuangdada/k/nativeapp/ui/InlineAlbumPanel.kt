package top.kuangdada.k.nativeapp.ui

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import coil3.compose.AsyncImage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import top.kuangdada.k.core.designsystem.component.KButton
import top.kuangdada.k.core.designsystem.theme.KRadius
import top.kuangdada.k.core.designsystem.theme.KSpacing
import top.kuangdada.k.core.designsystem.theme.KTheme
import top.kuangdada.k.core.designsystem.theme.KType

/**
 * ============================================================
 * 聊天内嵌相册（QQ 参考图，2026-10-19 / 2026-10-20 改版）
 * ============================================================
 * 点输入栏的相册图标不再直接弹系统全屏，而是在键盘交换区里显示**最近照片**：
 *  · **单排大图、宽度自适应**（2026-10-20 用户定稿）：一行，每格和面板等高，
 *    宽度按原图宽高比算 —— 横图铺得宽、竖图窄，和参考图一致；
 *  · 比例不变、内容不裁：框本身就是这张图的比例（`aspectRatio` + `Crop`）；
 *  · 点照片选中，右上角圆圈打勾；最多选 9 张，右下角发送；
 *  · 左下角「相册」才打开系统全屏 Photo Picker；
 *  · 无权限时给「允许访问 / 打开系统相册」两个出口。
 *
 * 读的是 MediaStore 最近 60 张。Android 13+ 用 READ_MEDIA_IMAGES；Android 14
 * 允许「仅选择部分照片」，所以 READ_MEDIA_VISUAL_USER_SELECTED 也算有权限。
 * 系统全屏 Picker 不需要任何权限，这也是无权限时的兜底路径。
 *
 * 发送仍复用聊天页的图片流水线（拷 cache → 压缩 → multipart），这里只负责选。
 */
@Composable
fun InlineAlbumPanel(
    sending: Boolean,
    onSend: (List<Uri>) -> Unit,
    onOpenSystemGallery: () -> Unit,
    modifier: Modifier = Modifier,
    /**
     * 「上滑松手发送」的拖拽预览：**面板只负责手势与判定**，浮层画在页面层
     * （全屏、模糊背景 + 大图 + 提示）—— 那个浮层要盖住顶栏、还要能超出面板高度，
     * 画在面板里会被交换区的 `clipToBounds` 裁掉。
     */
    onDragPreviewStart: (uri: Uri, aspect: Float, bounds: Rect) -> Unit = { _, _, _ -> },
    onDragPreviewMove: (offsetY: Float) -> Unit = {},
    onDragPreviewEnd: () -> Unit = {},
) {
    val context = LocalContext.current
    val c = KTheme.colors
    /** 上滑多少 px 松手才算"要发送"（dp → px 只在这一处算一次） */
    val sendDistancePx = with(LocalDensity.current) { ALBUM_SEND_DISTANCE_DP.dp.toPx() }
    var hasPermission by remember { mutableStateOf(hasMediaPermission(context)) }
    var askedOnce by rememberSaveable { mutableStateOf(false) }
    var loading by remember { mutableStateOf(false) }
    var photos by remember { mutableStateOf<List<AlbumPhoto>>(emptyList()) }
    val selected = remember { mutableStateListOf<Uri>() }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) {
        hasPermission = hasMediaPermission(context)
    }

    // 第一次打开面板自动请求一次；拒绝后不再反复弹，用户可以点按钮重试
    LaunchedEffect(Unit) {
        if (!hasPermission && !askedOnce) {
            askedOnce = true
            permissionLauncher.launch(mediaPermissions())
        }
    }

    LaunchedEffect(hasPermission) {
        if (!hasPermission) return@LaunchedEffect
        loading = true
        photos = withContext(Dispatchers.IO) { queryRecentImages(context, limit = 60) }
        loading = false
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .background(c.surface),
    ) {
        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            when {
                !hasPermission -> Column(
                    modifier = Modifier.align(Alignment.Center).padding(KSpacing.lg),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(KSpacing.sm),
                ) {
                    Text(
                        text = "需要相册权限才能显示最近照片",
                        style = KType.body,
                        color = c.textSecondary,
                    )
                    KButton(
                        text = "允许访问相册",
                        onClick = { permissionLauncher.launch(mediaPermissions()) },
                    )
                    Text(
                        text = "打开系统相册",
                        style = KType.body,
                        color = c.accentText,
                        modifier = Modifier
                            .clip(RoundedCornerShape(KRadius.control))
                            .clickable(onClick = onOpenSystemGallery)
                            .padding(horizontal = KSpacing.sm, vertical = KSpacing.xs),
                    )
                }

                loading -> CircularProgressIndicator(
                    modifier = Modifier.align(Alignment.Center),
                    color = c.accent,
                )

                photos.isEmpty() -> Text(
                    text = "相册里没有照片",
                    style = KType.body,
                    color = c.textMuted,
                    modifier = Modifier.align(Alignment.Center),
                )

                else -> BoxWithConstraints(Modifier.fillMaxSize()) {
                    /**
                     * **单排大图、宽度自适应**（用户参考图，2026-10-20 定稿）。
                     *
                     *  · 一行，每格**高度固定 = 面板内容高**；
                     *  · **宽度按原图宽高比算**（`Modifier.aspectRatio(w/h)`）：横图铺得很宽、
                     *    竖图窄，和图里那张参考图一模一样；
                     *  · 因为框本身就是这张图的比例，所以 `Crop` 也不会裁到任何内容 ——
                     *    图片完整显示、比例不变、图和图之间没有黑边（只剩 Fit 可能带来的
                     *    取整空隙，所以这里用 Crop 收掉）；
                     *  · 格与格零间距，横向连续滑动（不是一页一张的分页）。
                     *
                     * 宽度必须来自 MediaStore 的 WIDTH/HEIGHT（见 [AlbumPhoto]）：
                     * 只靠 Coil 解码后回调比例的话，第一帧所有格子都按默认宽度铺，
                     * 解码完再一起重排 —— 打开相册那一下会明显抖一下。
                     */
                    val cellHeight = maxHeight
                    LazyRow(
                        // 不设 horizontalArrangement（默认零间距）= 挨着
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        items(photos.size, key = { photos[it].uri }) { index ->
                            val photo = photos[index]
                            AlbumThumb(
                                uri = photo.uri,
                                aspect = photo.aspect(),
                                height = cellHeight,
                                selectedIndex = selected.indexOf(photo.uri),
                                onToggle = {
                                    val idx = selected.indexOf(photo.uri)
                                    if (idx >= 0) selected.removeAt(idx)
                                    else if (selected.size < 9) selected.add(photo.uri)
                                },
                                onDragStart = { bounds ->
                                    onDragPreviewStart(photo.uri, photo.aspect(), bounds)
                                },
                                onDragMove = onDragPreviewMove,
                                onDragEnd = { offsetY ->
                                    onDragPreviewEnd()
                                    // 上滑够距离 = 直接发这一张；没够 = 取消（回到面板）
                                    if (offsetY <= -sendDistancePx && !sending) {
                                        onSend(listOf(photo.uri))
                                    }
                                },
                            )
                        }
                    }
                }
            }
        }

        // 底栏：左下角「相册」= 系统全屏；右侧发送（选中才亮）
        Row(
            modifier = Modifier
                .navigationBarsPadding()
                .height(52.dp)
                .padding(horizontal = KSpacing.md),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(
                modifier = Modifier
                    .clip(RoundedCornerShape(KRadius.control))
                    .clickable(onClick = onOpenSystemGallery)
                    .padding(horizontal = KSpacing.xs, vertical = KSpacing.xxs),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(KSpacing.xxs),
            ) {
                Glyph(tint = c.textSecondary, kind = GlyphKind.Photo, size = 20.dp)
                Text(
                    text = "相册",
                    style = KType.body,
                    color = c.textPrimary,
                )
            }
            Box(modifier = Modifier.weight(1f))
            if (selected.isNotEmpty()) {
                Text(
                    text = "已选 ${selected.size}",
                    style = KType.footnote,
                    color = c.textSecondary,
                    modifier = Modifier.padding(end = KSpacing.sm),
                )
            }
            val canSend = selected.isNotEmpty() && !sending
            Box(
                modifier = Modifier
                    .height(34.dp)
                    .clip(RoundedCornerShape(KRadius.control))
                    .background(if (canSend) c.accent else c.accent.copy(alpha = 0.42f))
                    .clickable(enabled = canSend) { onSend(selected.toList()) }
                    .padding(horizontal = KSpacing.md),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = if (sending) "发送中…" else "发送",
                    style = KType.body,
                    color = c.onAccent,
                )
            }
        }
    }
}

/**
 * 相册条里的一格（单排大图，宽度自适应）。
 *
 * **高度固定、宽度 = 高度 × 原图宽高比**：横图宽、竖图窄，比例一律不变。
 * 因为框本身就是这张图的比例，`Crop` 等于"铺满且不裁内容" —— 用 `Fit` 反而会在
 * 换算取整时留下一两条像素的黑边，"挨着"的观感就没那么齐。
 *
 * 手势（2026-10-20，用户参考 QQ）：
 *  · **短按** = 选中 / 取消选中；
 *  · **按住不放**（[ALBUM_LONG_PRESS_MS]）→ 进入「上滑松手发送」：整张图浮起来跟着
 *    手指走，松手时上滑超过 [ALBUM_SEND_DISTANCE_DP] 就直接发这张；
 *  · 没滑够就松手 = 取消（回到面板，不发送）—— 长按本来是"想看看大图"的常见动作，
 *    不设门槛会误发。
 *
 * 为什么不用 `detectDragGesturesAfterLongPress`：它在"长按后没移动就松手"这条路径上
 * 不保证回调 `onDragEnd`（语音按钮那边踩过同一个坑），这里必须保证松手一定有结论。
 *
 * 三个回调都用 [rememberUpdatedState] 包一层：`pointerInput(uri)` 只在 uri 变化时
 * 重建，直接捕获 lambda 会一直是首次组合那个（`selected` 变了它还是旧视图），
 * 表现就是"点第一下能选、再点不取消"。
 */
@Composable
private fun AlbumThumb(
    uri: Uri,
    aspect: Float,
    height: Dp,
    selectedIndex: Int,
    onToggle: () -> Unit,
    onDragStart: (Rect) -> Unit,
    onDragMove: (Float) -> Unit,
    onDragEnd: (Float) -> Unit,
) {
    val c = KTheme.colors
    val toggle by rememberUpdatedState(onToggle)
    val dragStart by rememberUpdatedState(onDragStart)
    val dragMove by rememberUpdatedState(onDragMove)
    val dragEnd by rememberUpdatedState(onDragEnd)
    /**
     * 这一格在**根坐标系**里的位置与尺寸。
     *
     * 长按拖拽时浮图要从**这张图当前所在的位置**开始，而不是凭空在屏幕中央出现
     * （用户反馈："不是重新来一张从中间发送"）。所以每次布局都记一下自己的矩形，
     * 长按成立的那一刻把它交给页面层的浮层。
     */
    var boundsInRoot by remember { mutableStateOf(Rect.Zero) }
    Box(
        modifier = Modifier
            .height(height)
            // 宽度完全由原图比例决定（aspectRatio 会按已定的高度算出宽度）
            .aspectRatio(aspect.coerceIn(0.2f, 5f))
            .background(Color.Black)
            .onGloballyPositioned { boundsInRoot = it.boundsInRoot() }
            .pointerInput(uri) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    /**
                     * ⚠️ **不要 consume 这个 down**：横向列表（LazyRow）要靠它判断
                     * "我要开始滚"。一旦在按下时就吃掉，相册条直接滑不动。
                     *
                     * 接下来 ALBUM_LONG_PRESS_MS 内观察：
                     *  · 抬手 → 点选（切换选中）；
                     *  · 事件被别人消费（列表开始横向滚）→ 让给列表，什么都不做；
                     *  · 一直按着没动 → 长按成立，进入「上滑松手发送」。
                     */
                    var released = false
                    var listTookOver = false
                    withTimeoutOrNull(ALBUM_LONG_PRESS_MS) {
                        while (true) {
                            val event = awaitPointerEvent()
                            val change = event.changes.firstOrNull { it.id == down.id } ?: break
                            if (!change.pressed) {
                                released = true
                                break
                            }
                            if (change.isConsumed) {
                                listTookOver = true
                                break
                            }
                        }
                        Unit
                    }
                    if (listTookOver) return@awaitEachGesture
                    if (released) {
                        toggle()
                        return@awaitEachGesture
                    }
                    // 长按成立：之后每一帧把**累计**位移交给调用方（浮层按它移动），
                    // 同时 consume 掉，把列表的横向滚动挡在门外
                    dragStart(boundsInRoot)
                    var totalY = 0f
                    while (true) {
                        val event = awaitPointerEvent()
                        val change = event.changes.firstOrNull { it.id == down.id } ?: break
                        if (!change.pressed) {
                            dragEnd(totalY)
                            break
                        }
                        totalY += change.positionChange().y
                        change.consume()
                        dragMove(totalY)
                    }
                }
            },
    ) {
        AsyncImage(
            model = uri,
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = Modifier.fillMaxSize(),
        )
        // 右上角圈：选中 = 主题色实心 + ✓；未选中 = 半透明圈
        Box(
            modifier = Modifier
                .align(Alignment.TopEnd)
                .padding(4.dp)
                .size(20.dp)
                .clip(CircleShape)
                .then(
                    if (selectedIndex >= 0) {
                        Modifier.background(c.accent)
                    } else {
                        Modifier
                            .background(Color.Black.copy(alpha = 0.35f))
                            .border(1.5.dp, Color.White.copy(alpha = 0.92f), CircleShape)
                    },
                ),
            contentAlignment = Alignment.Center,
        ) {
            if (selectedIndex >= 0) {
                Glyph(tint = c.onAccent, kind = GlyphKind.Check, size = 13.dp)
            }
        }
    }
}

/** 当前是否有读图权限（Android 14 的"仅选中照片"也算） */
private fun hasMediaPermission(context: Context): Boolean = when {
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE ->
        ContextCompat.checkSelfPermission(context, Manifest.permission.READ_MEDIA_IMAGES) ==
            PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED,
            ) == PackageManager.PERMISSION_GRANTED

    Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU ->
        ContextCompat.checkSelfPermission(context, Manifest.permission.READ_MEDIA_IMAGES) ==
            PackageManager.PERMISSION_GRANTED

    else ->
        ContextCompat.checkSelfPermission(context, Manifest.permission.READ_EXTERNAL_STORAGE) ==
            PackageManager.PERMISSION_GRANTED
}

private fun mediaPermissions(): Array<String> = when {
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE -> arrayOf(
        Manifest.permission.READ_MEDIA_IMAGES,
        Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED,
    )

    Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU ->
        arrayOf(Manifest.permission.READ_MEDIA_IMAGES)

    else -> arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
}

/**
 * 相册里的一张照片。
 *
 * 连**原始像素宽高**一起带出来：单排大图的**宽度要按比例算**（`高度 × w/h`），
 * 只有 uri 的话得等 Coil 解码完才知道比例，第一帧只能按默认宽度铺、之后再整体
 * 重排（打开相册那一下会明显抖）。
 */
private data class AlbumPhoto(val uri: Uri, val width: Int, val height: Int) {
    /** 宽高比（w/h）。MediaStore 偶尔给 0，兜底成 1，避免除零 */
    fun aspect(): Float = width.coerceAtLeast(1).toFloat() / height.coerceAtLeast(1)
}

/** MediaStore 最近照片（按添加时间倒序，最多 [limit] 张） */
private fun queryRecentImages(context: Context, limit: Int): List<AlbumPhoto> {
    val out = ArrayList<AlbumPhoto>(limit)
    val projection = arrayOf(
        MediaStore.Images.Media._ID,
        MediaStore.Images.Media.WIDTH,
        MediaStore.Images.Media.HEIGHT,
    )
    context.contentResolver.query(
        MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
        projection,
        null,
        null,
        "${MediaStore.Images.Media.DATE_ADDED} DESC",
    )?.use { cursor ->
        val idColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
        val widthColumn = cursor.getColumnIndex(MediaStore.Images.Media.WIDTH)
        val heightColumn = cursor.getColumnIndex(MediaStore.Images.Media.HEIGHT)
        while (cursor.moveToNext() && out.size < limit) {
            out.add(
                AlbumPhoto(
                    uri = ContentUris.withAppendedId(
                        MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                        cursor.getLong(idColumn),
                    ),
                    width = if (widthColumn >= 0) cursor.getInt(widthColumn) else 0,
                    height = if (heightColumn >= 0) cursor.getInt(heightColumn) else 0,
                )
            )
        }
    }
    return out
}

/** 相册：按住多久进入「上滑松手发送」（与语音按钮的 200ms 同档，手感一致） */
private const val ALBUM_LONG_PRESS_MS = 220L

/** 上滑多少 dp 松手才真的发送（低于这个距离视为误触，取消） */
private const val ALBUM_SEND_DISTANCE_DP = 56
