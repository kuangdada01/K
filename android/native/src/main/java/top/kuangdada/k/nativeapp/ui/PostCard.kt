package top.kuangdada.k.nativeapp.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.geometry.isSpecified
import coil3.compose.AsyncImage
import top.kuangdada.k.core.data.PostUi
import top.kuangdada.k.core.designsystem.component.HeartIcon
import top.kuangdada.k.core.designsystem.component.KLikeButton
import top.kuangdada.k.core.designsystem.theme.KElevation
import top.kuangdada.k.core.designsystem.theme.KDimens
import top.kuangdada.k.core.designsystem.theme.KRadius
import top.kuangdada.k.core.designsystem.theme.KSpacing
import top.kuangdada.k.core.designsystem.theme.KTheme
import top.kuangdada.k.core.designsystem.theme.KType

/**
 * ============================================================
 * 帖子卡片（首页信息流）
 * ============================================================
 * 设计稿 §3.1 的三条修正都在这里落地：
 *
 *  1. **卡片必须是实心 `surface` + 阴影，不能用毛玻璃**。
 *     毛玻璃只服务"有内容从底下穿过"的浮层（导航胶囊、模态）；正文卡片下面是纯色页底，
 *     模糊等于什么都没做，只白白牺牲对比度（实测浅色 1.08:1、深色 1.09:1，人眼分不出边界）。
 *  2. **点赞三态明确化**：未赞 = 描边心 + `textSecondary`；已赞 = 实心心 + `danger`；
 *     按下 = scale(.92)。旧 Web 版的缺陷是未赞与已赞**颜色完全相同**，只差 svg 填充，
 *     快速滑动时用户分不清自己点没点过。
 *  3. **图片容器底色**：横图留白要与主题一致。旧版是 `#000` 硬编码，
 *     在浅色主题里就是一块突兀的黑矩形。这里用 `accentSoft` 做图床底。
 */
@Composable
fun PostCard(
    post: PostUi,
    onLike: () -> Unit,
    onBookmark: () -> Unit,
    onRepost: () -> Unit,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    /** 当前登录用户 id（用于判断"这条帖子是不是我的" → 决定要不要显示编辑入口） */
    myUserId: Long = 0,
    /** 编辑自己的帖子（null = 不提供入口）；回调带帖子本身，编辑页要用它的正文与既有图 */
    onEdit: ((PostUi) -> Unit)? = null,
    /** 点开第 index 张图（由调用方接原生图片查看器；null = 图片不可点） */
    onImageClick: ((List<String>, Int, Long?) -> Unit)? = null,
    /** 点评论图标（进帖子详情）；null = 评论图标不可点 */
    onComment: (() -> Unit)? = null,
    /** 点分享图标；null = 不可点 */
    onShare: (() -> Unit)? = null,
    /** 点视频封面（进播放器）；null = 视频封面不可点 */
    onVideoClick: (() -> Unit)? = null,
    /** 点正文里的 #话题 → 搜该话题的相关帖子；null = 话题只展示不可点 */
    onTagClick: ((String) -> Unit)? = null,
    /**
     * 点卡片上的**头像 / 昵称** → 进这个人的主页（null = 不可点）。
     *
     * 为什么头像与昵称**整块**可点、而不是把整张卡片拆成两个点击区域：
     * 头像（40dp）本身太小的点按目标，昵称那一列是"这一行文字"，两者合起来
     * 才是一个像样的触控区；同时**必须吃掉点击事件**（不能冒泡给卡片），
     * 否则点头像会连带打开帖子详情。
     */
    onOpenUser: ((userId: Long) -> Unit)? = null,
) {
    val c = KTheme.colors
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(KRadius.card),
        color = c.surface,
        shadowElevation = KElevation.card,
    ) {
        Column(
            modifier = Modifier
                .clickable(onClick = onClick)
                .padding(KSpacing.md),
            verticalArrangement = Arrangement.spacedBy(KSpacing.sm),
        ) {
            PostHeader(
                post = post,
                // 作者 id 取帖子里的 `user_id`（不是当前登录用户）——
                // 卡片上的头像永远是作者，点它进的是作者的页面
                onOpenUser = onOpenUser?.let { open -> ({ open(post.post.userId) }) },
            )

            // 媒体排在正文之前 —— 与设计稿一致（头像行 → 配图 → 正文 → 操作栏）
            when {
                post.images.isNotEmpty() -> PostImageGrid(
                    images = post.images,
                    // 点第 index 张 → 从那一张开始看（不是永远从第一张）。
                    // 第三个参数是**帖子 id**：查看器要用它按 `postImageKey(postId, page)`
                    // 声明共享元素（M5），key 必须与卡片/详情页同一套，飞行才对得上。
                    onClick = onImageClick?.let { cb -> { i: Int -> cb(post.images, i, post.id) } },
                    // 共享元素（M3）：详情页里的同一张图用同一个 key，于是点卡片是"图放大过去"
                    postId = post.id,
                )
                post.hasVideo -> VideoCover(
                    post,
                    onClick = onVideoClick,
                )
            }

            if (post.title.isNotBlank()) {
                Text(
                    text = post.title,
                    style = KType.subtitle,
                    color = c.textPrimary,
                )
            }
            if (post.description.isNotBlank()) {
                // 正文 + 话题：话题从正文里摘出来单独一行（用户要求"跟正文隔开一点"），
                // 并且可点 → 搜该话题的相关帖子
                TaggedDescription(
                    text = post.description,
                    style = KType.body,
                    color = c.textSecondary,
                    maxLines = 6,
                    onTagClick = onTagClick,
                )
            }

            PostActions(
                post = post,
                onLike = onLike,
                onBookmark = onBookmark,
                onRepost = onRepost,
                onComment = onComment,
                onShare = onShare,
                // 只有作者本人能编辑（服务端也会再判一次：只能改自己的帖子）
                canEdit = onEdit != null && myUserId > 0 && post.post.userId == myUserId,
                onEdit = onEdit,
            )
        }
    }
}

