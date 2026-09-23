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
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import top.kuangdada.k.nativeapp.ui.shareFullscreenBox
import top.kuangdada.k.nativeapp.voice.ShareRenderHolder

/**
 * ============================================================
 * 屏幕共享**全屏宿主**（M6.17：全屏 = 独立 Activity + Surface 交接）
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
 * ⚠️ 为什么退出全屏**必须同步摘除**（[onPause] 里就摘，不能等 onStop/onDestroy）：
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

    override fun onCreate(savedInstanceState: Bundle?) {
        // 与 MainActivity 同一套：edge-to-edge，状态栏/导航栏交给下面 hideSystemBars()
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_share_fullscreen)

        root = findViewById(R.id.k_share_fullscreen_root)
        box = findViewById(R.id.k_share_fullscreen_box)
        hint = findViewById(R.id.k_share_fullscreen_hint)
        sharer = intent.getStringExtra(EXTRA_SHARER)?.takeIf { it.isNotBlank() } ?: "有人"
        // 提示文案由这里定稿：布局里那条只有形状与颜色，文字要带上共享者名字
        (hint as android.widget.TextView).text =
            getString(R.string.k_share_fullscreen_hint, sharer)

        android.util.Log.i(
            ShareRenderHolder.TAG,
            "全屏宿主进入：共享者=$sharer 渲染器=#${ShareRenderHolder.rendererHash()}",
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
    }

    override fun onResume() {
        super.onResume()
        hideSystemBars()
        // 接画面。**attach 内部保证同一个渲染器不会有两个父**，所以这里不必先 detach
        ShareRenderHolder.attach(box)
        applyAspect()
        // 共享结束/换人共享 → 由房间侧通知退场（回调只在 onResume~onPause 之间登记，
        // 所以不可能拿到一个已经销毁的 Activity）
        ShareRenderHolder.onCloseRequest = { reason -> finishShareHost(reason) }
        // 画面比例在观看过程中可能真的变（换人共享 / 共享方换了采集形态）→ 重新摆一次画面框
        lifecycleScope.launch {
            snapshotFlow { ShareRenderHolder.aspect }
                .distinctUntilChanged()
                .collect { applyAspect() }
        }
    }

    override fun onPause() {
        // **先交回画面再走**（顺序理由见类注释）。用户自己返回时也一样走这里。
        ShareRenderHolder.onCloseRequest = null
        ShareRenderHolder.detach()
        super.onPause()
    }

    /** 旋转 / 尺寸变化：清单里配了 `configChanges`，Activity 不重建，只需重摆画面框 */
    override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
        super.onConfigurationChanged(newConfig)
        applyAspect()
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

        /**
         * 共享者名字（房间页 `startActivity` 时带上）。
         *
         * 为什么不用 Intent 传轨道/控制器：渲染器走的是 [ShareRenderHolder] 这个进程内持有者
         * （View 根本没法序列化进 Intent），这里只带一个纯展示用的字符串 ——
         * 宿主因此**不需要拿到 `VoiceRoomController`**，也就不会把语音会话的生命周期拖进第二个 Activity。
         */
        const val EXTRA_SHARER = "sharer"
    }
}
