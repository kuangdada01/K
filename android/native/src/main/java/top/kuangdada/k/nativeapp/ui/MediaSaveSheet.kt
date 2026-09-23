package top.kuangdada.k.nativeapp.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import top.kuangdada.k.core.designsystem.theme.KDimens
import top.kuangdada.k.core.designsystem.theme.KRadius
import top.kuangdada.k.core.designsystem.theme.KSpacing
import top.kuangdada.k.core.designsystem.theme.KTheme
import top.kuangdada.k.core.designsystem.theme.KType
import top.kuangdada.k.nativeapp.download.MediaSaver
import top.kuangdada.k.nativeapp.download.MediaStoreSaver

/**
 * ============================================================
 * 「长按图片 / 视频 → 底部弹层 → 保存到相册」
 * ============================================================
 * 用户诉求（2026-09-23）：图片和视频都要能长按存到手机里。
 *
 * ## 为什么是**全局一个宿主**，而不是每个页面各画一个
 * 能长按的地方有：聊天图片、帖子九宫格（信息流/主页/详情共用同一个 `PostCard`）、
 * 全屏看图、视频播放器 —— 四处各写一遍弹层，等于四份"保存中/已保存/失败"状态机，
 * 改一处漏三处。这里跟查看器（[LocalImageViewerOpener]）用同一套做法：
 * **Shell 里放一个宿主，任何地方通过 [LocalMediaSaveOpener] 喊一声**，
 * 宿主负责弹层、下载、落盘、结果提示。
 *
 * ## 为什么弹层自己带"保存中/已保存"状态，而不是关掉再弹 Toast
 * 视频要下几十秒。关掉弹层去转圈，用户看不到进度、也不知道能不能关页面 ——
 * 状态留在原地（"保存中… 45%" → "已保存到相册"）最省心，成功后再自动关掉。
 *
 * @param url 媒体地址（**必须是绝对地址**：调用方用仓库的 baseUrl 拼好；
 *   私信图片还要把鉴权头放进 [headers]，否则下载回来的是 403 的空壳）
 */
enum class MediaKind { Image, Video }

/** 弹层里除"保存"之外的额外动作（聊天：引用 / 撤回） */
data class MediaSheetAction(
    val label: String,
    val danger: Boolean = false,
    val onClick: () -> Unit,
)

/** 一次"保存媒体"的请求 */
data class MediaSaveTarget(
    val url: String,
    val kind: MediaKind,
    val headers: Map<String, String> = emptyMap(),
    /** 顶部标题（留空则按类型给"图片 / 视频"） */
    val title: String? = null,
    val extraActions: List<MediaSheetAction> = emptyList(),
)

/** 为 null = 当前不在 Shell 里（预览 / 单测）：长按保存静默失效，不报错 */
val LocalMediaSaveOpener = staticCompositionLocalOf<((MediaSaveTarget) -> Unit)?> { null }

/**
 * 「长按存这一张」的入口：把 [LocalMediaSaveOpener] 包成一个**稳定**的 lambda，
 * 给各页面的图片/视频格子接 `combinedClickable(onLongClick = …)` 用。
 *
 * 包一层而不是到处 `LocalMediaSaveOpener.current?.invoke(…)`：`combinedClickable` 会把
 * onLongClick 记进手势状态，lambda 每次组合都换实例等于每次重组都重建手势。
 * opener 为 null（预览 / 单测，不在 Shell 里）时长按静默无效。
 *
 * **不带鉴权头** —— 帖子配图/视频都在公开的 `/uploads/` 下。需要头的（私信图片）
 * 自己组一个 [MediaSaveTarget] 传 `headers`，见 MessagesScreen / ZoomableImage。
 */
@Composable
fun rememberMediaSave(): (String, MediaKind) -> Unit {
    val opener = LocalMediaSaveOpener.current
    return remember(opener) {
        { url, kind -> opener?.invoke(MediaSaveTarget(url = url, kind = kind)) }
    }
}

/** 保存过程的三个阶段（只影响弹层里的那一行文案与是否可点） */
private enum class SavePhase { Idle, Saving, Saved }

