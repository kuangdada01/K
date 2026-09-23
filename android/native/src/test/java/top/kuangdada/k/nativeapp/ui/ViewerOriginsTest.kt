package top.kuangdada.k.nativeapp.ui

import androidx.compose.ui.geometry.Rect
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 「这一张图从哪一格点开的」登记表（M5.2）。
 *
 * 这张表是进场/退场飞行的**唯一数据源**：查不到 → `sourceRect == null` → 查看器退化成"直接落位"
 * （用户看到的就是"没有飞、图直接出现在全屏"）。这一类问题在真机上很难定位
 * （页面看起来"正常"，只是没动画），所以这里把四条约定钉死。
 *
 * 三个真实存在的场景，每一条都对应一个测试：
 *  1. 同一条帖子多张图：**每张各自的矩形**（退场要飞回"当前这一张"）；
 *  2. 信息流卡片与详情页在转场期间**同时登记同一个 key**（同一个 postId + index）：
 *     后登记的（正在看的那一页）必须胜出，且**先离开组合的那一处只能撤掉自己那一条**；
 *  3. 矩形与宽高比是**分别**在布局与图片加载完成时写进来的：只写了一半也必须能读出来；
 *  4. **M5.4**：同一个 key 被两处来源先后写过时，宽高比必须**按字段合并**、不能被后到的
 *     "只写矩形"清掉 —— 清掉的后果就是真机反馈的"先铺满屏幕、再缩回全屏位置"
 *     （用户实测：只有第一排三张与单图会犯，因为那几个 index 同时被卡片与详情页登记）。
 */
class ViewerOriginsTest {

    private val post = 42L

    @Test
    fun returns_each_images_own_rect() {
        val origins = ViewerOrigins()
        origins.putRect(post, 0, Any(), Rect(0f, 0f, 100f, 100f))
        origins.putRect(post, 1, Any(), Rect(200f, 0f, 300f, 100f))

        val list = origins.of(post, 2)
        assertEquals(Rect(0f, 0f, 100f, 100f), list[0]?.rect)
        assertEquals(Rect(200f, 0f, 300f, 100f), list[1]?.rect)
    }

    @Test
    fun missing_index_reads_as_null() {
        val origins = ViewerOrigins()
        origins.putRect(post, 0, Any(), Rect(0f, 0f, 10f, 10f))

        val list = origins.of(post, 3)
        assertEquals(10f, list[0]!!.rect.width, 0.01f)
        assertNull(list[1])
        assertNull(list[2])
    }

    @Test
    fun unknown_post_reads_as_null() {
        val origins = ViewerOrigins()
        origins.putRect(post, 0, Any(), Rect(0f, 0f, 10f, 10f))
        assertNull(origins.of(7L, 1).first())
        // postId 为 null（来源不是帖子配图）时也必须是空，而不是命中别人的格子
        assertTrue(origins.of(null, 2).isEmpty())
    }

    /** 同一个 key 被两处登记（卡片 + 详情页）：胜出的是**后写**的那一处 */
    @Test
    fun later_registration_wins_for_the_same_key() {
        val origins = ViewerOrigins()
        val cardToken = Any()
        val detailToken = Any()
        origins.putRect(post, 1, cardToken, Rect(0f, 0f, 10f, 10f))
        origins.putRect(post, 1, detailToken, Rect(50f, 50f, 90f, 90f))

        assertEquals(Rect(50f, 50f, 90f, 90f), origins.of(post, 2)[1]?.rect)
    }

    /** 卡片离开组合时不能把详情页那条一起删掉（否则详情页就飞不起来了） */
    @Test
    fun removing_one_token_keeps_the_other_registration() {
        val origins = ViewerOrigins()
        val cardToken = Any()
        val detailToken = Any()
        origins.putRect(post, 1, cardToken, Rect(0f, 0f, 10f, 10f))
        origins.putRect(post, 1, detailToken, Rect(50f, 50f, 90f, 90f))

        origins.removeToken(cardToken)
        assertEquals(Rect(50f, 50f, 90f, 90f), origins.of(post, 2)[1]?.rect)
    }