/**
 * 卡片顶部的作者行：头像 + 昵称/时间 [+ 置顶]。
 *
 * **头像与昵称整块可点**（`onOpenUser` 非空时）→ 进作者主页。
 * 这一块必须自己消费点击：Compose 的 `clickable` 会吃掉事件，不会冒泡到卡片的
 * `clickable`，所以点作者不会顺带打开帖子详情（用户预期是"点谁的头像看谁"）。
 * 点击区只包住头像 + 文字，**不含右侧的「置顶」角标与整行空白** ——
 * 把空白也算进去会让"想点卡片进详情"的人在远离文字的地方误进主页。
 */
@Composable
private fun PostHeader(post: PostUi, onOpenUser: (() -> Unit)? = null) {
    val c = KTheme.colors
    // 头像共享元素的"发起端"入口（见 AvatarFlyer）：点名、判断该不该声明 key、导航都在它身上
    val flyer = rememberAvatarFlyer()
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
    ) {
        // 头像 + 昵称/时间 作为一个整体，点击进主页
        Row(
            modifier = Modifier
                .weight(1f)
                .then(
                    if (onOpenUser != null) {
                        Modifier.clickable(onClickLabel = "查看 ${post.username} 的主页", onClick = onOpenUser)
                    } else {
                        Modifier
                    }
                ),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(KSpacing.xs),
        ) {
            Avatar(
                url = post.avatarUrl,
                name = post.username,
                size = KDimens.avatarCard,
                /**
                 * 只有**这次跳转的发起卡片**才声明共享 key —— 同一屏里同作者的多张卡片
                 * 否则会抢同一个 key，头像会从错的那张卡飞过来（见 [AvatarShareState]）。
                 */
                sharedKey = avatarKey(post.post.userId).takeIf {
                    flyer.isSource(post.post.userId, post.id, AvatarShareOrigin.Card)
                },
                // 点头像本身：先点名"发起者"，再走与整行相同的跳转。
                // 点昵称仍然走整行那个 clickable（不做共享元素）—— 只有点头像才"飞"。
                onClick = onOpenUser?.let { open ->
                    { flyer.fly(post.post.userId, post.id, AvatarShareOrigin.Card, open) }
                },
            )
            // 昵称与「时间 · 位置」之间留一档间距：贴在一起时用户反馈"时间太挨着 id 了"
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(KSpacing.xxs),
            ) {
                Text(
                    text = post.username.ifBlank { "匿名" },
                    style = KType.bodyStrong,
                    color = c.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    // 位置并进这一行（设计稿「3 分钟前 · 来自 App」同一形态）；没填就不加分隔符
                    text = if (post.location.isBlank()) {
                        post.timeText
                    } else {
                        "${post.timeText} · ${post.location}"
                    },
                    style = KType.footnote,
                    color = c.textMuted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (post.post.isPinned) {
            Text("置顶", style = KType.tiny, color = c.accent)
        }
    }
}

/**
 * 圆形头像。
 *
 * @param glyph 没有头像图时的兜底：给 [GlyphKind] 就画图标，不给就画名字首字。
 *   聊天页用 `GlyphKind.User`（设计稿两侧都是人像图标）；信息流仍用首字 —— 首字能直接认出人。
 * @param bg / @param fg 底色与前景色，默认 `accentSoft` + `accent`。
 *   聊天页按气泡侧边区分：对方的头像是中性浅底 + 深图标，自己的是 accent 底 + onAccent 图标。
 * @param sharedKey 非空时这个头像参与"头像飞进对方主页"的共享元素转场（M3 补完）。
 *   两端必须是**同一个 key**（见 [avatarKey]），且发起端要被 [AvatarShareState] 点名。
 * @param onClick 点头像**本身**。与父级"整行可点"分开是有意的：只有点头像才做共享元素
 *   （点昵称进主页是普通转场），也避免嵌套 clickable 把父级的手势语义搅乱。
 */
@Composable
fun Avatar(
    url: String?,
    name: String,
    size: androidx.compose.ui.unit.Dp,
    modifier: Modifier = Modifier,
    glyph: GlyphKind? = null,
    bg: Color? = null,
    fg: Color? = null,
    sharedKey: String? = null,
    onClick: (() -> Unit)? = null,
) {
    val c = KTheme.colors
    val bgColor = bg ?: c.accentSoft
    val fgColor = fg ?: c.accent
    Box(
        modifier = modifier
            // 共享元素放在链首，圆角（这里是圆）紧跟其后 ——
            // 覆盖层只保留元素自身链上的修饰符，靠外层容器裁圆是裁不到的
            // （视频封面那一轮踩过：飞行中变直角、落位又变圆）
            .then(if (sharedKey != null) Modifier.sharedBoundsIfAvailable(sharedKey) else Modifier)
            .size(size)
            .clip(CircleShape)
            .background(bgColor)
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier),
        contentAlignment = Alignment.Center,
    ) {
        if (url != null) {
            AsyncImage(
                model = url,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.size(size).clip(CircleShape),
            )
        } else if (glyph != null) {
            Glyph(tint = fgColor, kind = glyph, size = size * 0.55f)
        } else {
            // 无头像时用首字兜底（不能留白圈，否则列表看起来像没加载出来）
            Text(
                text = avatarInitial(name),
                style = KType.caption,
                fontWeight = FontWeight.SemiBold,
                color = fgColor,
            )
        }
    }
}

