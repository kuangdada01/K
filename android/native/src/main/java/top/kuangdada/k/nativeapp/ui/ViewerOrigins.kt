package top.kuangdada.k.nativeapp.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.isSpecified
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import coil3.request.ImageRequest

/**
 * ============================================================
 * 「这一张图是从哪一格点开的」（ViewerOrigins）
 * ============================================================
 * 全屏看图器的进场/退场飞行**不再交给 Compose 的共享元素**（那一套在"覆盖层 ↔ 页面"这条
 * 路上真机实测不飞：元素被画在来源格的矩形上干等，落位时直接跳过去），改成查看器自己算几何：
 *
 *   1. 页面里的缩略格用 [registerViewerOrigin] 把自己的**窗口矩形**与**原图宽高比**登记在这里；
 *   2. 点开时把这些信息随 [ImageViewerRequest] 交给覆盖层（见 `rememberImageViewer`）；
 *   3. 覆盖层用 `矩形插值` 让那一张图从缩略格长到全屏、再缩回去。
 *
 * 为什么必须带**宽高比**：飞行首尾两帧要与两端**严丝合缝**地接上 ——
 * 起始帧要等于缩略格（`ContentScale.Crop` 填满格子），落位帧要等于全屏 `Fit` 的矩形。
 * 只要目标矩形是按同一个宽高比算出来的，"Crop 填满"与"Fit 完整显示"在那一帧就是同一张画面，
 * 交接时不会跳；宽高比未知时退回整个容器矩形（退化成"铺满屏幕"的裁剪，仍可用）。
 */

/**
 * 一张图的来源：缩略格在窗口里的矩形 + 原图宽高比（图还没加载出来时为 null）+ 缩略格的圆角。
 *
 * [cornerRadiusPx] 为什么也要登记：缩略格是**圆角**的（`RoundedCornerShape(KRadius.row)`），
 * 而全屏是**直角**的，飞行图必须跟着一起变 —— 出发/落位帧要与格子严丝合缝（圆角对圆角），
 * 全屏那一端才是直角。早先飞行图是个不裁剪的矩形，于是**点下去的第一帧缩略图的圆角就变成直角**、
 * 退回落位时也留着直角边（用户实测反馈："有圆角变直角，退回的时候也有直角边"）。
 */
data class ViewerOrigin(
    val rect: Rect,
    val aspect: Float?,
    /** 缩略格的圆角半径（px，窗口坐标系下的绝对值）；0 = 直角 */
    val cornerRadiusPx: Float = 0f,
)

/** 登记键：同一条帖子里第几张配图 */
private data class ViewerOriginKey(val postId: Long, val index: Int)

/**
 * 私信对话的**虚拟来源键**。
 *
 * 来源表的键本来叫 `postId`（它诞生于帖子配图），但它的真实身份其实是
 * "**这一组格子属于哪个可滚动的图片序列**"。私信图片没有帖子 id，却同样需要
 * "从哪一格飞出来"的几何（用户反馈：聊天里的图点开是直接闪现、没有详情页那种动画）。
 *
 * 这里把它映射到**负数区间**：帖子 id 在服务端恒为正，所以负数绝不会与帖子撞号 ——
 * 两者共用同一张来源表、各自的 key 空间互不干涉。做法与 `postImageKey` 把
 * "帖子 + 第几张"编成一个字符串是同一个思路：**一个稳定的、可复用的身份**。
 *
 * @param partnerId 聊天的对方用户 id（同一段对话一册来源；换人自然换表）。
 */
fun chatImageOriginKey(partnerId: Long): Long = -partnerId

/** 清掉某段对话的全部来源登记（离开聊天页时调用，避免表里留下无主矩形） */
fun ViewerOrigins.removeChatOrigins(partnerId: Long) {
    // 逐张撤不掉（不知道对方发了几张图），所以直接按 key 扫一遍表。
    // 粒度是"整组来源"，与"格子离开组合"那个 removeToken（单格粒度）互补。
    removePost(chatImageOriginKey(partnerId))
}

