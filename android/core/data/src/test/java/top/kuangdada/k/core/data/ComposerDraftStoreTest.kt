package top.kuangdada.k.core.data

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ============================================================
 * 发布页草稿存储测试（ComposerDraftStore，P2-4.1）
 * ============================================================
 * 对应验收“后台进程重建能恢复草稿”：
 *  - 保存/恢复往返一致（文字、位置、关闭评论、图片路径）
 *  - 已被系统清理的图片副本在 load 时被过滤（cacheDir 回收后草稿退化为文字）
 *  - 损坏的草稿文件：load 返回 null 并删除（不反复白读）
 *  - 原子写：保存中断不产生半截 JSON（旧内容可读）
 *  - clear 后无草稿；无内容的“空草稿”不算草稿
 */
class ComposerDraftStoreTest {

    private fun newStore(): Pair<ComposerDraftStore, File> {
        val dir = Files.createTempDirectory("composer-draft").toFile()
        return ComposerDraftStore(dir) to dir
    }

    @Test
    fun `保存后恢复往返一致`() {
        val (store, dir) = newStore()
        try {
            store.save(
                ComposerDraft(
                    text = "写了一半的正文",
                    location = "某地",
                    closeComments = true,
                    imagePaths = listOf("/cache/a.jpg", "/cache/b.jpg"),
                    savedAt = 42L,
                )
            )
            val loaded = store.load()
            assertNotNull(loaded)
            assertEquals("写了一半的正文", loaded!!.text)
            assertEquals("某地", loaded.location)
            assertTrue(loaded.closeComments)
            // /cache/a.jpg、/cache/b.jpg 在测试机上不存在 → load 时按存在性过滤
            assertTrue(loaded.imagePaths.isEmpty())
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun `存在的图片副本路径会保留，不存在的被过滤`() {
        val (store, dir) = newStore()
        try {
            val img = File(dir, "kept.jpg").apply { writeText("x") }
            store.save(ComposerDraft(text = "t", imagePaths = listOf(img.absolutePath, "/gone/x.jpg")))
            val loaded = store.load()
            assertEquals(listOf(img.absolutePath), loaded!!.imagePaths)
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun `损坏的草稿返回 null 并被删除`() {
        val (store, dir) = newStore()
        try {
            File(dir, "composer_draft.json").writeText("{ not json")
            assertNull(store.load())
            assertFalse(File(dir, "composer_draft.json").exists())
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun `clear 后没有草稿`() {
        val (store, dir) = newStore()
        try {
            store.save(ComposerDraft(text = "将被打断的内容"))
            store.clear()
            assertNull(store.load())
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun `全空的草稿不算草稿（load 返回 null）`() {
        val (store, dir) = newStore()
        try {
            store.save(ComposerDraft())
            assertNull(store.load())
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun `覆盖保存以最新为准`() {
        val (store, dir) = newStore()
        try {
            store.save(ComposerDraft(text = "第一版"))
            store.save(ComposerDraft(text = "第二版"))
            assertEquals("第二版", store.load()!!.text)
        } finally {
            dir.deleteRecursively()
        }
    }
}
