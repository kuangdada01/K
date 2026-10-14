package top.kuangdada.k.nativeapp.ui

import android.widget.FrameLayout
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import top.kuangdada.k.nativeapp.voice.ShareRenderHolder

/**
 * ============================================================
 * 屏幕共享画面在**房间页**里的宿主（M6.17；M6.19：尺寸变化后重建 surface）
 * ============================================================
 * 它只做三件事：提供一个容器、把容器交给 [ShareRenderHolder]、离开组合时摘掉。
 * **渲染器不在这里创建，也不由这里决定尺寸** —— 它活在持有者里、跨 Activity 交接；
 * 尺寸完全跟着内联槽位外面那层"画面比例框"走。
 *
 * ⚠️ **不透明黑底只能画在这里**（容器上），**绝不能画到上一层**：
 * `SurfaceView` 的 Surface 在窗口 UI 层**下面**出图（在窗口上"挖洞"），
 * 而**洞的边界就是这个容器矩形** —— 容器自己铺黑 = 画面矩形之外那两条留黑；
 * 而画在它上面的任何不透明元素（占位块、浮层）会盖住"洞"里的画面，整块变黑
 * （M6.16 真机事故，注释里记着，别再犯）。反过来也成立：容器铺黑**不会**盖住画面，
 * 因为画面根本不在 UI 层里。
 *
 * @param active 内联槽位当前是否**持有**画面。全屏期间是 false：画面在全屏宿主那边，
 *   这边留一个同尺寸的空槽 —— 天然不可能出现"两份渲染"
 */
@Composable
fun ShareRenderView(
    active: Boolean,
    modifier: Modifier = Modifier,
) {
    if (!active) return
    // 容器引用：onDispose 时用它回答"画面是不是还挂在**我们这个**容器上"（见下方 onDispose）
    val containerRef = remember { java.util.concurrent.atomic.AtomicReference<android.view.ViewGroup?>(null) }
    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            ShareRenderContainer(ctx).apply { containerRef.set(this) }
        },
        update = { container ->
            containerRef.set(container)
            // 每次进内联态（含退全屏回来）都把渲染器接回这个容器。
            // attach 自身幂等：已经在里面就什么也不做，所以这里不需要额外记账
            ShareRenderHolder.attach(container)
        },
    )
    DisposableEffect(Unit) {
        // 离开组合（退房 / 进全屏后不再画内联槽位）只**摘不销毁**：
        // 渲染器与解码链留给持有者，全屏宿主紧接着就把它接过去。
        //
        // ⚠️ 用**带 container 的 detach**（M6.18）：本槽位离开组合与"画面被宿主接走"是一对
        // **会交错**的时序 —— 宿主先接走、onDispose 后到时，盲摘会把宿主的画面摘掉
        // （真机症状：全屏/小窗黑、房间页槽位却在播）。带上容器后，只有当画面确实还挂在
        // 这个槽位容器上时才摘（渲染器/容器都不重新创建，见 ShareRenderHolder 的说明）。
        onDispose { containerRef.get()?.let { ShareRenderHolder.detach(from = it) } }
    }
}

/**
 * 共享画面的承载容器：**黑底 + "尺寸变化后重建 EGL surface"**（M6.19）。
 *
 * 为什么需要重建（真机定位的机制，详见 `ShareRenderHolder.rebuildSurfaceFor`）：
 * `EGL surface 的尺寸在创建那一刻固定`，而 SurfaceView 的 buffer 在 SurfaceFlinger 里是
 * **不缩放**（FREEZE）语义 —— "进房先按兜底 16:9 建 surface、随后画面框修正为 16:10"时，
 * buffer 仍是 16:9 尺寸、在更高的容器里左上对齐，**底部露出一条约 10% 框高的黑带**；
 * "进一下全屏再退出"能修好，正是因为它等价于这里的一次重建。
 *
 * 判据（两条都要）：
 *  · 容器**曾经有过尺寸**（首次布局不算：第一次创建 surface 时尺寸本来就是对的）；
 *  · **尺寸真的变了**（`onLayoutChange` 连"只有位置变化"（页面滚动）也回调 —— 必须排除，
 *    否则滚动会把画面重建出一帧黑闪）；变化超过 2% 才算（滤掉亚像素级抖动）。
 *
 * 执行时机：`postOnAnimation` —— 落在下一帧，彼时容器的新布局（新尺寸）已生效，
 * 重建出来的 surface 才能读到正确尺寸；并且用 removeCallbacks 把连续变化**合并成一次**。
 */
private class ShareRenderContainer(context: android.content.Context) : FrameLayout(context) {

    private val rebuild = Runnable { ShareRenderHolder.rebuildSurfaceFor(this) }

    init {
        // 画面矩形之外的那两条 = 纯黑（用户明确要求黑边是纯黑，不是页面底色）
        setBackgroundColor(android.graphics.Color.BLACK)
        addOnLayoutChangeListener { _, l, t, r, b, ol, ot, orr, ob ->
            val w0 = orr - ol
            val h0 = ob - ot
            val hadSize = w0 > 0 && h0 > 0
            val w1 = r - l
            val h1 = b - t
            val bigEnough = kotlin.math.abs(w1 - w0) > w0 * 0.02 ||
                kotlin.math.abs(h1 - h0) > h0 * 0.02
            if (hadSize && bigEnough) {
                removeCallbacks(rebuild)
                postOnAnimation(rebuild)
            }
        }
    }
}
