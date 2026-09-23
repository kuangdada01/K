package top.kuangdada.k.nativeapp

import android.content.Intent
import top.kuangdada.k.nativeapp.ui.AppDestination
import top.kuangdada.k.nativeapp.ui.encodeDest

/**
 * ============================================================
 * 深链解析（站内 URL → 应用内目标）
 * ============================================================
 * 与 Web 版的路由表**逐条对齐**（`client/src/router/AppRoutes.tsx`）：
 * ```
 * /                     首页
 * /post/:id             首页（并滚到那条帖子）
 * /explore              搜索发现
 * /books                图书
 * /books/:id            图书详情
 * /books/:id/read       阅读器（章节由详情页决定，见下）
 * /voice                语音
 * /messages             消息
 * /messages/:userId     与某人的聊天
 * /profile              个人主页
 * /profile/:id          他人的个人主页（二级页，顶栏自带返回）
 * /admin                管理后台
 * /announcements        公告
 * *                     首页（与 Web 的 `<Navigate to="/" replace />` 一致）
 * ```
 *
 * **为什么抽成纯函数**：解析错了用户会落到错误的页面，而这种错误手上很难发现
 * （点对了链接进错页，往往被当成"缓存问题"）。抽出来配单测，边界一次说清：
 * 尾斜杠、查询串、hash 路由（`#/post/1`）、非法 id、裸域/带 www 都要覆盖。
 *
 * 已知的一处**刻意降级**：`/post/:id` 在 Web 里是"首页 + 打开那条帖子"，原生版
 * 首页尚未实现"滚动定位到指定帖子"，所以先落到首页（不丢功能，只是少一次定位）。
 */
object DeepLink {

    /**
     * 从启动 Intent 解析目标；无法识别时返回 null（调用方保持默认首页）。
     *
     * 同时支持两种入口：
     * - 深链：`VIEW` + `https://www.kuangdada.top/...`（Manifest 的 intent-filter 已声明）；
     * - 通知点击：`extras` 里带 `deep_link` / `url`（本地通知由 App 自己构造）。
     */
    fun fromIntent(intent: Intent?): AppDestination? {
        if (intent == null) return null
        // 通知点击：优先级最高（显式带了目标）
        for (key in NOTIFICATION_KEYS) {
            val raw = intent.getStringExtra(key)?.takeIf { it.isNotBlank() } ?: continue
            parse(raw)?.let { return it }
        }
        if (intent.action != Intent.ACTION_VIEW) return null
        val data = intent.data?.toString() ?: return null
        return parse(data)
    }

    /** 解析站内 URL；无法识别或不是本站时返回 null */
    fun parse(rawUrl: String): AppDestination? {
        // 先处理**应用内编码形态**（`voice:42` / `book:abc` / `chat:7:名字`）。
        // 语音房通知的 deep_link 用的就是这种形态 —— 它比 URL 短、且不受 host 校验影响。
        parseEncoded(rawUrl)?.let { return it }

        val path = extractPath(rawUrl) ?: return null
        val segments = path.split('/').filter { it.isNotBlank() }
        if (segments.isEmpty()) return AppDestination.Home

        return when (segments[0]) {
            "post" -> {
                // 帖子详情页尚未实现，落到首页（见类注释的"刻意降级"）
                AppDestination.Home
            }
            "explore" -> AppDestination.Explore()
            "books" -> when {
                segments.size >= 3 && segments[2] == "read" ->
                    AppDestination.BookDetailDest(segments[1]) // 章节由详情页决定
                segments.size >= 2 -> AppDestination.BookDetailDest(segments[1])
                else -> AppDestination.Books
            }
            "voice" -> {
                val id = segments.getOrNull(1)?.toLongOrNull()
                if (id != null && id > 0) AppDestination.VoiceRoomDest(id) else AppDestination.Voice
            }
            "messages" -> {
                val id = segments.getOrNull(1)?.toLongOrNull()
                // 会话名需要另一个接口，这里留空由聊天页自己取
                if (id != null && id > 0) AppDestination.ChatDest(id, null) else AppDestination.Messages
            }
            "profile" -> {
                // `/profile` = 自己的主页（一级 tab）；`/profile/:id` = **他人主页**（二级页）。
                // 后一条以前被无条件落到自己的主页 —— 别人分享来的 `/profile/7` 会打开
                // "我的主页"，用户看到的是自己的资料（很难被当成 bug 报上来，但确实是错的）。
                val id = segments.getOrNull(1)?.toLongOrNull()
                if (id != null && id > 0) AppDestination.UserProfileDest(id) else AppDestination.Profile
            }
            "admin" -> AppDestination.Admin
            "announcements" -> AppDestination.Announcements
            else -> null
        }
    }