/**
 * 来源表。由 AppShell 持有（一处创建、一处读取），页面里的缩略格写入。
 *
 * ## 为什么每个 key 下有**多个槽位**（而不是"一个 key 一条记录"）
 *
 * 同一张图会被**两处**登记：信息流卡片的九宫格只显示前三张（index 0/1/2），详情页显示全部。
 * 于是 index 0/1/2 这两个来源会同时写同一个 key，而**矩形（布局阶段写）与宽高比（图片加载完写）
 * 是分两次、可能来自不同来源到达的**。
 *
 * 早先的实现是"一个 key 一条记录，谁最后写谁把整条替换掉"，后果是真机上量出来的这个 bug：
 * **只有第一排三张**会出现"先铺满屏幕、再缩回全屏位置" ——
 * 因为那三张的宽高比被另一处来源的矩形写入清掉了，查看器拿不到宽高比，
 * 落位矩形就退化成"整个屏幕"（`ContentScale.Crop` 铺满），交接给轮播的 `Fit` 时再缩回去。
 * 第二、三排（index 3..8）没有第二个来源，所以一切正常。
 *
 * 现在的规则是**按字段合并 + 位置取最新**：
 *  · 矩形（位置）取**最近写入**的那一份槽位 —— 它代表"用户此刻看到的那一格在哪"；
 *  · 圆角跟着矩形走（两者都是"那一格长什么样"，必须来自同一处，否则会出现
 *    "位置是详情页那格、圆角是卡片那格"这种对不上的组合）；
 *  · 宽高比是**图片自身属性**，与"从哪一格点开"无关：任意一份有就能用（分字段取值，互不清除）；
 *  · [removeToken] 只撤掉自己那一份，其他来源的那条**自动重新生效**。
 *
 * ## ★★ 2026-09-20：位置只认「**已落定**」的那一份（真机实测的"第一次打开跳变"根因）
 *
 * 上面那条"取最新写入"在**转场期间**是错的：那一小段时间里格子会被页面平移/缩放带着走，
 * 量到的是**动画中间态**。真机 logcat（OnePlus PGEM10，点开详情页后立刻点图）：
 *
 * ```
 * dump[open] idx=0 token=…4493903 seq=34 rect=(112,629,1328,2250)  ← 信息流卡片那一格（正随页面滑出）
 * dump[open] idx=0 token=…165711324 seq=35 rect=(360,629,1328,2250) ← 详情页那一格（还在滑入途中，宽高比都还没上报）
 * enter FLY src=(154,711,1359,2417)                                 ← 飞行起点：动画中间态，不是任何一格的真实位置
 * （页面落定后同样的操作：src=(56,773,1383,2542) —— 与详情格逐像素一致）
 * ```
 *
 * 用户看到的就是**第一次打开图片全屏时"跳变"**：飞行起点是一个偏移/被裁过的矩形，
 * 飞出去的那一张与背景里那一格错位（背景那一格的右侧还会露出一条竖直的缝）。
 * 退出与后续打开都正常 —— 因为那时页面早已落定，表里只剩"已落定"的那一份。
 *
 * 所以现在给每条矩形加一个**落定标记**（[Slot.stable]，由 [registerViewerOrigin] 按
 * "这一页是否还在转场"填写）：
 *  · [of] 只认**已落定**的矩形；只有转场中间态时返回 null → 查看器退化成"直接落位"
 *    （宁可没有飞行，也不从一个错位的矩形飞出来）；
 *  · 转场中间态**不覆盖**已经落定的那一份（落定后页面还会动的情况由它兜住）。
 */
@Stable
class ViewerOrigins {
    /** 一处登记（一个格子）在某个 key 下的数据槽位 */
    private class Slot(val token: Any) {
        var rect: Rect? = null
        var aspect: Float? = null

        /** 这一格的圆角（与 [rect] 同一次写入，读的时候也从胜出的那一份取） */
        var cornerRadiusPx: Float = 0f

        /**
         * 这个矩形是不是**落定**的（写它的时候，这一页已经不在转场里）。
         *
         * 只有落定的矩形才会被 [of] 选中：转场途中的矩形是动画中间态
         * （被页面平移/缩放带着走），拿它当飞行起点就是"第一次打开跳变"。
         */
        var stable: Boolean = false

        /** 最近一次写入的序号：查"位置"时用它挑最新的那一份 */
        var seq: Long = 0L
    }

    private val slots = HashMap<ViewerOriginKey, MutableList<Slot>>()

    private var seq = 0L

    private fun slot(postId: Long, index: Int, token: Any): Slot {
        val list = slots.getOrPut(ViewerOriginKey(postId, index)) { mutableListOf() }
        return list.firstOrNull { it.token === token } ?: Slot(token).also { list += it }
    }

    internal fun putRect(
        postId: Long,
        index: Int,
        token: Any,
        rect: Rect,
        cornerRadiusPx: Float = 0f,
        stable: Boolean = true,
    ) {
        slot(postId, index, token).apply {
            // 转场中间态**不许覆盖**已经落定的那一份：页面滑入滑出时格子每帧都在动，
            // 让中间态盖掉落定值，表里就只剩"动画中间的位置"了（真机实测的那个跳变）。
            if (!stable && this.stable) return
            this.rect = rect
            // 圆角与矩形**同一次写入**：它们是同一格的同一件事（布局长什么样），
            // 分开写就会出现"位置来自 A、圆角来自 B"的组合
            this.cornerRadiusPx = cornerRadiusPx
            this.stable = stable
            seq = ++this@ViewerOrigins.seq
        }
    }

