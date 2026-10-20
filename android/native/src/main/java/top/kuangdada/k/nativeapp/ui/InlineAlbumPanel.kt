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
import androidx.compose.foundation.layout.width
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
 *  · **单排大图**（2026-10-20 用户定稿）：一行、每格和面板等高（宽 = 高 × 9/16），
 *    横向连续滑动、格与格挨着；
 *  · 图片一律 `Fit`、**不改比例**：竖图完整显示，16:9 的横图上下留黑边；
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
    var photos by remember { mutableStateOf<List<Uri>>(emptyList()) }
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
                     * **单排大图**（用户参考图 + 明确要求，2026-10-20 定稿）。
                     *
                     *  · 一行，每格都是**和面板一样高**的大图，宽 = 高 × 9/16；
                     *  · 图片一律 `Fit`，**不裁不拉伸**：竖图完整显示，16:9 的横图
                     *    上下留黑边（用户原话："16:9 就上下黑色，竖图就显示全，
                     *    不要改变比例"）；
                     *  · 格与格零间距，横向连续滑动（不是一页一张的分页）。
                     *
                     * 之前两版都错在"缩略图墙"：用户要的是能看清内容的大图，
                     * 不是一眼扫过的小格子 —— 所以格子高度不再除以 2。
                     */
                    val cellHeight = maxHeight
                    val cellWidth = cellHeight * 9f / 16f
                    LazyRow(
                        // 不设 horizontalArrangement（默认零间距）= 挨着
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        items(photos.size, key = { photos[it] }) { index ->
                            val uri = photos[index]
                            AlbumThumb(
                                uri = uri,
                                width = cellWidth,
                                height = cellHeight,
                                selectedIndex = selected.indexOf(uri),
                                onToggle = {
                                    val idx = selected.indexOf(uri)
                                    if (idx >= 0) selected.removeAt(idx)
                                    else if (selected.size < 9) selected.add(uri)
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
 * 相册条里的一格（单排大图）。
 *
 * **9:16 的框 + `Fit`，绝不改比例**：竖图完整显示；16:9 的横图按宽度铺满、
 * 上下留黑边（用户要求"16:9 就上下黑色"）。框本身是黑底，所以留边和格子边界
 * 是同一块黑，挨着看是连续的。
 *
 * [onToggle] 用 [rememberUpdatedState] 兜一层：手势的 `pointerInput(uri)` 只在 uri
 * 变化时重建，直接捕获 lambda 会一直是首次组合那个（`selected` 变了它还是旧视图），
 * 表现就是"点第一下能选、再点不取消"。
 */
@Composable
private fun AlbumThumb(
    uri: Uri,
    width: Dp,
    height: Dp,
    selectedIndex: Int,
    onToggle: () -> Unit,
) {
    val c = KTheme.colors
    val toggle by rememberUpdatedState(onToggle)
    Box(
        modifier = Modifier
            .width(width)
            .height(height)
            // 黑底：横图上下留边、竖图两侧留边都落在这块黑上，不闪白
            .background(Color.Black)
            .pointerInput(uri) { detectTapGestures { toggle() } },
    ) {
        AsyncImage(
            model = uri,
            contentDescription = null,
            // Fit = 完整显示，不改比例（横图上下留黑边）
            contentScale = ContentScale.Fit,
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

/** MediaStore 最近照片（按添加时间倒序，最多 [limit] 张） */
private fun queryRecentImages(context: Context, limit: Int): List<Uri> {
    val out = ArrayList<Uri>(limit)
    val projection = arrayOf(MediaStore.Images.Media._ID)
    context.contentResolver.query(
        MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
        projection,
        null,
        null,
        "${MediaStore.Images.Media.DATE_ADDED} DESC",
    )?.use { cursor ->
        val idColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
        while (cursor.moveToNext() && out.size < limit) {
            out.add(
                ContentUris.withAppendedId(
                    MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                    cursor.getLong(idColumn),
                )
            )
        }
    }
    return out
}
