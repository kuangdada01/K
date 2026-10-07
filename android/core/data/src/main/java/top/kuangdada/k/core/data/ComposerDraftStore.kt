package top.kuangdada.k.core.data

import android.content.Context
import java.io.File
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * ============================================================
 * 发布页草稿（ComposerDraft，P2-4.1）
 * ============================================================
 * 进程重建/误触退出后恢复发布内容。持久化的字段：**文字、位置、关闭评论、
 * 已选图片的本地副本路径、保存时间**。
 *
 * 刻意**不**进草稿的内容与理由：
 *  - 视频（本地副本与临时 URL）：现有产品行为是「关闭页面即放弃视频」
 *    （onDispose 清理本地副本 + 服务端临时文件），草稿语义与其保持一致；
 *  - 视频/图片的原始 content:// uri：Photo Picker 的读权限是临时的，
 *    恢复时大概率已不可读，只存会误导。
 *
 * 图片路径是 cacheDir 里的**已压缩副本**（选图时落盘），恢复时按存在性过滤 ——
 * 系统清理 cacheDir 后草稿自然退化为纯文字，不会挂死在丢失文件上。
 */
@Serializable
data class ComposerDraft(
    val text: String = "",
    val location: String = "",
    val closeComments: Boolean = false,
    /** cacheDir 内已压缩图片副本的绝对路径（恢复时过滤不存在的） */
    val imagePaths: List<String> = emptyList(),
    val savedAt: Long = 0L,
) {
    /** 是否存在可恢复的内容（三项都空就没有恢复的意义） */
    val hasContent: Boolean
        get() = text.isNotBlank() || location.isNotBlank() || imagePaths.isNotEmpty()
}

/**
 * 草稿存取：filesDir 下一个 JSON 文件，读损坏即弃（删除坏文件返回 null），
 * 写入走「临时文件 + 原子改名」，进程被杀不会留下半截 JSON。
 *
 * 构造函数收目录而不是 Context：纯 JVM 单测直接传临时目录。
 */
class ComposerDraftStore internal constructor(private val dir: File) {

    constructor(context: Context) : this(context.applicationContext.filesDir)

    private val file = File(dir, DRAFT_FILE)
    private val json = Json { ignoreUnknownKeys = true }

    /** 读取草稿；不存在/损坏/无内容 → null（损坏文件顺手删除） */
    @Synchronized
    fun load(): ComposerDraft? {
        if (!file.exists()) return null
        val draft = runCatching { json.decodeFromString<ComposerDraft>(file.readText()) }.getOrNull()
        if (draft == null) {
            // 损坏的草稿没有恢复价值，删掉避免每次启动都白读一遍
            runCatching { file.delete() }
            return null
        }
        // 过滤掉已被系统清理的图片副本；剩下的无可恢复内容也不算有草稿
        val effective = draft.copy(imagePaths = draft.imagePaths.filter { File(it).exists() })
        return if (effective.hasContent) effective else null
    }

    /** 保存草稿（原子写：临时文件 + 改名，进程被杀不留半截 JSON） */
    @Synchronized
    fun save(draft: ComposerDraft) {
        runCatching {
            dir.mkdirs()
            val tmp = File(dir, "$DRAFT_FILE.tmp")
            tmp.writeText(json.encodeToString(ComposerDraft.serializer(), draft))
            if (!tmp.renameTo(file)) {
                // 极少数文件系统不支持覆盖式 rename：退回复制+删除
                tmp.copyTo(file, overwrite = true)
                tmp.delete()
            }
        }
    }

    /** 清空草稿（发布成功后调用） */
    @Synchronized
    fun clear() {
        runCatching { file.delete() }
    }

    private companion object {
        const val DRAFT_FILE = "composer_draft.json"
    }
}