@Composable
private fun PostImageGrid(images: List<String>, onClick: ((Int) -> Unit)?, postId: Long) {
    val c = KTheme.colors
    // 长按任意一格 = 存这一张（点还是原来的"打开"）
    val saveMedia = rememberMediaSave()
    // 单图 = **整卡宽、按原图比例完整显示**（设计稿首页卡片的通栏「帖子配图」块；
    // 普通照片 4:3 / 3:2 时与设计稿完全一致）。**不裁切**：手机截屏这类竖长图
    // 一旦被裁成 4:3 就只剩中间一条，用户实测反馈"图片显示不全 / 像 UI 残影"。
    // 多图才走下面的方块网格（缩略图墙本来就允许裁切，点开可看全图）。
    if (images.size == 1) {
        val url = images[0]
        // 显式内存缓存键（见 rememberThumbRequest）：查看器要拿这一张当飞行的占位图
        val painter = coil3.compose.rememberAsyncImagePainter(model = rememberThumbRequest(url))
        /**
         * 高度按**原图比例**算（不裁切），所以比例没出来时这一格会矮一截（4:3 占位）——
         * 用 [rememberImageAspect] 先查"这张图实测过的比例"：从详情页返回时卡片是新组合的，
         * 只有进程内缓存能挡住那次"先 4:3 再改回真比例"的**列表上下跳**（用户实测反馈）。
         */
        val ratio = rememberImageAspect(url, painter)
        Box(
            modifier = Modifier
                // 共享元素：放在链首 —— 它上报的是"这个元素自己的边界"，
                // 后面的 clip/background 只是画法，不影响要飞过去的矩形。
                //
                // **用 sharedElement 而不是 sharedBounds**（M5）：同一批 key 有两个端点
                // （卡片格 / 详情页格），两端必须同族；sharedBounds 的"原地也画一份"会让
                // 目标端在自己的位置上一直画着（返回时看起来像"图在原位等着"）。
                .sharedElementIfAvailable(postImageKey(postId, 0))
                // 登记"这一格在哪 + 取景比例 + 圆角"：全屏查看器的进出场飞行靠它（M5.2 / M5.5）
                // 圆角必须与下面那行 `clip(...)` 一致 —— 飞行图会从这个圆角变到全屏的直角
                .registerViewerOrigin(postId, 0, painter, KRadius.row)
                .fillMaxWidth()
                .aspectRatio(ratio)
                .clip(RoundedCornerShape(KRadius.row))
                .background(c.accentSoft)
                // 长按这一张 = 保存到相册（用户要求"图片视频要能长按存下来"）
                .then(
                    if (onClick != null) {
                        Modifier.combinedClickable(
                            onClick = { onClick(0) },
                            onLongClick = { saveMedia(url, MediaKind.Image) },
                        )
                    } else {
                        Modifier
                    }
                ),
        ) {
            Image(
                painter = painter,
                contentDescription = null,
                contentScale = ContentScale.FillWidth,
                modifier = Modifier.fillMaxSize(),
            )
        }
        return
    }
    val shown = images.take(3)
    // 网格宽度必须整除可用宽度（设计稿 §4.6）：
    // 卡片左右各 16 内边距 + 卡片 16 水平内边距 = 屏宽 - 64；3 列 + 2 个 8px 间隙
    val side = (KGridWidth() - KSpacing.xs * 2) / 3
    Row(horizontalArrangement = Arrangement.spacedBy(KSpacing.xs)) {
        shown.forEachIndexed { index, url ->
            // 用现成 painter（而不是 AsyncImage）把**原图宽高比**交给查看器，避免多解一次码；
            // 请求带显式内存缓存键 —— 查看器要拿这一张当飞行的占位图
            val painter = coil3.compose.rememberAsyncImagePainter(model = rememberThumbRequest(url))
            Box(
                modifier = Modifier
                    // 多图网格：每一格一个 key（详情页的多图网格用 globalIndex 对齐）
                    .sharedElementIfAvailable(postImageKey(postId, index))
                    // 圆角与下面那行 `clip(...)` 必须一致（M5.5：飞行图要圆角↔直角地变）
                    .registerViewerOrigin(postId, index, painter, KRadius.row)
                    .size(side)
                    .clip(RoundedCornerShape(KRadius.row))
                    // 图片底用主题色，避免横图留白处出现突兀的黑矩形
                    .background(c.accentSoft)
                    // 注意：卡片整体已经 clickable(onClick = 打开帖子)，
                    // 图片这层必须自己消费点击，否则点图会变成进详情页
                    // 长按这一格 = 保存到相册
                    .then(
                        if (onClick != null) {
                            Modifier.combinedClickable(
                                onClick = { onClick(index) },
                                onLongClick = { saveMedia(url, MediaKind.Image) },
                            )
                        } else {
                            Modifier
                        }
                    ),
            ) {
                Image(
                    painter = painter,
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.size(side),
                )
                if (index == shown.lastIndex && images.size > shown.size) {
                    Box(
                        modifier = Modifier
                            .size(side)
                            .background(Color(0x99000000)),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = "+${images.size - shown.size}",
                            style = KType.bodyStrong,
                            color = Color.White,
                        )
                    }
                }
            }
        }
    }
}

