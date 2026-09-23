package top.kuangdada.k.core.designsystem.theme

import android.content.Context
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.animation.BoundsTransform
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.spring
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp

/**
 * ============================================================
 * 动效令牌（KMotion）
 * ============================================================
 * 唯一来源：设计稿组件规范区「二 · 圆角 / 字号 / 间距尺度」的动效一行。
 *
 * 收敛前现状（Web 版，已审计）：`0.12 / 0.15 / 0.16 / 0.18 / 0.2 / 0.3s` 六种时长混用，
 * 缓动基本只有 `ease`，无令牌。
 *
 * 收敛后 **3 档时长 + 1 个缓动**：
 *   120ms 微反馈（按下、点赞）· 180ms 状态切换（选中、展开）· 260ms 浮层进出（弹层、导航）
 *
 * 缓动统一 `cubic-bezier(.2, .8, .2, 1)` —— 起步快、收尾缓，是 Material 的「标准」手感。
 *
 * ------------------------------------------------------------
 * v2（本工程 · 2026-09）：在时间档之上补**物理档**
 * ------------------------------------------------------------
 * 为什么加：时间档（`tween` + 固定曲线）的问题是**中途被打断时不自然** ——
 * 用户快速连点/滑动时，动画每次从头播一条固定曲线，观感是"发木、跟不上手指"。
 * 弹簧（`spring`）以"当前位置 + 当前速度"为初值继续解算，被打断也连续。
 *
 * 两个新档位按**属性类型**分，不要混用：
 *   · [spatial]：位置 / 尺寸 / 缩放 / 圆角 —— 允许轻微过冲，才有"物理感"；
 *   · [effects]：颜色 / 透明度 / 阴影 —— **不允许过冲**（阻尼比 1.0），
 *     否则颜色会先冲过目标再回来，观感是"脏"。
 *
 * 三档强弱（`Preset`）对应原来的 260/180/120ms 语义：
 *   · `Slow` ≈ 全屏/重页面级；`Default` ≈ 二级页转场、展开收起；`Fast` ≈ 微反馈。
 *
 * 时间档（[instant] / [quick] / [medium] / [standard]）**继续保留**：
 * 少数场景必须时间可控（一次性编排序列、截图对比、单测），弹簧给不了确定时长。
 * 新代码默认用 [spatial] / [effects]；需要"多少毫秒就是多少毫秒"时才用时间档。
 *
 * ------------------------------------------------------------
 * 降级开关（[LocalAnimationsEnabled] / [rememberAnimationsEnabled]）
 * ------------------------------------------------------------
 * 系统「设置 → 开发者选项 → 动画时长缩放」被关掉（= 0）或无障碍里的"移除动画"打开时，
 * 动效必须让路。Compose 的 `withFrameNanos` 系动画自身会参考系统的时长缩放，
 * 但**无限循环动画**（呼吸、脉冲、骨架屏微光）与**手写的一次性动画**不保证被覆盖 ——
 * 所以这里显式再兜一层，让页面能主动降级为"直接到位"。
 *
 * 用法：`if (LocalAnimationsEnabled.current) { ... }`，或在 [MotionEnterOnce] 这类
 * 包装里由 `enabled` 参数自动接管。
 */
object KMotion {
    /** 微反馈：按下、点赞、勾选 */
    const val instant = 120

    /** 状态切换：选中态、展开收起、颜色过渡 */
    const val quick = 180

    /** 浮层进出：弹层、下拉、导航胶囊 */
    const val medium = 260

    /** 统一缓动 cubic-bezier(.2, .8, .2, 1) */
    val standard: Easing = CubicBezierEasing(0.2f, 0.8f, 0.2f, 1f)

    /**
     * **骨架屏微光扫过一次**的时长（M4）。
     *
     * 为什么不并进上面三档：那三档是**一次性**动作（按下/切换/进出），这个是**环境性循环**——
     * 它没有"结束"的语义，只要求"不抢注意力"。1.4s 是实测在卡片尺寸上既不显快也不显慢的量；
     * 比它快会像"进度条在赶工"，比它慢会让人以为卡住了。
     *
     * 与三档一样，**必须由 [LocalAnimationsEnabled] 门控**：无限循环动画不保证被系统
     * 动画缩放覆盖，用户关掉动画后还在闪就是可访问性问题（不只是性能问题）。
     */
    const val shimmer = 1400

    /**
     * **呼吸**一轮的时长（M6，语音房麦位的"活着"感）。
     *
     * 比 [shimmer] 还慢一档（2.4s）：呼吸是**背景节奏**，快了会像"警报"。
     * 同样属于环境性循环，同样必须由 [LocalAnimationsEnabled] 门控。
     */
    const val breath = 2400