    /** 两处都在、撤掉的是"当前胜出"的那一条：剩下的那条要**重新生效**（列表页可能还在后面） */
    @Test
    fun removing_winner_falls_back_to_the_other_registration() {
        val origins = ViewerOrigins()
        val cardToken = Any()
        val detailToken = Any()
        origins.putRect(post, 1, cardToken, Rect(0f, 0f, 10f, 10f))
        origins.putRect(post, 1, detailToken, Rect(50f, 50f, 90f, 90f))

        origins.removeToken(detailToken)
        // 规则是"只撤掉自己那一份"：卡片那条立刻重新生效，查看器仍然飞得起来
        // （整条删掉的话这一格就查不到了，返回时表现为"图片直接消失、没飞回去"）
        assertEquals(Rect(0f, 0f, 10f, 10f), origins.of(post, 2)[1]?.rect)
    }

    /**
     * **真机反馈的那个 bug（M5.4）**：同一个 index 被两处来源先后登记，
     * 后到的那一处**只写了矩形**（它的图还没加载完，宽高比还没上报）——
     * 旧实现"一个 key 一条记录、谁最后写谁整条替换"会把先到的那份宽高比一起清掉。
     *
     * 后果在查看器里就是"先铺满屏幕、再缩回全屏位置"：没有宽高比 →
     * 落位矩形退化成整个容器（`fitRectIn(container, null) == container`）→
     * 飞过去的末帧是"铺满裁剪"，交接给轮播的 `Fit` 时再缩一下。
     *
     * 用户实测的范围也印证了这条路径：只有**第一排三张（index 0/1/2）与单图（index 0）**会犯，
     * 因为只有这几个 index 会被信息流卡片（只显示前三张）与详情页**同时**登记。
     */
    @Test
    fun a_second_source_writing_only_the_rect_keeps_the_aspect() {
        val origins = ViewerOrigins()
        val cardToken = Any()
        val detailToken = Any()
        // 卡片那一格：矩形与宽高比都到了
        origins.putRect(post, 0, cardToken, Rect(0f, 0f, 100f, 100f))
        origins.putAspect(post, 0, cardToken, 0.75f)
        // 详情页那一格后到：此刻它的图还没加载出来，所以只有矩形
        origins.putRect(post, 0, detailToken, Rect(300f, 600f, 400f, 700f))

        val origin = origins.of(post, 1)[0]!!
        // 位置取最新的那一份（正在看的那一格在哪），宽高比是图片自身的属性，不能被清掉
        assertEquals(Rect(300f, 600f, 400f, 700f), origin.rect)
        assertEquals(0.75f, origin.aspect!!, 0.001f)
    }

    /** 反过来（先宽高比、后矩形来自**另一处**来源）同样不能丢 —— 字段之间互不清除 */
    @Test
    fun aspect_from_one_source_survives_a_later_rect_from_another() {
        val origins = ViewerOrigins()
        val cardToken = Any()
        val detailToken = Any()
        origins.putRect(post, 2, detailToken, Rect(300f, 600f, 400f, 700f))
        origins.putAspect(post, 2, detailToken, 1.5f)
        origins.putRect(post, 2, cardToken, Rect(0f, 0f, 100f, 100f))

        val origin = origins.of(post, 3)[2]!!
        assertEquals(Rect(0f, 0f, 100f, 100f), origin.rect)
        assertEquals(1.5f, origin.aspect!!, 0.001f)
    }

    /**
     * 宽高比一旦真的丢了，几何就会退化成"整个屏幕" —— 这正是用户看到的现象。
     *
     * 这条测试把"症状"与"几何"钉在一起：以后谁再让宽高比在点击时读不到，
     * 上面两条会红；而这条说明为什么它必须红（不是"少个字段而已"）。
     */
    @Test
    fun missing_aspect_would_degrade_the_target_rect_to_the_whole_screen() {
        val container = Rect(0f, 0f, 1000f, 2000f)
        assertEquals(container, fitRectIn(container, aspect = null))
        assertTrue(fitRectIn(container, aspect = 0.75f) != container)
    }