/**
 * 视频区。
 *
 * 信息流视频封面（**M6.5 起没有自动播放了**）：
 *  · 静态封面 + 右上角「视频」胶囊（黑透明底）标明"这是一条视频"；
 *  · 点击**整块交给卡片**（冒泡到卡片根部的点击 → 进帖子详情页）——
 *    用户明确要求："首页帖子点了不要进入图片或者视频，应该是进入帖子详情页"；
 *  · 播放只在详情页里发生（那边是内联播放器，进来就播、带声音）。
 *
 * **历史（为什么要写下来）**：这里曾经有一套"聚焦满 3 秒就静音自动播放"的逻辑
 * （`FeedScreen` 的 `focusedPostId` + 这里按 `videoActive` 组合 `KVideoPlayer`）。
 * 它带来过一连串问题（`AndroidView` 不参与转场 → 卡片里出现"等飞行的播放器框"、
 * 播放器与共享元素打架），最后用户拍板：**首页不要自动播放**。
 * 于是那一整套（含 `videoActive` / `videoMuted` / `videoInteractive` 三个参数、
 * 静音角标、以及"播放中也要消费点击"的那层 `clickable`）一起删掉了 ——
 * 要恢复的话，把它和 `FeedScreen` 的聚焦判定一起拿回来即可（见 `docs/android-motion-plan.md` 的 M6.5）。
 */