    /** 按下时图标/按钮的缩放（设计稿 §3.1：按下瞬间 scale(.92) 微反馈） */
    const val pressedScale = 0.92f

    // ------------------------------------------------------------------
    // v2：物理档
    // ------------------------------------------------------------------

    /** 物理档强弱。`Default` 是绝大多数转场的默认值 */
    enum class Preset { Fast, Default, Slow }

    /**
     * 空间类：位置 / 尺寸 / 缩放 / 圆角。
     *
     * 阻尼比 < 1 才会有轻微过冲（"物理感"的来源）。三档的过冲量刻意都压得很小
     * （0.90 / 0.85 / 0.80），只做"收尾那一下的柔和"，不做弹跳玩具 ——
     * 越大的面（全屏页）越不该弹，所以 `Slow` 反而取更小的过冲。
     */
    fun <T> spatial(preset: Preset = Preset.Default): FiniteAnimationSpec<T> = when (preset) {
        Preset.Fast -> spring<T>(dampingRatio = 0.90f, stiffness = 1200f)
        Preset.Default -> spring<T>(dampingRatio = 0.85f, stiffness = 700f)
        Preset.Slow -> spring<T>(dampingRatio = 0.80f, stiffness = 400f)
    }

    /**
     * 效果类：颜色 / 透明度 / 阴影。
     *
     * **阻尼比固定 1.0（不过冲）**：颜色过冲会先冲过目标色再回来（观感是"脏"），
     * 透明度过冲在根节点上表现为"闪一下"。刚度越大越快，用于区分强弱档。
     */
    fun <T> effects(preset: Preset = Preset.Default): FiniteAnimationSpec<T> = when (preset) {
        Preset.Fast -> spring<T>(dampingRatio = 1f, stiffness = 2400f)
        Preset.Default -> spring<T>(dampingRatio = 1f, stiffness = 1600f)
        Preset.Slow -> spring<T>(dampingRatio = 1f, stiffness = 900f)
    }

    /**
     * 按下 / 点赞的**回弹**（刻意做过冲：0.45 明显"弹"一下）。
     *
     * 与 [spatial] 的区别：那个是"界面移动"该有的柔和收尾，这个是"手指施加了力"的反馈，
     * 只用在缩放这种小面积、短距离的属性上。
     */
    val pressSpec: FiniteAnimationSpec<Float> = spring<Float>(dampingRatio = 0.45f, stiffness = 1400f)

    /**
     * 边界动画：给 `LookaheadScope` + `Modifier.animateBounds` 用。
     *
     * 典型场景是导航胶囊的**滑动指示块**（M3）与共享元素容器（M3）：
     * 元素在"前瞻布局"里的位置变了，用它把**位置与尺寸一起**弹簧过去。
     *
     * 用显式对象表达式而不是 `BoundsTransform { _, _ -> ... }` 的 SAM 写法：
     * 该接口唯一的抽象方法叫 `createAnimationSpec(initialBounds, targetBounds)`
     * （实测自 animation 1.12.1 的字节码，**不叫 `transform`**），写成显式重写
     * 对"它到底是不是 Kotlin `fun interface`"零依赖，改版本时也不会突然编译不过。
     */
    val boundsTransform: BoundsTransform = object : BoundsTransform {
        override fun createAnimationSpec(
            initialBounds: Rect,
            targetBounds: Rect,
        ): FiniteAnimationSpec<Rect> = spatial<Rect>(Preset.Default)
    }

    /**
     * 同上，但**按距离缩阻尼**（小行程用不过冲的那一档）。
     *
     * 为什么需要第二个：弹簧的过冲量在**像素**上正比于行程。[boundsTransform] 的
     * `dampingRatio = 0.85` 在小面上（胶囊指示块，几十像素）正好是一点点"物理感"；
     * 但同一个参数用在**跨屏大行程**（信息流缩略图 → 全屏查看器，几百像素）上，
     * 过冲就变成十几到几十像素 —— 肉眼看到的正是"**图冲过目标位、顿一下、再回位**"。
     *
     * 所以按"两个矩形中心的距离"分档（阈值见 [BOUNDS_OVERSHOOT_DISTANCE_PX]）：
     *   · 近：保持 [Preset.Default] 的 0.85，小行程的物理感不变；
     *   · 远：换成 `spatialBoundedOf`（不过冲），大行程变成"到位就停"。
     *
     * 注意**不按尺寸变化分档**：缩放方向上的"弹"本来就看得见，而这块的用户反馈
     * 只针对位置；保守起见只处理距离。
     */
    val boundsTransformDistanceAware: BoundsTransform = object : BoundsTransform {
        override fun createAnimationSpec(
            initialBounds: Rect,
            targetBounds: Rect,
        ): FiniteAnimationSpec<Rect> {
            val distance = (targetBounds.center - initialBounds.center).getDistance()
            return if (distance > BOUNDS_OVERSHOOT_DISTANCE_PX) {
                spatialBounded<Rect>(Preset.Default)
            } else {
                spatial<Rect>(Preset.Default)
            }
        }
    }

