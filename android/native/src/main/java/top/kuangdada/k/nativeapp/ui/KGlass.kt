package top.kuangdada.k.nativeapp.ui

import android.os.Build
import android.util.Log
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.BlurEffect
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.layer.GraphicsLayer
import androidx.compose.ui.graphics.layer.drawLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.rememberGraphicsLayer
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import top.kuangdada.k.core.designsystem.theme.KMotion
import top.kuangdada.k.core.designsystem.theme.KTheme
import top.kuangdada.k.core.designsystem.theme.LocalAnimationsEnabled
import kotlin.math.roundToInt

/**
 * ============================================================
 * KGlass：毛玻璃（背景实时模糊）的自研实现
 * ============================================================
 *
 * 完整根因分析与实施方案见 `docs/android-glass-plan.md`（§12 是本机实测的机制定论）。
 *
 * ## 本机实测确定的三条渲染规则（2026-09-22，逐条隔离验证）
 *
 * **R1｜`RenderEffect` 只作用于图层"自己的绘制指令"，不作用于嵌套的 RenderNode 引用。**
 *  · 在带 RenderEffect 的层里画一条 40px 洋红带 → 被糊成柔和渐变（**能糊**）；
 *  · 把另一个图层 `drawLayer` 进带 RenderEffect 的层 → 内容全锐利（**不糊**）。
 *  → haze / Cloudy 走的正是"层套层"这条死路，所以它们都"只有色膜"。
 *
 * **R2｜滚动容器会把内容包进一个 RenderNode。** `verticalScroll` / `LazyColumn` 的裁剪
 * 是 `Modifier.clip` 实现的，而 `clip` 用 `graphicsLayer`。按 R1，**只要内容的绘制指令
 * 落在那个裁剪层里，模糊就到不了它** —— 这是"抓滚动内容再糊"这条路的总阻塞。
 *
 * **R3｜同一次绘制里 `drawContent()` 只能调一次**（v2 的实测结论）：
 * 先 `drawContent()` 上屏、再把 `Picture` 画到屏幕，会得到**空 Picture**。
 *
 * ## 本实现的做法（针对 R1/R2/R3 的直接对策）
 *
 * 关键：**让"栏那一块"的绘制指令直接落进那个挂 RenderEffect 的层**，
 * 而不是"把另一个图层画进这一层"（后者按 R1 必然不糊）。
 *
 *  · 源端 [kGlassSource]：先把内容照常上屏（清晰），然后**在重放层的录制块里再调一次
 *    `drawContent()`** —— 于是这一层里装的是**真正的绘制指令**，RenderEffect 就能作用于它；
 *  · 效果端 [kGlassBar]：只负责把这一层按 alpha 画出来，再叠 scrim 与本节点内容。
 *
 * 与 v3 的唯一区别就是重放层里装什么：
 * `drawLayer(源图层)`（嵌套引用，不糊）→ `drawContent()`（绘制指令，能糊）。
 *
 * ## 三道保障（与实现无关，都是对的，保留）
 *
 * · **P1 原点对齐**：源端录制时把栏左上角对齐到层原点，效果端零几何运算 ——
 *   没有逐帧几何量，就不会有"慢速滑动闪烁"；
 * · **P2 就绪门控**：只有 [KGlassScope.ready]（`revision > 0`，真的录过）才允许把 scrim
 *   拉成半透明；否则保持 [top.kuangdada.k.core.designsystem.theme.KColors.frostedSolid]
 *   不透明纯色 —— 根治"只有半透明、没有毛玻璃"；
 * · **P3 带迟滞的 latch**：开 = 内容确实滚到栏下；关 = **静止**在正顶端（迟滞，不闪）。
 *
 * ## 降级
 *
 * · API 27–30（无 RenderEffect）：`active` 内部强制 false，保持纯色；
 * · 录制抛错：标记 [KGlassScope.failed] → 永久纯色 + 一行日志；
 * · [KGlassRuntime]：全局开关 + 成本守卫，超预算自动退回纯色并打 WARN。
 */