    internal fun putAspect(postId: Long, index: Int, token: Any, aspect: Float) {
        slot(postId, index, token).apply {
            this.aspect = aspect
            seq = ++this@ViewerOrigins.seq
        }
    }

    /** 格子离开组合：只撤掉自己那一份（其他来源的那条要能重新生效） */
    internal fun removeToken(token: Any) {
        val it = slots.entries.iterator()
        while (it.hasNext()) {
            val list = it.next().value
            list.removeAll { s -> s.token === token }
            if (list.isEmpty()) it.remove()
        }
    }

    /**
     * 整组来源一起撤（某个 key 下的**所有**下标）。
     *
     * 与 [removeToken] 的分工：那个是"某一个格子走了"（粒度 = 单格，靠身份令牌），
     * 这个是"这组图整个不作数了"（粒度 = 组，靠 key）—— 例如离开聊天页时，
     * 那一段对话的格子全部注销，但当下**不知道对方发过几张**，逐个 removeToken 做不到。
     */
    internal fun removePost(postId: Long) {
        slots.keys.removeAll { it.postId == postId }
    }

    /** 取某条帖子的全部来源（与 images 同序，量不到矩形的位置为 null） */
    fun of(postId: Long?, count: Int): List<ViewerOrigin?> {
        if (postId == null || count <= 0) return emptyList()
        return List(count) { i ->
            val list = slots[ViewerOriginKey(postId, i)] ?: return@List null
            // 位置：最近写入的**已落定**矩形（转场中间态不算，见 putRect 与类注释）；
            // 圆角从**同一份**取（见 putRect 的注释）
            val winner = list.filter { it.rect != null && it.stable }.maxByOrNull { it.seq }
                ?: return@List null
            val rect = winner.rect ?: return@List null
            // 宽高比：任意一份有就能用（它描述的是图片本身，不是"从哪一格点开"）
            ViewerOrigin(rect, list.firstNotNullOfOrNull { it.aspect }, winner.cornerRadiusPx)
        }
    }
}

/** 为 null = 当前不在 Shell 里（预览、测试、StyleGuide）：登记与飞行都静默失效 */
val LocalViewerOrigins = staticCompositionLocalOf<ViewerOrigins?> { null }

/**
 * 把这一格缩略图的位置、取景比例与圆角登记给全屏查看器。
 *
 * 只登记、**不参与**共享元素 —— 卡片 ↔ 详情页那条飞行仍走 [sharedElementIfAvailable]。
 * 两者互不影响：查看器不再声明 `postImageKey`，所以它出现时不会把详情页那格"拉走"。
 *
 * ★★ **只有"这一页已经落定"时才写入有效矩形**（见 [ViewerOrigins] 的类注释）：
 *  · 这一页**正在出场**（用户已经不看它了）：立刻撤掉自己的登记 —— 否则下层信息流卡片
 *    那条会留在表里，被当成飞行起点（真机实测：起点比真实位置窄 179px，背景那一格的
 *    右侧露出一条竖直的缝，就是用户录屏里那条缝）；
 *  · 这一页**正在转场**（进场/出场）：写进去的是"动画中间态"，只当临时值，不覆盖落定值；
 *    落定的那一刻由下面的 [LaunchedEffect] 补写一次（`onGloballyPositioned` 只在位置
 *    变化时回调，"页面落定"未必伴随位置变化）。
 * 不在共享元素上下文里（重页面 / 预览 / 单测）时两个判据都返回 false → 一律按"已落定"处理。
 *
 * @param painter 格子自己那张图的 painter（**不要另建一个**：那会多解码一次，
 *   9 张配图就是 9 份原图内存）。宽高比在它加载完成后补记一次，点击时就能读到。
 * @param cornerRadius 这一格**自己**的圆角（与同一串 Modifier 里的 `clip(RoundedCornerShape(...))`
 *   必须一致）。**刻意不给默认值**：默认值会让"格子换了圆角、飞行没跟着换"这种错配静默发生，
 *   而这条错配在真机上就是"缩略图是圆角、点下去变直角"。
 */
