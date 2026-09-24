package top.kuangdada.k.nativeapp.ui

import androidx.compose.animation.AnimatedVisibilityScope
import androidx.compose.animation.EnterExitState
import androidx.compose.animation.SharedTransitionScope
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import top.kuangdada.k.core.designsystem.theme.KMotion

/**
 * ============================================================
 * 共享元素（M3）
 * ============================================================
 * 共享元素转场的两个端点分别在**相隔好几层的两个页面里**（例如信息流卡片里的配图
 * 与帖子详情页里的同一张图）。androidx 的做法是让两端各自用同一个 key 调
 * `Modifier.sharedBounds(...)`，并且**两端必须共享同一个 `SharedTransitionScope`
 * 与同一个 `AnimatedVisibilityScope`**。
 *
 * 传这两个作用域有两条路：
 *  1. 把 `SharedTransitionScope` 当参数一路透传 —— 要改 6 个屏幕的签名，且永远不知道
 *     以后会不会再多一层容器；
 *  2. 用 CompositionLocal 在 Shell 层注入，叶子组件自己按 key "认领"。
 *
 * 这里选 2：叶子只需要一行 `Modifier.sharedBoundsIfAvailable(key)`，
 * 而且**在没有共享元素上下文时自动退化为普通 Modifier**（比如 StyleGuide 里单独渲染
 * 一张卡片、或重页面走 MotionEnterOnce 那条路）—— 叶子组件不需要任何 null 判断。
 *
 * 关键：`SharedTransitionLayout` 必须是**源与目标的共同祖先**，所以它包在 AppShell 的
 * `AnimatedContent` 外面；`AnimatedVisibilityScope` 则取 `AnimatedContent` 内容 lambda 的
 * 接收者（`AnimatedContentScope : AnimatedVisibilityScope`）。
 */
data class SharedElementScopes(
    /** 由 AppShell 的 `SharedTransitionLayout` 提供 */
    val transition: SharedTransitionScope,
    /** 由 AppShell 的 `AnimatedContent` 内容 lambda 提供 */
    val visibility: AnimatedVisibilityScope,
)

/** 为 null = 当前不在可做共享元素转场的上下文里（重页面、独立预览、测试等） */
val LocalSharedElementScopes = staticCompositionLocalOf<SharedElementScopes?> { null }

/**
 * 共享元素是否**正在飞**（`SharedTransitionScope.isTransitionActive`）。
 *
 * 给谁用：**不参与 Compose 变换的东西** —— 目前只有视频播放器（`AndroidView`）。
 *
 * `AndroidView` 是真实的 Android View，页面在滑的时候它**钉在布局位置上不动**，
 * 于是只要它在转场期间存在，就会看到两种怪象（都是真机实测）：
 *  · **进入**：目标位置先出现一个黑色播放器框"等"封面飞过来；
 *  · **退出**：黑底跟着页面滑走了，但**视频画面留在原地**（残留）。
 *
 * 所以规则是：**它飞的时候，让播放器根本不存在**。
 * 注意"藏起来"不管用 —— `alpha` / `graphicsLayer` 对 `AndroidView` 无效（实测过一轮）。
 *
 * 为什么不用页面自己的 `EnterExitState`：**打断返回动画、立刻再进同一页**时，
 * `AnimatedContent` 复用同一份内容实例、把出场动画倒着播回来，那一刻
 * `currentState` 与 `targetState` 都还是 `Visible` —— 从页面状态上看不出"正在飞"，
 * 但共享元素确实在飞。这个信号三种情况（进入 / 退出 / 打断重进）全覆盖。
 *
 * **但它不足以单独判断"退出"**（真机反馈·第三轮）：返回时 `isTransitionActive` 是
 * 共享元素**匹配上之后**才为真的，而播放器要在**匹配之前的那几帧**就不存在 ——
 * 那几帧里它已经组合出来了，看到的正是"黑框在等"。所以退出这条路还要叠加
 * [isPageLeaving]（页面自己的出场状态），两个信号任一为真都不能组合播放器。
 */
