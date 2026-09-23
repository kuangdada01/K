package top.kuangdada.k.core.data

import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import top.kuangdada.k.core.data.model.Post

/**
 * 帖子在 UI 侧的表示（含 URL 解析与时间格式化）。
 *
 * 为什么要有这一层：服务端返回的是**相对路径**（`/uploads/xxx.jpg`），
 * Web 版靠同源直接能用，原生必须拼成绝对地址（`https://www.kuangdada.top/uploads/...`）。
 * 拼错的表现是"图片全白、但不报错"，所以统一在这里解析，不让各页面各写一遍。
 */
data class PostUi(
    val post: Post,
    /** 绝对图片地址（已过滤空串） */
    val images: List<String>,
    /** 绝对头像地址；无头像时为 null，UI 用首字兜底 */
    val avatarUrl: String?,
    /** 绝对视频封面地址（视频帖才有） */
    val videoCoverUrl: String?,
    /** 绝对视频地址（视频帖才有）；非空即代表这张卡片要进播放器 */
    val videoUrl: String?,
    /** 相对时间（刚刚 / 5 分钟前 / 3 小时前 / 2 天前 / 具体日期） */
    val timeText: String,
) {
    val id: Long get() = post.id
    val title: String get() = post.title
    val description: String get() = post.description
    /** 位置（空串=没带位置，UI 不显示该行） */
    val location: String get() = post.location
    val username: String get() = post.username
    val likeCount: Int get() = post.likeCount
    val isLiked: Boolean get() = post.isLiked
    val isBookmarked: Boolean get() = post.isBookmarked
    val isReposted: Boolean get() = post.isReposted
    val shareCount: Int get() = post.shareCount
    val repostCount: Int get() = post.repostCount
    val commentCount: Int get() = post.commentCount
    val hasVideo: Boolean get() = !post.videoUrl.isNullOrBlank()
}

/** 把服务端的相对路径拼成绝对地址。已经是 http(s) 的原样返回。 */
fun resolveUrl(path: String?, baseUrl: String): String? {
    val p = path?.takeIf { it.isNotBlank() } ?: return null
    if (p.startsWith("http://") || p.startsWith("https://")) return p
    val base = baseUrl.trimEnd('/')
    return if (p.startsWith("/")) "$base$p" else "$base/$p"
}

fun Post.toUi(baseUrl: String): PostUi = PostUi(
    post = this,
    images = images.mapNotNull { resolveUrl(it, baseUrl) },
    avatarUrl = resolveUrl(avatar, baseUrl),
    videoCoverUrl = resolveUrl(videoCover, baseUrl),
    videoUrl = resolveUrl(videoUrl, baseUrl),
    timeText = relativeTime(createdAt),
)

/**
 * 相对时间。
 *
 * 服务端时间戳是 ISO 字符串（`new Date().toISOString()`，UTC，形如 `2026-09-13T07:19:34.025Z`）。
 * 解析失败时**原样返回**而不是抛异常 —— 时间显示坏了不该让整页崩。
 */
fun relativeTime(iso: String, nowMillis: Long = System.currentTimeMillis()): String {
    if (iso.isBlank()) return ""
    val parsed = parseIso(iso) ?: return iso
    val diff = nowMillis - parsed
    if (diff < 0) return "刚刚"
    val minute = 60_000L
    val hour = 60 * minute
    val day = 24 * hour
    return when {
        diff < minute -> "刚刚"
        diff < hour -> "${diff / minute} 分钟前"
        diff < day -> "${diff / hour} 小时前"
        diff < 30 * day -> "${diff / day} 天前"
        else -> SimpleDateFormat("yyyy-MM-dd", Locale.getDefault()).format(parsed)
    }
}

/**
 * 只要「时:分」—— 聊天页气泡下方的时间戳。
 *
 * 为什么不用 [relativeTime]：聊天页的**日期已经由分隔条给出**（「今天/昨天/9月12日」），
 * 气泡下再写一遍"1 天前"既重复又自相矛盾（分隔条说"昨天"，气泡说"1 天前"）。
 * 设计稿里气泡下就是 `14:32` 这种纯时刻。
 */