/**
 * 顶栏玻璃的模糊半径。
 *
 * ⚠️ 这个值必须**连着色膜一起看**，两者是互补的：
 *
 * ```
 * 可见磨砂深度 ≈ 模糊半径 × (1 - 色膜alpha)
 * 沸腾可见度   ≈ 沸腾幅度(随半径增长) × (1 - 色膜alpha)
 * ```
 *
 * **沸腾**（真模糊每帧重算 + 内容每帧移动不到一像素 → 输出持续细微变化，滑得越慢越明显）
 * 之所以看得见，是因为背后的内容看得见。所以 2026-09-22 的最终策略是
 * **"先用色膜盖住背后内容，再把模糊放开加深"** —— 色膜一厚，沸腾被一起盖住，
 * 半径就不再受伪影限制了。
 *
 * 取值演进（**每一档都是真机试出来的**）：
 *  56dp/0.55 沸腾明显 → 20dp/0.55 遮不住 → 12dp/0.70 "有效果" → 20dp/0.70 "还有一点沸腾"
 *  → 16dp/0.70 → **32dp + 色膜 0.92**（当前：色膜盖住背后内容，模糊放开）
 */
val KGlassBlurRadius: Dp = 32.dp

/**
 * 毛玻璃的运行时总开关与成本守卫。
 *
 * 存在的理由：任何"每帧采样 + 模糊"的实现都要过 120Hz 的 8.33ms 帧预算，
 * 而这个 App 不模糊时基线就已经贴着 8ms。真机上若毛玻璃把高刷吃掉，必须能**立刻、无残留**地退回纯色。
 */
object KGlassRuntime {
    /**
     * 总开关。置 false = 全局退回纯色（零渲染成本）。
     *
     * ⚠️ **2026-09-22 定稿：默认 false（关闭）。**
     * 本机（OnePlus PGEM10 / Android 16 / API 36）上，本文件这条路**做不出真模糊**。
     * 逐项隔离诊断见 `docs/android-glass-plan.md` §12，核心是一条闭环：
     *
     *  · 规则 A：`RenderEffect` 只作用于图层**自己的绘制指令**，作用于不了**嵌套的图层引用**
     *    （洋红带实测：层内直接画 → 糊；把另一图层 `drawLayer` 进来 → 不糊）；
     *  · 规则 B：同一次绘制里 `drawContent()` **只能调一次**（第二次什么都画不出来）；
     *  · 于是：内容的绘制指令要么去屏幕（那模糊层里就空了 → 只有色膜），
     *    要么去模糊层（那屏幕就得画"图层引用" → 按规则 A 糊不了）。**两条路互斥。**
     *
     * 想再试时把这里改成 true，但先读 §12 —— 进程内这条路已经被排除，
     * 剩下能做真模糊的只有"系统悬浮窗口 `FLAG_BLUR_BEHIND`"（见 §12.5 第 2 条）。
     */
    var enabled by mutableStateOf(false)

    /**
     * 是否允许"成本超支自动退回纯色"。
     *
     * 默认开启，但触发条件刻意保守（见 [COST_LIMIT_NS] / [COST_STRIKES]），
     * 且触发时会打一行 WARN 日志 —— 不允许出现"悄悄不生效"的状态。
     */
    var autoDegrade: Boolean = true

    /** 源端录制 + 效果端重放的 UI 线程耗时上限（纳秒）。6ms ≈ 120Hz 预算的 72%。 */
    private const val COST_LIMIT_NS = 6_000_000L

    /** 连续超预算帧数达到它才降级（避免一次偶发尖峰就关掉效果）。 */
    private const val COST_STRIKES = 240

    /** 最近一次录制的 UI 线程耗时（纳秒）。**只含 CPU 侧**，不含 GPU。 */
    var lastCostNs by mutableLongStateOf(0L)
        private set

    private var strikes = 0

    internal fun reportRecordingCost(ns: Long) {
        lastCostNs = ns
        if (!autoDegrade || !enabled) return
        if (ns > COST_LIMIT_NS) {
            strikes++
            if (strikes >= COST_STRIKES) {
                enabled = false
                Log.w(
                    "KGlass",
                    "性能守卫触发：录制耗时连续 $strikes 帧超过 ${COST_LIMIT_NS / 1_000_000}ms" +
                        "（最近 ${ns / 1_000_000}ms），已全局退回纯色。",
                )
            }
        } else if (strikes > 0) {
            strikes--
        }
    }
}

/**
 * 一对 source/effect 共享的状态容器。一个页面（或整个 Shell）一个实例：
 * `rememberKGlass()` 之后，把内容挂 [kGlassSource]、把栏挂 [kGlassBar]。
 *
 * @param replayLayer 装"栏那一块绘制指令"的离屏层。由 [rememberKGlass] 创建并持有；
 *        它的释放由 Compose 的 GraphicsContext 托管，**不要手动 release**。
 */