@Composable
fun isSharedTransitionActive(): Boolean =
    LocalSharedElementScopes.current?.transition?.isTransitionActive == true

/**
 * 当前这一页**正在出场**（返回动画进行中）。
 *
 * 判据是页面自己的 `AnimatedVisibilityScope.transition.targetState == PostExit` ——
 * 与 [isSharedTransitionActive] 互补，理由见那边的注释：
 *  · 它与"共享元素有没有匹配上"无关，**转场一开始就为真**，所以能盖住匹配之前的那几帧；
 *  · 它管不了"打断返回动画、立刻再进同一页"（那种情况下状态还是 `Visible`），
 *    那种交给 [isSharedTransitionActive]。
 * 两者都不是"够用"的，**合起来才够**（真机上两头都踩过）。
 */
@Composable
fun isPageLeaving(): Boolean {
    val visibility = LocalSharedElementScopes.current?.visibility ?: return false
    return visibility.transition.targetState == EnterExitState.PostExit
}

/**
 * 当前这一页**正处在转场里**（进场或出场，转场一开始就为真）。
 *
 * 为什么还需要第三个信号（与 [isSharedTransitionActive] / [isPageLeaving] 并列）：
 *  · [isSharedTransitionActive] 要等共享元素**匹配上**才为真 —— 转场刚起步的那几帧是空窗；
 *  · [isPageLeaving] 只覆盖**出场**那一侧；
 *  · 而**目标端**（返回时的信息流卡片、进入时的详情页）既不是"正在出场"、匹配也还没发生，
 *    它却已经在自己的最终位置上把内容画出来了（真机反馈："退出到主页有播放器/封面在等动画飞过去"）。
 *
 * 判据与 AppShell 里给 `AnimationGate` 用的是同一个（`currentState != targetState`）：
 * 它对**两侧**都成立，而且**转场的第一帧就成立**，正好补上那个空窗。
 */
@Composable
fun isPageTransitioning(): Boolean {
    val visibility = LocalSharedElementScopes.current?.visibility ?: return false
    return visibility.transition.currentState != visibility.transition.targetState
}

/**
 * 当前这一页**正在进场**（它是这趟转场的目标端）。
 *
 * 与 [isPageLeaving] 对称：一个说"我在出场"、一个说"我在进场"。
 * 用途见 [shouldPreHideSharedElement]：**目标端不该在飞行接上之前就把元素画在自己的位置上**。
 */
@Composable
fun isPageEntering(): Boolean {
    val visibility = LocalSharedElementScopes.current?.visibility ?: return false
    return visibility.transition.currentState == EnterExitState.PreEnter
}

/**
 * 「这个共享 key 现在有几处声明」——回答"**对面那一端在不在**"。
 *
 * 为什么需要它：`sharedElement` 的原地绘制是被 `boundsTransformIsActive` 关掉的，
 * 而那个标志要**匹配上之后**才为真（1.12.1 字节码：`shouldRenderInPlace =
 * !(boundsTransformIsActive && shouldRenderInOverlay) && shouldRenderAtAll`）。
 * 所以在"转场已开始、共享元素还没匹配上"的那一小段里，**两端都会原地画一份**：
 * 返回信息流时，卡片那个视频位会**先自己把封面画出来**，飞行的那一份再飞过去
 * （真机反馈："有播放器还是封面在等动画飞过去"）。
 *
 * 修法：目标端在那一段里**把自己藏起来**（透明，但节点仍在 —— 匹配还得靠它）。
 * 藏起来这件事必须做在**祖先节点**上，不能做在元素自己的链上：
 * 覆盖层只保留元素自身链上的修饰符，祖先的 alpha / clip 不跟进去
 * （同一结论在 `PostCard.VideoCover` 的圆角注释里记过一次，真机验证过）。
 *
 * 但要先确认"对面真的有一端" —— 否则**没有对手的转场**（切 tab、从搜索页返回首页等）
 * 会让封面白白消失两百毫秒。所以这里查 [SharedElementPeers] 的声明计数。
 *
 * @return true = 现在应该把这个元素藏起来（透明）等飞行接上
 */
