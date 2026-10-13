package top.kuangdada.k.nativeapp.ui

import androidx.compose.runtime.Stable
import androidx.compose.ui.geometry.Rect

/**
 * ============================================================
 * 详情页内联播放器 → 沉浸全屏播放器的**交接单**（VideoHandoff）
 * ============================================================
 * 解决的真机问题（用户实测反馈）：
 *  1. 「详情页锁屏点击全屏不能续播」—— 内联播到一半点右下角全屏钮进全屏页，
 *     画面**从头开始**（还把用户已经看过的部分又放了一遍）；
 *  2. 「全屏视频进入退出没有图片全屏那种动画」—— 全屏页是硬切出来的，
 *     没有看图那种"从那一块长到全屏 / 缩回那一块"的飞行。
 *
 * ## 为什么会丢进度（根因，别再照着重写一遍）
 * 全屏页是 `AppDestination.VideoDest`，而它在 Shell 里被标成 **`isHeavyPage`** ——
 * 转场期间新旧两屏**不允许同时存在**（见 `AppShell.isHeavyPage` 的长注释：重页面
 * 同栈并存等于同一份独占资源建两遍，对视频就是第二个 ExoPlayer）。
 * 于是详情页**立刻离开了组合**，它的 `KVideoPlayer` 走 `onDispose { player.release() }`
 * —— 播放器连同当前进度一起没了。全屏页那边是新建的播放器、从 0 起播，
 * 所以"续播"这件事**没有任何一条现成的路**。
 *
 * 修法就是补一张**交接单**：详情页在"点全屏"的那一刻把"播到哪了 + 我在屏幕上的哪一块"
 * 写进来，全屏页建播放器时一次取走。
 *
 * ## 为什么连**几何**也一起交（而不是让全屏页自己现取）
 *
 * 因为取不到。详情页 → 全屏页这一步是两个渲染分支之间的**瞬间切换**
 * （`if (base.isHeavyPage)`），详情页在同一帧就离开组合，它登记的几何会随 `onDispose`
 * 一起撤掉 —— 全屏页首次组合与详情页销毁的先后顺序**没有保证**。
 * 靠"现取"就是一场竞态，真机上的表现是"飞行动画时有时无"（最难查的那种）。
 *
 * 在这里一并快照就没有这个窗口：单子是**用户在详情页上点下去的那一刻**写的，
 * 那时矩形一定还在。
 *
 * ## 为什么是进程级单例而不是随导航参数传
 * 导航状态必须**可序列化**（`encodeDest` 只写 `video:<postId>`，见 `AppNavigator`），
 * 位置与矩形这种"一次性的、有时效的值"塞进去既污染了路由契约、也无法表达
 * "这次是全屏按钮点的"。而它与 `ViewerOrigins` 是同一类东西 ——
 * **一处写入、另一处读取的进程内便签**。
 *
 * ## 时效性
 * 只在"点全屏 → 全屏页建播放器"这一小段有意义，所以：
 *  · 带 [STALE_MS] 的过期判定（进程回收后恢复导航目标时会拿到一张几小时前的旧单子 ——
 *    那时应该老老实实从头播，而不是跳到某个随机位置）；
 *  · 取是**读并清**（一次性消费），避免退出全屏再进第二次时又跳到旧位置。
 */
internal object VideoHandoff {

    /** 交接单超过这个时长就作废（一次点击到建播放器通常 < 1s，60s 给了充足余量） */
    private const val STALE_MS = 60_000L

    /** 一张交接单：交给哪条帖子、播到哪、总多长、从哪一块飞出去 */
    private class Slip(
        val postId: Long,
        val positionMs: Long,
        val durationMs: Long,
        val origin: VideoOrigin?,
        val timestampMs: Long,
    )

    private var pending: Slip? = null

    /**
     * 登记"我现在播到哪了 + 我在屏幕上的哪一块"（点全屏的那一刻调用）。
     *
     * @param positionMs 当前进度；<= 0 视为"没有可续的进度"（刚起播就点全屏）
     * @param durationMs 总时长（未知传 0）
     * @param origin 视频块在窗口里的矩形 + 圆角；量不到传 null（退化成"直接落位"）
     */
    fun offer(postId: Long, positionMs: Long, durationMs: Long, origin: VideoOrigin? = null) {
        if (postId <= 0L) return
        // 进度与几何至少要有一样，否则这张单子没有任何用处
        if (positionMs <= 0L && origin == null) return
        pending = Slip(postId, positionMs, durationMs, origin, System.currentTimeMillis())
    }