    /**
     * 公开的「不过冲空间档」：与 [spatial] 刚度一致、只把阻尼比抬到 1.0。
     *
     * 给"几何由调用方自己插值"的场景用（目前是全屏查看器的进场/退场飞行）：
     * 那种动画的矩形是**每帧手算**的，一旦过冲就会被 `lerpRect` 夹回 `[0,1]` ——
     * 表现不是"弹一下"，而是"飞到目标位、顿一下、再回到目标位"（等于白顿）。
     * 与其夹掉，不如根本上不产生过冲。
     */
    fun <T> spatialBounded(preset: Preset = Preset.Default): FiniteAnimationSpec<T> = when (preset) {
        Preset.Fast -> spring<T>(dampingRatio = 1f, stiffness = 1200f)
        Preset.Default -> spring<T>(dampingRatio = 1f, stiffness = 700f)
        Preset.Slow -> spring<T>(dampingRatio = 1f, stiffness = 400f)
    }
}

/**
 * [KMotion.boundsTransformDistanceAware] 的分档阈值：两个矩形中心相距多少 px 以上算"大行程"。
 *
 * 取 240px：在 PGEM10（1dp = 3.5px）上约 68dp，正好是"从列表格子飞到全屏"这类跨区飞行的量级 ——
 * 而胶囊指示块、就地变形这类小行程都远在它之下，不会被误判。
 */
private const val BOUNDS_OVERSHOOT_DISTANCE_PX = 240f

/** 浮层进出用到的偏移量（260ms 配合） */
object KMotionOffset {
    val sheetSlide = 24.dp

    /**
     * 「重页面」一次性入场时的起始下滑量（[MotionEnterOnce] 默认值）。
     *
     * 比 [sheetSlide] 小：入场是整页在动，位移太大在长页面上会显得"晕"。
     */
    val enterSlide = 16.dp

    /**
     * **同位切换**时新内容的横向进场量（分段控件「会话 | 通知」切段）。
     *
     * 与上面两条的区别：这是"同一块区域里换了一批内容"，不是"来了一层新页面"——
     * 顶栏、分段控件、底部导航全都没动。所以位移必须**明显更小**：
     * 大了会读成"整页在左右翻"，与那些不动的元素打架（§6 每屏只留一个抢注意力的动效）。
     * 配 [KMotion.spatial] 的弹簧，实际观感是"内容从切换方向那一侧让出来"。
     */
    val switchSlide = 14.dp

    val zero = IntOffset(0, 0)
}

/**
 * 动效是否开启（系统动画缩放 != 0）。默认 `true`：没包在 [KTheme] 里时按"开"处理。
 *
 * 由 [KTheme] 用 [rememberAnimationsEnabled] 的实测值提供。
 */
val LocalAnimationsEnabled = staticCompositionLocalOf { true }

/**
 * 读系统「动画时长缩放 / 移除动画」并**持续监听**变化（用户在设置里改完切回来要立刻生效）。
 *
 * 为什么读 `Settings.Global.ANIMATOR_DURATION_SCALE` 而不是别的：它是开发者选项里
 * "动画时长缩放"与无障碍"移除动画"共同的落点，值为 `0` 即表示用户要求不要动画。
 *
 * 读不到时按 `1f`（正常）处理：`Settings.Global.getFloat` 在该项不存在时抛
 * `SettingNotFoundException`，某些定制 ROM 上确实会缺 —— **不能让它把主题炸掉**。
 */
@Composable
fun rememberAnimationsEnabled(): Boolean {
    val context = LocalContext.current
    var scale by remember(context) { mutableFloatStateOf(readAnimatorScale(context)) }

    DisposableEffect(context) {
        val resolver = context.contentResolver
        val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
            /**
             * 刻意重写**单参数**版本：AOSP 里 `onChange(boolean, Uri)` 的默认实现就是
             * 转发到它，重写它能在所有 API 级别上都收到回调（只重写双参数版本的话，
             * 老系统上框架调的是单参数版本，我们反而收不到）。
             */
            override fun onChange(selfChange: Boolean) {
                scale = readAnimatorScale(context)
            }
        }
        resolver.registerContentObserver(
            Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE),
            false,
            observer,
        )
        onDispose { resolver.unregisterContentObserver(observer) }
    }

    return scale > 0f
}

private fun readAnimatorScale(context: Context): Float = runCatching {
    Settings.Global.getFloat(
        context.contentResolver,
        Settings.Global.ANIMATOR_DURATION_SCALE,
        1f,
    )
}.getOrDefault(1f)
