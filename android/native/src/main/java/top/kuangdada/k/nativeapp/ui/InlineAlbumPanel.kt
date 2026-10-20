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
 *  · **两行缩略图墙、格子统一 9:16**：等宽等高、彼此零间距，横向滑动
 *    （2026-10-20 用户要求："相册是挨着无缝显示的，不是一张一张选择"）；
 *    横图（16:9）也 Crop 成 9:16 显示 —— 统一格子才排得严丝合缝；
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
                     * 两行缩略图墙（用户给的 QQ 参考图，2026-10-20 定稿）。
                     *
                     * 格子**统一 9:16 竖框**：不管原图是竖的 9:16 还是横的 16:9，
                     * 一律 Crop 成 9:16（用户原话："放一张 9:16 的，16:9 也显示 9:16"）。
                     * 这样每格等宽等高，整面墙严丝合缝 —— 按原图比例取宽的话，横图会把
                     * 那一列撑宽、竖图旁边留缝，看起来就不"挨着"了。
                     *
                     * 行高 = 面板内容高的一半；格宽 = 行高 × 9/16。
                     * 列 = 上下两格（`chunked(2)`），列内上下紧贴、列与列零间距。
                     */
                    val rowHeight = maxHeight / 2
                    val thumbWidth = rowHeight * 9f / 16f
                    val columns = photos.chunked(2)
                    LazyRow(
                        // 不设 horizontalArrangement（默认零间距）= 无缝
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        items(columns.size, key = { columns[it].first() }) { index ->
                            Column {
                                columns[index].forEach { uri ->
                                    AlbumThumb(
                                        uri = uri,
                                        width = thumbWidth,
                                        height = rowHeight,
                                        selectedIndex = selected.indexOf(uri),
                                        onToggle = {
                                            val idx = selected.indexOf(uri)
                                            if (idx >= 0) selected.removeAt(idx)
                                            else if (selected.size < 9) selected.add(uri)
                                        },
                                    )
                                }
                                // 总共奇数张时最后一列只有一张：补一块同色占位，
                                // 否则这一列的底部会露出页面底色、看起来像"墙缺了一角"
                                if (columns[index].size == 1) {
                                    Box(
                                        modifier = Modifier
                                            .width(thumbWidth)
                                            .height(rowHeight)
                                            .background(c.surface),
                                    )
                                }
                            }
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
 * 缩略图墙里的一格。
 *
 * **固定 9:16 竖框 + Crop**：原图是 9:16 的截图正好铺满，16:9 的横图裁成中间一段
 * 显示（用户要求"16:9 也显示 9:16"）。缩略图墙的用途是"一眼扫到、点选"，
 * 统一格子比保留原比例更重要 —— 后者会让横图把整列撑宽、竖图旁边留缝。
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
            // 图还没解码出来时铺主题底色，不闪白
            .background(c.surfaceRaised)
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