@Composable
fun shouldPreHideSharedElement(key: Any): Boolean {
    val peers = LocalSharedElementPeers.current ?: return false
    // 对面那一端在（同一个 key 有两处声明）才谈得上"等它飞过来"
    if (!peers.hasCounterpart(key)) return false
    // 已经接上了：该由框架接管绘制（原地那一份它自己会关掉），别再插一脚
    if (isSharedTransitionActive()) return false
    // 只有"我是目标端"时才藏：源端要一直画着，直到飞行把它接走
    return isPageEntering()
}

/**
 * 共享元素的**声明计数表**（由 Shell 持有，见 [declareSharedPeer]）。
 *
 * 与 `ViewerOrigins` / `AvatarShareState` 同一类东西：一处创建、多处写入、按 key 读。
 * 它只回答一个问题 —— "**除了我，还有别的端在声明这个 key 吗**"，
 * 用来判断"会不会真的有一条飞行"（见 [shouldPreHideSharedElement]）。
 */
@Stable
class SharedElementPeers {
    private val counts = androidx.compose.runtime.mutableStateMapOf<Any, Int>()

    internal fun declare(key: Any) {
        counts[key] = (counts[key] ?: 0) + 1
    }

    internal fun release(key: Any) {
        val next = (counts[key] ?: 1) - 1
        if (next <= 0) counts.remove(key) else counts[key] = next
    }

    /** 这个 key 现在**有对手**吗（>= 2 处声明） */
    fun hasCounterpart(key: Any): Boolean = (counts[key] ?: 0) >= 2
}

/** 为 null = 当前不在共享元素上下文里（重页面、预览、测试）：登记与读取都静默失效 */
val LocalSharedElementPeers = staticCompositionLocalOf<SharedElementPeers?> { null }

/**
 * 声明"这一处也挂了 [key]"（随组合进出自动成对）。
 *
 * 必须与 `sharedElementIfAvailable(key)` **挂在同一个元素上**，否则计数会与实际情况对不上。
 */
@Composable
fun Modifier.declareSharedPeer(key: Any): Modifier {
    val peers = LocalSharedElementPeers.current ?: return this
    DisposableEffect(peers, key) {
        peers.declare(key)
        onDispose { peers.release(key) }
    }
    return this
}

/**
 * 按 [key] 参与共享元素转场；**不在共享元素上下文里时原样返回 `this`**。
 *
 * @param overlayClip 飞行期间在覆盖层里的裁剪。默认 [NoOverlayClip]（不裁）。
 *        顶栏那一端要传 [topBarOverlayClip]，见那里的长注释。
 *        ⚠️ 只在 [renderInOverlay] = true 时有意义——元素不进覆盖层就无所谓裁剪。
 * @param renderInOverlay 对应库的 `renderInOverlayDuringTransition`（默认 true = 飞行那份画进
 *        `SharedTransitionScope` 的覆盖层、**原地留白**）。
 *
 *        ⚠️⚠️ **2026-09-24：不要给 `sharedElement` 传 `false`**（帖子里配图与视频封面都曾误传过）。
 *        库源码 1.12.1（`SharedElementEntry.kt` 226-238）写得明确：
 *        ```
 *        shouldRenderInOverlay = shouldRenderAtAll && boundsTransformIsActive && isEnabled &&
 *                                renderInOverlayDuringTransition && (isTransitionActive || isMutating)
 *        shouldRenderInPlace   = !boundsTransformIsActive || (!shouldRenderInOverlay && shouldRenderAtAll)
 *        ```
 *        而 `sharedElement` 的 `renderOnlyWhenVisible = true` → 源端的 `shouldRenderAtAll` 在飞行期为
 *        false（内容改由"飞行那份"提供）。**一旦 `renderInOverlayDuringTransition = false`：
 *        `shouldRenderInOverlay` 恒为 false → "飞行那份"根本不存在**，只剩目标端在原地画。
 *        结果 = 屏幕上同时有两份图（源端位置一份 + 目标端位置一份），没有任何东西在飞。
 *        真机逐帧取证（`KFLY` 探针）就是这个形状：`img-card draw#2..27` 与 `img-detail f=0..26`
 *        **一路交替**，直到转场结束 —— 用户描述为"进详情页闪一下"。
 *
 *        09-23 之所以传 `false`，是想让"进详情后立刻上滑长图"时顶栏毛玻璃有内容可采样
 *        （页面里那格不留白）。**正确的修法是让顶栏在转场期间降级成纯色**（
 *        `rememberTopBarGlass(canBlur = canBlur && !isPageTransitioning(), …)`，见 PostDetailScreen），
 *        而不是牺牲飞行本身。
 *
 *        库里的参数名是 `clipInOverlayDuringTransition`（不是 `overlayClip` —— 名字差一点就会
 *        `NAMED_PARAMETER_NOT_FOUND` 编译失败），这里对外仍叫 `overlayClip`，因为它就是"覆盖层里的裁剪"。
 */
