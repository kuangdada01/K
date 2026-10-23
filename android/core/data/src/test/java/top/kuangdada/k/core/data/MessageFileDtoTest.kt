package top.kuangdada.k.core.data

import org.junit.Assert.assertEquals
import org.junit.Test
import top.kuangdada.k.core.data.model.MessageDto

/**
 * ============================================================
 * 私信文件 DTO · 纯逻辑单测（2026-10-23）
 * ============================================================
 * 原生端目前只做到「文件消息能看见」：气泡文案由 [MessageDto.fileLabel] 兜底，
 * content 是空的 —— 算错就会画出一个空气泡，属于"不报错的错"，所以钉死几条断言：
 *  · 名字缺失 → 「文件」；大小缺失 → 不拼括号；
 *  · 大小 < 10 保留一位小数（与 Web `formatFileSize` 同口径）；
 *  · 引用条：文件引用的优先级在图片/语音之后，但必须能出文字。
 */
class MessageFileDtoTest {

    private fun dto(
        fileName: String? = null,
        fileSize: Long = 0,
        fileUrl: String? = "/api/messages/1/media",
    ) = MessageDto(
        id = 1,
        senderId = 1,
        receiverId = 2,
        fileUrl = fileUrl,
        fileName = fileName,
        fileSize = fileSize,
    )

    @Test
    fun `文件气泡带名字与大小`() {
        val msg = dto(fileName = "季度报告.pdf", fileSize = 1536)
        assertEquals(true, msg.hasFile)
        assertEquals("[文件] 季度报告.pdf（1.5 KB）", msg.fileLabel)
    }

    @Test
    fun `名字缺失退化成 文件，大小缺失不拼括号`() {
        assertEquals("[文件] 文件", dto(fileName = null, fileSize = 0).fileLabel)
        assertEquals("[文件] 文件", dto(fileName = "  ", fileSize = 0).fileLabel)
        assertEquals("[文件] a.zip（128 MB）", dto(fileName = "a.zip", fileSize = 128L * 1024 * 1024).fileLabel)
    }

    @Test
    fun `不是文件消息时不误判`() {
        val text = MessageDto(id = 2, senderId = 1, receiverId = 2, content = "hi")
        assertEquals(false, text.hasFile)
    }

    @Test
    fun `引用文件消息的摘要是 文件加名字`() {
        val quoted = MessageDto(
            id = 3,
            senderId = 1,
            receiverId = 2,
            content = "",
            quotedMessageId = 1,
            quotedFileName = "报告.pdf",
        )
        assertEquals("[文件] 报告.pdf", quoted.quotedPreview)
    }
}
