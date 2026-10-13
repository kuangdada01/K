package top.kuangdada.k.nativeapp

import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import top.kuangdada.k.nativeapp.ui.AppDestination
import top.kuangdada.k.nativeapp.ui.AppRoot

/**
 * ============================================================
 * 原生版入口（唯一的 Activity）
 * ============================================================
 * M2 阶段的能力：登录/注册 · 首页信息流 · 搜索发现 · 图书列表/详情/阅读器 ·
 * 语音房间列表 · 个人主页三标签（帖子/转发/收藏）· 悬浮导航胶囊 · 沉浸态。
 *
 * 三个与 Web 版对齐的行为：
 *  1. **游客可浏览**（服务端 `/api/posts`、`/api/books`、`/api/voice/rooms` 都是 optionalAuth），
 *     只有互动与个人主页要求登录；
 *  2. **冷启动先用本地 token 乐观进入已登录态**，后台用 `/api/auth/me` 校验；
 *  3. **返回键逐层弹出**，回到一级页再按**交还系统**（Android 14+ 的"返回主屏幕"预览动画
 *     由系统播；根 Activity 的返回 = 把任务移到后台，对齐 Web 版"双击 tab 最小化"的语义。
 *     2026-10-13 起不再自己调 `moveTaskToBack` —— 有注册返回回调时系统就不会播那个动画）。
 *
 * 服务端地址 = `BuildConfig.DEFAULT_SERVER_URL`（在 :core:data 里配置）。
 *
 * 本类只做"Activity 独有的能力"：锁屏亮屏、进程图装配、深链解析 —— 其余启动语义
 * （鉴权/主题/登录保护/返回处理）都在 `AppRoot` / `AppShell` 里。
 */
class MainActivity : ComponentActivity() {

    companion object {
        /**
         * 全屏意图（`SocialNotifier.post` 的 `setFullScreenIntent`）在 Intent 上打的标记。
         *
         * 只有用带这个 extra 的 Intent 启动/送达时才允许"画在锁屏之上 + 点亮屏幕"，
         * 并在离开前台时立刻收回（见 [onPause]）：`setShowWhenLocked(true)` 的语义是
         * **不需要解锁验证**就能看到并操作本 Activity，常开的话"锁屏前开着 App →
         * 按电源键亮屏"会绕过锁屏直接进 App（2026-10-11 反馈）。
         */
        const val EXTRA_LAUNCHED_FROM_FULL_SCREEN = "from_full_screen"
    }

    /** 传进 Compose 的深链目标；由 Compose 消费（消费后置 null，避免重复跳转）。 */
    private var pendingDeepLink by mutableStateOf<AppDestination?>(null)

    /**
     * 深链 / 通知点击的接收入口。
     *
     * Manifest 是 singleTop，App 开着时点站内链接**不会重建 Activity**，
     * 只回调本方法（漏了它的表现：App 开着点链接毫无反应，冷启动却正常）。
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        pendingDeepLink = DeepLink.fromIntent(intent)
        // App 已在运行时，全屏意图也走这里送达（singleTop + NEW_TASK 不会重建 Activity）
        applyWakeFlags(intent.getBooleanExtra(EXTRA_LAUNCHED_FROM_FULL_SCREEN, false))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        // 锁屏亮屏的另一半：通知的全屏意图把系统带到本 Activity 时，
        // 没有这两个标志的话部分 ROM（实测 ColorOS/一加）不会真正点亮屏幕、
        // 也不会把 Activity 画在锁屏之上 —— 表现是"屏幕闪了一下还是黑的"。
        // 但只允许"这一趟确实是全屏意图拉起来的"才开（离开前台即关，见 [onPause]），
        // 不能常开 —— 理由见 [EXTRA_LAUNCHED_FROM_FULL_SCREEN] 的注释。
        applyWakeFlags(intent.getBooleanExtra(EXTRA_LAUNCHED_FROM_FULL_SCREEN, false))
        // AppGraph.from 会在 Manifest 漏配 android:name=".KApp" 时自建并打警告，
        // 而不是像 `(application as KApp)` 那样直接崩在 UI 起来之前
        val graph = AppGraph.from(this)
        // 调试入口（仅 debug 变体有效；发布版是空实现，见 DebugEntry 的两份同名文件）
        DebugEntry.maybeRunNetworkDiagnostics(intent)
        // 冷启动深链 / 通知点击
        pendingDeepLink = DeepLink.fromIntent(intent)
        setContent {
            AppRoot(
                graph = graph,
                initialDestination = AppDestination.Home,
                deepLink = pendingDeepLink,
                onDeepLinkConsumed = { pendingDeepLink = null },
            )
        }
    }

    override fun onPause() {
        super.onPause()
        // 用完即关：离开前台（切走/灭屏）就收回锁屏标志。全屏意图那一趟的亮屏
        // 发生在进入前台之前，这里关掉不会打断它；之后的"手动锁屏 → 按电源键亮屏"
        // 才会回到正常锁屏界面，而不是把 App 画在锁屏上直接可操作。
        applyWakeFlags(false)
    }

    /**
     * 开/关"锁屏亮屏"两个标志（`setTurnScreenOn` + `setShowWhenLocked`）。
     *
     * API 27+ 走 Activity 属性；24–26 用等价的 window flag（`FLAG_TURN_SCREEN_ON`/
     * `FLAG_SHOW_WHEN_LOCKED` 已标废弃，但语义一致）。
     */
    private fun applyWakeFlags(enabled: Boolean) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setTurnScreenOn(enabled)
            setShowWhenLocked(enabled)
        } else {
            @Suppress("DEPRECATION")
            if (enabled) {
                window.addFlags(
                    android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                        android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED,
                )
            } else {
                window.clearFlags(
                    android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                        android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED,
                )
            }
        }
    }
}