@Composable
fun Modifier.sharedElementIfAvailable(
    key: Any,
    overlayClip: SharedTransitionScope.OverlayClip = NoOverlayClip,
    renderInOverlay: Boolean = true,
): Modifier {
    val scopes = LocalSharedElementScopes.current ?: return this
    with(scopes.transition) {
        return this@sharedElementIfAvailable.sharedElement(
            rememberSharedContentState(key),
            scopes.visibility,
            boundsTransform = KMotion.boundsTransform,
            renderInOverlayDuringTransition = renderInOverlay,
            clipInOverlayDuringTransition = overlayClip,
        )
    }
}

/**
 * 「不裁剪」的 [SharedTransitionScope.OverlayClip]。
 *
 * 单独写一个是因为 `sharedElement(...)` 的 `clipInOverlayDuringTransition` 参数**不接受 null**，
 * 而我们需要"可选"这个语义。行为与库默认的 `ParentClip` 在没有父共享内容时一致（返回 null = 不裁）。
 */
val NoOverlayClip: SharedTransitionScope.OverlayClip = object : SharedTransitionScope.OverlayClip {
    override fun getClipPath(
        sharedContentState: SharedTransitionScope.SharedContentState,
        bounds: Rect,
        layoutDirection: LayoutDirection,
        density: Density,
    ): Path? = null
}