@Stable
class KGlassScope internal constructor(
    internal val replayLayer: GraphicsLayer,
) {
    /** 内容区在 window 里的矩形。**只在落定后登记** —— 绘制期转场位移污染不了它。 */
    internal var contentBounds: Rect? by mutableStateOf(null)

    /** 栏（顶栏 / 胶囊）在 window 里的矩形，由栏自己登记。 */
    internal var barBounds: Rect? by mutableStateOf(null)

    /** 重放层的录制尺寸（px）。 */
    internal var replaySize: IntSize by mutableStateOf(IntSize.Zero)
        private set

    /**
     * 每完成一次录制 +1。**这是"真的录到内容了"的唯一凭据** ——
     * 尺寸只是 `record` 声明的，不代表里面真有绘制指令（v2 就栽在这）。
     */
    internal var revision by mutableIntStateOf(0)

    /** 录制失败过 → 本作用域永久退回纯色。 */
    internal var failed: Boolean by mutableStateOf(false)
        private set

    internal fun markRecorded(size: IntSize) {
        if (replaySize != size) replaySize = size
        revision++
    }

    internal fun markFailed(t: Throwable) {
        if (failed) return
        failed = true
        Log.w(
            "KGlass",
            "录制失败，本页毛玻璃退回纯色（子树里多半含 graphicsLayer / RenderEffect / shadow）：${t.message}",
            t,
        )
    }

    /** 录制区是否就绪 —— **唯一**允许把 scrim 拉成半透明的判据（P2）。 */
    internal val ready: Boolean
        get() = !failed && contentBounds != null && barBounds != null &&
            replaySize.width > 0 && replaySize.height > 0 && revision > 0

    /** 内容与栏是否相交。 */
    internal val overlapping: Boolean
        get() {
            val content = contentBounds ?: return false
            val bar = barBounds ?: return false
            val r = content.intersect(bar)
            return r.width > 1f && r.height > 1f
        }
}

/** 创建一个玻璃作用域（页面级 / Shell 级各一个，别跨页复用）。 */
@Composable
fun rememberKGlass(): KGlassScope {
    val layer = rememberGraphicsLayer()
    return remember(layer) { KGlassScope(layer) }
}

/**
 * 玻璃的开关（P3 带迟滞的 latch）。
 *
 * @param settled 页面转场是否已落定（`!isPageTransitioning()`）。
 * @param pageKey 换页标识。**key 变化即复位**：新页面重新走一遍判定。
 * @param contentUnderBar 内容**确实**滚到栏下面了（滚动偏移 > 0）。
 * @param atRestAtTop 内容**静止在正顶端**（偏移 == 0 且当前不在滚动中）。
 *
 * 状态机：
 * ```
 * 未落定                 → 关（纯色）
 * 内容没滚到栏下          → 关（纯色）  ← 短页面/首屏就是这个状态，不会出现"半透明无模糊"
 * 内容滚到栏下            → 开（模糊 + 半透明），latch 住
 * 滚动中经过顶端          → 保持开（迟滞，不闪）
 * 静止在正顶端            → 关（淡出回纯色）
 * ```
 */
@Composable
fun rememberGlassActive(
    glass: KGlassScope,
    settled: Boolean,
    pageKey: Any?,
    contentUnderBar: Boolean,
    atRestAtTop: Boolean,
): Boolean {
    var activated by remember(pageKey) { mutableStateOf(false) }
    val shouldActivate = settled && !glass.failed && glass.overlapping &&
        (contentUnderBar || (activated && !atRestAtTop))
    if (shouldActivate != activated) {
        // SideEffect：组合成功后再写，避免"组合期写状态"的反向写警告。
        // 晚一帧切换没有任何代价 —— 玻璃本来就走淡入淡出。
        SideEffect { activated = shouldActivate }
    }
    return activated
}

/**
 * 毛玻璃的**源**：挂到会被栏盖住的内容容器上（滚动列表本身或其外层）。
 *
 * 两条硬约束：
 *  1. 必须在 modifier 链上位于滚动容器的**左侧（外层）**；
 *  2. 挂载的节点**不能同时包含栏**（否则把栏自己录进去 → 自反馈），
 *    且**必须与栏是兄弟节点、且在栏之前绘制**。
 *
 * @param enabled 转场落定后为 true。false 期间不录制、不登记坐标
 *        （防绘制期转场位移污染坐标系）。
 */