    /**
     * 取 URL 的路径部分。
     *
     * 四个必须处理的形态：
     * 1. `https://www.kuangdada.top/post/1?x=2` → 校验 host、去查询串；
     * 2. `https://www.kuangdada.top/#/post/1` → hash 路由（Web 版就是 hash 路由）；
     * 3. `kuangdada.top/post/1`（无 scheme）与 `/post/1`（纯路径）也要认；
     * 4. 裸路径 `explore`（通知 payload 里常见）也认。
     *
     * **必须校验 host**：`https://example.com/explore` 的路径长得一样，
     * 不校验的话别人网站的链接会把我们的 App 打开到错误页面。
     */
    private fun extractPath(rawUrl: String): String? {
        var s = rawUrl.trim()
        if (s.isEmpty()) return null
        val schemeIdx = s.indexOf("://")
        if (schemeIdx > 0) {
            val afterScheme = s.substring(schemeIdx + 3)
            val slash = afterScheme.indexOf('/')
            val hostPart = if (slash >= 0) afterScheme.substring(0, slash) else afterScheme
            if (!isOurHost(hostPart)) return null
            val pathPart = if (slash >= 0) afterScheme.substring(slash) else "/"
            return finishPath(pathPart)
        }
        // 无 scheme：可能是 "kuangdada.top/post/1"、"www.kuangdada.top/x" 或 "/post/1"、"post/1"
        if (!s.startsWith("/")) {
            val slash = s.indexOf('/')
            if (slash < 0) {
                // 裸路径（没有斜杠）：当作 "/explore" 这种
                return finishPath("/$s")
            }
            val hostPart = s.substring(0, slash)
            // 只有看起来像主机名（含 . 或 :）的才校验；否则按裸路径处理
            if (hostPart.contains('.') || hostPart.contains(':')) {
                if (!isOurHost(hostPart)) return null
            }
            s = s.substring(slash)
        }
        if (!s.startsWith("/")) return null
        return finishPath(s)
    }

    /** host 必须是我们自己的域（含端口时只比主机名） */
    private fun isOurHost(hostWithPort: String): Boolean {
        val host = hostWithPort.substringBefore(':').lowercase()
        return host == "kuangdada.top" || host == "www.kuangdada.top"
    }

    /**
     * 解析应用内编码形态（不含 `://`、也不含 `/`）。
     *
     * 与 `AppNavigator` 的 `encodeDest`/`decodeDest` 是同一套字符串，
     * 但这里**只接受明确带前缀的形态**，避免把普通文本误判成路由。
     */
    private fun parseEncoded(raw: String): AppDestination? {
        val s = raw.trim()
        if (s.contains("://") || s.contains('/')) return null
        return when {
            s.startsWith("voice:") -> s.removePrefix("voice:").toLongOrNull()
                ?.takeIf { it > 0 }?.let { AppDestination.VoiceRoomDest(it) }
            s.startsWith("book:") -> s.removePrefix("book:").takeIf { it.isNotBlank() }
                ?.let { AppDestination.BookDetailDest(it) }
            s.startsWith("chat:") -> {
                val rest = s.removePrefix("chat:")
                val id = rest.substringBefore(':').toLongOrNull()
                if (id != null && id > 0) {
                    AppDestination.ChatDest(id, rest.substringAfter(':', "").ifBlank { null })
                } else null
            }
            else -> null
        }
    }

    private fun finishPath(pathWithQuery: String): String? {
        var p = pathWithQuery
        // hash 路由：`#/post/1` → 用 hash 之后的内容
        val hash = p.indexOf('#')
        if (hash >= 0) {
            val frag = p.substring(hash + 1)
            val fragSlash = frag.indexOf('/')
            if (fragSlash >= 0) {
                p = frag.substring(fragSlash)
            } else if (frag.isNotBlank()) {
                p = "/$frag"
            } else {
                p = p.substring(0, hash) // `#` 后面是空的，用前半段
            }
        }
        // 去查询串
        val q = p.indexOf('?')
        if (q >= 0) p = p.substring(0, q)
        return p
    }

    private val NOTIFICATION_KEYS = listOf("deep_link", "deepLink", "url", "link")
}

/**
 * 导航器扩展：把 Intent 里的深链落到当前页面。
 *
 * 放在这里而不是 `AppNavigator` 里，是为了**不让导航层依赖 Android Intent**
 * （导航层是纯状态机，单测里可以直接构造，不需要 Robolectric）。
 */
fun top.kuangdada.k.nativeapp.ui.AppNavigator.navigateFromIntent(intent: Intent?): Boolean {
    val dest = DeepLink.fromIntent(intent) ?: return false
    if (dest == AppDestination.Home) return false // 首页 = 默认态，不需要动
    // push 而不是 replace：用户按返回键能回到进来之前的地方
    push(dest)
    return true
}

/** 供 `rememberSaveable` 恢复用：把目标编码成与导航器一致的字符串 */
internal fun AppDestination.toEncodedString(): String = encodeDest(this)
