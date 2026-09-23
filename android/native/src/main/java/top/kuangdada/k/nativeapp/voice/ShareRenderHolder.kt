package top.kuangdada.k.nativeapp.voice

import android.content.Context
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import top.kuangdada.k.nativeapp.R
import top.kuangdada.k.nativeapp.ui.SHARE_FRAME_ASPECT
import top.kuangdada.k.nativeapp.ui.shareContentAspect

/**
 * ============================================================
 * 屏幕共享渲染器的**会话级持有者**（M6.17：全屏 = 独立宿主 + Surface 交接）
 * ============================================================
 * 这一版把"全屏"从"同一棵 Compose 树里 lerp 一个矩形"换成**直播类 App 的成熟做法**：
 * **全屏是另一个 Activity，画面靠"把那一个渲染器 View 交过去"实现**。
 * 于是整场共享里渲染器实例、GL 上下文、挂着的 sink、解出来的帧**只有一份**，
 * 进/退全屏不重建、不重新解码、不重新等首帧。
 *
 * 为什么非得让渲染器**活在组合树之外**：
 *  · 它是 `SurfaceViewRenderer`（`SurfaceView` 子类），Surface 由 SurfaceFlinger 按**窗口**摆位、
 *    在窗口 UI 层**下面**出图（"挖洞"）。而 Compose 的 `AndroidView` 把 View 的生死绑在组合上：
 *    页面一离开组合就 `onRelease` → `release()` + GL Surface 销毁，且 `onRelease` **没有取消的机会**
 *    （它没有返回值）。要跨宿主交接，就必须自己拿着它。
 *  · 交接的可行性不是推测，是 javap 核对 144.7559.15 AAR 得到的事实：
 *      - `SurfaceViewRenderer.surfaceDestroyed()` 是**空实现**；`SurfaceEglRenderer` 覆盖它并调
 *        `releaseEglSurface()`（把 EGL surface 置空、等渲染线程收尾），**不销毁解码链与 sink**；
 *      - 新窗口 `surfaceCreated` → `createEglSurface()` 重建 EGL surface 并 `makeCurrent()`。
 *    所以**交接后下一帧就继续画**（`createEglSurface` 只建 surface + makeCurrent，
 *    **没有重绘最后一帧**的动作 ⇒ 中间会空一帧，这是"交接后闪一下黑"的唯一来源，见 [attach]）。
 *
 * ⚠️ 三条不许碰的红线：
 *  1. **不许 `release()` / 重新 `init()`**：那正是"重新等首帧"的全部来源；
 *  2. **`addSink` 只挂一次**（tag 去重，见 [addSinkOnce]）——重复挂 WebRTC 会抛异常；
 *  3. **同一时刻只能有一个父容器**：`ViewGroup.addView` 对已有父的 View 直接抛
 *     `IllegalStateException`（不是"自动挪过去"）。所以挂载前一律先从旧父摘除。
 *
 * 访问线程：全部在主线程（Compose 组合、Activity 生命周期、点击回调都在主线程）。
 *
 * 附：本对象同时是**共享轨比例缓存的所有者**。比例必须活在组合之外 ——
 * 写入方是渲染器的解码线程回调，读取方是下一帧的组合；放进 `remember` 就变成"谁先谁后看运气"，
 * 重启组合（进/退全屏）会把它清掉，于是每次都要重演一次「16:9 → 真比例」，
 * 用户看到的就是**退出全屏时比例跳一下**。这一版它同时被房间页与全屏 Activity 读，
 * 两边看到的是同一个数，所以退全屏**不可能**再改比例。
 */
object ShareRenderHolder {

    /**
     * 日志 tag。**整场共享的"没有重建"证据全在这个 tag 下**：
     * `渲染器创建 #<hash>` 只应出现一次；进出全屏各一行，hash 必须相同。
     * `android/scripts/share-log.mjs` 也在抓它，别改名。
     */
    const val TAG = "KShareRender"

    /**
     * 渲染器槽位的**纯逻辑**状态：只管"当前该不该重建渲染器"。
     *
     * 抽出来是为了能脱机单测（真机验证之外还要有可回归的门禁）；
     * 判据只有一条：**换轨才换渲染器**。进/退全屏、页面滚动、盒子动画都不换轨
     * —— 所以"整场共享只创建一次渲染器"是这条 `if` 的直接推论。
     */
    class RendererSlot {
        var trackId: String? = null
            private set