/**
 * ============================================================
 * 「**顶栏那一条不许被飞行元素盖住**」的裁剪（顶栏底边 = [topBarBottomPx]，窗口像素）
 * ============================================================
 *
 * 现象（用户实测反馈）：**从首页点配图进详情页后立刻快速上滑**，顶栏会整条被那张配图
 * 盖住（连状态栏那一条一起），滚停了才"重新显示"出来；慢滑、或等转场结束再滑都不触发。
 *
 * 机理：配图这条共享元素在飞行期间被画进 `SharedTransitionScope` 的**覆盖层**，
 * 而覆盖层永远画在页面内容（含顶栏）**之上**。快速上滑会让配图在页面里的**目标位置**
 * 一路移到顶栏那一条上，飞行中的那一份于是跟着压在顶栏上；等飞行落地，配图改回
 * 页面内绘制（在顶栏之下），顶栏就"重新显示"了。
 *
 * 修法与全屏查看器**同一条思路**（见 `ImageViewer.kt` 的 `topInsetPx` 与
 * `FlyingImage.topClipPx`）：**不是改透明度，而是把顶栏那一条从绘制里裁掉** ——
 * 顶栏区域于是露出页面自己画的顶栏，观感正是"图片钻到顶栏后面"，
 * 与页面内滚动时图片穿过顶栏的表现一致。
 *
 * ⚠️ 为什么只能裁飞行元素、不能给顶栏加 z：**顶栏必须留在页面里**（它要跟着页面转场一起
 * 滑动；`renderInSharedTransitionScopeOverlay` 会丢掉父层的转场变换，页面一滑顶栏就会"钉住"）。
 * 覆盖层永远在页面之上，所以只剩"裁掉飞行元素越界的那一条"这一条路。
 *
 * ⚠️ 只挂在**详情页那一端**：飞行期间真正在覆盖层里画的是**目标端**那一份
 * （库的 `shouldRenderAtAll = boundsAnimation.target`，而 `target` = 这一页正在**进场**）。
 * 进详情页时目标端是详情页 → 用这里的裁剪；返回信息流时目标端是卡片那端（[NoOverlayClip]）
 * → 退出方向一点不受影响。
 *
 * ⚠️⚠️ **每次调用都新建 `Path`**（不学库的 `ShapeBasedClip` 复用同一个对象）：
 * 库把 `getClipPath` 的返回值**存进条目、留到同一帧的 `drawInOverlay` 才用**
 * （`SharedContentNode.draw()` → `clipPathInOverlay` → `SharedElementEntry.drawInOverlay`）。
 * 复用同一个 `Path` 时，只要同一帧里有两个元素共用这个实例，**后一次会把前一次的路径覆盖掉**，
 * 前一个元素就会被按别人的矩形裁掉。详情页里配图 / 视频封面本来就共用同一份裁剪，
 * 所以这里必须无状态。代价只是飞行期间每帧多几个 `Path` 分配，可忽略。
 *
 * @param topBarBottomPx 顶栏底边（窗口像素）。返回 0 = 不避让（顶栏还没量出来）。
 */
fun topBarOverlayClip(topBarBottomPx: () -> Float): SharedTransitionScope.OverlayClip =
    object : SharedTransitionScope.OverlayClip {
        override fun getClipPath(
            sharedContentState: SharedTransitionScope.SharedContentState,
            bounds: Rect,
            layoutDirection: LayoutDirection,
            density: Density,
        ): Path? {
            val top = topBarBottomPx()
            // 不避让、或元素整个在顶栏之下：不裁（返回 null 最省，也保证"没越过顶栏时逐像素不变"）
            if (top <= 0f || bounds.top >= top) return null
            // 库要求返回的 Path 在 SharedTransitionScope 坐标系里（= 窗口坐标），
            // 所以直接用 bounds 的横向范围 + 顶栏底边，而不是"本地坐标 + 平移"。
            return Path().apply {
                addRect(Rect(bounds.left, top, bounds.right, bounds.bottom.coerceAtLeast(top)))
            }
        }
    }

/**
 * 按 [key] 参与共享元素转场；**不在共享元素上下文里时原样返回 `this`**。
 *
 * `boundsTransform` 用 [KMotion.boundsTransform]（M1 定义的弹簧档）——
 * 位置与尺寸一起弹簧过去，且与其他转场共用同一套手感参数。
 *
 * ⚠️ **`sharedBounds` 与 `sharedElement` 的区别是"飞行期间两端各自怎么画"**（真机实测 + 1.12.1 字节码）：
 *  · `sharedBounds`（下面这个）：两端**都留在原地画**，只有"边界"在动。
 *    → **目标端会在自己的最终位置上一直画着**：从详情返回时，信息流卡片的视频位**先自己显示封面**
 *    在那儿等着，飞行的那一份再落上去（用户反馈："播放器还没到位就有图在原位置等待"）。
 *  · `sharedElement`（上面那个）：飞行期间元素被画进**覆盖层**，原地**不画**。
 *    → 返回时目标位是空的，只有飞行的那一份，等它落位。
 *
 * 所以：**内容会"位移"的元素用 [sharedElementIfAvailable]**（视频/图片封面这种整块搬家的）；
 * `sharedBounds` 留给"原地变形"的场景。
 */
