package top.kuangdada.k.core.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * ============================================================
 * 图书 / 语音 / 用户资料 的 DTO（对齐 shared/src/types.ts 与各 routes）
 * ============================================================
 */

// ---------------------------------------------------------------
// 图书（server/src/routes/books.ts）
// ---------------------------------------------------------------

/**
 * 图书列表项。
 *
 * 注意字段是**驼峰** `volumeCount` / `chapterCount`（服务端这里就是驼峰，
 * 与帖子域的 snake_case 不一致 —— 契约漂移最容易出在这种地方）。
 */
@Serializable
data class BookSummary(
    val id: String,
    val title: String = "",
    val author: String = "",
    val description: String = "",
    /** 相对路径（形如 `/api/books/<id>/cover`），需要拼绝对地址；无封面时为 null */
    val cover: String? = null,
    @SerialName("volumeCount") val volumeCount: Int = 0,
    @SerialName("chapterCount") val chapterCount: Int = 0,
)

@Serializable
data class BookChapter(
    /** 相对路径（卷内章节形如 `第一卷/001.txt`），请求内容时作为 `file` 查询参数 */
    val file: String,
    /** 'text' | 'pdf' */
    val type: String = "text",
    val title: String = "",
) {
    val isPdf: Boolean get() = type == "pdf"
}

@Serializable
data class BookVolume(
    /** 根目录章节的卷名为空串 */
    val name: String = "",
    val chapters: List<BookChapter> = emptyList(),
)

/** 图书详情（= 列表项 + volumes） */
@Serializable
data class BookDetail(
    val id: String,
    val title: String = "",
    val author: String = "",
    val description: String = "",
    val cover: String? = null,
    val volumes: List<BookVolume> = emptyList(),
) {
    val chapterCount: Int get() = volumes.sumOf { it.chapters.size }

    /** 拍平成一维章节列表（阅读器要"下一章"就必须有全局顺序） */
    val flatChapters: List<BookChapter> get() = volumes.flatMap { it.chapters }
}

/** GET /api/books 的响应 */
@Serializable
data class BookListResponse(val books: List<BookSummary> = emptyList())

// ---------------------------------------------------------------
// 用户资料（server/src/routes/users.ts）
// ---------------------------------------------------------------

/** GET /api/users/:id —— 公开资料，多三个统计字段 */
@Serializable
data class UserProfile(
    val id: Long,
    val username: String,
    @SerialName("avatar") val avatar: String? = null,
    val bio: String = "",
    val role: String? = null,
    @SerialName("created_at") val createdAt: String = "",
    @SerialName("post_count") val postCount: Int = 0,
    @SerialName("followers_count") val followersCount: Int = 0,
    @SerialName("following_count") val followingCount: Int = 0,
)

/** GET /api/users/:id/posts 的响应 —— 与信息流同形状（含分页字段） */
@Serializable
data class UserPostsResponse(
    val posts: List<Post> = emptyList(),
    val total: Int = 0,
    val page: Int = 1,
    @SerialName("totalPages") val totalPages: Int = 0,
)

// ---------------------------------------------------------------
// 语音房间（server/src/routes/voice.ts）
// ---------------------------------------------------------------

/**
 * 语音房间。
 *
 * `creator_id` 对**访客创建的房间是 0**（占位）—— 服务端明确说明不要用相等判断归属，
 * 归属以 `isCreator` 为准（访客靠 `X-Voice-Owner-Token`）。
 */
@Serializable
data class VoiceRoom(
    val id: Long,
    val name: String = "",
    val description: String = "",
    @SerialName("cover_url") val coverUrl: String? = null,
    @SerialName("creator_id") val creatorId: Long = 0,
    @SerialName("created_at") val createdAt: String = "",
    @SerialName("creator_username") val creatorUsername: String? = null,
    @SerialName("creator_avatar") val creatorAvatar: String? = null,
    /** 当前在线人数（服务端从 WS 内存态取） */
    @SerialName("participantCount") val participantCount: Int = 0,
    /** 当前查看者是否为本房间创建者（服务端逐查看者计算） */
    @SerialName("isCreator") val isCreator: Boolean = false,
)

@Serializable
data class VoiceRoomListResponse(val rooms: List<VoiceRoom> = emptyList())

/** POST /api/voice/rooms 的响应；访客建房时会**只此一次**回下发所有权令牌 */
@Serializable
data class CreateRoomResponse(
    val room: VoiceRoom,
    @SerialName("ownerToken") val ownerToken: String? = null,
)

@Serializable
data class CreateRoomRequest(val name: String, val description: String = "", val coverUrl: String? = null)

/** 房间封面上传响应（服务端压缩后返回相对 URL，如 /uploads/voice-covers/cover-….jpg） */
@Serializable
data class RoomCoverResponse(val url: String)

/** 删除房间响应 */
@Serializable
data class DeleteRoomResponse(val success: Boolean = false)

/** POST /api/voice/ticket 的响应（登录用户连 WS 用） */
@Serializable
data class TicketResponse(val ticket: String = "")

/** 房间内文字聊天消息（WS 信令的备用通道） */
@Serializable
data class VoiceChatMessage(
    val id: Long = 0,
    @SerialName("room_id") val roomId: Long = 0,
    @SerialName("sender_id") val senderId: Long = 0,
    val username: String = "",
    val avatar: String? = null,
    val content: String = "",
    @SerialName("created_at") val createdAt: String = "",
)

/** 在线参与者（WS 的 joined / peer-joined 携带） */
@Serializable
data class VoiceParticipant(
    val userId: Long = 0,
    val username: String = "",
    val avatar: String? = null,
    val muted: Boolean = false,
    /** 无麦克风权限、仅收听的成员 */
    val listener: Boolean = false,
    /** 正在共享屏幕（全房间最多一人，服务端互斥） */
    val sharing: Boolean = false,
)