fun Modifier.kGlassSource(
    glass: KGlassScope,
    enabled: Boolean = true,
): Modifier = composed {
    val blurPx = with(LocalDensity.current) { KGlassBlurRadius.toPx() }
    val blurEffect = remember(blurPx) { BlurEffect(blurPx, blurPx) }
    Modifier
        .onGloballyPositioned { if (enabled) glass.contentBounds = it.boundsInWindow() }
        .drawWithContent {
            // ① 内容照常上屏（清晰的这一份）
            drawContent()

            if (!KGlassRuntime.enabled || !enabled || glass.failed) return@drawWithContent
            val content = glass.contentBounds ?: return@drawWithContent
            val bar = glass.barBounds ?: return@drawWithContent

            val w = bar.width.roundToInt().coerceAtLeast(1)
            val h = bar.height.roundToInt().coerceAtLeast(1)
            val startedAt = System.nanoTime()
            try {
                // ② 把"栏那一块"录进重放层 —— 关键是**直接在这里调 drawContent()**，
                //    让层里装的是**绘制指令**。若改成 `drawLayer(某个源图层)`，
                //    层里就只有一个嵌套 RenderNode 引用，按 R1 **不会被模糊**（v3 的实测教训）。
                //
                //    这里用 `record {}`（Compose 官方捕获内容的方式）而不是手工换
                //    `drawContext.canvas` —— 后者录不到内容（v2 的实测教训）。
                glass.replayLayer.record(IntSize(w, h)) {
                    // 原点对齐：只有一次**恒定**的平移（源左上角 → 栏左上角），滚动期不变。
                    translate(
                        left = -(bar.left - content.left),
                        top = -(bar.top - content.top),
                    ) {
                        this@drawWithContent.drawContent()
                    }
                }
                // RenderEffect 挂在重放层自己身上：它只作用于这一层的绘制指令，
                // 本节点自己的内容（按钮/标题）从头到尾不进这一层。
                glass.replayLayer.renderEffect = blurEffect
                glass.markRecorded(IntSize(w, h))
            } catch (t: Throwable) {
                // 绝不因为毛玻璃而崩溃：标记失败 → 本作用域永久退回纯色
                glass.markFailed(t)
            } finally {
                KGlassRuntime.reportRecordingCost(System.nanoTime() - startedAt)
            }
        }
}

/**
 * 毛玻璃的**效果端**：挂到顶栏 / 导航胶囊上。
 *
 * 链上位置**保持不变** —— 必须在 `kTopBar()` 的左侧，玻璃矩形才含状态栏那一条。
 *
 * 绘制层次（从下到上）：源端录好的模糊层 → frosted scrim →
 * 本节点自己的内容（按钮/标题，保持清晰）。
 *
 * @param active 见 [rememberGlassActive]。只有 `active && ready` 才会真的把 scrim 拉成半透明。
 */
fun Modifier.kGlassBar(
    glass: KGlassScope,
    active: Boolean,
): Modifier = composed {
    val colors = KTheme.colors
    val animationsEnabled = LocalAnimationsEnabled.current
    // API 27–30 没有 RenderEffect：恒走纯色兜底（"半透明不模糊"的劣化态不能出现）
    val effectiveActive = active && Build.VERSION.SDK_INT >= 31 && KGlassRuntime.enabled

    // P2 就绪门控：**唯一**的降透明度依据。这一行就是"只有半透明、没有毛玻璃"的根治点。
    val ready = effectiveActive && glass.ready

    // 淡入淡出而不是硬切：ready 翻转的瞬间玻璃"长出来/收回去"，不闪。
    // 系统动画关掉时直接到位（snap），遵守项目的 LocalAnimationsEnabled 规矩。
    val glassAlpha by animateFloatAsState(
        targetValue = if (ready) 1f else 0f,
        animationSpec = if (animationsEnabled) KMotion.effects() else snap(),
        label = "glassAlpha",
    )

    Modifier
        .onGloballyPositioned { glass.barBounds = it.boundsInWindow() }
        .drawWithContent {
            val a = glassAlpha
            if (a > 0.01f) {
                glass.revision // 订阅源端录制（内容重录了就跟着重绘）
                glass.replayLayer.alpha = a
                // 层里已经是"栏那一块 + 已施加 RenderEffect"的绘制指令，直接画在栏的原点。
                drawLayer(glass.replayLayer)
            }
            // scrim **恒画**：a=0 时它就是 frostedSolid 不透明纯色兜底 ——
            // 这条栏唯一的背景来源就是这里，跳过它整条栏会全透明（真机踩过）。
            // 注意：接管了原来的 background，就必须在**所有**分支兜住背景。
            drawRect(lerp(colors.frostedSolid, colors.frosted, a))
            drawContent()
        }
}
