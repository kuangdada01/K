package top.kuangdada.k.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import top.kuangdada.k.core.data.api.CommentDto

/**
 * ============================================================
 * 评论组树的契约测试（帖子详情页）
 * ============================================================
 * 服务端 `GET /api/posts/:id/comments` 返回的是**扁平数组**（顶级评论与其回复混在一起，
 * 靠 `parent_id` 表达关系），组树是客户端做的。这段逻辑写错的表现是
 * **评论"凭空消失"或层级错乱**，而且不报任何错、接口单测也照样绿 —— 所以单独钉住：
 *
 *  1. 顶级与回复按 `parent_id` 归位；
 *  2. 父评论**不在本页**（分页续拉/父评论被删）的回复不能丢，要当顶级显示；
 *  3. 排序按 `created_at`，同一时间戳再按 id（服务端两次返回顺序不一致时页面不能跳）；
 *  4. `isMine` 只认当前用户 id。
 */
class CommentTreeTest {

    private fun row(
        id: Long,
        parentId: Long? = null,
        content: String = "c$id",
        userId: Long = 1,
        createdAt: String = "2026-09-14T10:00:00.000Z",
    ) = CommentDto(
        id = id,
        userId = userId,
        postId = 9,
        parentId = parentId,
        content = content,
        createdAt = createdAt,
    )

    @Test
    fun `顶级评论与回复按 parentId 归位`() {
        val tree = buildCommentTree(
            rows = listOf(
                row(1, createdAt = "2026-09-14T10:00:00.000Z"),
                row(2, parentId = 1, createdAt = "2026-09-14T10:01:00.000Z"),
                row(3, parentId = 1, createdAt = "2026-09-14T10:02:00.000Z"),
                row(4, createdAt = "2026-09-14T10:03:00.000Z"),
            ),
            myUserId = 1,
            baseUrl = "https://example.test",
        )

        assertEquals(listOf(1L, 4L), tree.map { it.id })
        assertEquals(listOf(2L, 3L), tree.first().replies.map { it.id })
    }

    @Test
    fun `父评论不在本页时回复不丢_降级为顶级`() {
        // 分页续拉的第 2 页：只拿到"回复"，父评论还在第 1 页 —— 必须仍然显示出来
        val tree = buildCommentTree(
            rows = listOf(row(20, parentId = 999, content = "跨页回复")),
            myUserId = 1,
            baseUrl = "https://example.test",
        )

        assertEquals(1, tree.size)
        assertEquals("跨页回复", tree.first().raw.content)
        assertTrue(tree.first().replies.isEmpty())
    }

    @Test
    fun `排序按时间_同一时间按 id_不依赖服务端顺序`() {
        val tree = buildCommentTree(
            rows = listOf(
                row(30, createdAt = "2026-09-14T10:05:00.000Z"),
                row(10, createdAt = "2026-09-14T10:01:00.000Z"),
                row(11, createdAt = "2026-09-14T10:01:00.000Z"),
                row(12, parentId = 10, createdAt = "2026-09-14T10:09:00.000Z"),
                row(13, parentId = 10, createdAt = "2026-09-14T10:08:00.000Z"),
            ),
            myUserId = 1,
            baseUrl = "https://example.test",
        )

        assertEquals(listOf(10L, 11L, 30L), tree.map { it.id })
        assertEquals(listOf(13L, 12L), tree.first().replies.map { it.id })
    }

    @Test
    fun `isMine 只认当前用户`() {
        val tree = buildCommentTree(
            rows = listOf(row(1, userId = 7), row(2, parentId = 1, userId = 42)),
            myUserId = 42,
            baseUrl = "https://example.test",
        )

        assertEquals(false, tree.first().isMine)
        assertEquals(true, tree.first().replies.first().isMine)
    }

    @Test
    fun `头像与时间在组树时就解析好`() {
        val tree = buildCommentTree(
            rows = listOf(row(1).copy(avatar = "/uploads/a.png")),
            myUserId = 1,
            baseUrl = "https://example.test/",
        )

        assertEquals("https://example.test/uploads/a.png", tree.first().avatarUrl)
        assertTrue(tree.first().timeText.isNotBlank())
    }
}
