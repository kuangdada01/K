package top.kuangdada.k.nativeapp.ui.viewer

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import top.kuangdada.k.nativeapp.ui.ImageViewerRequest
import top.kuangdada.k.nativeapp.ui.LocalImageViewerOpener
import top.kuangdada.k.nativeapp.ui.LocalViewerOrigins

/**
 * ============================================================
 * 图片查看器的 Compose 入口（M5 起走 Shell 内的覆盖层）
 * ============================================================
 * 签名与旧实现保持一致，所以调用方（信息流/详情/主页三处）不用改 —— 变的只是"打开"的实现：
 * 旧版 `startActivity(ImageViewerActivity)`，现在把请求交给 Shell 的覆盖层。
 *
 * **M5.2**：打开时顺带把"这一组缩略图各自在哪"（[LocalViewerOrigins] 里由截图格子登记的
 * 窗口矩形 + 原图宽高比）装进请求，覆盖层据此自己算进场/退场飞行的几何。
 * 量不到（不在 Shell 里、格子已被回收）时 origins 为空 —— 查看器退化为直接落位，不会出错。
 *
 * @param postId 帖子配图 id，用于查来源（key 与卡片/详情页同一套）。null = 不做飞行。
 */
@Composable
fun rememberImageViewer(
    onClosed: ((Int) -> Unit)? = null,
    /**
     * 进/退飞行时要避让的**顶栏底边**（窗口像素；0 = 不避让）。
     *
     * 传 **lambda** 而不是值：顶栏高度是测量出来的（组合之后才有值），
     * 而这里要的是"点下去那一刻"的真实高度。用途见 [ImageViewerRequest.topInsetPx]。
     */
    topInsetPx: () -> Float = { 0f },
): (urls: List<String>, index: Int, headers: Map<String, String>, postId: Long?) -> Unit {
    val open = LocalImageViewerOpener.current
    val origins = LocalViewerOrigins.current
    /**
     * 用 `rememberUpdatedState` 取"最新的那个 lambda"：调用方每次组合都会给一个新实例，
     * 若把它塞进下面 `remember` 的 key，"打开"这个函数就会每次都换新实例。
     */
    val currentTopInset = rememberUpdatedState(topInsetPx)
    return remember(open, origins, onClosed) {
        { urls, index, headers, postId ->
            if (urls.isNotEmpty()) {
                val start = index.coerceIn(0, urls.lastIndex)
                open(
                    ImageViewerRequest(
                        images = urls,
                        index = start,
                        headers = headers,
                        postId = postId,
                        onClosed = onClosed,
                        topInsetPx = currentTopInset.value(),
                        origins = origins?.of(postId, urls.size) ?: emptyList(),
                        /**
                         * 实时来源。**打开之后来源那一格还会排完版**（详情单图在图片加载完
                         * 之前只有 4:3 占位高），只有逐帧重取才能让退场落回真位置 ——
                         * 详细理由见 [ImageViewerRequest.resolveOrigin]。
                         */
                        resolveOrigin = origins?.let { live ->
                            { page -> live.of(postId, urls.size).getOrNull(page) }
                        },
                    ),
                )
            }
        }
    }
}

/**
 * 不需要鉴权头的简版（帖子的 `/uploads/` 图片是公开的）。
 * 私信/私密图片必须用带 `headers` 的那个重载，否则 403（表现为"图全黑但不报错"）。
 */
@Composable
fun rememberImageViewerSimple(
    onClosed: ((Int) -> Unit)? = null,
    topInsetPx: () -> Float = { 0f },
): (urls: List<String>, index: Int, postId: Long?) -> Unit {
    val open = rememberImageViewer(onClosed, topInsetPx)
    return remember(open) {
        { urls, index, postId -> open(urls, index, emptyMap(), postId) }
    }
}
