package top.kuangdada.k.nativeapp.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import top.kuangdada.k.core.data.SessionRepository
import top.kuangdada.k.core.data.ThemePreference
import top.kuangdada.k.core.designsystem.theme.KTheme
import top.kuangdada.k.core.designsystem.theme.KType
import top.kuangdada.k.nativeapp.AppGraph
import top.kuangdada.k.nativeapp.CrashLog

/**
 * ============================================================
 * 根壳（AppRoot）—— App 的启动路径与全局状态门
 * ============================================================
 * 负责在任何页面内容之上先立住这几件事：
 *
 *  · 鉴权恢复中 → 转圈（避免闪一下未登录 UI）；
 *  · `AuthState.Offline` → 明确的离线提示（不能进"游客 UI 但带登录凭证"的矛盾态）；
 *  · 令牌失效（`Expired`）→ 自动弹登录页；
 *  · 深链 / 通知点击的落地（等首次鉴权恢复完成后再跳）。
 *
 * **返回键在这里不再注册任何 handler**（2026-10-13 起）：这一层没有可关闭的东西，
 * 注册了反而会把"返回"从系统手里抢走 —— 只要窗口上有 PRIORITY_DEFAULT 的回调，
 * **返回主屏幕的系统动画（缩小 + 露出桌面）就不会播**。不注册时系统默认接管：
 * 根 Activity 的返回 = 把任务移到后台，与旧的 `moveTaskToBack` 同语义、还多了动画。
 * 页面栈/弹层的返回处理全在 `AppShell`（那里才看得到弹层状态）。
 *
 * 主题（`KTheme`）也在这里下发：主题偏好启动时同步读初值避免色闪，
 * 运行期由 DataStore 的 Flow 驱动；写盘走**进程级** scope（不该被窗口销毁打断）。
 */
@Composable
fun AppRoot(
    graph: AppGraph,
    initialDestination: AppDestination,
    /** 深链 / 通知点击解析出的目标；等首次鉴权恢复完成后再落地 */
    deepLink: AppDestination? = null,
    onDeepLinkConsumed: () -> Unit = {},
) {
    // 主题偏好：启动时同步读初值避免色闪，运行期由 DataStore 的 Flow 驱动
    val themeMode by graph.theme.flow.collectAsState(
        initial = graph.theme.readInitialBlocking(),
    )
    val dark = when (themeMode) {
        ThemePreference.Mode.System -> isSystemInDarkTheme()
        ThemePreference.Mode.Light -> false
        ThemePreference.Mode.Dark -> true
    }
    KTheme(darkTheme = dark) {
        RootContent(
            graph = graph,
            initialDestination = initialDestination,
            themeMode = themeMode,
            // 写盘走**进程级** scope：它是"用户意图"的落盘，不该被窗口销毁打断
            // （appScope 带 crashGuard，见 AppGraph 的注释）
            onThemeChange = { mode -> graph.appScope.launch { graph.theme.set(mode) } },
            deepLink = deepLink,
            onDeepLinkConsumed = onDeepLinkConsumed,
        )
    }
}

