package top.kuangdada.k.nativeapp.ui

import android.os.Build
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import top.kuangdada.k.core.designsystem.theme.KSpacing
import kotlinx.coroutines.delay

/**
 * ============================================================
 * 图片格 / 视频封面在「内容不在页面里」时露出来的**兜底底色**
 * ============================================================
 *
 * 病根（2026-09-25 录像逐帧取证，用户原话："突然变磨砂质感"）：
 * 共享元素飞行期间，**这一格在页面里是空的** —— 内容被画进了
 * `SharedTransitionLayout` 的**覆盖层**（`sharedElement` 的语义：飞行期两端原地都不画），
 * 要等落地才回到页面里。而**顶栏的毛玻璃采样的正是"页面"这一层**
 * （`Modifier.layerBackdrop` 挂在页面的内容列上，见 `PostDetailScreen`）。于是：
 *   · 飞行期间 → 玻璃采样到的是这一格的**兜底底色**；
 *   · 飞行结束 → 这一格变回真图，玻璃立刻又采样到图片本身。
 * 两次采样的颜色不同 ⇒ **顶栏在那两帧之间"换了个质感"**。
 *
 * 实测量化（用户录像 `Record_2026-09-25-21-49-49`，顶栏那一条带的平均明度；
 * 全程内容没动，只有顶栏在变）：
 *   ```
 *   2.50s  bar=237.8  bar2=222.1  img=52.7   ← 飞行中：玻璃采到浅色兜底
 *   2.52s  bar=214.9  bar2=198.4  img=56.9   ← 落地那一**帧**：采到深色配图
 *   2.62s+ bar=215.3  bar2=200.1  img=52.8   ← 稳定
 *   ```
 * **只有长图能看出来**（用户原话）：短图够不到顶栏底下，采样范围里根本没有那一格。
 *
 * 两件事缺一不可：
 *  ① 兜底不能是纯色，要**与图同色调**（否则玻璃还是采到两种颜色）；
 *  ② 兜底必须挂在**共享元素节点外面**（同级兄弟）—— 库的 `shouldRenderInPlace = false`
 *     会让共享元素**整棵子树都不画**，挂里面会被一起吞掉，等于没修。
 *
 * ★ 2026-09-25 晚：兜底只在**顶栏那一条带**里画（[MediaCellBackdropStripFactor]，1.05 倍）。
 * ⚠️ 并且**只在"页面自己有毛玻璃顶栏"的那一端用**（详情/消息/图书）—— 信息流那一端没有顶栏玻璃，
 * 挂上去只会被眼睛看见（返回时"顶栏残留一条糊图"就是它）。
 * 为什么：兜底是"这张图的模糊副本"，它在飞行期间**会在可见区域露出来**（内容此时在覆盖层上飞），
 * 看起来就是"图先糊着、落地突然变清晰" —— 用户对这个的形容是"图片动画不自然"。
 * 而**玻璃只需要在顶栏那一条带里采到正确的颜色**，所以把兜底裁到那一条带里：
 * 观感回到"飞行期这一格空着"（一直如此），顶栏该有的颜色一点也不少。
 *
 * ⚠️ 裁剪依赖元素在窗口里的 y（`positionInWindow`）；拿不到时**按"不裁"处理** ——
 * 宁可露出一块糊图，也不能让顶栏那条又跳回去。
 *
 * ⚠️ `Modifier.blur` 依赖 `RenderEffect`（Android 12 / API 31+），minSdk 27 上会静默失效 ——
 * 低版本退回纯色兜底（= 修复前的行为，不倒退），与毛玻璃自己的降级是同一条线。
 */

/** 兜底模糊半径：比顶栏玻璃（[KGlassBlurRadius]=32dp）略小 —— 玻璃还会再糊一层。 */
private val MediaCellBackdropBlur = 24.dp

/** 飞行结束后兜底再保留多久（防"结束差一帧"时闪一下）。 */
private const val MediaCellBackdropHoldMs = 300L

