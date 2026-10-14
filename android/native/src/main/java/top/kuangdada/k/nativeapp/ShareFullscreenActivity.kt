package top.kuangdada.k.nativeapp

import android.os.Bundle
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.snapshotFlow
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch
import top.kuangdada.k.nativeapp.ui.shareFullscreenBox
import top.kuangdada.k.nativeapp.voice.ShareRenderHolder

/**
 * ============================================================
 * 屏幕共享**全屏宿主**（M6.17：全屏 = 独立 Activity + Surface 交接；M6.18：小窗也归它）
 * ============================================================
 * 直播类 App 的标准做法：全屏不是"在同一棵视图树里把画面放大"，而是**换一个宿主窗口**，
 * 把**同一个播放器**交给它（等价于 ExoPlayer 的 `player.setVideoSurfaceView(...)`）。
 * 于是整场共享里渲染器实例、GL 上下文、sink、解码链只有一份 ⇒
 * 进全屏不黑屏、不重新解码、不重新等首帧；退出全屏同理。
 *
 * 本类**只做宿主**，四件事：
 *  1. 一个纯黑底 + 画面比例框的窗口（黑边 = 窗口底色，见 layout 的层级说明）；
 *  2. 从 [top.kuangdada.k.nativeapp.voice.ShareRenderHolder] 取渲染器**挂进来**、退场时**交回去**
 *     —— 全程不 `release()`、不重新 `init()`、不重挂 sink；
 *  3. 沉浸（收状态栏/导航栏）+ 屏幕常亮；
 *  4. 手势：**单击提示、双击退出**（按用户要求没有 × 图标，所以提示是必须的，
 *     否则第一次用的人会觉得"退不出去了"）。
 *
 * ## M6.18 · 小窗（画中画）由**本宿主自己**进入
 *
 * 房间页的「小窗观看」只负责带上 [EXTRA_ENTER_PIP] 把宿主打开；真正的
 * `enterPictureInPictureMode` 在这里做（[requestEnterPip]）。三个理由：
 *  1. 系统要求**调用者必须是前台且 resumed 的 Activity** —— 在房间页对 MainActivity
 *     调用时，前台已经/即将是这个宿主，调用必然失败（旧版就是这么"点了没反应"的）；
 *  2. 小窗里显示的是"**调用者 Activity 当前的样子**"—— 即便让 MainActivity 侥幸进了小窗，
 *     显示的也是可滚动的一整页房间（画面已经交接走了），根本不是共享画面；
 *  3. 系统小窗的内容 = 本窗口的像素，而本窗口本来就"只有画面"（黑底 + 比例框 + 渲染器），
 *     于是天然满足 Web 端小窗的同款约定：**小窗里不放任何提示文案**（[onPictureInPictureModeChanged]）。
 *
 * ⚠️ 进 PiP 会触发 `onPause`：这里**不能**按普通退场去 detach 画面（小窗立刻黑），
 * 判据与全部生命周期决策都在 [SharePipFlow]（纯逻辑 + 单测）。
 *
 * ⚠️ 为什么退出全屏（普通路径）**必须同步摘除**（[onPause] 里就摘，不能等 onStop/onDestroy）：
 * Activity 的 `onPause` 一定早于房间页的 `onResume`，而房间页会在 `onResume` 里把渲染器接回去。
 * 挂晚了（或让两个宿主同时持有）就是"退全屏后内联槽位一直空着"或直接抛
 * `IllegalStateException: The specified child already has a parent`。
 *
 * ⚠️ 画面交接后会**空一帧**：WebRTC 的 `EglRenderer.createEglSurface` 只建 surface + `makeCurrent()`，
 * 没有"重绘最后一帧"的动作，新窗口的第一张图要等解码线程推下一帧（共享流 15~30fps ⇒ 33~66ms）。
 * 这是自带渲染器的固有行为（javap 核对 144 版 AAR），换来的收益是**不重建、不等待首帧**。
 */
class ShareFullscreenActivity : ComponentActivity() {

    private lateinit var root: ViewGroup
    private lateinit var box: ViewGroup
    private lateinit var hint: View

    /** 上一次 ACTION_DOWN 的时间戳（双击判定；与房间内页的"点两下"是同一语义） */
    private var lastDownAt = 0L

    /** 提示的隐藏任务（单击时重排；避免连续单击留下一堆待执行的隐藏） */
    private val hideHint = Runnable { hint.visibility = View.GONE }

