package top.kuangdada.k.nativeapp.ui

import androidx.compose.ui.geometry.Rect
import kotlin.math.abs

/**
 * 沉浸视频播放器**进/退场飞行**的几何计算（纯函数，单测钉住）。
 *
 * 这一套是**照搬图片查看器**（[ImageViewer] 的 `ViewerFlight` + `FlyingImage`）的：
 * 同一套矩形插值、同一套圆角插值、同一套遮罩淡入、**同一个全屏落位矩形算法**
 * （[videoFullscreenRect] 就是 [fitRectIn]）。查看器那条路已经在真机上跑通过，
 * 视频这条路没有任何理由另立一套 —— 观感差异、以及"为什么两处不一样"的维护成本，
 * 都来自"各写一遍"。
 *
 * 抽成纯函数是为了让"落在哪、缩到多大"能被 `VideoFlightGeometryTest` 直接钉住：
 * 这类几何写错的表现是"飞出去与来源块错位""落位时跳一下"，
 * 在真机上一眼可见却很难靠读代码发现。
 */

/**
 * 视频飞行时长（ms，**名义值**）。与查看器的 [VIEWER_FLIGHT_MS] **保持同一档** ——
 *  全屏图与全屏视频对用户是同一类动作，两个时长不同会读成"视频那个快了一拍"。
 *
 * 实际驱动它的是一条**无过冲弹簧**（[KMotion.spatialBounded]），收尾约 220ms；
 * 这个常量只用于**超时兜底**（[VideoPlayerScreen] 里那两条 `withTimeoutOrNull`）
 * 与文档口径，不参与动画本身。
 */
internal const val VIDEO_FLIGHT_MS = 250

/**
 * 视频在**全屏位**上的矩形。
 *
 * ★ 与查看器完全一致：`fitRectIn(container, aspect)` —— 按**内容宽高比**在容器里
 * Fit 出来的矩形，**不是容器本身**。
 *
 * ## 为什么不能用容器本身（我踩过的坑）
 * 第一版这里 `return container`，理由是"PlayerView 内部会按比例 letterbox，
 * 再算一次就是两套裁剪"。那个理由**只在落位之后成立**，对**飞行途中是错的**：
 * 飞行块是一个 Compose 元素，容器是一个竖屏长方形（1440×3168），
 * 让一块 16:9 的画面去"铺满"它，结果就是**画面被拉成竖条**再"收"成横条 ——
 * 用户看到的不是"视频放大到全屏"，而是"一块东西被扯变形"，观感完全不成立。
 *
 * 视频是 16:9、屏幕是 9:19.5，两者的 Fit 矩形正好是**屏幕中间那条 16:9 的横带**，
 * 那才是"视频在全屏页上的位置"。飞行块长到这条横带、播放器随后出现在同一位置，
 * 交接严丝合缝（查看器的 `FlyingImage` → `HorizontalPager` 就是这个模式）。
 *
 * @param aspect 视频宽高比（宽 / 高）；null 或非法时退回容器本身（查看器同款兜底）
 */
internal fun videoFullscreenRect(container: Rect, aspect: Float?): Rect =
    fitRectIn(container, aspect)

/**
 * 视频飞行矩形：从 [from]（详情页那一块）插值到 [to]（全屏那条横带）。
 *
 * ============================================================
 * ★ 缓动**不在这里**（2026-10-17 改）
 * ============================================================
 * 这里曾经叠过一次 smoothstep，而动画本身又是一条线性 tween —— 等于把两条曲线叠在一起：
 * 实际观感是"起步先顿一下、收尾再顿一下"，中间那段才是动的。
 * 现在几何只做**纯插值**，缓动交给驱动 [VideoPlayerScreen.flight] 的**弹簧**：
 *  · 弹簧以"当前进度 + 当前速度"为初值，**中途被打断（入场中按返回）不会回弹重来**；
 *  · 曲线只有一条，读代码时不用在"这里缓了一次、那里又缓了一次"之间做心算。
 */
internal fun videoFlightRect(from: Rect?, to: Rect?, progress: Float): Rect? {
    if (from == null || to == null) return null
    return lerpRect(from, to, progress)
}