    /**
     * 圆角（M5.5）与矩形**同一份槽位**：位置取谁，圆角就取谁的。
     *
     * 两处来源的圆角可能不同（卡片格与详情格是两套布局），错配的后果是
     * "从详情页那一格飞出来，圆角却按卡片格算" —— 飞行首帧与格子对不上。
     */
    @Test
    fun corner_radius_travels_with_the_winning_rect() {
        val origins = ViewerOrigins()
        val cardToken = Any()
        val detailToken = Any()
        origins.putRect(post, 0, cardToken, Rect(0f, 0f, 100f, 100f), cornerRadiusPx = 8f)
        origins.putRect(post, 0, detailToken, Rect(300f, 600f, 400f, 700f), cornerRadiusPx = 24f)

        val origin = origins.of(post, 1)[0]!!
        // 后写的详情页那格胜出：矩形与圆角都得是它的
        assertEquals(Rect(300f, 600f, 400f, 700f), origin.rect)
        assertEquals(24f, origin.cornerRadiusPx, 0.01f)
    }

    /** 没登记圆角（老调用方 / 不在 Shell 里）时按直角处理，不会崩也不会乱飞 */
    @Test
    fun corner_radius_defaults_to_right_angle() {
        val origins = ViewerOrigins()
        origins.putRect(post, 0, Any(), Rect(0f, 0f, 100f, 100f))
        assertEquals(0f, origins.of(post, 1)[0]!!.cornerRadiusPx, 0.01f)
    }

    /** 矩形（布局阶段写）与宽高比（图片加载完成后写）分两次到达，读出来要是**合起来**的结果 */
    @Test
    fun rect_and_aspect_are_merged() {
        val origins = ViewerOrigins()
        val token = Any()
        origins.putRect(post, 0, token, Rect(0f, 0f, 200f, 100f))
        assertNull(origins.of(post, 1)[0]?.aspect)

        origins.putAspect(post, 0, token, 1.5f)
        val origin = origins.of(post, 1)[0]!!
        assertEquals(Rect(0f, 0f, 200f, 100f), origin.rect)
        assertEquals(1.5f, origin.aspect!!, 0.001f)
    }

    /** 先到宽高比、后到矩形（图片比布局快的情况）同样不能丢 */
    @Test
    fun aspect_arriving_first_is_kept() {
        val origins = ViewerOrigins()
        val token = Any()
        origins.putAspect(post, 0, token, 0.75f)
        // 只有宽高比、还没有矩形时：查不到（返回 null），因为飞行几何必须有矩形
        assertNull(origins.of(post, 1)[0])

        origins.putRect(post, 0, token, Rect(0f, 0f, 200f, 100f))
        assertEquals(0.75f, origins.of(post, 1)[0]?.aspect!!, 0.001f)
    }

    /** 缩略图缓存键两端（格子写、查看器读）必须由同一个函数生成 */
    @Test
    fun thumb_cache_key_is_shared_by_both_sides() {
        assertEquals("k-thumb:/uploads/a.jpg", thumbMemoryCacheKey("/uploads/a.jpg"))
        assertEquals(thumbMemoryCacheKey("x"), thumbMemoryCacheKey("x"))
    }

    /**
     * ★★ 真机实测的「第一次打开图片全屏会跳变」根因（2026-09-20）。
     *
     * 现场 logcat（OnePlus PGEM10，点开详情页后**立刻**点图）：
     * ```
     * idx=0 token=…4493903  rect=(112,629,1328,2250)   ← 信息流卡片那一格（正随页面滑出）
     * idx=0 token=…165711324 rect=(360,629,1328,2250)  ← 详情页那一格（还在滑入途中）
     * enter FLY src=(154,711,1359,2417)                ← 飞行起点：动画中间态
     * （页面落定后再点：src=(56,773,1383,2542)，与详情格逐像素一致）
     * ```
     * 起点错位 → 飞出去的那一张与背景里那一格对不上（背景那格右侧还露出一条竖直的缝）。
     * 退出与后续打开正常，因为那时页面早已落定。
     *
     * 约定：**只有"已落定"的矩形才算数**（[ViewerOrigins.putRect] 的 `stable`）。
     */
    @Test
    fun only_settled_rects_are_usable() {
        val origins = ViewerOrigins()
        val detailToken = Any()
        // 页面还在转场：写进来的只是动画中间态
        origins.putRect(post, 0, detailToken, Rect(360f, 629f, 1328f, 2250f), stable = false)

        // 宁可"查不到"（查看器退化成直接落位），也不从一个错位的矩形飞出来
        assertNull(origins.of(post, 1)[0])
    }