/**
 * 兜底画到"屏幕顶部多少倍顶栏高度"为止。
 *
 * ★ 必须是 **1.0 出头一点点**（不是 1.6）：玻璃的 `blur` 作用在**顶栏自己那块取景**上
 * （边缘是 clamp，不会采到栏外），所以兜底只需要盖住**顶栏那一条本身**。
 * 取 1.6 会让它多糊出顶栏下方 ~150px —— 那一段没有任何东西遮着，用户看到的就是
 * **"返回首页时顶栏下面残留一条糊图"**（09-25 晚实测）。
 */
private const val MediaCellBackdropStripFactor = 1.05f

/**
 * 放在图片格最底层的兜底。调用方仍需保留自己的 `.background(fallback)`（加载失败时用）。
 *
 * @param painter 这一格**真正要显示的那张图**的 painter（两端必须同一个请求，见
 *        `rememberThumbRequest` / `rememberVideoCoverRequest` 的显式缓存键）。
 */
@Composable
fun MediaCellBackdrop(
    painter: Painter,
    fallback: Color,
    contentScale: ContentScale = ContentScale.Crop,
    modifier: Modifier = Modifier,
) {
    // 三个信号取并集：与 VideoCover 里藏「视频」胶囊用的是同一组判据（各自补一段空窗）
    val flying = isSharedTransitionActive() || isPageLeaving() || isPageTransitioning()
    /**
     * 兜底不是"飞完马上换回纯色"，而是**多留 300ms**。
     *
     * 为什么：飞行的结束与"这一格回到页面里"理论上同一帧发生（库在同一次布局更新里把
     * `boundsTransformIsActive` 置假、原地那份立刻开始画），但**万一差一帧**，
     * 兜底从"模糊图"变回"纯色"就会在顶栏上闪一下 —— 那正是这次要修的观感。
     * 多留 300ms 让兜底多糊一会儿（此时它已被真图盖住，看不见），把这个缝兜死。
     */
    var latched by remember { mutableStateOf(false) }
    LaunchedEffect(flying) {
        if (flying) {
            latched = true
        } else {
            delay(MediaCellBackdropHoldMs)
            latched = false
        }
    }
    // 只有"真会露出来"的时候才挂（静止时这一格被真图完全盖住，没必要为列表每张卡片付 RenderEffect）
    val active = (flying || latched) && Build.VERSION.SDK_INT >= 31

    // 元素在窗口里的 y —— 用来把兜底裁到"顶栏那一条带"（拿不到时置 NaN → 不裁）
    var topInWindow by remember { mutableFloatStateOf(Float.NaN) }
    val stripPx = with(LocalDensity.current) {
        (kTopBarHeightEstimatePx(bottomPadding = KSpacing.xs).toFloat() *
            MediaCellBackdropStripFactor)
    }

    Box(
        modifier = modifier
            .background(fallback)
            .onGloballyPositioned { topInWindow = it.positionInWindow().y },
    ) {
        if (active) {
            Image(
                painter = painter,
                contentDescription = null,
                contentScale = contentScale,
                modifier = Modifier
                    .fillMaxSize()
                    // edgeTreatment 默认 Rectangle：模糊不会糊出格子外（圆角那层是外面裁的）
                    .blur(MediaCellBackdropBlur)
                    /**
                     * 只画"落在屏幕顶部那一条带"里的部分（见文件头注释）。
                     * 本节点的 y=0 对应窗口 y=[topInWindow]，所以条带底边在本节点里的位置 =
                     * `stripPx - topInWindow`；<=0 表示这一格整体已经在条带之下 → 一个字都不画。
                     */
                    .drawWithContent {
                        val cut = stripPx - topInWindow
                        if (cut.isNaN()) {
                            // 还没拿到坐标：不裁（宁可露一块糊图，也不能让顶栏跳回去）
                            drawContent()
                        } else if (cut > 0f) {
                            clipRect(
                                left = 0f,
                                top = 0f,
                                right = size.width,
                                bottom = cut.coerceAtMost(size.height),
                                clipOp = androidx.compose.ui.graphics.ClipOp.Intersect,
                            ) {
                                this@drawWithContent.drawContent()
                            }
                        }
                    },
            )
        }
    }
}
