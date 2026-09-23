package top.kuangdada.k.core.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * ============================================================
 * 领域模型（严格对齐 server 的 shared/src/types.ts）
 * ============================================================
 * 为什么要在这里重新写一遍而不是共享 TS 类型：TS 类型在编译期擦除，跨语言无法复用；
 * DTO 必须与**服务端实际返回的 JSON 字段名**逐一对齐，字段名错了在真机上的表现是
 * "某个功能静默失效"（页面不报错、就是没数据），所以每个字段都标注了服务端来源。
 */

/** 用户（shared/src/types.ts User） */
@Serializable
data class User(
    val id: Long,
    val username: String,
    val email: String = "",
    val avatar: String? = null,
    val bio: String = "",
    val role: String? = null,
    @SerialName("created_at") val createdAt: String = "",
    @SerialName("post_count") val postCount: Int? = null,
    @SerialName("followers_count") val followersCount: Int? = null,
    @SerialName("following_count") val followingCount: Int? = null,
) {
    val isAdmin: Boolean get() = role == "admin"
}

/** 帖子（shared/src/types.ts Post；服务端在返回前用 withImages() 补出 images 数组） */
@Serializable
data class Post(
    val id: Long,
    @SerialName("user_id") val userId: Long,
    @SerialName("image_url") val imageUrl: String = "",
    val images: List<String> = emptyList(),
    val title: String = "",
    val description: String = "",
    @SerialName("created_at") val createdAt: String = "",
    val username: String = "",
    val avatar: String? = null,
    @SerialName("like_count") val likeCount: Int = 0,
    @SerialName("comment_count") val commentCount: Int = 0,
    @SerialName("share_count") val shareCount: Int = 0,
    /** 0/1，未登录时为 null */
    val liked: Int? = null,
    val shared: Int? = null,
    val bookmarked: Int? = null,
    val reposted: Int? = null,
    @SerialName("repost_count") val repostCount: Int = 0,
    @SerialName("close_comments") val closeComments: Int? = null,
    val pinned: Int? = null,
    @SerialName("video_url") val videoUrl: String? = null,
    @SerialName("video_cover") val videoCover: String? = null,
    /** 发帖时填的位置（自由文本，空串=没填）。服务端 migration 027 起返回该字段 */
    val location: String = "",
) {
    val isLiked: Boolean get() = liked == 1
    val isBookmarked: Boolean get() = bookmarked == 1
    val isReposted: Boolean get() = reposted == 1
    val commentsClosed: Boolean get() = closeComments == 1
    val isPinned: Boolean get() = pinned == 1
}

/** 分页响应（GET /api/posts） */
@Serializable
data class PostPage(
    val posts: List<Post> = emptyList(),
    val total: Int = 0,
    val page: Int = 1,
    @SerialName("totalPages") val totalPages: Int = 0,
) {
    val hasMore: Boolean get() = page < totalPages
}

/** 收藏/转发列表响应（GET /api/posts/bookmarks/me、/reposts/me）——注意字段是 has_more，形状与信息流不同 */
@Serializable
data class PostListWithMore(
    val posts: List<Post> = emptyList(),
    @SerialName("has_more") val hasMore: Boolean = false,
)

/** 认证响应（POST /api/auth/login、/register） */
@Serializable
data class AuthResponse(
    val token: String,
    val user: User,
)

/** 只有 message 的响应（send-code / forgot-password / reset-password） */
@Serializable
data class MessageResponse(
    val message: String = "",
)

// ---- 请求体 ----

@Serializable
data class LoginRequest(val email: String, val password: String)

@Serializable
data class SendCodeRequest(val email: String)

@Serializable
data class RegisterRequest(
    val username: String,
    val email: String,
    val password: String,
    val code: String,
)

@Serializable
data class ForgotPasswordRequest(val email: String)

@Serializable
data class ResetPasswordRequest(
    val email: String,
    val code: String,
    val password: String,
)

/**
 * 更新资料请求体（PUT /api/users/me ← shared/src/schemas/user.ts `updateProfileSchema`）。
 *
 * 两个字段都可空，**null 的字段不会出现在 JSON 里**（[KJson] 配了 `explicitNulls = false`），
 * 于是服务端按「未提供 = 保持原值」处理 —— 这正是「只改简介不碰昵称」需要的语义。
 *
 * 字段名为什么叫 username 而不是 nickname：服务端只有一个 `username` 列
 * （既有登录/注册/帖子署名都用它），界面上的「昵称」只是文案。
 */
@Serializable
data class UpdateProfileRequest(
    val username: String? = null,
    val bio: String? = null,
)

// ---- 互动响应 ----

@Serializable
data class LikeResult(val liked: Boolean, @SerialName("like_count") val likeCount: Int = 0)

@Serializable
data class BookmarkResult(val bookmarked: Boolean)

@Serializable
data class ShareResult(@SerialName("share_count") val shareCount: Int = 0, val shared: Boolean = false)

@Serializable
data class RepostResult(val reposted: Boolean, @SerialName("repost_count") val repostCount: Int = 0)