fun timeOfDay(iso: String): String {
    val t = parseIso(iso) ?: return iso
    return SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(t))
}

/**
 * 会话页日期分隔条文案：「今天 14:32」/「昨天 14:32」/「9月12日 14:32」/「2025年9月12日 14:32」。
 *
 * 与 [relativeTime] 的分工：那个回答"多久以前"（帖子、列表用），这个回答**哪一天** ——
 * 分隔条是按自然日分组的，用相对时间会在边界上算错（23:59 与 00:01 只差 2 分钟，却是两天）。
 *
 * 不再用「3 天前」这类相对天数（用户反馈要直接看日期）：倒数第二天起直接给日期。
 */
fun dayDividerText(iso: String, nowMillis: Long = System.currentTimeMillis()): String {
    val t = parseIso(iso) ?: return iso
    val hm = SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(t))
    val todayStart = dayStart(nowMillis)
    val thatStart = dayStart(t)
    val days = ((todayStart - thatStart) / 86_400_000L).toInt()
    return when {
        days <= 0 -> "今天 $hm"
        days == 1 -> "昨天 $hm"
        yearOf(thatStart) == yearOf(todayStart) ->
            SimpleDateFormat("M月d日 HH:mm", Locale.getDefault()).format(Date(t))
        else -> SimpleDateFormat("yyyy年M月d日 HH:mm", Locale.getDefault()).format(Date(t))
    }
}

/**
 * 两条消息是否同一自然日（决定要不要插日期分隔条）。
 * 解析失败返回 false —— 宁可多插一条分隔条，也不要把两天的消息错并到一条下面。
 */
fun isSameDay(aIso: String, bIso: String): Boolean {
    val a = parseIso(aIso) ?: return false
    val b = parseIso(bIso) ?: return false
    return dayStart(a) == dayStart(b)
}

/**
 * 相邻两条消息的间隔毫秒（newer − older；任一解析失败返回 null）。
 *
 * 聊天页的时间分隔条与 web 移动端同一条规则：间隔超过 5 分钟就插一条，
 * 与自然日无关（23:59 与 00:01 差 2 分钟，不该各插一条）。调用方对 null 的处理
 * 与 [isSameDay] 相反：解析失败宁可**不**插，免得堆一堆分隔条。
 */
fun timeGapMillis(newerIso: String, olderIso: String): Long? {
    val newer = parseIso(newerIso) ?: return null
    val older = parseIso(olderIso) ?: return null
    return newer - older
}

private fun dayStart(millis: Long): Long = Calendar.getInstance().apply {
    timeInMillis = millis
    set(Calendar.HOUR_OF_DAY, 0)
    set(Calendar.MINUTE, 0)
    set(Calendar.SECOND, 0)
    set(Calendar.MILLISECOND, 0)
}.timeInMillis

private fun yearOf(millis: Long): Int =
    Calendar.getInstance().apply { timeInMillis = millis }.get(Calendar.YEAR)

private val isoFormats = listOf(
    "yyyy-MM-dd'T'HH:mm:ss.SSSXXX",
    "yyyy-MM-dd'T'HH:mm:ssXXX",
    "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
    "yyyy-MM-dd'T'HH:mm:ss'Z'",
    "yyyy-MM-dd HH:mm:ss",
)

private fun parseIso(iso: String): Long? {
    for (pattern in isoFormats) {
        val ok = runCatching {
            val fmt = SimpleDateFormat(pattern, Locale.US).apply {
                // 带 Z 但没写 XXX 的老格式按 UTC 解（服务端用 toISOString，是 UTC）
                timeZone = TimeZone.getTimeZone("UTC")
                isLenient = true
            }
            fmt.parse(iso)?.time
        }.getOrNull()
        if (ok != null) return ok
    }
    return null
}
