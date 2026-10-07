package top.kuangdada.k.core.data

import java.io.File

/**
 * ============================================================
 * 临时媒体清理任务清单（TempCleanupJournal）
 * ============================================================
 * 一个落盘的"待删除服务端临时视频"清单（filesDir 下纯文本，每行一个 URL）。
 *
 * 为什么需要落盘：发布页放弃草稿时的清理如果只存在于内存/协程里，
 * 进程被杀（系统回收 / 用户划掉）任务就丢了，1GB 草稿只能等服务端
 * 24h TTL。落盘后**下次启动**读到清单即重试；服务端 TTL 仍是最终兜底。
 *
 * 故意做得极简（追加 + 整文件重写，行去重靠 filterNot）：
 * 任务量级是"每台设备个位数 URL"，不值得为此引入数据库。
 */
internal class TempCleanupJournal(private val file: File) {

    private val lock = Any()

    /** 当前待清理清单（文件不存在/读失败 → 空，清理任务丢了还有服务端 TTL 兜底） */
    fun load(): List<String> = synchronized(lock) {
        runCatching {
            if (file.exists()) file.readLines().map { it.trim() }.filter { it.isNotEmpty() }.distinct() else emptyList()
        }.getOrDefault(emptyList())
    }

    /** 登记一个待清理 URL（幂等：重复登记不产生重复行） */
    fun add(url: String) {
        synchronized(lock) {
            if (load().contains(url)) return
            runCatching { file.appendText(url + "\n") }
        }
    }

    /** 移除一个已完成（或确认不存在）的 URL；重复行一并清掉 */
    fun remove(url: String) {
        synchronized(lock) {
            runCatching {
                val rest = load().filterNot { it == url }
                if (rest.isEmpty()) {
                    if (file.exists()) file.delete()
                } else {
                    file.writeText(rest.joinToString("\n", postfix = "\n"))
                }
            }
        }
    }
}
