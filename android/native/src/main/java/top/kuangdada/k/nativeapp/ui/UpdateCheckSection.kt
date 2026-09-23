package top.kuangdada.k.nativeapp.ui

import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import kotlinx.coroutines.launch
import top.kuangdada.k.core.data.ApiResult
import top.kuangdada.k.core.data.displayMessage
import top.kuangdada.k.core.designsystem.component.KButton
import top.kuangdada.k.core.designsystem.component.KButtonVariant
import top.kuangdada.k.core.designsystem.theme.KSpacing
import top.kuangdada.k.core.designsystem.theme.KType
import top.kuangdada.k.core.designsystem.theme.KTheme
import top.kuangdada.k.nativeapp.download.AppUpdater
import top.kuangdada.k.nativeapp.download.DownloadController

/**
 * ============================================================
 * 检查更新（自更新链路的前端）
 * ============================================================
 * `AppUpdater`（查 `/api/app/version`）+ `DownloadController`（系统下载 + 拉起安装）
 * 是能力层，这里负责**把它变成用户能触达的入口**，并处理三个容易做错的点：
 *
 * 1. **下载广播必须在生命周期内注册/反注册** —— 漏了反注册会泄漏 receiver
 *    （Activity 销毁后仍被系统回调）；漏了注册则"下载完成了但界面永远不知道"。
 * 2. **"安装未知应用"未授权时要引导去系统设置**，而不是让下载完成后静默什么都不发生
 *    （Android 8+ 的典型表现：点了更新、下载完了、安装页不弹，用户以为坏了）。
 * 3. **服务端 `version` 为 null = 没配置 = 无更新**，这与"请求失败"是两回事：
 *    前者应提示"已是最新"，后者应提示具体的错误原因。
 */
@Composable
fun UpdateCheckSection(modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val c = KTheme.colors

    val updater = remember { AppUpdater(context) }
    val downloader = remember { DownloadController(context) }

    var checking by remember { mutableStateOf(false) }
    var pending by remember { mutableStateOf<AppUpdater.UpdateCheck?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    // 下载完成广播：只在「已经开始」的生命周期里注册。
    // 用 DisposableEffect + LifecycleEventObserver 而不是直接 LaunchedEffect：
    // 前者能在 Activity 进后台时反注册，避免持有已销毁的 context。
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner, downloader) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> downloader.register()
                Lifecycle.Event.ON_STOP -> downloader.unregister()
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(KSpacing.xs)) {
        KButton(
            text = if (checking) "检查中…" else "检查更新",
            enabled = !checking,
            variant = KButtonVariant.Ghost,
            onClick = {
                checking = true
                error = null
                scope.launch {
                    when (val r = updater.checkForUpdate()) {
                        is ApiResult.Success -> {
                            val check = r.data
                            if (check.hasUpdate && check.apkUrl != null) {
                                pending = check
                            } else {
                                Toast.makeText(context, "已是最新版本", Toast.LENGTH_SHORT).show()
                            }
                        }
                        is ApiResult.Failure -> error = r.error.displayMessage
                    }
                    checking = false
                }
            },
        )
        error?.let {
            Text("检查更新失败：$it", style = KType.caption, color = c.danger)
        }
    }

    // 发现新版本 → 明确征得用户同意再下载（不静默开始下十几 MB）
    pending?.let { check ->
        AlertDialog(
            onDismissRequest = { pending = null },
            title = { Text("发现新版本 ${check.latestVersion ?: ""}") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(KSpacing.xs)) {
                    Text("当前版本：${check.currentVersion}", style = KType.caption, color = c.textSecondary)
                    check.notes?.takeIf { it.isNotBlank() }?.let {
                        Text(it, style = KType.body, color = c.textPrimary)
                    }
                }
            },
            confirmButton = {
                KButton(
                    text = "下载并安装",
                    onClick = {
                        pending = null
                        // 未授权"安装未知应用"时**先引导设置页**，而不是下完才发现装不上
                        if (!downloader.canInstallPackages()) {
                            Toast.makeText(
                                context,
                                "请允许「安装未知应用」后重试",
                                Toast.LENGTH_LONG,
                            ).show()
                        }
                        val id = downloader.start(
                            url = check.apkUrl!!,
                            fileName = "k-app-${check.latestVersion}-release.apk",
                            mimeType = "application/vnd.android.package-archive",
                            installAfter = true,
                        )
                        if (id == null) {
                            Toast.makeText(context, "下载启动失败", Toast.LENGTH_SHORT).show()
                        } else {
                            Toast.makeText(context, "已开始下载，完成后会提示安装", Toast.LENGTH_SHORT).show()
                        }
                    },
                )
            },
            dismissButton = {
                KButton(text = "以后再说", variant = KButtonVariant.Ghost, onClick = { pending = null })
            },
            modifier = Modifier.fillMaxWidth(),
        )
    }
}
