package top.kuangdada.k.nativeapp.ui

import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import coil3.request.ImageRequest
import coil3.size.Size
import top.kuangdada.k.core.data.ThemePreference
import top.kuangdada.k.core.data.model.BookSummary
import top.kuangdada.k.core.designsystem.theme.KElevation
import top.kuangdada.k.core.designsystem.theme.KDimens
import top.kuangdada.k.core.designsystem.theme.KMotion
import top.kuangdada.k.core.designsystem.theme.KRadius
import top.kuangdada.k.core.designsystem.theme.KSpacing
import top.kuangdada.k.core.designsystem.theme.KTheme
import top.kuangdada.k.core.designsystem.theme.KType

/**
 * ============================================================
 * 共享小件（M2 起的页面级复用件）
 * ============================================================
 */

/**
 * 页面顶栏（每页第一行内容）**垂直位置的唯一来源** = 状态栏安全区 + `KSpacing.xs`。
 *
 * 为什么必须收敛成一条：改之前同一个"页面第一行"的位置由**三处叠加**决定，而三处各页取值都不同 ——
 *   ① 顶部安全区：`statusBarsPadding()` 散在**每个页面文件各自**调（改之前 17 个文件里各一处）；
 *   ② 承载顶栏的列表 `contentPadding.top`：首页/他人主页 8dp、消息/图书/语音/主页/公告/发现/后台 16dp；
 *   ③ 顶栏自身的内边距：首页 `top = KSpacing.xxs`、其余 `vertical = KSpacing.xs`。
 * 结果是同为"顶栏"的落点差了 16dp（Tab 页 = 安全区 + 16 + 8，首页 = 安全区 + 8 + 4，二级页 = 安全区 + 8）——
 * 用户看到的就是"TOP 栏位置有些页面不一样"，而且是**同层级页之间**不一样，最难忍。
 *
 * 现在的规则只有一条：顶栏容器（列表的第一个 item / 根 Column 里的顶栏 Row）挂 [kTopBar]。
 *   · 它自带状态栏安全区 + `KSpacing.xs` 上边距；
 *   · 顶栏内部（[KPageHeader] 或手写顶栏 Row）**只写下边距**，不许再写 top；
 *   · 承载顶栏的列表 `contentPadding.top` 必须是 **0**（不写这个参数即可）——
 *     列表的顶部内边距是给"第一条内容"的呼吸，它和顶栏的定位无关，16dp 那档就是这么叠出来的。
 *
 * **故意不用它的页面**（不是遗漏）：
 *   · 图片查看器 / 视频播放器 / 语音房的全屏共享浮层 —— 它们没有顶栏，左上角那个返回钮是
 *     **浮在画面上的控件**，位置由画面决定（`statusBarsPadding` + 自己的内边距），
 *     套页面顶栏的规则反而会把返回钮从画面上挤下来。
 */
fun Modifier.kTopBar(): Modifier = this.statusBarsPadding().padding(top = KSpacing.xs)







/**
 * 顶栏浮层高度的**首帧估算值**（px），给列表 `contentPadding.top` 起步用。
 *
 * 病根（用户反馈"详情页 / 消息对话页 / 图书二级页刚进页面时顶栏高矮跳一下"）：
 * 这三个页面都是「顶栏浮层 + 列表 `contentPadding.top` = 顶栏实测高」的结构，
 * 而实测值来自 `onSizeChanged` —— **首帧拿不到**，只能从 0 起步，于是内容先顶到最上面、
 * 测量值回来后才弹到顶栏之下，看上去就是顶栏"先矮一下再变高"。
 *
 * 这里给出与真实值同量级的估算（状态栏 + [kTopBar] 的上内边距 + 页头行高 + 顶栏下内边距），
 * 首帧即用它起步；`onSizeChanged` 的真实值到达后再覆盖 —— 两者通常只差几 dp
 * （系统放大字号时 [KPageHeader] 的 `heightIn(min)` 会高于行高常量，那一步负责精确修正），
 * 肉眼看不到跳动。
 *
 * @param bottomPadding 该页顶栏自身的下内边距，**必须与调用处 `.padding(bottom = …)` 一致**：
 *        PostDetail 用 [KSpacing.xs]，聊天页 / 图书详情用 [KSpacing.md]。
 */