@Composable
fun Modifier.sharedBoundsIfAvailable(key: Any): Modifier {
    val scopes = LocalSharedElementScopes.current ?: return this
    with(scopes.transition) {
        // 前两个参数按位置传：接口里它们的名字与顺序以 1.12.1 的签名为准
        // （`sharedBounds(modifier, sharedContentState, animatedVisibilityScope, boundsTransform, …)`），
        // 用位置传可以避免把参数名记错。
        val contentState = rememberSharedContentState(key)
        return this@sharedBoundsIfAvailable.sharedBounds(
            contentState,
            scopes.visibility,
            boundsTransform = KMotion.boundsTransform,
        )
    }
}

/**
 * 帖子配图的共享 key。**两端必须调用同一个函数**生成 key ——
 * 手写字符串字面量是最容易出错的地方（少个短横线就是"图从屏幕角落飞进来"这种诡异现象）。
 */
fun postImageKey(postId: Long, index: Int): String = "post-img-$postId-$index"

/**
 * 头像的共享 key（卡片/详情页作者头像 ↔ 对方主页的头像）。
 *
 * 为什么 key 里只有 userId、没有 postId：**目标页（对方主页）只知道 userId** ——
 * 它拿不到"你是从哪条帖子点进来的"。所以发起端要额外被"点名"，见 [AvatarShareState]。
 */
fun avatarKey(userId: Long): String = "avatar-$userId"

/**
 * 「头像共享元素」的点名状态：记录**这一次飞行是谁发起的、要落到谁身上**。
 *
 * 为什么需要它：key 只能写成 `avatar-$userId`（见上），但同一屏里**很可能有同一个作者的
 * 多张卡片** —— 那就会有多个节点声明同一个 key，共享元素会匹配到错的那个
 * （表现为"头像从另一张卡的位置飞过来"）。所以用"发起者身份"把声明权
 * **限定在一个节点上**。三个字段合起来回答"这个头像该不该声明 key"。
 *
 * [origin] 不是多余的：信息流卡片和帖子详情里的作者头像**用的是同一个 key**，
 * 而"卡片 → 帖子详情"这条转场里两端都会组合。只按 (userId, sourcePostId) 判断的话，
 * 从卡片进详情时两端同时声明 → 头像会**飞进帖子详情页的作者行**（真机上就是这么错的）。
 * 加上来源类型后，卡片只认卡片的点名、详情只认详情的点名，两条路径互不干扰。
 *
 * **过期的状态不是"无害"，而是"错飞"**：早先这里不清状态，点头像进主页之后状态一直留着，
 * 下次点**同一条帖子的卡片**进详情时源端继续声明 → 头像飞进详情页。所以离开对方主页时
 * 必须 [clear]（见 [AvatarFlyer.clear] 与 `UserProfileScreen` 的 `DisposableEffect`）。
 */
class AvatarShareState {
    /** 这次要飞向谁的主页 */
    var userId by mutableStateOf(0L)

    /** 从哪条帖子发起的（null = 当前没有点名中的飞行） */
    var sourcePostId by mutableStateOf<Long?>(null)

    /** 发起端是哪一类页面 */
    var origin by mutableStateOf(AvatarShareOrigin.Card)

    /** 点名：写下发起端身份。发起端必须在**导航之前**调用（见 [AvatarFlyer.fly]）。 */
    fun arm(userId: Long, postId: Long, origin: AvatarShareOrigin) {
        this.userId = userId
        this.sourcePostId = postId
        this.origin = origin
    }

    /** 撤销点名 */
    fun clear() {
        sourcePostId = null
    }

    /** 发起端该不该声明 key */
    fun isSource(userId: Long, postId: Long, origin: AvatarShareOrigin): Boolean =
        sourcePostId == postId && this.userId == userId && this.origin == origin

    /** 目标端（对方主页）该不该声明 key —— 它只知道 userId，所以只比这一项 */
    fun isTarget(userId: Long): Boolean = sourcePostId != null && this.userId == userId
}