/**
 * 弹层宿主：**只在真的有目标时才被组合**（调用方写 `target?.let { MediaSaveSheetHost(it, …) }`）。
 *
 * ★ 为什么把"有没有目标"这个判断留在**调用方**，而不是这里 `if (target == null) return`：
 * [rememberModalBottomSheetState] 必须与 [ModalBottomSheet] **同生共死**。宿主常驻的话，
 * sheetState 会在弹层关掉之后停在 `Hidden` 并被记住，下一次长按复用同一个状态；
 * 整个宿主进出组合 = 每次都是全新状态，与 [ComposerScreen] 那套已验证可用的写法一致。
 *
 * 下载与落盘都在 [MediaSaver] 里（IO 线程），这里只管状态与文案。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MediaSaveSheetHost(target: MediaSaveTarget, onDismiss: () -> Unit) {
    val c = KTheme.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    var phase by remember { mutableStateOf(SavePhase.Idle) }
    var progress by remember { mutableFloatStateOf(0f) }
    var error by remember { mutableStateOf<String?>(null) }

    val perform: () -> Unit = {
        phase = SavePhase.Saving
        progress = 0f
        scope.launch {
            val result = when (target.kind) {
                MediaKind.Video -> MediaSaver.saveVideo(
                    context = context,
                    url = target.url,
                    namePrefix = "K-视频",
                    headers = target.headers,
                ) { p -> progress = p }

                MediaKind.Image -> MediaSaver.saveImage(
                    context = context,
                    url = target.url,
                    namePrefix = "K-图片",
                    headers = target.headers,
                )
            }
            when (result) {
                is MediaSaver.Result.Saved -> phase = SavePhase.Saved
                is MediaSaver.Result.Failed -> {
                    phase = SavePhase.Idle
                    error = result.reason
                }
            }
        }
    }

    /**
     * API 27–28 写公共目录要 `WRITE_EXTERNAL_STORAGE`（29 起 MediaStore 不需要任何权限）。
     * 权限被拒就停在原地给一句话 —— 不静默失败，也不反复弹窗。
     */
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted -> if (granted) perform() else error = "没有存储权限，存不进相册" }

    // 成功给用户一眼确认的时间，再自动收起；失败留在原地让用户能重试
    LaunchedEffect(phase) {
        if (phase == SavePhase.Saved) {
            delay(900)
            onDismiss()
        }
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = c.surface,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(horizontal = KSpacing.md)
                .padding(bottom = KSpacing.md),
            verticalArrangement = Arrangement.spacedBy(KSpacing.xs),
        ) {
            Text(
                text = target.title ?: if (target.kind == MediaKind.Video) "视频" else "图片",
                style = KType.subtitle,
                color = c.textPrimary,
                modifier = Modifier.padding(bottom = KSpacing.xxs),
            )

            SheetRow(
                label = when (phase) {
                    SavePhase.Idle -> if (target.kind == MediaKind.Video) "保存视频" else "保存图片"
                    SavePhase.Saving -> if (progress > 0f) {
                        "保存中… ${(progress * 100).toInt()}%"
                    } else {
                        "保存中…"
                    }

                    SavePhase.Saved -> "已保存到相册"
                },
                // 保存中/已保存时不可再点：连点会并发下好几份（大的视频尤其致命）
                enabled = phase == SavePhase.Idle,
                highlighted = phase != SavePhase.Idle,
                busy = phase == SavePhase.Saving,
                onClick = {
                    error = null
                    val needPermission = MediaStoreSaver.needsLegacyPermission() &&
                        ContextCompat.checkSelfPermission(
                            context,
                            Manifest.permission.WRITE_EXTERNAL_STORAGE,
                        ) != PackageManager.PERMISSION_GRANTED
                    if (needPermission) {
                        permissionLauncher.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                    } else {
                        perform()
                    }
                },
            )

            // 页面自己的动作（聊天：引用 / 撤回）—— 先收弹层再执行，否则回调里改的状态
            // 会画在弹层底下（用户看不到自己刚点的结果）
            target.extraActions.forEach { action ->
                SheetRow(
                    label = action.label,
                    danger = action.danger,
                    onClick = {
                        onDismiss()
                        action.onClick()
                    },
                )
            }

            if (error != null) {
                Text(
                    text = error.orEmpty(),
                    style = KType.caption,
                    color = c.danger,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().padding(top = KSpacing.xxs),
                )
            }

            SheetRow(label = "取消", onClick = onDismiss)
        }
    }
}

/** 弹层里的一行：整行可点，左侧文字，右侧（保存中时）一个小转圈 */
@Composable
private fun SheetRow(
    label: String,
    onClick: () -> Unit,
    enabled: Boolean = true,
    danger: Boolean = false,
    highlighted: Boolean = false,
    busy: Boolean = false,
) {
    val c = KTheme.colors
    val shape = RoundedCornerShape(KRadius.control)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            // 每一行都是可点区域，高度不得低于最小触达尺寸（"取消"也一样）
            .heightIn(min = KDimens.minTouchTarget)
            .clip(shape)
            .background(if (highlighted) c.accentSoft else c.surfaceRaised)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = KSpacing.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            style = KType.body,
            color = when {
                danger -> c.danger
                highlighted -> c.accent
                else -> c.textPrimary
            },
        )
        if (busy) {
            Spacer(Modifier.width(KSpacing.xs))
            CircularProgressIndicator(
                color = c.accent,
                strokeWidth = 1.5.dp,
                modifier = Modifier.size(14.dp),
            )
        }
    }
}
