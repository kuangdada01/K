package top.kuangdada.k.nativeapp.ui

import android.widget.FrameLayout
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import top.kuangdada.k.nativeapp.voice.ShareRenderHolder

/**
 * ============================================================
 * 屏幕共享画面在**房间页**里的宿主（M6.17）
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
    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            FrameLayout(ctx).apply {
                // 画面矩形之外的那两条 = 纯黑（用户明确要求黑边是纯黑，不是页面底色）
                setBackgroundColor(android.graphics.Color.BLACK)
            }
        },
        update = { container ->
            // 每次进内联态（含退全屏回来）都把渲染器接回这个容器。
            // attach 自身幂等：已经在里面就什么也不做，所以这里不需要额外记账
            ShareRenderHolder.attach(container)
        },
    )
    DisposableEffect(Unit) {
        // 离开组合（退房 / 进全屏后不再画内联槽位）只**摘不销毁**：
        // 渲染器与解码链留给持有者，全屏宿主紧接着就把它接过去
        onDispose { ShareRenderHolder.detach() }
    }
}