@Composable
internal fun VideoCover(
    post: PostUi,
    onClick: (() -> Unit)? = null,
) {
    val c = KTheme.colors
    val side = KGridWidth()
    val videoKey = postVideoKey(post.id)

    /**
     * 这条视频的共享元素**正在飞**吗（卡片 ↔ 详情页那条）。
     *
     * 三个信号并集，各自补一段空窗（理由见 `SharedElements.kt` 里三处注释）：
     *  · [isPageTransitioning]：转场第一帧就为真 —— 补"还没匹配上"的那几帧；
     *  · [isSharedTransitionActive]：共享元素匹配上之后为真 —— 补"打断返回又立刻重进"那种
     *    页面状态看不出在飞的情况；
     *  · [isPageLeaving]：本页正在出场。
     *
     * 用途：飞行期间**不画「视频」胶囊** —— 它是共享元素的兄弟节点（不跟着飞），
     * 留在原地就是"目标位先摆着一个标签等人飞过来"（M5.8 那次修的就是这个）。
     */
    val sharedFlying = isSharedTransitionActive() || isPageLeaving() || isPageTransitioning()

    /**
     * 目标端在"飞行还没接上"的那几帧里先把自己藏起来（见 [shouldPreHideSharedElement]）。
     *
     * 藏的是**祖先**（这一层 Box），不是共享元素自己那条链 —— 覆盖层只保留元素自身的修饰符，
     * 所以藏祖先不影响飞行的那一份。
     */
    val hideUntilFlying = shouldPreHideSharedElement(videoKey)

    // 长按封面 = 保存视频到相册（点仍是原来的语义：进详情页，详情里才播放）
    val saveMedia = rememberMediaSave()
    Box(
        modifier = Modifier
            .width(side)
            .aspectRatio(16f / 9f)
            // 卡片整体已经 clickable（进详情），视频区这一层自己消费点击 ——
            // 否则这一下会被卡片抢走、语义变成"打开详情"而不是"播放"（实测踩过：点视频完全没反应）。
            // 长按 = 保存视频；没有点击回调时（调用方没给）这一层不吃事件，保持原来的冒泡语义。
            .then(
                if (onClick != null) {
                    Modifier.combinedClickable(
                        onClick = onClick,
                        onLongClick = { post.videoUrl?.let { saveMedia(it, MediaKind.Video) } },
                    )
                } else {
                    Modifier
                }
            )
            .alpha(if (hideUntilFlying) 0f else 1f),
    ) {
        /**
         * 共享元素层：**整个视频区**作为一个整体飞（底色 + 封面）。
         *
         * 为什么 key 挂在这一层、而不是像早先那样只挂在封面上（M5.8）：
         * 图片格那一族的 key 就是挂在**带底色和圆角的那个 Box** 上的，所以飞行期间整格都不在原地画；
         * 而视频这边只挂了封面，于是**底色盒子与文案留在原地** ——
         * 返回信息流时卡片那个视频位先摆着一个空框等封面飞过来，与图片帖的观感不一致
         * （用户实测反馈："一致性不怎么好"）。
         *
         * 圆角与底色必须在**这一层自己的链上**（共享元素覆盖层只保留元素自身的修饰符，
         * 祖先容器上的 clip 不跟进去）—— 否则飞行中是直角、落位又变圆角。
         */
        Box(
            modifier = Modifier
                .fillMaxSize()
                .sharedElementIfAvailable(videoKey)
                .declareSharedPeer(videoKey)
                .clip(RoundedCornerShape(KRadius.row))
                .background(c.accentSoft),
            contentAlignment = Alignment.Center,
        ) {
            // 封面：**始终**作为最底层存在（原来是"没播放时才画"）。
            // 为什么这么改：
            //  · 共享元素（M3）：详情页的同一张封面用同一个 key，于是点卡片是"封面放大过去"
            //    （视频帖原本两端没有 key，所以点视频帖什么都不会飞）；
            //  · 它必须是 Compose 画的元素（AsyncImage）。共享元素在转场期间会被画进
            //    SharedTransitionScope 的覆盖层，而播放器是 AndroidView/SurfaceView，
            //    放进去会出黑块或重复实例（styles.xml 里 surface_type 那个坑是同一类问题）。
            if (post.videoCoverUrl != null) {
                AsyncImage(
                    model = post.videoCoverUrl,
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize(),
                )
            }
        }

        /**
         * 右上角「视频」胶囊（用户要求：**黑透明胶囊 + 两个字「视频」**）。
         *
         * 为什么放在共享元素**外面**：它是"这条是视频"的角标，不属于要飞的那块画面；
         * 但正因为是兄弟节点，**飞行期间必须不画** —— 否则目标位会先摆着标签等人飞过来
         * （M5.8 修过的那个坑，与之前「▶ 视频」文案同理）。
         *
         * 形态沿用本工程既有的浮层约定（共享画面右上角那三个钮也是这套）：
         * 半透明黑底 + 白字 —— 它压在任意封面上都读得出来。
         */
        if (!sharedFlying) {
            Text(
                text = "视频",
                style = KType.tiny,
                color = Color.White,
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(KSpacing.xs)
                    .clip(RoundedCornerShape(KRadius.pill))
                    .background(Color.Black.copy(alpha = 0.35f))
                    .padding(horizontal = KSpacing.xs, vertical = 2.dp),
            )
        }
    }
}

