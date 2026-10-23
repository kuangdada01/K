package top.kuangdada.k.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import top.kuangdada.k.core.data.model.MAX_MESSAGE_FILE_BYTES
import top.kuangdada.k.core.data.model.MAX_MESSAGE_FILES
import top.kuangdada.k.core.data.model.MessageFileKind
import top.kuangdada.k.core.data.model.formatFileBytes
import top.kuangdada.k.core.data.model.isAllowedMessageFile
import top.kuangdada.k.core.data.model.messageFileExtension
import top.kuangdada.k.core.data.model.messageFileKind
import top.kuangdada.k.core.data.model.messageFileMime
import top.kuangdada.k.core.data.model.messageFileSizeError

/**
 * ============================================================
 * 私信文件规则 · 纯逻辑单测（2026-10-23）
 * ============================================================
 * 这些常量与服务端 `shared/src/constants/upload.ts` 是**手工镜像**的（没有代码生成）：
 * 数字写错了编译器不会拦 —— 表现是「本地放行、服务端 400」或者反过来的静默拒绝。
 * 所以这里把几个关键值钉死，改 shared 时会立刻红。
 */
class MessageFileRulesTest {

    @Test
    fun `上限与服务端一致`() {
        assertEquals(100L * 1024 * 1024, MAX_MESSAGE_FILE_BYTES)
        assertEquals(9, MAX_MESSAGE_FILES)
    }

    @Test
    fun `扩展名白名单：常见文档、媒体、压缩包放行`() {
        listOf(
            "报告.pdf", "a.docx", "b.xlsx", "c.pptx", "note.txt", "readme.md",
            "p.jpg", "q.PNG", "v.mp4", "m.m4a", "z.zip", "x.7z", "k.epub",
            "无空格的名字.rar",
        ).forEach { assertTrue(it, isAllowedMessageFile(it)) }
    }

    @Test
    fun `可执行文件一律不放行`() {
        listOf("evil.exe", "a.bat", "x.cmd", "setup.msi", "app.apk", "lib.jar", "run.sh", "p.ps1")
            .forEach { assertFalse(it, isAllowedMessageFile(it)) }
        // 没有扩展名的也不放行（服务端同样判不出来）
        assertFalse(isAllowedMessageFile("Makefile"))
    }

    @Test
    fun `扩展名解析：大小写不敏感，忽略路径`() {
        assertEquals("pdf", messageFileExtension("A.PDF"))
        assertEquals("gz", messageFileExtension("C:\\tmp\\a.tar.gz"))
        assertEquals("", messageFileExtension("README"))
        assertEquals("", messageFileExtension(".gitignore"))
    }

    @Test
    fun `大小校验：空文件、超限、边界`() {
        assertEquals("文件是空的", messageFileSizeError(0))
        assertNull(messageFileSizeError(MAX_MESSAGE_FILE_BYTES))
        assertTrue(messageFileSizeError(MAX_MESSAGE_FILE_BYTES + 1)?.contains("100MB") == true)
    }

    @Test
    fun `归类：扩展名优先，MIME 兜底`() {
        assertEquals(MessageFileKind.Pdf, messageFileKind("a.pdf", null))
        assertEquals(MessageFileKind.Archive, messageFileKind("a.zip", null))
        assertEquals(MessageFileKind.Image, messageFileKind("a.png", null))
        assertEquals(MessageFileKind.Video, messageFileKind("a.mp4", null))
        assertEquals(MessageFileKind.Doc, messageFileKind("a.docx", null))
        assertEquals(MessageFileKind.Text, messageFileKind("a.ts", null))
        // 没有扩展名（云盘 provider 常见）→ 按服务端给的 MIME
        assertEquals(MessageFileKind.Image, messageFileKind("blob", "image/jpeg"))
        assertEquals(MessageFileKind.Other, messageFileKind("blob", "application/zip"))
    }

    @Test
    fun `大小格式化与 Web 同口径`() {
        assertEquals("", formatFileBytes(0))
        assertEquals("1023 B", formatFileBytes(1023))
        assertEquals("1.0 KB", formatFileBytes(1024))
        assertEquals("1.5 KB", formatFileBytes(1536))
        assertEquals("30 MB", formatFileBytes(30L * 1024 * 1024))
        assertEquals("100 MB", formatFileBytes(100L * 1024 * 1024))
    }

    @Test
    fun `打开文件用的 MIME 能按扩展名推出来`() {
        assertEquals("application/pdf", messageFileMime("a.pdf", null))
        assertEquals("video/mp4", messageFileMime("a.mp4", null))
        // 服务端给的 MIME 优先
        assertEquals("text/plain; charset=utf-8", messageFileMime("a.txt", "text/plain; charset=utf-8"))
        // 推不出来给通配类型，让系统自己挑应用
        assertEquals("*/*", messageFileMime("a.unknownext", null))
    }
}