    /**
     * 共享者名字（`EXTRA_SHARER`）。只用在下面那行日志与提示里 ——
     * 但它不是装饰：出问题时"是谁的共享"是定位的第一步（换个房间/换个人共享，
     * 渲染器就该换一次，日志里靠这个名字对得上）。
     */
    private var sharer: String = "有人"

    /**
     * 小窗（画中画）流程状态机 —— onPause 该不该交画面、onStop 该不该收尾，全部问它。
     * 判据与理由（四条生命周期路径）见 [SharePipFlow] 的类注释与单测。
     */
    private val pipFlow = SharePipFlow()

    /**
     * 本次启动是否要在画面接好后**直接进小窗**（房间页「小窗观看」带 `EXTRA_ENTER_PIP`）。
     *
     * 只消费一次（在 [onResume] 消费）：此刻 Activity 已可见，
     * `enterPictureInPictureMode` 才有成功的前提 —— 部分版本对"尚未就绪"的调用直接返回 false。
     */
    private var enterPipOnStart = false

    override fun onCreate(savedInstanceState: Bundle?) {
        // 与 MainActivity 同一套：edge-to-edge，状态栏/导航栏交给下面 hideSystemBars()
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_share_fullscreen)

        root = findViewById(R.id.k_share_fullscreen_root)
        box = findViewById(R.id.k_share_fullscreen_box)
        hint = findViewById(R.id.k_share_fullscreen_hint)
        sharer = intent.getStringExtra(EXTRA_SHARER)?.takeIf { it.isNotBlank() } ?: "有人"
        enterPipOnStart = intent.getBooleanExtra(EXTRA_ENTER_PIP, false)
        // 提示文案由这里定稿：布局里那条只有形状与颜色，文字要带上共享者名字
        (hint as android.widget.TextView).text =
            getString(R.string.k_share_fullscreen_hint, sharer)

        android.util.Log.i(
            ShareRenderHolder.TAG,
            "全屏宿主进入：共享者=$sharer 小窗=$enterPipOnStart 渲染器=#${ShareRenderHolder.rendererHash()}",
        )
        // 全屏看共享期间不许息屏（与房间内页的 KeepScreenOn 同一套：系统按"有内容要看"处理，
        // 界面不可见时自动失效，不存在忘记释放 WakeLock 的问题）
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        // 进出全屏做淡入淡出：进场那一帧画面正在交接（见类注释的"空一帧"），硬切会更明显
        @Suppress("DEPRECATION")
        window.setWindowAnimations(R.style.KShareFullscreenWindowAnimation)

