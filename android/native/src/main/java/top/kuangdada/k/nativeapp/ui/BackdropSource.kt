package top.kuangdada.k.nativeapp.ui

import androidx.compose.foundation.background
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.drawscope.ContentDrawScope
import androidx.compose.ui.unit.Dp
import com.kyant.backdrop.backdrops.LayerBackdrop
import com.kyant.backdrop.drawPlainBackdrop
import com.kyant.backdrop.effects.blur

/**
 * ============================================================
 * backdrop（液态玻璃 / 毛玻璃）的**源那一层**：铺页底色 + 画内容
 * ============================================================
 *
 * 用法（四处都是同一个写法：AppShell 的胶囊、PostDetail / Messages / Books 的顶栏）：
 * ```
 * val backdrop = rememberLayerBackdrop(onDraw = rememberBackdropOnDraw(c.bgPage))
 * ```
 *
 * **一定要用这个函数，不要在那里直接写内联 lambda** —— 2026-09-23 修的那个
 * "玻璃闪一下 / 重新加载"就是内联 lambda 引起的：
 *
 *  · `rememberLayerBackdrop` 内部是 `remember(graphicsLayer, onDraw) { LayerBackdrop(...) }`，
 *    而内联 lambda（捕获了 `pageBg`）**每次重组都是新对象** → 每次都新建一个 `LayerBackdrop` 实例；
 *  · 库的 `LayerBackdropElement.update()` 发现实例变了会**把源节点的坐标清成 null**：
 *    ```
 *    if (node.backdrop != backdrop) { node.backdrop.layerCoordinates = null; node.backdrop = backdrop }
 *    ```
 *  · 而 `LayerBackdrop.drawBackdrop()` 一拿不到坐标就 **直接 return —— 整块玻璃一个像素都不画**，
 *    只剩 `onDrawSurface` 那层色膜 = 一片平整的浅色；
 *  · 恢复要等**容器被重新布局**（`onGloballyPositioned` 把坐标写回来）—— 导航时那一次
 *    往往落在转场结束，所以看起来就是"玻璃闪了约半秒又自己好了"。
 *
 * 真机现象（用户反馈 + 逐帧量化，见 `.workbuddy/memory/2026-09-23.md`）：点导航栏底下那条帖子的
 * 配图 → 进详情 → 返回，胶囊在返回转场期间变"一片浅色、透不出背后内容"。
 * **背后是浅色时看不出来**（色膜叠上去差不多），背后是照片/深色时才显眼 ——
 * 所以用户描述成"点胶囊下的图片才会"。
 *
 * 修法：`remember` 固定 lambda 实例（不再重建 `LayerBackdrop`），底色用
 * `rememberUpdatedState` 跟着走（主题切换时颜色照样更新，而不是把旧色冻住）。
 */
@Composable
fun rememberBackdropOnDraw(pageBg: Color): ContentDrawScope.() -> Unit {
    val latestPageBg = rememberUpdatedState(pageBg)
    return remember {
        {
            drawRect(latestPageBg.value)
            drawContent()
        }
    }
}

/**
 * 顶栏玻璃的**统一写法**（详情 / 消息 / 图书三处共用，参数必须一模一样）。
 *
 * ⚠️ 整份 `remember`：链上的 lambda 都是身份比较，内联写法每次重组都会让库
 * `update()` → `updateEffects()` **把模糊整条链清掉重建**（与胶囊踩的是同一个坑，
 * 见 `AppShell.capsuleGlass` 的注释）。键取全参数：换了源、换主题（tint/solid 变）、
 * 或低版本降级，本来就该重建一次。
 *
 * 顺序仍是铁律：**只放 blur，不要加 colorFilter / vibrancy**（本机实测会打断效果链）。
 *
 * ⚠️⚠️ [backdrop] **必须是本页自己的源**（本页内容列上挂 `Modifier.layerBackdrop` 录的那一层）。
 * **不能**改成"用 shell 那层"（`AppShell.shellBackdrop`）—— 顶栏本身就在 shell 那层的内容里，
 * 采样它 = **图层自引用**：录制源层时遇到顶栏 → 顶栏又要画源层 → 无限递归。
 * 实测（2026-09-23）直接原生崩溃（hwui `RenderNode::prepareTreeImpl` 深层递归 / 栈溢出）。
 * 底部胶囊可以共用 shell 那层，是因为它画在源层**之后**（源里不含它）。
 *
 * 代价：顶栏看不到"共享元素的飞行覆盖层"（覆盖层在页面之外）。飞行落在详情页封面附近、
 * 不经过顶栏，所以实践上没有影响；真遇到再说。
 */
@Composable
fun rememberTopBarGlass(
    canBlur: Boolean,
    backdrop: LayerBackdrop,
    blurRadius: Dp,
    tint: Color,
    solid: Color,
): Modifier = remember(canBlur, backdrop, blurRadius, tint, solid) {
    if (canBlur) {
        Modifier.drawPlainBackdrop(
            backdrop = backdrop,
            shape = { RectangleShape },
            effects = { blur(blurRadius.toPx()) },
            onDrawSurface = { drawRect(tint) },
        )
    } else {
        Modifier.background(solid)
    }
}