@Composable
fun kTopBarHeightEstimatePx(bottomPadding: Dp): Int {
    val density = LocalDensity.current
    val statusBarPx = WindowInsets.statusBars.getTop(density)
    return statusBarPx + with(density) {
        // 顶栏内容高按 KIconButton 的实际尺寸算：这些二级页顶栏是手写的
        // `Row { KIconButton + Text }`，用的是 iconButton(36dp)，**不是** KPageHeader 的
        // headerIconButton(38dp) —— 弄错会平白多算 2dp。
        (KSpacing.xs + KDimens.iconButton + bottomPadding).roundToPx()
    }
}

/**
 * 页头：标题 + 可选副标题 + 右侧动作。所有一级/二级页统一用它，保证顶部节奏一致。
 *
 * **行高钉在 [KDimens.headerIconButton]（38dp）** —— 这是"同层级页面的标题必须在同一个位置"
 * 的必要条件：标题在行内是**垂直居中**的，而行的实际高度由"最高的那个孩子"决定，
 * 于是**带不带右侧钮**会把同一个 24sp 标题放到不同的 y 上。
 *
 * 真机实测（PGEM10，560dpi override → 1dp=3.5px；kTopBar 上沿五行完全一致 = 188px）：
 *   · 消息页（无右侧钮）标题上沿 188px；
 *   · 图书/语音/主页（36dp 图标钮）202px；
 *   · 首页（38dp 搜索钮，且当时是**另一份手写页头**）206px。
 * 同层级页面之间差 4~5dp，用户看到的就是"消息页左上角的『消息』跟其他一级页不在同一个位置"。
 * 钉住行高之后五行都是 38dp 的行，标题落在同一条线上（各行下方的控件也随之对齐）。
 *
 * 用 `heightIn(min =)` 而不是 `height()`：系统放大字号时标题要能把行撑高
 * （与 [KSegmentedTabs] 的 `segmentHeight` 同一条规矩），写死高度会在"大字体"下裁字。
 */