@Composable
internal fun PostActions(
    post: PostUi,
    onLike: () -> Unit,
    onBookmark: () -> Unit,
    onRepost: () -> Unit,
    canEdit: Boolean,
    onEdit: ((PostUi) -> Unit)?,
    onComment: (() -> Unit)? = null,
    onShare: (() -> Unit)? = null,
) {
    val c = KTheme.colors
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(KSpacing.md),
    ) {
        // 点赞：三态明确（未赞描边+次要色 / 已赞实心+危险色 / 按下缩放）
        KLikeButton(liked = post.isLiked, count = post.likeCount, onClick = onLike)

        ActionItem(
            label = formatCount(post.commentCount),
            selected = false,
            // 点评论数进详情（原来这里是空实现，点了没反应）
            onClick = { onComment?.invoke() },
        ) { tint, _ -> Glyph(tint, GlyphKind.Chat, size = 18.dp) }

        ActionItem(
            label = formatCount(post.repostCount),
            selected = post.isReposted,
            onClick = onRepost,
        ) { tint, _ -> Glyph(tint, GlyphKind.Repost, size = 18.dp) }

        ActionItem(
            label = formatCount(post.shareCount),
            selected = false,
            onClick = { onShare?.invoke() },
        ) { tint, _ -> Glyph(tint, GlyphKind.Share, size = 18.dp) }

        Spacer(Modifier.weight(1f))

        // 编辑：只在自己的帖子上出现（服务端 PUT 也会再判一次归属）
        if (canEdit && onEdit != null) {
            Text(
                text = "编辑",
                style = KType.caption,
                color = c.textSecondary,
                modifier = Modifier
                    .clip(RoundedCornerShape(KRadius.chip))
                    .clickable { onEdit(post) }
                    .padding(horizontal = KSpacing.xxs, vertical = KSpacing.xs),
            )
        }

        Box(modifier = Modifier.clickable(onClick = onBookmark)) {
            Glyph(
                tint = if (post.isBookmarked) c.accent else c.textSecondary,
                kind = GlyphKind.Bookmark,
                size = 18.dp,
            )
        }
    }
}

@Composable
internal fun ActionItem(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    icon: @Composable (Color, Boolean) -> Unit,
) {
    val c = KTheme.colors
    val tint = if (selected) c.accent else c.textSecondary
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(KRadius.chip))
            .clickable(onClick = onClick)
            .padding(horizontal = KSpacing.xxs, vertical = KSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(KSpacing.xxs),
    ) {
        icon(tint, selected)
        Text(label, style = KType.caption, color = tint)
    }
}

/** 卡片内的可用宽度（屏宽 - 屏幕左右边距 - 卡片内边距） */
@Composable
internal fun KGridWidth(): androidx.compose.ui.unit.Dp {
    val screen = androidx.compose.ui.platform.LocalConfiguration.current.screenWidthDp.dp
    return screen - KSpacing.md * 4
}