/**
 * 圆角插值：来源块是圆角（`KRadius.row`）、全屏是直角，飞行途中要跟着一起变。
 *
 * 与 [videoFlightRect] 同样**只做纯插值** —— 圆角必须与矩形**同一进度**，
 * 各缓一次就会在途中出现"圆角已经方了、框还没到位"的错位。
 */
internal fun videoFlightCorner(fromPx: Float, toPx: Float, progress: Float): Float =
    fromPx + (toPx - fromPx) * progress.coerceIn(0f, 1f)

/**
 * 这条飞行**值不值得播**。
 *
 * 判据与查看器的 `canFly` 一一对应：
 *  · 动效开关开着（系统"移除动画"必须让路）；
 *  · 来源矩形量到了、且**确实落在容器里**（查看器用 `Rect.usableIn`）；
 *  · 两端矩形不是同一个（尺寸完全一致时没有可看的位移，白播只是让进出变慢）。
 */
internal fun videoFlightUsable(from: Rect?, container: Rect, animationsEnabled: Boolean): Boolean {
    if (!animationsEnabled) return false
    if (from == null) return false
    if (!from.left.isFinite() || !from.top.isFinite()) return false
    if (!from.right.isFinite() || !from.bottom.isFinite()) return false
    if (from.width <= 1f || from.height <= 1f) return false
    if (container.width <= 0f || container.height <= 0f) return false
    return abs(from.width - container.width) > 1f || abs(from.height - container.height) > 1f
}

/**
 * 视频封面在飞行块里的**取景系数**（与查看器的 `cropOverScaleOf` 同一个用途）。
 *
 * 飞行块按 [fitRect] 布局（Fit），而封面要 `ContentScale.Crop` 填满它 ——
 * 也就是"按 base 布局的内容铺满 rect"的等比覆盖系数。
 * 直接复用查看器那个函数，保证两处的 Crop 语义逐像素一致。
 */
internal fun videoCoverCropScale(base: Rect, rect: Rect): Float = cropOverScaleOf(base, rect)

/**
 * 飞行块的**绘制期变换**：把"布局在终态矩形 [target] 上"的内容，
 * 变换成"看起来铺在 [current] 上"。
 *
 * ============================================================
 * ★★ 为什么不是"改布局尺寸"（2026-10-13 "退出没有动画"的真根因）
 * ============================================================
 * 逐帧改 `Modifier.size()` 会每帧触发 measure + layout；而这一块里装的是
 * `AndroidView`（`PlayerView` + `TextureView`），尺寸一变就要**重新分配 Surface** ——
 * 几十毫秒级的重活，还会丢掉上一帧内容。表现是：几何在动，
 * **Surface 里的画面卡在旧尺寸**，用户看到的就是"根本没有动画"
 * （真机逐帧日志已证明动画值本身是连续的：1.0 → 0.669 → 0.537 → … → 0.0）。
 *
 * 所以尺寸**钉死在终态**，动画只走 `graphicsLayer` 的 scale/translation
 * （绘制期属性：不 measure、不 layout、不动 Surface）。图片查看器的 `FlyingImage`
 * 也是这个思路（Canvas 里 translate+scale 绘制，全程不重新测量）。
 *
 * ## 几何约定
 *  · 布局：尺寸 = [target] 的宽高，位置 = [target] 的左上角；
 *  · 缩放：[current] 与 [target] 的**等比**比值（取小的那一维，保证内容不溢出）；
 *  · 原点：**中心**（与 `lerpRect` 的中心插值一致）；
 *  · 于是 [current] == [target] 时 scale = 1、dx = dy = 0 → **恒等变换**，
 *    落地那一刻不需要任何"切回去"的动作。
 */
internal data class VideoFlightTransform(val scale: Float, val dx: Float, val dy: Float)

internal fun videoFlightTransform(current: Rect?, target: Rect): VideoFlightTransform {
    val toW = target.width.coerceAtLeast(1f)
    val toH = target.height.coerceAtLeast(1f)
    if (current == null) return VideoFlightTransform(1f, 0f, 0f)
    // 等比缩放取小的那一维：保证内容完整落在 current 里（大的一维会留边）
    val scale = minOf(current.width / toW, current.height / toH).coerceIn(0.01f, 1f)
    return VideoFlightTransform(
        scale = scale,
        dx = current.center.x - target.center.x,
        dy = current.center.y - target.center.y,
    )
}
