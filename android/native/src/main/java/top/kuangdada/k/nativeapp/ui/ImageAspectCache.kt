package top.kuangdada.k.nativeapp.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.graphics.painter.Painter

/**
 * ============================================================
 * 「这张图实测过的宽高比」（ImageAspectCache）
 * ============================================================
 * 解决的是**列表上下跳**（用户实测反馈："从详情页退出到首页，首页的帖子有时候会上下跳，
 * 类似第一次进 app"）。
 *
 * ## 现象与成因
 *
 * 单图卡片的**高度是按原图比例算的**（设计稿要求不裁切，见 `PostCard.PostImageGrid`），
 * 而"原图比例"要等 Coil 把图解出来才知道 —— 图没出来时退回 4:3 占位。
 * 于是**每次卡片重新组合**（从详情页返回、列表项被回收后重建、切 tab 回来）
 * 都会先按 4:3 排一次版、图到了再改回真实比例：
 *
 * ```
 * 4:3   → 高 = 宽 / 1.333 = 0.75 宽
 * 9:16  → 高 = 宽 / 0.5625 = 1.78 宽      ← 两次排版差 1.03 个卡宽（≈370dp）
 * ```
 *
 * 而信息流的 item 带 `animateItem()`（增删/重排走弹簧），所以整条列表会**动画着上下跳一下**；
 * 正好与"第一次进 app"同源（那次只是没有旧位置可比，看着像加载）。
 * 这个坑只落在**恰好一张图**的帖子上（多图格是方块、视频区是 16:9，都不依赖图片自身比例），
 * 与用户说的"有时候"一致。
 *
 * ## 为什么不能用 `remember` 记住
 *
 * 返回首页时卡片是**新组合出来的**，`remember` 里什么都没有。所以这里用**进程内 Map**
 * （key = 图片 URL）：它记的是"这张图长什么样"，与页面/组合的生命周期无关。
 *
 * 同一个 URL 只会存一个比例（同一张图的比例不会变，重复写就是同一个值），也不做淘汰 ——
 * 一条 URL 对应一个 Float，一屏几十条帖子也就几 KB，比"整条列表跳一下"便宜得多。
 */
private val measuredAspects = HashMap<String, Float>()

/**
 * 单图比例：**优先用实测过的**（图没加载出来也不跳），没有才退回 [fallback]（4:3 占位）。
 *
 * 图加载出来后把真实比例补记进缓存；写放在 [LaunchedEffect] 里，组合期**只读不写**。
 */
@Composable
fun rememberImageAspect(url: String, painter: Painter, fallback: Float = 4f / 3f): Float {
    val measured = painter.aspectOrNull()
    LaunchedEffect(url, measured) {
        if (measured != null && measured > 0f) measuredAspects[url] = measured
    }
    return measured ?: measuredAspects[url] ?: fallback
}
