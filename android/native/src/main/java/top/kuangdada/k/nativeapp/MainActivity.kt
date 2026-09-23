package top.kuangdada.k.nativeapp

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.PredictiveBackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import top.kuangdada.k.core.data.SessionRepository
import top.kuangdada.k.core.data.ThemePreference
import top.kuangdada.k.core.designsystem.theme.KTheme
import top.kuangdada.k.nativeapp.ui.AppDestination
import top.kuangdada.k.nativeapp.ui.AppNavigator
import top.kuangdada.k.nativeapp.ui.AppShell
import top.kuangdada.k.nativeapp.ui.rememberAppNavigator

/**
 * ============================================================
 * 原生版入口
 * ============================================================
 * M2 阶段的能力：登录/注册 · 首页信息流 · 搜索发现 · 图书列表/详情/阅读器 ·
 * 语音房间列表 · 个人主页三标签（帖子/转发/收藏）· 悬浮导航胶囊 · 沉浸态。
 *
 * 三个与 Web 版对齐的行为：
 *  1. **游客可浏览**（服务端 `/api/posts`、`/api/books`、`/api/voice/rooms` 都是 optionalAuth），
 *     只有互动与个人主页要求登录；
 *  2. **冷启动先用本地 token 乐观进入已登录态**，后台用 `/api/auth/me` 校验；
 *  3. **返回键逐层弹出**，回到一级页再按才最小化（对齐 Web 版"双击 tab 最小化"的语义）。
 *
 * 服务端地址 = `BuildConfig.DEFAULT_SERVER_URL`（在 :core:data 里配置）。
 *
 * **基类是 `ComponentActivity`**：曾经它是 `FragmentActivity`，因为 `BiometricPrompt`
 * （私密文件夹解锁）只接受 `FragmentActivity`。那个功能 09-18 已整体删除，
 * 于是基类回归最朴素的那个（`setContent` / `enableEdgeToEdge` / `PredictiveBackHandler`
 * 全都来自 `androidx.activity`，与是否带 Fragment 无关）。
 */
class MainActivity : ComponentActivity() {

    /**
     * 深链需要在这里处理，而不是只在 onCreate 里。
     *
     * 原因：Manifest 是 `launchMode="singleTop"`（也是 :app 的配置）——
     * Activity 已在栈顶时，新的 `VIEW` Intent **不会重建 Activity**，
     * 只回调 [onNewIntent]。漏了这个方法的表现是：
     * App 开着的时候点站内链接**毫无反应**（冷启动却正常，所以很容易漏）。
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        pendingDeepLink = DeepLink.fromIntent(intent)
    }

    /** 待处理的深链：onCreate 时解析一次，之后由 Compose 消费（消费后置 null，避免重复跳转） */
    private var pendingDeepLink by mutableStateOf<top.kuangdada.k.nativeapp.ui.AppDestination?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        // AppGraph.from 会在 Manifest 漏配 android:name=".KApp" 时自建并打警告，
        // 而不是像 `(application as KApp)` 那样直接崩在 UI 起来之前
        val graph = AppGraph.from(this)
        // 调试入口（仅 debug 变体有效；发布版是空实现，见 DebugEntry 的两份同名文件）
        DebugEntry.maybeRunNetworkDiagnostics(intent)
        // 冷启动深链 / 通知点击
        pendingDeepLink = DeepLink.fromIntent(intent)
        // 把 Activity 的"最小化"能力显式传进 Compose —— 在 @Composable 里直接调
        // Activity 的方法看不到（返回键的 lambda 不是 Activity 的成员作用域）。
        // M2 起它同时交给 AppShell（返回栈空时的兜底）与本文件的兜底 handler。
        val minimize: () -> Unit = { moveTaskToBack(true) }
        setContent {
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
                Root(
                    graph = graph,
                    minimize = minimize,
                    themeMode = themeMode,
                    onThemeChange = { mode ->
                        // 写盘是挂起操作：用 Activity 的 lifecycleScope，随 Activity 销毁自动取消
                        lifecycleScope.launch { graph.theme.set(mode) }
                    },
                    deepLink = pendingDeepLink,
                    onDeepLinkConsumed = { pendingDeepLink = null },
                )
            }
        }
    }
}

@Composable
private fun Root(
    graph: AppGraph,
    minimize: () -> Unit,
    themeMode: ThemePreference.Mode,
    onThemeChange: (ThemePreference.Mode) -> Unit,
    deepLink: top.kuangdada.k.nativeapp.ui.AppDestination? = null,
    onDeepLinkConsumed: () -> Unit = {},
) {
    val c = KTheme.colors
    val authState by graph.session.state.collectAsState()
    val navigator = rememberAppNavigator(AppDestination.Home)

    // 深链 / 通知点击：等首次鉴权恢复完成后再跳，否则登录保护页会被弹回首页
    LaunchedEffect(deepLink, authState) {
        val target = deepLink ?: return@LaunchedEffect
        if (authState is SessionRepository.AuthState.Restoring) return@LaunchedEffect
        navigator.push(target)
        onDeepLinkConsumed()
    }

    // 冷启动：本地有 token 就乐观进已登录态，同时后台用 /auth/me 校验
    LaunchedEffect(Unit) { graph.session.restore() }

    // 令牌明确失效（服务端 401）→ 推到登录页。**不静默变成游客**，
    // 否则用户会以为"我的数据没了"。
    LaunchedEffect(authState) {
        val s = authState
        if (s is SessionRepository.AuthState.Expired && navigator.current !is AppDestination.Login) {
            navigator.push(AppDestination.Login)
        }
    }

    /**
     * 返回键兜底（M2）。
     *
     * 真正的返回处理已经搬进 `AppShell`（那里才看得到"设置弹层/作品选单开着没有"这两个
     * Shell 自己的状态），这里的 handler 只在 **AppShell 还没进组合**时生效
     * （冷启动读取本地登录态、显示转圈那一小段）：那时按返回应该最小化，而不是退出 App。
     *
     * 为什么是 `PredictiveBackHandler` 而不是 `BackHandler`：见 AppShell 里的说明 ——
     * `BackHandler` 会吞掉预测式返回的手势进度。
     *
     * 优先级：`OnBackPressedDispatcher` 按**后注册先响应**派发，AppShell 在本函数之后进组合，
     * 所以正常情况下轮不到这里（这正是想要的）。
     */
    PredictiveBackHandler(enabled = true) { progress ->
        progress.collect { }
        minimize()
    }

    when (authState) {
        is SessionRepository.AuthState.Restoring -> Box(
            modifier = Modifier.fillMaxSize().background(c.bgPage),
            contentAlignment = Alignment.Center,
        ) {
            CircularProgressIndicator(color = c.accent)
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
            composer = graph.composer,
            admin = graph.admin,
            navigator = navigator,
            themeMode = themeMode,
            onThemeChange = onThemeChange,
            // 返回键的处理在 AppShell 里（它才看得到覆盖层状态），但"最小化"是 Activity 的能力
            minimize = minimize,
        )
    }
}


