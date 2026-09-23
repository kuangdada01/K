package top.kuangdada.k.nativeapp.ui

import android.os.Process
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.util.Collections
import java.util.concurrent.Executors

/**
 * ============================================================
 * 「动画优先」闸门（AnimationGate + ImageLoading）
 * ============================================================
 * 用户要求：**动画优先，加载内容给动画让步**。
 *
 * 掉帧的成因往往不是动画本身，而是**动画与图片加载抢 CPU**：一次转场里新页面刚进组合，
 * 十几张图同时开始取网络 + 解码，解码线程池默认可以开到几十个线程，UI/RenderThread 拿不到
 * 时间片 → 动画就"顿"。所以这里做两件事：
 *
 *  1. [ImageLoading]：图片加载走**自己的线程池**（固定 3 线程 + `THREAD_PRIORITY_BACKGROUND`）。
 *     并发有上限、优先级低于 UI，动画帧永远优先拿到 CPU；
 *  2. [AnimationGate]：**页面转场 / 查看器飞行**进行期间，新派发的加载任务在门口排队，
 *     动画结束后再放行（在后台协程里挂起，不占用任何线程；"已经在飞"的请求不受影响）。
 *
 * 为什么闸门做在**调度器**上而不是 Coil 的拦截器里：拦截器会连"内存缓存命中"一起挡住 ——
 * 那样查看器自己那张图也会被挡在门外，飞行途中就是一片空白。做在 fetcher/decoder 上则
 * 只挡"真正要干活的"（取网络/解码）那一层，内存命中的图照常立刻返回。
 *
 * 查看器自己的请求（[top.kuangdada.k.nativeapp.ui.viewer.viewerImageRequest]）用
 * [ImageLoading.immediate]：它**就是**那个动画，不能给自己让路。
 *
 * 安全阀：闸门最多扣住 [GATE_MAX_HOLD_MS]，超时无条件放行 —— 万一某条路忘了 end，
 * 表现也只是"图晚 1.5 秒出来"，而不是"图永远不加载"。
 */
object AnimationGate {

    /** 安全阀：任何被扣住的加载任务最多等这么久 */
    private const val GATE_MAX_HOLD_MS = 1500L

    /** 正在进行中的动画/转场（用"令牌集合"而不是布尔：转场与飞行可能同时存在） */
    private val reasons: MutableSet<Any> = Collections.synchronizedSet(mutableSetOf())

    private val busyFlow = MutableStateFlow(false)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    val busy: Boolean get() = busyFlow.value

    /** 进入动画：token 必须是**稳定的身份**（同一处动画反复 begin 不会重复计数） */
    fun begin(token: Any) {
        if (reasons.add(token)) busyFlow.value = true
    }

    /** 离开动画：与 [begin] 必须成对（用 DisposableEffect 保证 dispose 时一定 end） */
    fun end(token: Any) {
        if (reasons.remove(token)) busyFlow.value = reasons.isNotEmpty()
    }

    /** 闸门开着时挂起（在后台协程里用，不阻塞线程） */
    suspend fun awaitIdle() {
        busyFlow.first { !it }
    }

    /** 闸门开了（或超时）之后执行一次，用于把被扣住的任务重新派发出去 */
    fun afterIdle(action: () -> Unit) {
        if (!busy) {
            action()
            return
        }
        scope.launch {
            withTimeoutOrNull(GATE_MAX_HOLD_MS) { busyFlow.first { !it } }
            action()
        }
    }
}

/**
 * 动画期间**把加载任务停在门口**的调度器。
 *
 * 与 `dispatcher.dispatch` 的语义差别只有一点：闸门开着时**不立刻派发**，而是等它开了再派发。
 * 因为只是"延后派发"（不是占着线程等），所以不会造成线程饥饿。
 */
class YieldToAnimationDispatcher(private val delegate: CoroutineDispatcher) : CoroutineDispatcher() {

    override fun dispatch(context: kotlin.coroutines.CoroutineContext, block: Runnable) {
        if (!AnimationGate.busy) {
            delegate.dispatch(context, block)
            return
        }
        AnimationGate.afterIdle { delegate.dispatch(context, block) }
    }
}

/**
 * 图片加载的执行环境。
 *
 * 线程数取 3：足够让列表滚动时"一张接一张"地出图，又不会把 8 个核全占了
 * （Coil 默认的 `Dispatchers.IO` 在突发时可能开出几十个线程，那正是动画掉帧的元凶）。
 */
object ImageLoading {

    private val pool = Executors.newFixedThreadPool(3) { runnable ->
        Thread(runnable, "k-image").apply {
            // 让内核把 CPU 让给 UI/RenderThread：图片慢一点出没关系，动画不能掉帧
            priority = Process.THREAD_PRIORITY_BACKGROUND
        }
    }

    private val dispatcher: CoroutineDispatcher = pool.asCoroutineDispatcher()

    /** 普通加载（信息流卡片 / 详情配图 / 封面 / 头像）：动画期间排队 */
    val gated: CoroutineDispatcher = YieldToAnimationDispatcher(dispatcher)

    /** 动画自己的图（全屏查看器里那一张）：不排队 —— 它慢一步，动画就没画面了 */
    val immediate: CoroutineDispatcher = dispatcher
}
