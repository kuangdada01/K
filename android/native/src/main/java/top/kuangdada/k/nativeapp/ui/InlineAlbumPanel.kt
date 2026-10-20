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
import androidx.compose.foundation.gestures.detectTapGestures
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import coil3.compose.AsyncImage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
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
) {
    val context = LocalContext.current
    val c = KTheme.colors
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
 * [onToggle] 用 [rememberUpdatedState] 兜一层：手势的 `pointerInput(uri)` 只在 uri
 * 变化时重建，直接捕获 lambda 会一直是首次组合那个（`selected` 变了它还是旧视图），
 * 表现就是"点第一下能选、再点不取消"。
 */
@Composable
private fun AlbumThumb(
    uri: Uri,
    aspect: Float,
    height: Dp,
    selectedIndex: Int,
    onToggle: () -> Unit,
) {
    val c = KTheme.colors
    val toggle by rememberUpdatedState(onToggle)
    Box(
        modifier = Modifier
            .height(height)
            // 宽度完全由原图比例决定（aspectRatio 会按已定的高度算出宽度）
            .aspectRatio(aspect.coerceIn(0.2f, 5f))
            .background(Color.Black)
            .pointerInput(uri) { detectTapGestures { toggle() } },
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
