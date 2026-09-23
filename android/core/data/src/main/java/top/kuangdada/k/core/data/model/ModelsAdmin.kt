package top.kuangdada.k.core.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * ============================================================
 * 管理后台 DTO（server/src/routes/admin/ 下三个子路由，共 15 个端点）
 * ============================================================
 * 三张表的行形状与字段名都已核对源码（repositories/admin.repo.ts）。
 *
 * 一处必须注意的**服务端"只增不改"设计**：用户/公告列表有**两种响应形状**：
 *  · 不带 `page`/`q` → `{ users, has_more }`（老客户端走的路径，上限截断）
 *  · 带 `page` 或 `q` → `{ users, total, page, limit, totalPages, has_more }`
 * 原生侧**一律带 `page`**，所以只需要后者一种形状 —— 但要知道为什么会有两个。
 */

// ---------------------------------------------------------------
// 用户
// ---------------------------------------------------------------

@Serializable
data class AdminUserRow(
    val id: Long,
    val username: String = "",
    val email: String = "",
    val avatar: String? = null,
    val bio: String = "",
    val role: String = "user",
    /** null = 未封禁；否则是解封时间（ISO 字符串） */
    @SerialName("banned_until") val bannedUntil: String? = null,
    @SerialName("created_at") val createdAt: String = "",
    @SerialName("post_count") val postCount: Int = 0,
) {
    val isAdmin: Boolean get() = role == "admin"

    /**
     * 是否**当前**处于封禁中。
     *
     * 注意：服务端只存解封时间，不自己判过期 —— 所以客户端必须比时间。
     * 直接判 `bannedUntil != null` 会把"已到期的封禁"也显示成已封禁。
     */
    fun isBannedNow(nowMillis: Long = System.currentTimeMillis()): Boolean {
        val until = bannedUntil ?: return false
        return runCatching { java.time.Instant.parse(until).toEpochMilli() > nowMillis }.getOrDefault(true)
    }
}

@Serializable
data class AdminUserPage(
    val users: List<AdminUserRow> = emptyList(),
    val total: Int = 0,
    val page: Int = 1,
    val limit: Int = 20,
    @SerialName("totalPages") val totalPages: Int = 0,
    @SerialName("has_more") val hasMore: Boolean = false,
)

/** POST /users/:id/ban 的响应 */
@Serializable
data class BanResult(
    val success: Boolean = false,
    @SerialName("banned_until") val bannedUntil: String? = null,
)

/** 请求体：封禁天数（服务端 schema 只允许 1 / 7 / 30 / 365） */
@Serializable
data class BanRequest(val days: Int)

/** 请求体：重置密码（至少 6 位） */
@Serializable
data class ResetPasswordRequest2(val password: String)

@Serializable
data class AdminUsersResponse(val users: List<AdminUserRow> = emptyList())

// ---------------------------------------------------------------
// 帖子
// ---------------------------------------------------------------

@Serializable
data class AdminPostRow(
    val id: Long,
    @SerialName("user_id") val userId: Long = 0,
    @SerialName("image_url") val imageUrl: String = "",
    val title: String = "",
    val description: String = "",
    @SerialName("close_comments") val closeComments: Int = 0,
    val pinned: Int = 0,
    @SerialName("video_url") val videoUrl: String? = null,
    @SerialName("video_cover") val videoCover: String? = null,
    @SerialName("share_count") val shareCount: Int = 0,
    @SerialName("repost_count") val repostCount: Int = 0,
    /**
     * 评论数。**不是 posts 表的列**，是服务端用子查询算出来的
     * （admin.repo.ts 的 `listAllPosts`）。
     *
     * 默认 0 是刻意的兜底：这条字段是后补的，老版本服务端不返回它 ——
     * 给了默认值，客户端在旧服务端上只会少显示一个数字，不会整页解析失败。
     */
    @SerialName("comment_count") val commentCount: Int = 0,
    @SerialName("created_at") val createdAt: String = "",
    val username: String = "",
    val avatar: String? = null,
    /**
     * 帖子配图的**相对路径**（服务端 `withImages` 补出来的 `images` 数组的首项）。
     *
     * 服务端返回的是 `images: [...]`（不是单数字段），这里显式映射第一张，
     * 让列表能画缩略图；没有图（纯文字帖/视频帖无封面）时是 null。
     */
    val images: List<String> = emptyList(),
) {
    val isPinned: Boolean get() = pinned == 1

    /** 缩略图用的相对路径（服务端返回的是相对地址，渲染前要拼 baseUrl） */
    val coverPath: String? get() = images.firstOrNull()?.takeIf { it.isNotBlank() }
}