        /** 绑定当前轨；返回 true 表示**必须重建渲染器**（换轨），false = 沿用同一个实例 */
        fun bind(trackId: String): Boolean {
            if (this.trackId == trackId) return false
            this.trackId = trackId
            return true
        }

        /** 换轨时先复位：渲染器还没建出来之前不能对外声称"已经绑在这条轨上" */
        fun reset() {
            trackId = null
        }
    }

    private val slot = RendererSlot()

    // ------------------------------------------------------------------
    // 状态（全部主线程访问）
    // ------------------------------------------------------------------

    /**
     * Application 上下文。渲染器**跨 Activity**，用 Activity 当 Context 会把它拽住
     * （`SurfaceView` 持有 Context 引用，而渲染器活得比任何一个 Activity 都久）。
     *
     * ⚠️ **必须由 `KApp.onCreate` 装配**（[install]），不能靠"房间页组合时顺手装一下"：
     * 组合里 `bindTrack` 在页面函数体、`ShareRenderView` 在更深的位置 ——
     * 谁先谁后由调用点决定，一旦 [newRenderer] 早于 install 跑，`lateinit` 直接抛
     * `UninitializedPropertyAccessException`，真机表现就是**一进房就闪退**
     * （本机实测崩在 `ShareRenderHolder`，日志只有一行 `lateinit property appContext has not been initialized`）。
     */
    private var appContext: Context? = null

    private var renderer: org.webrtc.SurfaceViewRenderer? = null

    /** 当前共享轨（换轨时旧渲染器连同它的 sink 一起丢） */
    private var currentTrack: org.webrtc.VideoTrack? = null

    /** 会话给的 EGL 上下文（房间页在 [bindTrack] 时同步进来，持有者不反向依赖控制器） */
    private var sessionEglContext: org.webrtc.EglBase.Context? = null

    /** 会话没给出 EGL 上下文时兜底自建的那个（自己的生命周期自己收，见 [release]） */
    private var fallbackEgl: org.webrtc.EglBase? = null

    /** 渲染器当前所属的容器（null = 现在没人持有它，房间内联槽位/全屏宿主都可以来取） */
    private var attachedTo: ViewGroup? = null

    /**
     * 四个比例来源里的两个（另外两个按轨存在 [decodedAspect] 里，兜底在 [shareContentAspect]）：
     * **共享者声明的采集尺寸**（最高优先，进房/开始共享那一刻就已知）与**会话接收探针**。
     */
    private var declaredSize: Pair<Int, Int>? = null
    private var probedAspect: Float = 0f

    /**
     * 渲染器量到的解码比例，**按轨 id 存**，活在组合之外。
     *
     * 按轨 id 而不是"一个全局值"：换人共享必然换轨，旧比例留着会让新画面先按旧比例摆一下。
     * `VideoTrack.id()` 是原生指针，换轨即换 id。
     */
    private val decodedAspect = mutableMapOf<String, Float>()

    /** 当前生效的画面比例（见 [aspect]） */
    private var aspectState by mutableStateOf(SHARE_FRAME_ASPECT)

    /**
     * 首帧计数（渲染器每出一次首帧 +1）。房间里用它把"（等待画面…）"去掉 ——
     * 用**计数器**而不是布尔：换轨（换人共享）后要能重新变成"等待画面"。
     */
    var firstFrameTick by mutableIntStateOf(0)
        private set

    /**
     * "共享已结束，全屏宿主请退场"的回调。
     *
     * 全屏 Activity 在 `onResume` 里登记、`onPause` 里清掉 —— 于是它**只在自己活着时**被调用，
     * 不存在"拿一个已经销毁的 Activity 去 finish"的问题。
     */
    @Volatile
    var onCloseRequest: ((String) -> Unit)? = null

    /** 当前**生效**的画面比例。房间页内联槽位与全屏 Activity 都读它 ——
     *  于是"进/退全屏"这条路上比例来源完全一致，不存在某一侧自己回落到 16:9 的机会。 */
    val aspect: Float get() = aspectState