/** 发起这次头像飞行的页面类型（见 [AvatarShareState.origin]） */
enum class AvatarShareOrigin {
    /** 列表里的帖子卡片（首页 / 探索 / 主页作品列表…） */
    Card,

    /** 帖子详情页里的作者行 */
    Detail,
}

/** 由 Shell 提供；为 null = 当前上下文不做头像共享元素（重页面、预览、测试） */
val LocalAvatarShareState = staticCompositionLocalOf<AvatarShareState?> { null }

/**
 * 头像共享元素的**发起端入口**：把"判断该不该声明 key / 点名 / 导航"三件事收在一处，
 * 调用方（卡片、详情页作者行、对方主页）各写一行即可。
 *
 * 为什么"点名"和"导航"必须隔两帧（[fly] 里那段 `withFrameNanos`）：
 * 写状态只是让发起端**失效**，它要下一轮组合才会把 `Modifier.sharedBounds(key)` 挂上去；
 * 而导航会让目标页**立刻**组合。两者撞在同一帧时，目标页组合的那一刻源端还没声明 key，
 * 共享元素匹配不上 → **头像根本不飞**。真机上的表现正是这样：点头像只是一次普通转场，
 * 而"上一次遗留下来、早就声明好的状态"反而会错飞一次。
 * 连等两帧保证：第 1 帧完成发起端的重新组合，第 2 帧它已经落进共享元素目录。
 */
@Stable
class AvatarFlyer internal constructor(
    private val state: AvatarShareState?,
    private val scope: CoroutineScope,
) {
    /** 作为发起端：该不该声明 key */
    fun isSource(userId: Long, postId: Long, origin: AvatarShareOrigin): Boolean =
        state?.isSource(userId, postId, origin) == true

    /** 作为目标端（对方主页）：该不该声明 key */
    fun isTarget(userId: Long): Boolean = state?.isTarget(userId) == true

    /** 点名 → 等两帧 → 导航。没有共享元素上下文时退化成直接导航。 */
    fun fly(userId: Long, postId: Long, origin: AvatarShareOrigin, open: () -> Unit) {
        if (state == null) {
            open()
            return
        }
        state.arm(userId, postId, origin)
        scope.launch {
            withFrameNanos { }
            withFrameNanos { }
            open()
        }
    }

    /** 撤销点名。**离开目标页时必须调用**，否则状态会留到下一次无关的跳转里错飞。 */
    fun clear() {
        state?.clear()
    }
}

/**
 * 取得当前上下文的头像飞行器。
 * 不在共享元素上下文里（重页面 / 预览 / 测试）时，[AvatarFlyer.isSource] 恒为 false、
 * [AvatarFlyer.fly] 直接导航 —— 调用方不需要任何 null 判断。
 */
@Composable
fun rememberAvatarFlyer(): AvatarFlyer {
    val state = LocalAvatarShareState.current
    val scope = rememberCoroutineScope()
    return remember(state, scope) { AvatarFlyer(state, scope) }
}

/** 图书封面的共享 key（列表卡片 ↔ 图书详情） */
fun bookCoverKey(bookId: String): String = "book-cover-$bookId"

/**
 * 视频封面的共享 key（信息流卡片 ↔ 帖子详情的内联播放器）。
 *
 * **两端挂的都必须"封面图"这个 Compose 元素，绝不能挂在播放器容器上**：
 * 共享元素在转场期间被画进 `SharedTransitionScope` 的覆盖层，而播放器是
 * `AndroidView`（`PlayerView` + SurfaceView/TextureView），渲染路径绕开 Compose ——
 * 丢进覆盖层的结果是黑块、或者屏幕上出现第二个播放器实例。
 * （同一个坑的另一面见 `res/values/styles.xml` 里 `surface_type=texture_view` 的注释。）
 */
fun postVideoKey(postId: Long): String = "post-video-$postId"