@Composable
fun KPageHeader(
    title: String,
    subtitle: String? = null,
    modifier: Modifier = Modifier,
    trailing: (@Composable () -> Unit)? = null,
) {
    val c = KTheme.colors
    Row(
        // 只留下边距：上边距由容器的 [kTopBar] 给（两处都给 = 又叠成 16dp，那是这次要修的病根）
        modifier = modifier
            .fillMaxWidth()
            .padding(bottom = KSpacing.xs)
            .heightIn(min = KDimens.headerIconButton),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(title, style = KType.title, color = c.textPrimary)
            if (subtitle != null) {
                Text(subtitle, style = KType.footnote, color = c.textMuted, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
        trailing?.invoke()
    }
}

/**
 * 书封的 Coil 请求模型（**已被 [rememberSharedCoverRequest] 取代，保留仅为历史线索**）。
 *
 * 不再使用的原因：它只解决了"缓存键不同"这一半 —— 尺寸钉成 `Size.ORIGINAL`
 * （书封只有 10～60KB、240～720px 宽），两端确实共用一条缓存了。
 * 但**另一半没解决**：转场期间新派发的解码仍会被 [AnimationGate] 扣到动画之后，
 * 而共享元素（`sharedBounds`）要求**目标端第一帧就有内容**。
 * 真机表现就是"**第一次点图书会闪一下封面**"（第二次有缓存、几乎同帧到达，看着才自然）。
 *
 * 现在两端一律走 [rememberSharedCoverRequest]（尺寸 + 显式键 + `ImageLoading.immediate` 三件齐）。
 * 留这一条注释是为了让后来者在改这块时知道：**钉尺寸只是必要条件，不是充分条件**。
 */
@Suppress("unused")
@Composable
private fun rememberBookCoverModelLegacy(url: String?): Any? {
    val context = LocalContext.current
    return remember(url) {
        url?.let { ImageRequest.Builder(context).data(it).size(Size.ORIGINAL).build() }
    }
}

/**
 * 书封的内存缓存键（**显式**，与请求上的 `Size.ORIGINAL` 配套）。
 *
 * 与帖子配图那一套 [thumbMemoryCacheKey] 是同一个理由的不同做法：那边给"缩略尺寸"的请求
 * 钉一个固定键，让查看器能拿它当占位图；这边尺寸已经钉成 `ORIGINAL`、两端天然同键，
 * 但**仍然需要显式化** —— 见 [viewerLikeRequest]。
 *
 * ⚠️ 改这里必须同步 [rememberSharedCoverRequest]：Coil 判断"这条请求是不是同一个"用的是
 * `ImageRequest` 的相等性（含 `memoryCacheKey`），两处不一致就等于两套缓存。
 */
fun bookCoverMemoryCacheKey(url: String): String = "k-book:$url"

/**
 * 与查看器同构的加载请求：**钉死尺寸 + 钉死内存缓存键 + 走不受动画让路的调度器**。
 *
 * 本函数存在的唯一原因是一个真机 bug：「**第一次点图书会闪一下封面**」。
 *
 * 这一族（图书封面 / 帖子配图 / 头像）的共享元素都挂在 `sharedBounds` 上，语义是
 * "两端各自留在原地画、只有边界在动"。于是**目标端的封面内容必须第一帧就有** ——
 * 它是从目标端自己的尺寸画出来的，源端那份内容不参与飞行。
 *
 * 而"第一帧就有"有两个破坏点（两个都会让**首次**比第二次差，因为第二次有缓存）：
 *
 *  1. **缓存键不同**：`AsyncImage(model = url)` 会按组件自己的尺寸请求，卡片（~190dp）
 *     与详情页（104dp）是两条缓存 → 详情页必须现场解码；
 *  2. **解码被动画让路**：[AnimationGate] 会在转场期间把新派发的解码推到动画结束
 *     （见 `ImageLoading.gated`）—— 而这里要的正是"转场期间就画出来"，
 *     被扣住的结果就是封面空几帧、动画快完了才"啪"地出现。
 *
 * 所以：尺寸钉 `ORIGINAL`（两端同键）→ 缓存键显式钉住 → 调度器用 `ImageLoading.immediate`
 * （与全屏查看器同一条豁免：**它就是动画的一部分，不能给自己让路**）。
 */
@Composable
fun rememberSharedCoverRequest(url: String?): ImageRequest? {
    val context = LocalContext.current
    return remember(url, context) {
        url?.let {
            ImageRequest.Builder(context)
                .data(it)
                .size(Size.ORIGINAL)
                .memoryCacheKey(bookCoverMemoryCacheKey(it))
                .fetcherCoroutineContext(ImageLoading.immediate)
                .decoderCoroutineContext(ImageLoading.immediate)
                .build()
        }
    }
}

/**
 * 头像的内存缓存键（**显式**）。
 *
 * 为什么头像也需要显式键：同一张头像会被**三个不同尺寸**的组件加载 ——
 * 消息列表行 `avatarRow`(48) / 聊天气泡 `avatarCard` / 帖子卡片又是另一档。
 * 不钉尺寸的话 Coil 的自动缓存键**包含请求尺寸**，三处各算各的 →
 * 同一个人、同一张图进三个页面解三遍，**进页面必现"头像重新加载"**（用户实测反馈）。
 *
 * 与书封 [bookCoverMemoryCacheKey] 是同一个套路：尺寸钉 `ORIGINAL` + 键显式化，
 * 三个尺寸就共用**一条**内存缓存，进页面直接命中、零解码。
 */
fun avatarMemoryCacheKey(url: String): String = "k-avatar:$url"

/**
 * 头像的 Coil 请求模型：**钉尺寸 + 显式缓存键 + 不吃动画让路**。
 *
 * 三个尺寸共用一条缓存（见 [avatarMemoryCacheKey]）之外，第三条同样关键：
 * 默认调度器是 [ImageLoading.gated]，而**进页面本身就是一次转场** ——
 * `AnimationGate` 会把转场期间新派发的取图/解码全部扣到动画结束再放行。
 * 结果就是"进消息页时头像空一片、动画快完了才一起冒出来"，而且**只有第一次差**
 * （第二次缓存命中、几乎同帧，看着就正常）。
 *
 * 这与书封、帖子配图是完全同一条病根、同一个解法（见 [rememberSharedCoverRequest] 的长注释）。
 * 头像虽然不参与共享元素飞行，但它同样属于"页面第一帧就该有的东西"，
 * 所以也走 [ImageLoading.immediate] 豁免。
 *
 * ## ★★ 尺寸钉 `Size.ORIGINAL` 是错的（2026-09-24 真机取证纠正）
 *
 * 头像最大的那一档是 `KDimens.avatarRow` = **48dp**（3x 屏 ≈ 144px）。而 `Size.ORIGINAL`
 * 会让 Coil 把**原图全分辨率**解进内存 —— 真机 logcat 实测：本机两个头像分别解出
 * `512x360` 与 **`3840x2160`**。后者是 **3840×2160×4 ≈ 33MB** 的位图：
 *
 *  · 解码本身要几百毫秒（比"钉死小尺寸"慢两个数量级）；
 *  · 每次进页面都往内存缓存里塞 33MB，GC 压力直接反映成列表掉帧；
 *  · 而画到屏幕上只有 144px，**999 倍的解码量全白做**。
 *
 * 钉 `Size.ORIGINAL` 的初衷是"三个尺寸共用一个键"，但那条路径不需要靠 ORIGINAL 实现 ——
 * [avatarMemoryCacheKey] 已经把键**显式**钉住了，尺寸换成固定值反而更对：
 * 三处用同一个固定尺寸 → 仍然共用一条缓存，且这条缓存是小的。
 *
 * 取值 [AVATAR_DECODE_PX] = 384px：3x 屏下 48dp 是 144px，留 2.67 倍余量给
 * 未来"头像放大看"之类的需求，同时仍远小于任何原图（33MB → 约 0.6MB）。
 */
private const val AVATAR_DECODE_PX = 384

@Composable
fun rememberAvatarRequest(url: String?): ImageRequest? {
    val context = LocalContext.current
    return remember(url, context) {
        url?.let {
            ImageRequest.Builder(context)
                .data(it)
                // 固定小尺寸（不是 ORIGINAL —— 见上面长注释）：三处共用一条**小**缓存
                .size(AVATAR_DECODE_PX)
                .memoryCacheKey(avatarMemoryCacheKey(it))
                // 磁盘缓存也钉住同一条键：换尺寸/换请求对象时不至于重下一次
                .diskCacheKey(avatarMemoryCacheKey(it))
                .fetcherCoroutineContext(ImageLoading.immediate)
                .decoderCoroutineContext(ImageLoading.immediate)
                .build()
        }
    }
}

/**
 * 视频封面的内存/磁盘缓存键（**显式**）。
 *
 * 为什么视频封面也需要：它是**共享元素的端点**（信息流卡片 ⇄ 帖子详情页），
 * 两端原来是裸 `AsyncImage(model = videoCoverUrl)` —— 各自按组件尺寸算缓存键，
 * 卡片格与详情页尺寸不同 → 两条缓存 → **目标端第一帧是空的**，
 * 而共享元素（`sharedElement`）语义要求两端各自留在原地画，第一帧空就是"图没飞出来"。
 *
 * 与 [bookCoverMemoryCacheKey] 完全同构（那一条也是共享元素端点）。
 * 详情页与卡片必须都走 [rememberVideoCoverRequest] 才能保证两边同一个键。
 */
fun videoCoverMemoryCacheKey(url: String): String = "k-video-cover:$url"

/**
 * 视频封面的加载请求：**钉死尺寸 + 显式键 + 不让路给动画**。
 *
 * 与 [rememberSharedCoverRequest]（书封）同一条理由，见那个函数的详细注释：
 * 共享元素目标端的内容必须**第一帧就有**，否则飞行途中封面是空的。
 *
 * 尺寸钉 `Size.ORIGINAL` 是**有意**的（与书封一致）：两端尺寸不同、但必须同键，
 * 钉 ORIGINAL 让"同键"与"同尺寸"两件事合一，最不容易写歪。
 * 视频封面本来就是要全屏看的图，解全尺寸并不浪费（与头像那种 48dp 小圆片不同）。
 */
@Composable
fun rememberVideoCoverRequest(url: String?): ImageRequest? {
    val context = LocalContext.current
    return remember(url, context) {
        url?.let {
            ImageRequest.Builder(context)
                .data(it)
                .size(Size.ORIGINAL)
                .memoryCacheKey(videoCoverMemoryCacheKey(it))
                .fetcherCoroutineContext(ImageLoading.immediate)
                .decoderCoroutineContext(ImageLoading.immediate)
                .build()
        }
    }
}

/**
 * 语音房封面的内存缓存键（**显式**）。
 *
 * 与 [avatarMemoryCacheKey] / [bookCoverMemoryCacheKey] 同一个套路：Coil 默认的缓存键
 * **包含请求尺寸**，房间卡片（108dp 高）与将来任何别处的封面尺寸不同就是两条缓存。
 * 钉一个显式键，让"同一张房间封面"在任何地方都命中同一条。
 */
fun roomCoverMemoryCacheKey(url: String): String = "k-room-cover:$url"

/**
 * 语音房封面的加载请求：**钉尺寸 + 显式缓存键 + 不吃动画让路**。
 *
 * 2026-09-24 用户反馈：「**语音界面房间周围的阴影也是会加载一下**」。
 *
 * 根因与头像/书封完全同一条：`VoiceRoomCard` 里的封面原来是裸的
 * `AsyncImage(model = coverUrl)`，于是
 *  ① 缓存键按组件尺寸自动算（与别处不共享）；
 *  ② 调度器是默认的 [ImageLoading.gated]，会让路给动画 ——
 *     而"进语音页"本身就是一次转场，封面被推到动画结束后才解码。
 * 封面一迟到，卡片里那块 108dp 的横幅就先是空底色；卡片是 `Surface(shadowElevation)`,
 * 封面带来的重绘正好落在阴影上 —— 观感就是"房间周围的阴影加载了一下"。
 *
 * 钉 108dp 高的实际像素（[VOICE_COVER_DECODE_PX]，3x 屏约 324px 宽）而不是
 * `Size.ORIGINAL`：房间封面是横幅，原图动辄 4K，全解进内存纯浪费（同头像那条教训）。
 */
private const val VOICE_COVER_DECODE_PX = 512

@Composable
fun rememberRoomCoverRequest(url: String?): ImageRequest? {
    val context = LocalContext.current
    return remember(url, context) {
        url?.let {
            ImageRequest.Builder(context)
                .data(it)
                .size(VOICE_COVER_DECODE_PX)
                .memoryCacheKey(roomCoverMemoryCacheKey(it))
                .diskCacheKey(roomCoverMemoryCacheKey(it))
                .fetcherCoroutineContext(ImageLoading.immediate)
                .decoderCoroutineContext(ImageLoading.immediate)
                .build()
        }
    }
}

/**
 * 图书卡片（设计稿 §3.3.1 图书列表）。
 *
 * 设计稿形态：**封面直出 + 两行文字，没有白底卡片、没有阴影** —— 书封本身就是卡片，
 * 再包一层白 Surface 会把封面切小一圈、还多出一圈突兀的白边。
 * 第二行是「作者 · 已读 N%」（进度来自进程内 [BookProgress]，没读过就只显示作者）。
 * 宽度跟随网格格子（390pt + 2 列 + 12 间距下正好是设计稿的 172），不写死，避免余量堆到一边。
 */
@Composable
fun BookCard(
    book: BookSummary,
    coverUrl: String?,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = KTheme.colors
    Column(
        modifier = modifier.clickable(onClick = onClick),
    ) {
        // 书封：竖版（约 3:4）。没有封面时用 surfaceSunken 底 + 书名首字兜底，
        // 不留空白方块（空方块在网格里看起来像"没加载出来"）。
        // 共享元素（M3）：这一块与图书详情里的封面共用 key → 点卡片时封面放大过去；
        // 没有封面（走首字兜底）时也照样共享 —— 兜底块"长成"详情页的封面反而更连续。
        Box(
            modifier = Modifier
                .sharedBoundsIfAvailable(bookCoverKey(book.id))
                .fillMaxWidth()
                .aspectRatio(0.75f)
                .clip(RoundedCornerShape(KRadius.row))
                .background(c.surfaceSunken),
            contentAlignment = Alignment.Center,
        ) {
            if (coverUrl != null) {
                AsyncImage(
                    // 与图书详情用同一个请求（尺寸 / 显式缓存键 / 不受让路的调度器都要一致，
                    // 见 rememberSharedCoverRequest）：否则首帧是空的，飞行途中封面没内容
                    model = rememberSharedCoverRequest(coverUrl),
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxWidth().aspectRatio(0.75f),
                )
            } else {
                Text(
                    text = book.title.take(1),
                    style = KType.title,
                    color = c.accent,
                )
            }
        }
        // 文字块与封面的间距（12）要**大于**书名与作者的间距（4）——
        // 设计稿里作者行是贴着书名的，书名才是与封面分组的那一行
        Spacer(Modifier.height(KSpacing.sm))
        Text(
            text = book.title,
            style = KType.bodyStrong,
            color = c.textPrimary,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        Spacer(Modifier.height(KSpacing.xxs))
        Text(
            text = buildString {
                if (book.author.isNotBlank()) append(book.author)
                val read = BookProgress[book.id]
                if (read != null && book.chapterCount > 0 && read in 0 until book.chapterCount) {
                    if (isNotEmpty()) append(" · ")
                    append("已读 ${(read + 1) * 100 / book.chapterCount}%")
                }
            },
            style = KType.footnote,
            color = c.textMuted,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * 分段控件（消息页「会话 | 通知」、管理后台的三分段都用它）。
 *
 * 形态按设计稿「消息会话 · 会话列表」实测对齐（390pt 宽换算）：
 *  · **药丸轨道**：高 ~43dp、圆角 = 高的一半（原实现是 radiusControl(10) 的方角轨道，
 *    与设计稿并排看明显"方"）；
 *  · 轨道底色 `surfaceSunken`（#E8F0E8）= 设计稿实测 #E8EFE8；原来的 accentSoft(#D1DBD6)
 *    更绿更重，整块控件会抢视线；
 *  · 选中段是**纯白药丸、无描边**（实测选中块边界处既没有暗环也没有阴影），
 *    靠白/浅灰的明度差分层次，不再画 1dp 描边。
 *
 * ------------------------------------------------------------
 * M7：选中态从"每项各自变底色"改成**一个滑动的药丸指示块**
 * ------------------------------------------------------------
 * 改之前每一项自己画 `surface` 底、字重瞬变 —— 点「通知」的表现是"会话那块底色瞬间消失、
 * 通知瞬间变白变粗"，位置是跳变的（用户反馈：「会话按钮切通知没有动画效果」）。
 * 现在与导航胶囊同一套做法：**一个实心药丸画在所有项下层**，用 [KMotion.spatial] 的弹簧
 * 从旧段滑到新段；各项只负责文字的反色（见 [SegmentLabel]）。
 * 位移走 `graphicsLayer.translationX` 而不是 `Modifier.offset`：前者只重绘、不重新布局。
 */
@Composable
fun KSegmentedTabs(
    options: List<String>,
    selectedIndex: Int,
    onSelect: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = KTheme.colors
    val pill = RoundedCornerShape(percent = 50)
    val gap = KSpacing.xxs

    // 空列表直接不画：下面要按 options.size 均分宽度，除零会得到 Infinity 宽度（整块控件画崩）
    if (options.isEmpty()) return
    val selected = selectedIndex.coerceIn(0, options.lastIndex)

    BoxWithConstraints(
        modifier = modifier
            .fillMaxWidth()
            .clip(pill)
            .background(c.surfaceSunken)
            .padding(gap),
    ) {
        // 每一项等宽（下面 Row 里每项 weight(1f)），所以指示块的位置能直接算出来 ——
        // 不需要为了拿子项坐标去上 SubcomposeLayout / 自定义 Layout（与导航胶囊同一套做法）。
        // 宽度要**减掉项之间的间隔**，否则最后一段的指示块会偏出轨道（间隔数是 n-1）。
        val itemWidth = (maxWidth - gap * (options.size - 1)) / options.size

        // 刻意不写 `by`：State 留到 graphicsLayer 里读，滑动期间只重绘、不重组
        val indicatorX = animateDpAsState(
            targetValue = itemWidth * selected,
            animationSpec = KMotion.spatial(),
            label = "segmentIndicator",
        )

        // ① 选中药丸（下层）。
        //
        // 高度必须等于"选中段的高"，所以既不能用 `height(固定值)` —— 系统放大字号时段落会被撑高，
        // 药丸就比选中段矮一截；也不能用 `maxHeight` —— 本控件通常挂在 LazyColumn 的 item 上，
        // 那里 maxHeight 是 Infinity，直接算崩。`matchParentSize` 拿的是**同层 Box 定稿后**的尺寸，
        // 而 Box 的尺寸由 Row 决定（matchParentSize 的子项不参与父尺寸计算），正好是要的那个值。
        Box(modifier = Modifier.matchParentSize()) {
            Box(
                modifier = Modifier
                    .align(Alignment.CenterStart)
                    .graphicsLayer { translationX = indicatorX.value.toPx() }
                    .width(itemWidth)
                    .fillMaxHeight()
                    .clip(pill)
                    .background(c.surface),
            )
        }

        // ② 各项文字（上层，画在药丸之上）
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(gap),
        ) {
            options.forEachIndexed { index, label ->
                SegmentLabel(
                    label = label,
                    selected = index == selected,
                    // 重复点当前段不回调：没有变化就不该有动效，也不该让页面白刷一次
                    onClick = { if (index != selected) onSelect(index) },
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

/**
 * 分段里的一项（只有文字，底色由外层的滑动药丸承担）。
 *
 * 字号与字重**不能动画**，所以"变粗"这件事用**两层文字叠着交叉淡入淡出**：
 * 选中层（SemiBold + `textPrimary`）与未选层（Normal + `textSecondary`）alpha 互补。
 * 直接切换字重的话，药丸还在滑、字已经"啪"地变粗 —— 两个东西不合拍。
 *
 * 两层都参与布局，取较宽的那一层，文字居中 —— 所以切换时整段的字不会左右抖。
 */
@Composable
private fun SegmentLabel(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = KTheme.colors
    val sel = animateFloatAsState(
        targetValue = if (selected) 1f else 0f,
        animationSpec = KMotion.effects(),
        label = "segmentLabel",
    )
    Box(
        modifier = modifier
            .heightIn(min = KDimens.segmentHeight)
            .clip(RoundedCornerShape(percent = 50))
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = onClick,
            )
            .padding(vertical = KSpacing.xs),
        contentAlignment = Alignment.Center,
    ) {
        // 两层叠加，各自的 alpha 都在 graphicsLayer 里读（只重绘、不重组）
        Text(
            text = label,
            style = KType.caption,
            fontWeight = FontWeight.SemiBold,
            color = c.textPrimary,
            modifier = Modifier.graphicsLayer { alpha = sel.value },
        )
        Text(
            text = label,
            style = KType.caption,
            fontWeight = FontWeight.Normal,
            color = c.textSecondary,
            modifier = Modifier.graphicsLayer { alpha = 1f - sel.value },
        )
    }
}

/** 空状态里的动作按钮占位（避免每个页面各写一遍 padding） */
@Composable
fun KSectionSpacer() {
    Spacer(Modifier.height(KSpacing.sm))
}

/**
 * 轻量提示条（M2 的过渡形态）。
 *
 * 位置刻意抬到**导航胶囊之上**（`navScrollPadding`）—— 放在屏幕最底部会被悬浮胶囊盖住，
 * 用户看不到任何反馈。M4 会抽成带队列的全局 Toast 宿主（现在的形态是"一次只显示一条，
 * 1.8 秒后自动消失"，多来源同时触发会互相覆盖）。
 */
@Composable
fun KToast(
    text: String,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = KTheme.colors
    LaunchedEffect(text) {
        kotlinx.coroutines.delay(1800)
        onDismiss()
    }
    Box(modifier = modifier.padding(bottom = KDimens.navScrollPadding + KSpacing.lg)) {
        Box(
            modifier = Modifier
                .clip(RoundedCornerShape(KRadius.row))
                .background(c.surfaceRaised)
                .border(1.dp, c.borderSubtle, RoundedCornerShape(KRadius.row))
                .padding(horizontal = KSpacing.md, vertical = KSpacing.xs),
        ) {
            Text(text, style = KType.caption, color = c.textPrimary)
        }
    }
}

/**
 * 主题模式选择行（跟随系统 / 浅色 / 深色）。
 *
 * 三态而不是"深色开关"：**跟随系统是默认值**，只给一个开关的话用户一旦拨动
 * 就再也回不到"跟随系统"（Web 版的设计稿也是三态）。
 */
@Composable
fun ThemeModeRow(
    current: ThemePreference.Mode,
    onChange: (ThemePreference.Mode) -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = KTheme.colors
    val options = listOf(
        ThemePreference.Mode.System to "跟随系统",
        ThemePreference.Mode.Light to "浅色",
        ThemePreference.Mode.Dark to "深色",
    )
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(KRadius.row))
            .background(c.surface)
            .border(1.dp, c.borderSubtle, RoundedCornerShape(KRadius.row))
            .padding(horizontal = KSpacing.md, vertical = KSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text("外观", style = KType.body, color = c.textPrimary)
        Row(horizontalArrangement = Arrangement.spacedBy(KSpacing.xs)) {
            options.forEach { (mode, label) ->
                val selected = mode == current
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(KRadius.pill))
                        .background(if (selected) c.accent else Color.Transparent)
                        .border(
                            1.dp,
                            if (selected) c.accent else c.borderSubtle,
                            RoundedCornerShape(KRadius.pill),
                        )
                        .clickable { onChange(mode) }
                        .padding(horizontal = KSpacing.sm, vertical = 6.dp),
                ) {
                    Text(
                        text = label,
                        style = KType.caption,
                        color = if (selected) c.onAccent else c.textSecondary,
                    )
                }
            }
        }
    }
}