    /** 现在是不是有人持有渲染器（房间内联槽位 / 全屏宿主）—— 房间用它判断"要不要接回来" */
    val isAttached: Boolean get() = attachedTo != null

    /**
     * 渲染器的 identityHashCode（0 = 还没有渲染器）。
     *
     * 只用于日志：**同一个值贯穿整场共享**就是"没有重建渲染器"的硬证据，
     * 与 [newRenderer] 里那行"渲染器创建 #…"配合看 —— 整场共享只应出现一次"创建"。
     */
    fun rendererHash(): Int = renderer?.let { System.identityHashCode(it) } ?: 0

    /**
     * 请全屏宿主退场（共享结束 / 换人共享 / 离开房间）。
     *
     * 由**房间侧**调用而不是宿主自己订阅状态：宿主是纯 View 的 Activity，拿不到控制器；
     * 而房间页在全屏期间一直活着（宿主只是压在它上面），状态一定在那里先变。
     * 没有宿主在听时是一次空操作（房间里没进过全屏就是这条路径）。
     */
    fun requestClose(reason: String) {
        onCloseRequest?.invoke(reason)
    }

    // ------------------------------------------------------------------
    // 进程级装配
    // ------------------------------------------------------------------

    /**
     * 登记 Application 上下文。**由 `KApp.onCreate` 调用**（见 [appContext] 的说明：
     * 放进组合里就会变成"谁先谁后看运气"，早一步就是进房闪退）。
     */
    fun install(context: Context) {
        appContext = context.applicationContext
    }

    // ------------------------------------------------------------------
    // 轨与比例
    // ------------------------------------------------------------------

    /**
     * 绑定当前共享轨，并更新四个比例来源中的两个（声明尺寸、会话探针）。
     *
     * 由房间页在组合里调用（state 一变就走一遍）：
     *  · 换轨 → 先 [RendererSlot.reset]、丢旧渲染器、再建新的（旧 sink 绑的是旧轨，不丢就是"新共享画不出来"）；
     *  · 同轨 → 只更新比例输入并重算 [aspectState]，
     *    此时若渲染器正挂在**全屏宿主**上，这里什么都不会动它 —— 这正是"全屏期间房间侧的重组不影响画面"。
     *
     * @param eglContext 会话当前的 EGL 上下文（null → 兜底自建一个，见 [acquireEgl]）
     */
    fun bindTrack(
        track: org.webrtc.VideoTrack,
        declared: Pair<Int, Int>?,
        probed: Float,
        eglContext: org.webrtc.EglBase.Context?,
    ) {
        declaredSize = declared
        probedAspect = probed
        sessionEglContext = eglContext
        if (currentTrack === track) {
            refreshAspect(track.id())
            return
        }
        // 换轨：旧渲染器的 sink 绑在旧轨上，留着也画不出新画面
        currentTrack = track
        slot.reset()
        releaseRenderer()
        acquireEgl(eglContext)
        ensureRenderer()
    }

    /** 解码线程量到的画面比例（渲染器的 `onFrameResolutionChanged` 回调，见 [newRenderer]） */
    private fun onDecodedAspect(trackId: String, w: Int, h: Int) {
        val next = w.toFloat() / h
        val known = decodedAspect[trackId]
        /*
         * **5% 迟滞**：编码器按 2 的幂降采样时比例不变（640x400 与 1920x1200 都是 1.600），
         * 这种"分辨率在爬、比例没变"的情况**不许动布局**；真换了形态（16:10 → 16:9 是 11%）才跟随。
         * 只在判定要动时写 State —— 否则每次分辨率变化都会让两个宿主各重新摆位一次。
         */
        if (known == null || kotlin.math.abs(next - known) / known > 0.05f) {
            decodedAspect[trackId] = next
            Log.i(
                TAG,
                "画面比例更新：${known?.let { "%.3f".format(it) } ?: "首次"} → " +
                    "${"%.3f".format(next)}（$w x $h）",
            )
            refreshAspect(trackId)
        }
    }

    /** 重算并发布当前比例（四个来源 → 一个值，规则见 [shareContentAspect]） */
    private fun refreshAspect(trackId: String) {
        val next = shareContentAspect(declaredSize, decodedAspect[trackId], probedAspect)
        if (next != aspectState) aspectState = next
    }

