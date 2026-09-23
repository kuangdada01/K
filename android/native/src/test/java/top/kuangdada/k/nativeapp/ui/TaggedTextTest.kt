package top.kuangdada.k.nativeapp.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ============================================================
 * 正文 / 话题拆分（TaggedDescription 的纯逻辑部分）
 * ============================================================
 * 这块逻辑**必须与服务端 `shared/src/utils/tag.ts: extractTags()` 对齐**：
 * 服务端按 `#([\p{L}\p{N}_-]+)` 从正文抽话题入库，
 * 客户端如果把"其实没入库的片段"从正文里摘走，用户就会看到正文莫名少了一截。
 *
 * 真机反馈来源：用户发的是「你好#风景」（话题直接粘在正文屁股上）→
 * 展示时要摘出来单独一行、并留出间距。
 */
class TaggedTextTest {

    @Test
    fun `话题粘在正文后面时被摘出，正文不留尾巴`() {
        val parts = splitTags("你好#风景")
        assertEquals("你好", parts.body)
        assertEquals(listOf("风景"), parts.tags)
    }

    @Test
    fun `话题夹在中间时正文合并成一行且不留多余空格`() {
        val parts = splitTags("今天#测试 去了公园")
        assertEquals(listOf("测试"), parts.tags)
        // 摘掉 "#测试" 后是 "今天 去了公园"：首尾已 trim，中间的空格保留
        assertEquals("今天 去了公园", parts.body)
    }

    @Test
    fun `超长话题不摘走 —— 服务端会整条忽略，留在正文里才与数据一致`() {
        val longTag = "a".repeat(31)
        val parts = splitTags("正文 #$longTag")
        assertTrue(parts.tags.isEmpty())
        assertEquals("正文 #$longTag", parts.body)
    }

    @Test
    fun `重复话题去重且都从正文里摘掉`() {
        val parts = splitTags("#风景 好看 #风景")
        assertEquals(listOf("风景"), parts.tags)
        assertEquals("好看", parts.body)
    }

    @Test
    fun `最多取 10 个话题，多余的原样留在正文`() {
        val text = (1..12).joinToString(" ") { "#t$it" }
        val parts = splitTags(text)
        assertEquals(10, parts.tags.size)
        assertEquals("t1", parts.tags.first())
        assertEquals("t10", parts.tags.last())
        // 第 11、12 个话题没有入库，必须还在正文里（否则用户会以为内容丢了）
        assertTrue(parts.body.contains("#t11"))
        assertTrue(parts.body.contains("#t12"))
    }

    @Test
    fun `没有话题时正文原样返回`() {
        val parts = splitTags("普通正文，没有话题")
        assertEquals("普通正文，没有话题", parts.body)
        assertTrue(parts.tags.isEmpty())
    }

    @Test
    fun `多个换行在摘掉话题后被压成最多一个空行`() {
        val parts = splitTags("第一段\n\n#话题\n\n\n第二段")
        assertEquals(listOf("话题"), parts.tags)
        assertTrue("不应出现连续 3 个换行：${parts.body}", !parts.body.contains("\n\n\n"))
    }
}
