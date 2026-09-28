package top.kuangdada.k.nativeapp.ui

import android.os.SystemClock
import android.util.Log
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.launch
import top.kuangdada.k.core.data.ApiResult
import top.kuangdada.k.core.data.displayMessage
import top.kuangdada.k.core.designsystem.theme.KSpacing
import top.kuangdada.k.core.designsystem.theme.KType
import top.kuangdada.k.core.designsystem.theme.KTheme
import top.kuangdada.k.nativeapp.download.AppUpdater
import top.kuangdada.k.nativeapp.download.UpdateLaunch
import top.kuangdada.k.nativeapp.download.UpdatePromptPolicy
import top.kuangdada.k.nativeapp.download.UpdateSkipStore

/**
 * ============================================================
 * App 自更新提示（UpdatePromptHost）—— 挂在 AppShell 最上层
 * ============================================================
 * 对应服务端 `GET /api/app/version`（见 [AppUpdater]）。行为按用户 09-27 的要求：
 *
 *  · **有新版本就提示**，弹窗可以取消（「以后再说」/ 点遮罩 / 按返回键，三者等价）；
 *  · **取消后不再打扰**，直到服务端发布**下一个**版本 —— 记的是"跳过的版本号"，
 *    判据见 [UpdatePromptPolicy] 与 [UpdateSkipStore]。
 *
 * 三个容易做错的点，都是从旧实现（`:native` 里那个从未接线的 `UpdateCheckSection`）带过来的经验：
 *
 * 1. ★ **v0.1.11 起不再自己下载与安装**（见 [UpdateLaunch]）：「立即更新」只把 APK 直链
 *    交给系统浏览器，用户从下载列表点安装。这条改动是为了摘掉 `REQUEST_INSTALL_PACKAGES`
 *    ——「安装包权限 + 下载 apk + 拉起安装器」会被国产安全软件判成"捆绑安装"
 *    （2026-09-28 用户实测被腾讯手机管家报 `a.gray.BulimiaTGen.f`，且**真的拦掉了安装**：
 *    他 09-27 下载过 0.1.8，却一直停在 09-24 的 debug 版本上）。
 * 2. **检测失败必须静默**（离线/接口异常不该打扰用户）—— 与 Web 端 `AppUpdatePrompt` 一致。
 * 3. **取消语义必须持久化**（见 [UpdateSkipStore]）：否则"回前台再查一次"会变成反复打扰。
 *
 * 检测时机：**冷启动一次 + 每次回到前台**（后者带 60s 节流）。只挂冷启动是不够的 ——
 * 版本可能是 App 开着的时候发上去的，而用户很少真正杀进程重启。
 * 之所以敢加"回前台再查"，是因为取消状态是**持久化**的：重复检测不会变成重复打扰。
 */