@Composable
private fun RootContent(
    graph: AppGraph,
    initialDestination: AppDestination,
    themeMode: ThemePreference.Mode,
    onThemeChange: (ThemePreference.Mode) -> Unit,
    deepLink: AppDestination?,
    onDeepLinkConsumed: () -> Unit,
) {
    val c = KTheme.colors
    val authState by graph.session.state.collectAsState()
    val navigator = rememberAppNavigator(initialDestination)

    /**
     * 上次崩溃的现场（见 [CrashLog]）：**只弹一次**，读完即删。
     *
     * 真机闪退以前只能靠"再复现一次 + 连 USB 抓 logcat"，用户手上没电脑时等于没法排查。
     * 现在崩完再打开 App 会看到这段堆栈，点「复制」直接贴进聊天即可。
     */
    val context = LocalContext.current
    var crashText by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { crashText = CrashLog.take(context) }
    crashText?.let { text ->
        KAlertDialog(
            title = "上次闪退了",
            textContent = {
                Text(
                    text = text.take(4000),
                    style = KType.footnote,
                    color = c.textSecondary,
                    modifier = Modifier
                        .heightIn(max = 320.dp)
                        .verticalScroll(rememberScrollState()),
                )
            },
            confirmText = "复制",
            dismissText = "关闭",
            onConfirm = {
                val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                clipboard.setPrimaryClip(ClipData.newPlainText("崩溃日志", text))
                crashText = null
            },
            onDismissRequest = { crashText = null },
        )
    }

    /**
     * 首次鉴权恢复（幂等：**只有还停在 `Restoring` 才真正发起**）。
     *
     * 为什么加这个判断而不是像旧实现那样无条件 `restore()`：
     * 冷启动时初值恒为 `Restoring` → 照常发起；已经恢复过就跳过，
     * 避免多打一次 `/auth/me`、也让首帧不闪转圈。
     */
    LaunchedEffect(Unit) {
        if (graph.session.state.value is SessionRepository.AuthState.Restoring) {
            graph.session.restore()
        }
    }

    // 令牌明确失效（服务端 401）→ 推到登录页。**不静默变成游客**，
    // 否则用户会以为"我的数据没了"。
    LaunchedEffect(authState) {
        val s = authState
        if (s is SessionRepository.AuthState.Expired && navigator.current !is AppDestination.Login) {
            navigator.push(AppDestination.Login)
        }
    }

    // 深链 / 通知点击：等首次鉴权恢复完成后再跳，否则登录保护页会被弹回首页。
    LaunchedEffect(deepLink, authState) {
        val target = deepLink ?: return@LaunchedEffect
        if (authState is SessionRepository.AuthState.Restoring) return@LaunchedEffect
        navigator.push(target)
        onDeepLinkConsumed()
    }

    // 注：这里原来有一个"恢复中/离线提示上也按返回最小化"的 PredictiveBackHandler ——
    // 2026-10-13 删除：这一层没有任何可关闭的东西，注册回调只会**抢掉系统的
    // "返回主屏幕"动画**（见文件头注释）。不注册时系统默认行为就是"把任务移到后台"，
    // 与原来 minimize() 的效果一致，还白得预览动画。

    when (authState) {
        is SessionRepository.AuthState.Restoring -> Box(
            modifier = Modifier.fillMaxSize().background(c.bgPage),
            contentAlignment = Alignment.Center,
        ) {
            CircularProgressIndicator(color = c.accentText)
        }

        /**
         * 离线：本地有凭证但 /auth/me 因网络原因失败（P1-3.1）。
         * 不能进游客界面 —— 那会出现"游客 UI 但请求仍带登录凭证"的矛盾态；
         * 给出明确的离线提示与重试入口，凭证原样保留。
         */
        is SessionRepository.AuthState.Offline -> Box(
            modifier = Modifier.fillMaxSize().background(c.bgPage),
            contentAlignment = Alignment.Center,
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(
                    text = "网络不可用",
                    style = KType.subtitle,
                    color = c.textPrimary,
                )
                Text(
                    text = "登录凭证已保留，恢复网络后可重试",
                    style = KType.body,
                    color = c.textSecondary,
                    modifier = Modifier.padding(top = 8.dp),
                )
                Button(
                    onClick = { graph.session.retryRestore() },
                    modifier = Modifier.padding(top = 16.dp),
                ) {
                    Text("重试", color = c.onAccent)
                }
            }
        }

        else -> AppShell(
            session = graph.session,
            posts = graph.posts,
            comments = graph.comments,
            books = graph.books,
            users = graph.users,
            friends = graph.friends,
            voice = graph.voice,
            messages = graph.messages,
            realtime = graph.realtime,
            inbox = graph.inbox,
            notifyPref = graph.notifyPref,
            composer = graph.composer,
            admin = graph.admin,
            navigator = navigator,
            themeMode = themeMode,
            onThemeChange = onThemeChange,
        )
    }
}
