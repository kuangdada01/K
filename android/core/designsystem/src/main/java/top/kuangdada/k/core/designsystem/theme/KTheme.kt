package top.kuangdada.k.core.designsystem.theme

import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer

/**
 * ============================================================
 * 主题（KTheme）
 * ============================================================
 * 两套主题 = 一份令牌 + 一个开关。切换 [darkTheme]（或跟随系统）时所有组件自动翻转。
 *
 * 与 Web 版 `[data-theme='dark']` 覆盖 CSS 变量是同一个机制，只是换到 Compose：
 * 设计令牌 -> [KColors] -> Material3 [ColorScheme] -> 组件。
 *
 * **刻意不套用 Material3 默认色、也不开动态取色**：设计稿是特定色板（浅色青瓷黛绿 /
 * 深色玄夜鎏金），动态取色会把品牌观感换成用户壁纸的颜色。
 *
 * 用法：
 * ```
 * KTheme {                     // 跟随系统
 *     Text("标题", style = KType.title, color = KTheme.colors.textPrimary)
 * }
 * KTheme(darkTheme = true) { … }  // 强制深色（StyleGuide 对照用）
 * ```
 */
private val LocalKColors = staticCompositionLocalOf<KColors> {
    error("KColors 未提供：请把内容包在 KTheme { } 里")
}

object KTheme {
    /** 当前主题的全部颜色令牌 */
    val colors: KColors
        @Composable @ReadOnlyComposable get() = LocalKColors.current
}

/** 令牌 -> Material3 ColorScheme 的映射（只做必要映射，语义不一致的一律走 KTheme.colors） */
private fun KColors.toMaterialScheme(): ColorScheme {
    val base = if (this === KLightColors) lightColorScheme() else darkColorScheme()
    return base.copy(
        primary = accent,
        onPrimary = onAccent,
        primaryContainer = accentSoft,
        onPrimaryContainer = accent,
        inversePrimary = accent,
        secondary = accent,
        onSecondary = onAccent,
        secondaryContainer = accentSoft,
        onSecondaryContainer = accent,
        tertiary = accent,
        onTertiary = onAccent,
        background = bgPage,
        onBackground = textPrimary,
        surface = surface,
        onSurface = textPrimary,
        surfaceVariant = accentSoft,
        onSurfaceVariant = textSecondary,
        surfaceContainerLowest = bgPage,
        surfaceContainerLow = surface,
        surfaceContainer = surface,
        surfaceContainerHigh = surfaceRaised,
        surfaceContainerHighest = surfaceRaised,
        error = danger,
        onError = onAccent,
        errorContainer = dangerSoft,
        onErrorContainer = danger,
        // M3 把 outline 用作「中性描边」，我们的语义是「需要边界时的描边」-> borderStrong
        outline = borderStrong,
        outlineVariant = borderSubtle,
        // 焦点环与强调色同源
        inverseSurface = focusRing,
        inverseOnSurface = onAccent,
        scrim = this.scrim,
        surfaceTint = Color.Transparent, // 关掉 M3 elevation 染色，卡片层次靠阴影与描边
    )
}

@Composable
fun KTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val kColors = if (darkTheme) KDarkColors else KLightColors

    /**
     * 动效降级开关（v2 新增）。
     *
     * 系统把「动画时长缩放」设成 0（或无障碍里开"移除动画"）时，
     * 页内无限循环动画与一次性入场要能走"直接到位"的分支 —— 见 KMotion.kt 的降级开关一节。
     * 实测值由 [rememberAnimationsEnabled] 提供，并且**持续监听**：
     * 用户去设置里改完切回来，不需要重启 App。
     */
    val animationsEnabled = rememberAnimationsEnabled()

    /**
     * 主题切换的过渡（M4）。
     *
     * 做法是**用旧主题的页底色盖一层、再淡出**，而不是"把整棵树降到 alpha 0.6 再淡回 1"：
     * 后者会让 Activity 的窗口底色从底下透出来 —— 深色主题切浅色时那一下白闪比"直接跳"更难看。
     *
     * 为什么不做 `Crossfade`：那会**同时组合两份 App**（两份导航栈、两个 LazyColumn、
     * 甚至两个播放器），代价完全不可接受。这里只多画一层纯色，动画期间不重组任何内容。
     *
     * 这一层不消费点击（`Box` 不挂手势），所以褪色期间界面依然能点。
     * 动画关掉时直接跳过（连这一层都不画）。
     */
    var scrimColor by remember { mutableStateOf<Color?>(null) }
    val scrimAlpha = remember { Animatable(0f) }
    val previousColors = remember { mutableStateOf(kColors) }
    LaunchedEffect(kColors) {
        val from = previousColors.value
        previousColors.value = kColors
        if (from === kColors || !animationsEnabled) {
            scrimColor = null
            scrimAlpha.snapTo(0f)
            return@LaunchedEffect
        }
        // 旧底色不透明地盖住新主题，然后淡掉 —— 观感是"旧配色溶开、新配色浮现"
        scrimColor = from.bgPage
        scrimAlpha.snapTo(1f)
        scrimAlpha.animateTo(0f, KMotion.effects())
        scrimColor = null
    }

    CompositionLocalProvider(
        LocalKColors provides kColors,
        LocalAnimationsEnabled provides animationsEnabled,
    ) {
        MaterialTheme(
            colorScheme = kColors.toMaterialScheme(),
            typography = KType.material,
        ) {
            Box(modifier = Modifier.fillMaxSize()) {
                content()
                val scrim = scrimColor
                if (scrim != null) {
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            // 绘制期读动画值：褪色过程不重组
                            .graphicsLayer { alpha = scrimAlpha.value }
                            .background(scrim),
                    )
                }
            }
        }
    }
}