    /** 落定之后补写一次 → 立刻可用（这正是 `registerViewerOrigin` 里那个 LaunchedEffect 的作用） */
    @Test
    fun settling_publishes_the_final_rect() {
        val origins = ViewerOrigins()
        val detailToken = Any()
        origins.putRect(post, 0, detailToken, Rect(360f, 629f, 1328f, 2250f), stable = false)
        assertNull(origins.of(post, 1)[0])

        origins.putRect(post, 0, detailToken, Rect(56f, 773f, 1383f, 2542f), stable = true)
        assertEquals(Rect(56f, 773f, 1383f, 2542f), origins.of(post, 1)[0]?.rect)
    }

    /** 转场中间态**不许覆盖**已落定的那一份（页面落定后又开始动的场景） */
    @Test
    fun a_transient_rect_does_not_clobber_a_settled_one() {
        val origins = ViewerOrigins()
        val token = Any()
        origins.putRect(post, 0, token, Rect(56f, 773f, 1383f, 2542f), cornerRadiusPx = 24f)
        origins.putRect(post, 0, token, Rect(360f, 629f, 1328f, 2250f), cornerRadiusPx = 0f, stable = false)

        val origin = origins.of(post, 1)[0]!!
        assertEquals(Rect(56f, 773f, 1383f, 2542f), origin.rect)
        // 圆角也跟着"落定的那一份"，不会出现"位置是落定的、圆角是中间态的"
        assertEquals(24f, origin.cornerRadiusPx, 0.01f)
    }

    /**
     * **正在出场的那一页**必须撤掉自己的登记。
     *
     * 用户录屏里那条竖缝就是这条规则缺失造成的：信息流卡片（正在滑出）把详情格挤掉，
     * 飞行起点变成卡片那一格（比真实位置窄 179px），背景那一格的右侧露了出来。
     * 撤掉之后：只剩"详情页还在转场"的中间态 → 查不到 → 直接落位（没有飞行，也没有错位）。
     */
    @Test
    fun dropping_the_leaving_page_never_falls_back_to_its_stale_rect() {
        val origins = ViewerOrigins()
        val cardToken = Any()
        val detailToken = Any()
        origins.putRect(post, 0, cardToken, Rect(112f, 629f, 1328f, 2250f))
        origins.putRect(post, 0, detailToken, Rect(360f, 629f, 1328f, 2250f), stable = false)

        // 卡片那一页开始出场：撤掉它的登记
        origins.removeToken(cardToken)
        assertNull(origins.of(post, 1)[0])

        // 详情页落定后补写 → 正常可飞
        origins.putRect(post, 0, detailToken, Rect(56f, 773f, 1383f, 2542f))
        assertEquals(Rect(56f, 773f, 1383f, 2542f), origins.of(post, 1)[0]?.rect)
    }

    /**
     * 「这一格已经被回收、但它的矩形还留在表里」——必须能被识别出来。
     *
     * 为什么单开一条：[registerViewerOrigin] 只在**能拿到非零矩形**时才写，
     * 而"矩形已失效"是没有信号的 —— 表里仍留着上一轮布局的坐标。
     * 用它去飞，表现就是"图从一个早就没有内容的位置飞出来"（用户实测反馈里
     * "只有第一次会这样"的另一种成因：首次进入时上一页的格子还没被回收干净）。
     *
     * 约定：读的那一方要能判断"这条记录还新鲜吗"。这里钉住 [ViewerOrigin.rect]
     * 与 `boundsInWindow()` 同处一个坐标系（窗口坐标），所以判定条件就是
     * **矩形是否落在窗口内且非零**，不需要额外的版本号。
     */
    @Test
    fun a_stale_rect_is_detectable_by_being_outside_the_window() {
        val window = Rect(0f, 0f, 1000f, 2000f)
        // 被回收的格子：布局早已消失，坐标停在旧位置（这里落在窗口外）
        val stale = Rect(0f, -500f, 100f, -400f)
        val fresh = Rect(100f, 300f, 200f, 400f)

        fun isStale(r: Rect): Boolean = r.width <= 0f || r.height <= 0f ||
            r.bottom < window.top || r.top > window.bottom

        assertTrue(isStale(stale))
        assertTrue(!isStale(fresh))
    }
}