        root.setOnTouchListener { _, event -> onRootTouch(event) }
        // 布局跑完才知道可用空间（含是否要避让系统栏）→ 这时才能按画面比例摆画面框
        root.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> applyAspect() }

        /*
         * 画面比例跟随 + 换渲染器后的重新挂载（M6.18 起收集区间 = STARTED）。
         *
         * 为什么不再写在 onResume 里：进/出小窗、按 Home 回来都会反复 onResume，
         * 每来一次就多一个常驻 collector（lifecycleScope 的生命周期是**整个 Activity**）。
         * 限定在 STARTED 区间语义还更对：**PiP 期间 Activity 是 paused 但 started** ——
         * 小窗里画面比例变化、换人共享换了渲染器，这里都还能跟上。
         */
        lifecycleScope.launch {
            lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
                launch {
                    // 画面比例在观看过程中可能真的变（换人共享 / 共享方换了采集形态）→ 重新摆一次画面框
                    snapshotFlow { ShareRenderHolder.aspect }
                        .distinctUntilChanged()
                        .collect { applyAspect() }
                }
                launch {
                    // 换轨 = 换渲染器（旧渲染器连同 sink 已被持有者丢下）。本宿主没有
                    // "组合重组"这条线来感知它 —— 这个代号是唯一信号，变化就重新挂载。
                    // drop(1)：初次/回前台时 snapshotFlow 会先发射当前值，彼时 onResume
                    // 已完成挂载（attach 幂等，这里只是省一次无意义调用）。
                    snapshotFlow { ShareRenderHolder.rendererGeneration }
                        .drop(1)
                        .collect { ShareRenderHolder.attach(box) }
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        hideSystemBars()
        // 接画面。**attach 内部保证同一个渲染器不会有两个父**，所以这里不必先 detach
        ShareRenderHolder.attach(box)
        applyAspect()
        // 共享结束/换人共享 → 由房间侧通知退场。回调在小窗期间**保持登记**（onPause 不清它），
        // 房内共享结束能把小窗里的宿主也撤下来；真正的清理由是 onStop / 普通退场（见下方）
        ShareRenderHolder.onCloseRequest = { reason -> finishShareHost(reason) }

        /*
         * 回到前台（首次进入 / 从后台回来 / **从小窗展开**）都走这里：退出 PiP 流程 ——
         * 展开回来后用户再双击退出，必须回到"onPause 交画面"的普通路径（理由见 SharePipFlow）。
         */
        if (pipFlow.onResumed()) {
            android.util.Log.i(
                ShareRenderHolder.TAG,
                "小窗展开：回到全屏宿主 渲染器=#${ShareRenderHolder.rendererHash()}",
            )
        }

        /*
         * 「小窗观看」：等这一帧的布局/挂载就绪后再进小窗。
         *
         * 不在 onResume 里直接调 `enterPictureInPictureMode`：它要求 Activity 已"完全就绪"
         * （窗口可见、有尺寸），部分版本对同帧调用会判"尚未就绪"而失败；post 到下一帧
         * 给布局与画面挂载留出余地（也是官方示例的调用形态：用户动作 → 下一帧进入）。
         */
        if (enterPipOnStart) {
            enterPipOnStart = false
            root.post { requestEnterPip() }
        }
    }

    override fun onPause() {
        /*
         * 普通退场：**先交回画面再走**（顺序理由见类注释）。用户自己返回时也走这里。
         *
         * 例外 —— 进小窗：小窗显示的就是这个窗口的像素，画面与退场通知都要**留着**
         * （判据与完整理由见 [SharePipFlow]：就是"点了小窗结果黑窗"这个坑）。
         */
        if (pipFlow.shouldDetachOnPause()) {
            ShareRenderHolder.onCloseRequest = null
            ShareRenderHolder.detach()
        }
        super.onPause()
    }

    override fun onStart() {
        super.onStart()
        /*
         * 声明"宿主活着"（见 ShareRenderHolder.hostAlive 的长注释）：房间页据此**不把画面
         * 接回内联槽位** —— **PiP 会让 MainActivity 在宿主下面 resume**（小窗是悬浮的，
         * 底下的任务回前台），没有这个标记，房间页会把这次 resume 误读成"宿主退了"，
         * 然后把渲染器从小窗里抢回去（真机症状：小窗黑、房间页槽位却在播）。
         */
        ShareRenderHolder.hostAlive = true
    }

    override fun onStop() {
        // **先声明"宿主走了"再做收尾**：房间页从这一刻起可以接回画面。
        // 注意 PiP 期间系统**不回调 onStop**（宿主是 paused 但 started），所以这行只会在
        // 真退场（finish / 按 Home 离开 / 小窗被关）时执行。
        ShareRenderHolder.hostAlive = false
        super.onStop()
        /*
         * 走到这里且仍在 PiP 流程里 = **用户把小窗关了**（X / 拖到边缘收起；展开会先 onResume，
         * PiP 持续期间系统也不回调 onStop）。系统不保证替我们 finish 宿主，所以统一收尾：
         * 交回画面 + 结束自己。
         *
         * 不收尾的后果（真机可见）：小窗关了，压在下边的全屏宿主还留在后台 ——
         * 用户回到 App 看到的是一块黑的全屏页，而房间页的槽位是空的。
         */
        if (pipFlow.shouldCleanupOnStop()) {
            android.util.Log.i(
                ShareRenderHolder.TAG,
                "小窗关闭：交回画面并结束宿主 渲染器=#${ShareRenderHolder.rendererHash()}",
            )
            ShareRenderHolder.onCloseRequest = null
            ShareRenderHolder.detach()
            if (!isFinishing) finish()
        }
    }

    /**
     * 进出小窗的瞬时回调（进入 = true；展开或关闭 = false）。
     *
     * 进入：隐藏「双击退出」提示 —— 小窗里显示的是**这个窗口的像素**，提示文案会直接
     * 盖在共享画面上（与 Web 端小窗层的同款约定："小窗里不放任何提示文案"）。
     * 退出：这里不区分"展开 / 关闭"（那是 [SharePipFlow] 的职责），只把画面框按窗口新尺寸重摆一次。
     */
    override fun onPictureInPictureModeChanged(
        isInPictureInPictureMode: Boolean,
        newConfig: android.content.res.Configuration,
    ) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        if (isInPictureInPictureMode) {
            pipFlow.onEnteredPip()
            hint.visibility = View.GONE
            hint.removeCallbacks(hideHint)
        }
        applyAspect()
    }

    /** 旋转 / 尺寸变化：清单里配了 `configChanges`，Activity 不重建，只需重摆画面框 */
    override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
        super.onConfigurationChanged(newConfig)
        applyAspect()
    }

    /**
     * 进小窗（画中画）。由 [onResume] 消费「小窗观看」的请求后调用（见 [EXTRA_ENTER_PIP]）。
     *
     * 系统层面的三件事（与旧版房间页里那段半成品同清单，执行者换成宿主自己）：
     *  1. `supportsPictureInPicture="true"` 必须在**本 Activity** 的清单条目上开
     *     （PiP 是逐 Activity 声明的能力；漏了 `enterPictureInPictureMode` 会**静默返回 false**，
     *     不崩溃、不报错 —— 表现就是"点了没反应"）；
     *  2. 比例取共享画面的真实比例（[ShareRenderHolder.aspect]，与内联槽位/全屏同一个值），
     *     否则竖屏共享在小窗里会留大片黑边；并夹到系统接受的范围（见下方常量）；
     *  3. 失败给一句人话（部分设备/系统设置禁用了 PiP），而不是点了没反应。
     *
     * 失败**不 finish**：画面已经全屏在播，留在全屏比退回房间页更接近用户点的东西
     * （用户想看的是共享画面，只是小窗没成）。
     */
    private fun requestEnterPip() {
        if (pipFlow.inPipFlow || isInPictureInPictureMode) return
        val aspect = ShareRenderHolder.aspect.takeIf { it.isFinite() && it > 0.05f } ?: DEFAULT_ASPECT
        // 系统对 PiP 窗口宽高比有范围限制（约 0.42~2.38），超出的极端比例会被拒绝或裁切 ——
        // 先在调用前收敛，行为在文档范围内的设备上才可预期
        val clamped = aspect.coerceIn(PIP_MIN_ASPECT, PIP_MAX_ASPECT)
        val entered = runCatching {
            val params = android.app.PictureInPictureParams.Builder()
                .setAspectRatio(android.util.Rational((clamped * 1000).toInt(), 1000))
                .build()
            enterPictureInPictureMode(params)
        }.getOrDefault(false)
        // ⚠️ 登记必须在调用返回后**立刻**做：紧随的 onPause 要据此保留画面（见 SharePipFlow）。
        // 不能等 onPictureInPictureModeChanged —— 它的时序在部分 ROM 上不稳定。
        pipFlow.onEnterRequested(entered)
        if (!entered) {
            android.widget.Toast.makeText(
                this,
                R.string.k_share_pip_unavailable,
                android.widget.Toast.LENGTH_SHORT,
            ).show()
        }
    }

    private fun finishShareHost(reason: String) {
        android.util.Log.i(
            ShareRenderHolder.TAG,
            "全屏宿主退场（$reason）渲染器=#${ShareRenderHolder.rendererHash()}",
        )
        finish()
    }

    /**
     * 沉浸：收起状态栏与导航栏。
     *
     * 用 `BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE`（与房间内页的 `ImmersiveSystemBars` 同一档）：
     * 边缘上滑能临时唤出系统栏，不会出现"进去了就再也看不到时间/电量"。
     * 这套是**窗口级**的（不用 Compose），因为全屏宿主是纯 View 的 Activity，没有组合。
     */
    private fun hideSystemBars() {
        val controller = WindowCompat.getInsetsController(window, root)
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        controller.hide(WindowInsetsCompat.Type.systemBars())
    }

    /**
     * 画面框 = 按画面比例 letterbox 居中，多出来的部分是 root 的纯黑底色。
     *
     * 为什么必须真的改**布局尺寸**而不是缩放/裁切：`SurfaceViewRenderer` 按 **View 自身尺寸**
     * 推画面比例（`setLayoutAspectRatio` 在 `onLayout` 里由宽高算出来，javap 已核对 144 版 AAR），
     * 所以"框的比例 == 画面的比例"这件事只能靠布局尺寸表达。
     *
     * 比例取自 [top.kuangdada.k.nativeapp.voice.ShareRenderHolder.aspect] ——
     * **与房间内联槽位同一个值**，所以退出全屏时比例不可能变（这正是用户报的"退全屏跳一下"的修法）。
     * 小窗里同样走这条：PiP 窗口比例与画面一致时画面框铺满整个小窗（与 Web 端小窗同观感）。
     */
    private fun applyAspect() {
        val availableWidth = root.width
        val availableHeight = root.height
        if (availableWidth <= 0 || availableHeight <= 0) return
        val geometry = shareFullscreenBox(
            availableWidthPx = availableWidth,
            availableHeightPx = availableHeight,
            aspect = top.kuangdada.k.nativeapp.voice.ShareRenderHolder.aspect,
        )
        val params = box.layoutParams as ViewGroup.LayoutParams
        if (params.width == geometry.widthPx && params.height == geometry.heightPx) return
        params.width = geometry.widthPx
        params.height = geometry.heightPx
        box.layoutParams = params
        android.util.Log.i(
            ShareRenderHolder.TAG,
            "全屏宿主：可用 ${availableWidth}x$availableHeight → 画面框 ${geometry.widthPx}x${geometry.heightPx} " +
                "比例=${"%.3f".format(geometry.aspect)} 渲染器=#${ShareRenderHolder.rendererHash()}",
        )
    }

    /**
     * 单击 = 亮一下「双击退出全屏」；双击 = 退出。
     *
     * 手写而不是上 `GestureDetector`：只需要 DOWN 的时间戳差一个判据
     * （与系统双击超时 `ViewConfiguration.getDoubleTapTimeout()` 对齐），
     * 引一个 detector 反而要处理长按/滚动一堆用不上的分支。
     */
    private fun onRootTouch(event: MotionEvent): Boolean {
        // 小窗里不响应手势：PiP 窗口有自己的点击语义（单击唤出"展开/关闭"、双击放大），
        // 我们的"单击提示 / 双击退出"在小窗里只会制造不可预期的状态（提示也看不见了）
        if (isInPictureInPictureMode) return true
        if (event.action != MotionEvent.ACTION_DOWN) return true
        val now = event.eventTime
        if (now - lastDownAt <= ViewConfiguration.getDoubleTapTimeout()) {
            lastDownAt = 0L
            finish()
        } else {
            lastDownAt = now
            hint.visibility = View.VISIBLE
            hint.removeCallbacks(hideHint)
            hint.postDelayed(hideHint, HINT_VISIBLE_MS)
        }
        return true
    }

    companion object {
        /** 提示亮着的时长：与房间内页那条提示一致（2.5s），低于它会被读成"闪了一下" */
        private const val HINT_VISIBLE_MS = 2_500L

        /** 画面还没量到尺寸时的比例兜底（与房间页/全屏共用 16:9 的缺省口径） */
        private const val DEFAULT_ASPECT = 16f / 9f

        /** 系统对 PiP 窗口宽高比的可接受范围（超出会被拒绝或裁切，见 [requestEnterPip]） */
        private const val PIP_MIN_ASPECT = 0.42f
        private const val PIP_MAX_ASPECT = 2.38f

        /**
         * 共享者名字（房间页 `startActivity` 时带上）。
         *
         * 为什么不用 Intent 传轨道/控制器：渲染器走的是 [ShareRenderHolder] 这个进程内持有者
         * （View 根本没法序列化进 Intent），这里只带一个纯展示用的字符串 ——
         * 宿主因此**不需要拿到 `VoiceRoomController`**，也就不会把语音会话的生命周期拖进第二个 Activity。
         */
        const val EXTRA_SHARER = "sharer"

        /**
         * 「启动后直接进小窗」（房间页「小窗观看」带 true 进来；不带 = 普通全屏观看）。
         *
         * 为什么走这条"先开宿主、宿主自己缩成小窗"的路（而不是房间页直接调系统 PiP）：
         *  · 系统要求 PiP 的调用者是**前台且 resumed** 的 Activity —— 房间页调时前台正变成宿主；
         *  · 小窗里显示的是"调用者 Activity 当前的样子" —— 房间页直接进小窗只会看到一整页
         *    可滚动的房间（共享画面多半不在可视区），而宿主窗口里**只有画面**。
         */
        const val EXTRA_ENTER_PIP = "enterPip"
    }
}