    /**
     * **一次取走**进度与飞行来源。
     *
     * 为什么只留这一个入口（而不是分别 `takePosition` / `takeOrigin`）：单子是
     * 读并清的，先取的那一步就把整张单子消费掉了，紧接着取另一样只会拿到 null ——
     * 表现是"能续播但没动画"或反过来，取决于调用顺序。这种坑很隐蔽，
     * 所以干脆不给第二个入口。
     *
     * 只认 [postId] 对得上的那一张：从 A 帖的视频进全屏、路上又切到了 B 帖
     * （深链 / 返回再进），拿 A 的进度去 seek B 的视频就是"随便跳到一个位置"，
     * 比从头播更糟。
     */
    fun take(postId: Long): Handoff {
        val slip = pending ?: return Handoff()
        pending = null
        if (slip.postId != postId) return Handoff()
        if (System.currentTimeMillis() - slip.timestampMs > STALE_MS) return Handoff()
        return Handoff(
            positionMs = slip.positionMs.takeIf { it > 0L },
            origin = slip.origin,
        )
    }

    /** 丢掉手上的单子（退出全屏、删帖这类"这条视频不作数了"的路径用） */
    fun clear() {
        pending = null
    }

    /** 一次取走的成果：可续播进度（可能为 null）+ 飞行来源（可能为 null），两者互相独立 */
    class Handoff(
        val positionMs: Long? = null,
        val origin: VideoOrigin? = null,
    )
}

/**
 * 全屏页取交接单（`postId <= 0` 时直接给空成果）。
 *
 * 单独一个函数而不是在调用处直接 `take`：`postId` 的默认值是 0（探索页那条路径不传），
 * 把"0 不查表"这条判断收在这里，比在每个调用点各写一次 `takeIf` 稳。
 */
internal fun videoFullscreenHandoff(postId: Long): VideoHandoff.Handoff {
    if (postId <= 0L) return VideoHandoff.Handoff()
    return VideoHandoff.take(postId)
}

/**
 * 详情页视频块的**来源几何**：那一块在窗口里的矩形 + 圆角 + 视频宽高比 + 封面。
 *
 * 与 [ViewerOrigin] 是同一套思路（全屏看图器靠它算飞行），只是这条路上飞的是**视频块**：
 * 内联播放器是 `AndroidView`，**不能**参与 Compose 共享元素（它不走 Compose 绘制管线、
 * 也不参与 Compose 变换，见 `KVideoPlayer` 的长注释），
 * 所以只能用"矩形插值"这条查看器已经验证过的路。
 *
 * @param rect 视频块在窗口里的矩形（点击那一刻量到的）
 * @param aspect 视频宽高比（未知时全屏页按 16:9 兜底）
 * @param cornerRadiusPx 视频块的圆角（px）—— 出发/落位帧要与它严丝合缝
 * @param coverUrl 视频封面地址（**有就画、没有就退回纯色块**）。
 *
 *   ## 为什么飞行块要画封面（真机取证后的改动）
 *   第一版飞行块只填一层主题色（`accentSoft`）。深色主题下那个颜色几乎是黑的，
 *   压在同样黑的遮罩上等于**看不见** —— 逐帧录屏证实块确实在变大，
 *   但用户报的正是"根本没有位移到全屏的动画"（看不出来 = 不存在）。
 *
 *   换成封面之后，飞行呈现的就是"详情页那一张封面图放大铺满屏幕"，
 *   与看图那条路径的观感一致，也就真的读得出位移了。
 */
data class VideoOrigin(
    val rect: Rect,
    val aspect: Float?,
    val cornerRadiusPx: Float,
    val coverUrl: String? = null,
)

/**
 * 「这一块视频现在在窗口的哪个位置」——由 [KVideoPlayer] 每帧量一次交给调用方，
 * 调用方在"点全屏"的那一刻把它打包进 [VideoHandoff]。
 *
 * 为什么用 [Stable] 的可写盒子而不是 `mutableStateOf`：这个值**每帧都在变**
 * （列表滚动、页面转场），写成 Compose 状态会让整个详情页每帧重组一次 ——
 * 代价极高而收益为零（它只在点击那一刻被读一次）。与 `ViewerOrigins` 里那个
 * `RectHolder` 是同一个取舍。
 */
@Stable
class VideoRectProbe {
    /** 最近一次量到的矩形（窗口坐标）；还没量到时为 null */
    var rect: Rect? = null
        internal set

    /** 圆角（px）；与 [rect] 同一次写入（两者都是"这一块长什么样"） */
    var cornerRadiusPx: Float = 0f
        internal set

    /**
     * 打包成交给全屏页的来源。
     *
     * @param aspect 视频宽高比；未知传 null
     * @param coverUrl 视频封面（有就画在飞行块上，见 [VideoOrigin.coverUrl]）
     * @return 还没量到矩形时返回 null（全屏页据此退化成"直接落位"）
     */
    fun toOrigin(aspect: Float? = null, coverUrl: String? = null): VideoOrigin? {
        val r = rect ?: return null
        if (r.width <= 0f || r.height <= 0f) return null
        return VideoOrigin(r, aspect, cornerRadiusPx, coverUrl)
    }

    /** 记一次测量结果（由 [KVideoPlayer] 的 `onGloballyPositioned` 调用） */
    internal fun update(rect: Rect, cornerRadiusPx: Float) {
        this.rect = rect
        this.cornerRadiusPx = cornerRadiusPx
    }
}