    // ------------------------------------------------------------------
    // 挂载 / 摘除（"交接"就发生在这两个方法之间）
    // ------------------------------------------------------------------

    /**
     * 把渲染器挂到 [container]（房间内联槽位 / 全屏宿主的容器）。
     *
     * 三条必须做对的事，顺序都不能换：
     *  1. **先从旧父摘除**：`addView` 对已有父的 View 抛异常，且**交接的定义就是"先摘、再挂"**
     *     —— 中间渲染器没有父，不存在两个窗口同时持它。
     *  2. **用 `MATCH_PARENT` 的 `FrameLayout.LayoutParams` 挂**：`SurfaceViewRenderer.onMeasure`
     *     按 View 的**自身尺寸**推画面比例（`setLayoutAspectRatio` 在 `onLayout` 里由宽高算），
     *     所以渲染器必须铺满调用方已经算好的"内容比例框"。调用方按"比例框居中 + 纯黑底"摆它，
     *     黑边就由**容器自己的底色**提供 —— 这也是"多余部分纯黑"唯一安全的画法：
     *     不透明底色只允许画在渲染层**内部**，画在它上面会盖住 Surface 挖的洞（M6.16 真机事故）。
     *  3. **挂完 `requestLayout()`**：容器可能早就布局过了，`addView` 不保证再跑一次 layout
     *     （`onMeasure` 不跑 → `setLayoutAspectRatio` 不更新 → 画面按旧比例出图）。
     *
     * ⚠️ 交接后画面**会继续，但中间空一帧**：`EglRenderer.createEglSurface` 只建 surface +
     * `makeCurrent()`，**没有"重绘最后一帧"的动作**，新 surface 的第一张图要等解码线程推下一帧
     * （共享流 15~30fps ⇒ 33~66ms）。这是 WebRTC 自带渲染器的固有行为，不是这里漏了什么；
     * 换来的是**不重建、不重新解码**。
     */
    fun attach(container: ViewGroup) {
        val view = ensureRenderer() ?: return
        if (attachedTo === container && view.parent === container) return

        (view.parent as? ViewGroup)?.let { old ->
            old.removeView(view)
            if (attachedTo === old) attachedTo = null
        }

        val params = FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT,
        )
        params.gravity = Gravity.CENTER
        container.addView(view, params)
        attachedTo = container
        container.requestLayout()
    }

    /**
     * 从**当前**容器摘除渲染器，但**不销毁它**（"交接"的另一半）。
     *
     * 摘除会走 `SurfaceView.onDetachedFromWindow` → Surface 销毁 → `surfaceDestroyed`
     * → `releaseEglSurface()`。**这是交接必须付的代价**：Surface 属于窗口，跨窗口只能换一张。
     * 渲染器实例、EGL 上下文、sink、解码链都不动（javap 已核对，见类注释）。
     */
    fun detach() {
        val view = renderer ?: return
        (view.parent as? ViewGroup)?.removeView(view)
        attachedTo = null
    }

    /** 释放整场共享（离开房间时调用）。之后 [bindTrack] 会重新建一个 —— 那是**新的一场共享**。 */
    fun release() {
        releaseRenderer()
        currentTrack = null
        slot.reset()
        declaredSize = null
        probedAspect = 0f
        decodedAspect.clear()
        aspectState = SHARE_FRAME_ASPECT
    }

    // ------------------------------------------------------------------
    // 渲染器本体
    // ------------------------------------------------------------------

    private fun releaseRenderer() {
        detach()
        renderer = null
        // 兜底 EglBase 是"这个渲染器专用的"，随渲染器一起收；
        // 会话给的那个由 VoiceSession 管，**绝不能在这里 release**
        if (fallbackEgl != null) {
            runCatching { fallbackEgl?.release() }
            fallbackEgl = null
        }
    }

    private fun acquireEgl(context: org.webrtc.EglBase.Context?) {
        if (context != null) return
        fallbackEgl = org.webrtc.EglBase.create()
    }

    private fun ensureRenderer(): org.webrtc.SurfaceViewRenderer? {
        renderer?.let { return it }
        val track = currentTrack ?: return null
        val glContext = fallbackEgl?.eglBaseContext ?: sessionEglContext
        if (glContext == null) {
            Log.w(TAG, "还没有可用的 EGL 上下文，稍后再绑（不建渲染器，避免多占一个 GL 上下文）")
            return null
        }
        return newRenderer(glContext, track).also {
            renderer = it
            slot.bind(track.id())
        }
    }

    /**
     * 建渲染器。**整场共享只应出现一次这一行日志**（验收看的就是它）。
     *
     * 四条硬约束（全是 javap 核对 144 版 AAR 得到的事实，错一条都**静默**变成黑屏/变形）：
     *  1. **复用会话的 EGL 上下文**：每个 `EglBase` 都是独立 GL 上下文 + 线程，反复开关共享会堆积；
     *  2. **`init()` 是异步的**（内部建 GL 线程/Surface）→ `setScalingType` 要在它之后设，
     *     并在每次分辨率变化时重设（早调用可能被覆盖）；
     *  3. **关掉硬件缩放器**：开着时渲染器按**视频分辨率**建 Surface、再让硬件拉满整个 View，
     *     这条路径**绕开 FIT 的 letterbox**，比例差一点就是硬拉伸/裁切；
     *  4. **同一个 renderer 不能重复 addSink 同一路轨**（WebRTC 抛异常）→ tag 去重。
     */
    private fun newRenderer(
        glContext: org.webrtc.EglBase.Context,
        track: org.webrtc.VideoTrack,
    ): org.webrtc.SurfaceViewRenderer {
        val trackId = track.id()
        // 装配缺失时**不留一条会崩的路**：这一场共享只是没画面（房间其余功能照常），
        // 日志里把原因说清；正常路径（KApp.onCreate 装了）永远走不到这里
        val context = appContext ?: android.app.Application()
        if (appContext == null) {
            Log.e(TAG, "缺少 Application 上下文（KApp.onCreate 未调用 install），渲染器退化为无主题上下文")
        }
        return org.webrtc.SurfaceViewRenderer(context).apply {
            // 第一条证据：整场共享只应出现一次
            Log.i(TAG, "渲染器创建 #${System.identityHashCode(this)}")
            init(
                glContext,
                object : org.webrtc.RendererCommon.RendererEvents {
                    override fun onFirstFrameRendered() {
                        Log.i(TAG, "远端共享首帧已渲染")
                        ShareFlow.firstFrame()
                        firstFrameTick++
                    }

                    override fun onFrameResolutionChanged(w: Int, h: Int, rotation: Int) {
                        // 这一行是"糊/比例不对"的判据：**解码出来的真实分辨率**
                        Log.i(TAG, "远端共享画面 ${w}x$h rotation=$rotation")
                        ShareFlow.resolution(w, h)
                        if (w > 0 && h > 0) onDecodedAspect(trackId, w, h)
                        // 分辨率一变，比例也可能变 → 重设一次渲染策略（见上面第 2 条）
                        runCatching { setScalingType(FIT, FIT) }
                    }
                },
            )
            setEnableHardwareScaler(false)
            setScalingType(FIT, FIT)
            // sink **只挂一次**，且不随宿主变化重挂：挂载/摘除走的是 ViewGroup，不碰 sink
            addSinkOnce(track)
            ShareFlow.sinkAttached()
        }
    }
}

/** FIT：画面完整显示、留黑边（**不用 FILL** —— 它会裁掉溢出的部分） */
private val FIT = org.webrtc.RendererCommon.ScalingType.SCALE_ASPECT_FIT

/**
 * 每个 renderer 只对同一路轨 addSink 一次（WebRTC 对重复 addSink 会抛异常）。
 *
 * tag 用 `R.id.k_share_sink_tag`（`res/values/ids.xml` 里唯一一处定义）。
 * 交接（摘了再挂）不走这里，所以**整场共享的 addSink 仍然只有一次**。
 */
private fun org.webrtc.SurfaceViewRenderer.addSinkOnce(track: org.webrtc.VideoTrack) {
    if (getTag(R.id.k_share_sink_tag) == track) return
    runCatching { track.removeSink(this) }
    track.addSink(this)
    setTag(R.id.k_share_sink_tag, track)
}