@Composable
fun UpdatePromptHost(modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val c = KTheme.colors

    val updater = remember { AppUpdater(context) }
    val skipStore = remember { UpdateSkipStore(context) }
    val gate = remember { CheckGate() }

    var pending by remember { mutableStateOf<AppUpdater.UpdateCheck?>(null) }

    /**
     * 本次运行里**已经做过选择**的版本（点过「立即更新」或「以后再说」）。
     *
     * 「以后再说」另外会落盘（跨进程有效）；这个集合管的是"同一次运行里别又问一遍" ——
     * 最要紧的是**点了更新、正在下载**的那几十秒：回到前台再查时版本还没变，
     * 不挡一下就会在下载过程中再弹一次。
     */
    val handled = remember { mutableSetOf<String>() }

    var foregroundTick by remember { mutableStateOf(0) }

    /**
     * 查一次更新。两个入口共用（冷启动 / 回到前台），[CheckGate] 负责去重与节流 ——
     * 冷启动时"AppShell 进组合"与"Activity ON_START"可能都会触发，节流保证只打一个请求。
     */
    fun checkNow() {
        val now = SystemClock.elapsedRealtime()
        if (gate.inFlight || now - gate.lastAt < CHECK_THROTTLE_MS) return
        gate.inFlight = true
        gate.lastAt = now
        scope.launch {
            try {
                when (val r = updater.checkForUpdate()) {
                    is ApiResult.Success -> {
                        val check = r.data
                        val latest = check.latestVersion?.trim().orEmpty()
                        when {
                            // 本次运行已经问过这一版（正在下载 / 刚点过以后再说）
                            latest.isNotEmpty() && latest in handled -> Unit
                            UpdatePromptPolicy.shouldPrompt(check, skipStore.skippedVersion()) ->
                                pending = check
                            // 配了版本号却没配下载地址：这是服务端的配置缺口，留日志不打扰用户
                            check.hasUpdate ->
                                Log.w(TAG, "服务端有新版本 $latest 但没有 apkUrl，跳过提示")
                            else -> Log.i(TAG, "已是最新版本（本机 ${check.currentVersion}）")
                        }
                    }
                    // 静默：离线/接口异常不是用户的问题
                    is ApiResult.Failure -> Log.i(TAG, "更新检测失败：${r.error.displayMessage}")
                }
            } finally {
                gate.inFlight = false
            }
        }
    }

    val lifecycleOwner = LocalLifecycleOwner.current

    // 回到前台再查一次。这个 observer 原先还负责"随生命周期注册下载完成广播"，
    // 现在下载交给浏览器了，它就只剩检测时机这一个职责。
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                // 进前台就触发一次检测（节流在 checkNow 里，不会因为来回切而狂打接口）
                Lifecycle.Event.ON_START -> foregroundTick++
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    /**
     * 冷启动这一次**不能只靠 ON_START**：MainActivity 在读本地登录态时先画一个转圈，
     * AppShell 可能在 Activity 的 ON_START 之后才进组合 —— 那时 observer 已经错过了那次事件，
     * 于是"冷启动检测"要等下一次真进前台才会发生（用户看到的就是"更新提示时有时无"）。
     */
    LaunchedEffect(Unit) { checkNow() }
    LaunchedEffect(foregroundTick) { if (foregroundTick > 0) checkNow() }

    // 提示统一走全局主题化 Toast（不再是"下载完成/失败"的广播回调 —— 下载已交给浏览器，
    // 本 App 不再知道下载进度，也就不该对进度发表意见）
    val toast = LocalToast.current

    /**
     * 取消：记下这一版，下次只在服务端出了**新**版本时才再问。
     * 「以后再说」、点遮罩、按返回键三条路径都走这里 —— 它们的语义对用户是同一件事。
     */
    fun cancelPrompt(check: AppUpdater.UpdateCheck) {
        val v = check.latestVersion?.trim().orEmpty()
        if (v.isNotEmpty()) {
            skipStore.markSkipped(v)
            handled.add(v)
        }
        pending = null
    }

    // 发现新版本 → 明确征得用户同意再下载（不静默开始下十几 MB）
    pending?.let { check ->
        KAlertDialog(
            title = "发现新版本 ${check.latestVersion.orEmpty()}",
            textContent = {
                // 整段居中：弹窗是「居中标题 + 并排按钮」的排版，说明文字左对齐会跟标题错开一条边
                Column(
                    verticalArrangement = Arrangement.spacedBy(KSpacing.xs),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(
                        "当前版本 ${check.currentVersion}",
                        style = KType.caption,
                        color = c.textSecondary,
                        textAlign = TextAlign.Center,
                    )
                    check.notes?.takeIf { it.isNotBlank() }?.let {
                        Text(
                            it,
                            style = KType.body,
                            color = c.textPrimary,
                            textAlign = TextAlign.Center,
                        )
                    }
                }
            },
            confirmText = "立即更新",
            dismissText = "以后再说",
            onDismissRequest = { cancelPrompt(check) },
            onConfirm = {
                val url = check.apkUrl?.trim().orEmpty()
                pending = null
                check.latestVersion?.trim()?.takeIf { it.isNotEmpty() }?.let { handled.add(it) }
                when {
                    // 服务端配了版本号却没配下载地址：这是配置缺口，说清楚比静默好
                    !UpdateLaunch.isOpenableUrl(url) ->
                        toast.show("下载地址缺失，请稍后再试")
                    // 极简 ROM 上可能一个浏览器都没有 —— 必须提示，否则就是"点了没反应"
                    !UpdateLaunch.openInBrowser(context, url) ->
                        toast.show("没有可用的浏览器，请手动访问 $url")
                    else ->
                        toast.show("已在浏览器打开，下载完成后点安装包即可安装")
                }
            },
            modifier = modifier,
        )
    }
}

/** 两次检测之间的最小间隔：来回切前后台不该反复打接口 */
private const val CHECK_THROTTLE_MS = 60_000L

private const val TAG = "KUpdatePrompt"

/**
 * 「一次探测」的去重与节流状态。
 *
 * 单独一个类而不是两个 `remember { mutableStateOf(...) }`：这两个值只被
 * [UpdatePromptHost.checkNow] 读写，**不需要**参与重组 —— 用 State 反而会让
 * 每次检测都触发一次整棵 Shell 的重组（它挂在 AppShell 顶层）。
 */
private class CheckGate {
    var inFlight = false
    var lastAt = 0L
}