@Composable
fun Modifier.registerViewerOrigin(
    postId: Long,
    index: Int,
    painter: Painter,
    cornerRadius: Dp,
): Modifier {
    val origins = LocalViewerOrigins.current ?: return this
    val token = remember(postId, index) { Any() }
    // 圆角在这里就换算成 px：登记表存的是**窗口坐标系的绝对值**（与矩形同一套单位）
    val cornerRadiusPx = with(LocalDensity.current) { cornerRadius.toPx() }
    val leaving = isPageLeaving()
    val settled = !leaving && !isPageTransitioning()
    // 最近一次量到的矩形（普通字段，不触发重组）：落定那一刻要拿它补写一次
    val lastRect = remember { RectHolder() }
    DisposableEffect(origins, token, leaving) {
        // 出场：这一页已经不是用户在看的那一页了，登记必须撤掉（下层可能还挂着同一个 key）
        if (leaving) origins.removeToken(token)
        onDispose { origins.removeToken(token) }
    }
    // 图加载出来前宽高比是未知的；加载完成后补记（否则飞行落位帧会与全屏 Fit 对不上）
    val aspect = painter.aspectOrNull()
    LaunchedEffect(origins, token, aspect) {
        if (aspect != null) origins.putAspect(postId, index, token, aspect)
    }
    // 落定那一刻补写：转场期间的最后一次布局回调通常早于"落定"，
    // 不补写的话表里就只有中间态（= 没有可用来源 → 飞行被跳过）。
    LaunchedEffect(origins, token, settled) {
        val rect = lastRect.value
        if (settled && rect != null) {
            origins.putRect(postId, index, token, rect, cornerRadiusPx, stable = true)
        }
    }
    return this.onGloballyPositioned { coords ->
        val rect = coords.boundsInWindow()
        if (rect.width > 0f && rect.height > 0f) {
            lastRect.value = rect
            origins.putRect(postId, index, token, rect, cornerRadiusPx, stable = settled)
        }
    }
}

/** 装"最近一次量到的矩形"的小盒子：故意不用 `mutableStateOf` —— 每帧写状态会白白触发重组 */
private class RectHolder {
    var value: Rect? = null
}

/** 原图宽高比（width / height）；没加载出来时为 null */
internal fun Painter.aspectOrNull(): Float? {
    val size = intrinsicSize
    if (!size.isSpecified) return null
    if (size.width <= 0f || size.height <= 0f) return null
    return size.width / size.height
}

/**
 * 缩略图的**显式内存缓存键**。
 *
 * 为什么非要显式：全屏查看器要拿"用户刚刚看的那张缩略图"当**飞行的第一帧**
 * （见 [top.kuangdada.k.nativeapp.ui.viewer.viewerImageRequest] 的 `placeholderMemoryCacheKey`）。
 * 而 Coil 自动算出来的缓存键**包含请求尺寸**，列表格与查看器尺寸不同 → 键不同 → 拿不到，占位图是空的。
 *
 * 于是两端约定同一个键：格子用 [thumbRequest] 加载（写这个键），查看器用它当占位。
 * 这不只是"好看"—— 原图（ORIGINAL）解码要几十到上百毫秒，没有占位图的话，
 * 飞行前半程那一张是**空白**的，观感就是"图突然变大一下"而不是"从缩略格飞出来"。
 */
fun thumbMemoryCacheKey(url: String): String = "k-thumb:$url"

/**
 * 缩略格的加载请求：**带显式内存缓存键**（[thumbMemoryCacheKey]），
 * 好让全屏查看器把它当飞行的占位图。
 *
 * 两端必须都走这一个函数生成请求，否则键写歪了占位图就静默失效（图会"跳"而不是"飞"）。
 *
 * ★ **走 [ImageLoading.immediate]（不让路）**：这两个格子是**共享元素的端点**，
 *   而"打开全屏查看器"本身就是动画 —— 转场期间被 [AnimationGate] 扣住的解码，
 *   结果就是"点下去先空一两帧、再糊回来"。这一条与全屏查看器自己的请求
 *   （`viewerImageRequest`）是同一条豁免理由：**它就是那个动画的一部分**。
 *
 *   注意这里**没有**钉尺寸：格子按自身尺寸请求（列表格与详情格尺寸不同、各解一份），
 *   这是有意的 —— 显式内存缓存键已经把"两端拿得到同一张"这件事保证了，
 *   而占位图只要求"有内容"，不要求像素级一致；钉死尺寸反而会让列表滚动时多解一遍原图。
 */
@Composable
fun rememberThumbRequest(url: String): ImageRequest {
    val context = LocalContext.current
    return remember(url, context) {
        ImageRequest.Builder(context)
            .data(url)
            .memoryCacheKey(thumbMemoryCacheKey(url))
            .fetcherCoroutineContext(ImageLoading.immediate)
            .decoderCoroutineContext(ImageLoading.immediate)
            .build()
    }
}