/** 管理端帖子列表（服务端形状与信息流一致：`{ posts, total, page, totalPages }`） */
@Serializable
data class AdminPostPage(
    val posts: List<AdminPostRow> = emptyList(),
    val total: Int = 0,
    val page: Int = 1,
    @SerialName("totalPages") val totalPages: Int = 0,
)

// ---------------------------------------------------------------
// 公告
// ---------------------------------------------------------------

@Serializable
data class AdminAnnouncementRow(
    val id: Long,
    val title: String = "",
    val content: String = "",
    /** null = 全体公告 */
    @SerialName("target_user_id") val targetUserId: Long? = null,
    @SerialName("from_user_id") val fromUserId: Long = 0,
    @SerialName("created_at") val createdAt: String = "",
    @SerialName("target_username") val targetUsername: String? = null,
)

@Serializable
data class AdminAnnouncementPage(
    val announcements: List<AdminAnnouncementRow> = emptyList(),
    val total: Int = 0,
    val page: Int = 1,
    val limit: Int = 20,
    @SerialName("totalPages") val totalPages: Int = 0,
    @SerialName("has_more") val hasMore: Boolean = false,
)

/** 创建公告的请求体（target_user_id 为空 = 全体公告） */
@Serializable
data class CreateAnnouncementRequest(
    val title: String,
    val content: String,
    @SerialName("target_user_id") val targetUserId: Long? = null,
)

// ---------------------------------------------------------------
// 公告（面向普通用户的 /api/announcements）
// ---------------------------------------------------------------

/**
 * 用户侧公告（shared/src/types.ts Announcement）。
 *
 * 与管理端的区别：多了 `is_read`（0/1）与 `from_username` / `from_avatar` 快照，
 * 少了 `target_username` 之外的差异不大 —— 但**是两套 DTO**，不要混用。
 */
@Serializable
data class AnnouncementDto(
    val id: Long,
    val title: String = "",
    val content: String = "",
    @SerialName("target_user_id") val targetUserId: Long? = null,
    @SerialName("from_user_id") val fromUserId: Long = 0,
    @SerialName("created_at") val createdAt: String = "",
    @SerialName("from_username") val fromUsername: String? = null,
    @SerialName("from_avatar") val fromAvatar: String? = null,
    @SerialName("is_read") val isRead: Int = 0,
) {
    val read: Boolean get() = isRead == 1
}

@Serializable
data class AnnouncementsResponse(val announcements: List<AnnouncementDto> = emptyList())

// ---------------------------------------------------------------
// 通知（/api/notifications，评论/回复等互动通知）
// ---------------------------------------------------------------

/**
 * 互动通知（shared/src/types.ts Notification）。
 * `type` 目前是 'reply' | 'comment'；`content` 是服务端拼好的摘要。
 */
@Serializable
data class NotificationDto(
    val id: Long,
    val type: String = "",
    @SerialName("from_user_id") val fromUserId: Long = 0,
    @SerialName("post_id") val postId: Long? = null,
    @SerialName("comment_id") val commentId: Long? = null,
    val content: String = "",
    val read: Int = 0,
    @SerialName("created_at") val createdAt: String = "",
    @SerialName("from_username") val fromUsername: String = "",
    @SerialName("from_avatar") val fromAvatar: String? = null,
) {
    val isRead: Boolean get() = read == 1
}

@Serializable
data class NotificationsResponse(
    val notifications: List<NotificationDto> = emptyList(),
    @SerialName("unread_count") val unreadCount: Int = 0,
)
