package top.kuangdada.k.core.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * ============================================================
 * 私信 DTO（server/src/routes/messages.ts）
 * ============================================================
 * 三种响应形状不同，必须分开：
 *  · `GET /conversations` → `{ conversations: [...] }`
 *  · `GET /:userId`       → `{ messages: [...], has_more }`（**游标分页**，不是页码）
 *  · `POST /`             → 直接返回单条 message 对象（不是包在 messages 里）
 */

/** 会话（服务端聚合查询生成，含对方信息 + 最后一条消息 + 未读数） */
@Serializable
data class ConversationDto(
    @SerialName("partner_id") val partnerId: Long,
    val username: String = "",
    val avatar: String? = null,
    /** 最后一条消息的内容摘要（图片消息时服务端给的是占位文案） */
    @SerialName("last_message") val lastMessage: String = "",
    @SerialName("last_message_at") val lastMessageAt: String = "",
    @SerialName("unread_count") val unreadCount: Int = 0,
)

@Serializable
data class ConversationsResponse(val conversations: List<ConversationDto> = emptyList())

/**
 * 消息。
 *
 * 引用（回复）相关有 4 个可选字段：引用消息可能是**纯图片**（quoted_content 为空、
 * quoted_image_url 有值），所以 UI 不能只判 content。
 */
@Serializable
data class MessageDto(
    val id: Long,
    @SerialName("sender_id") val senderId: Long,
    @SerialName("receiver_id") val receiverId: Long,
    val content: String = "",
    @SerialName("image_url") val imageUrl: String? = null,
    /** 0 = 未读，1 = 已读 */
    val read: Int = 0,
    @SerialName("created_at") val createdAt: String = "",
    @SerialName("sender_username") val senderUsername: String = "",
    @SerialName("quoted_message_id") val quotedMessageId: Long? = null,
    @SerialName("quoted_content") val quotedContent: String? = null,
    @SerialName("quoted_image_url") val quotedImageUrl: String? = null,
    @SerialName("quoted_sender_username") val quotedSenderUsername: String? = null,
) {
    val hasImage: Boolean get() = !imageUrl.isNullOrBlank()
    val isRead: Boolean get() = read == 1
    /** 引用的内容摘要（纯图片引用也要有可显示的文本） */
    val quotedPreview: String
        get() = quotedContent?.takeIf { it.isNotBlank() }
            ?: if (!quotedImageUrl.isNullOrBlank()) "[图片]" else ""
}

/**
 * 消息历史响应。
 *
 * **游标分页**：`has_more` 表示还有**更早**的消息，向上翻页时传
 * `before_id` = 当前最旧一条的 id。这跟帖子域的页码分页是两套机制，别混用。
 */
@Serializable
data class MessageHistoryResponse(
    val messages: List<MessageDto> = emptyList(),
    @SerialName("has_more") val hasMore: Boolean = false,
)

/** 标记已读 / 清空会话的响应 */
@Serializable
data class SimpleSuccess(val success: Boolean = false, val message: String? = null)

/** 发送消息的表单字段（multipart；content 与 image 至少要有一个） */
@Serializable
data class SendMessageForm(
    @SerialName("receiverId") val receiverId: Long,
    val content: String = "",
    @SerialName("quotedMessageId") val quotedMessageId: Long? = null,
)
