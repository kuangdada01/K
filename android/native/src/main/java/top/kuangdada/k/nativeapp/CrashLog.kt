package top.kuangdada.k.nativeapp

import android.content.Context
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * ============================================================
 * 崩溃现场留档（2026-10-20 加）
 * ============================================================
 * 起因：用户报"发送图片/撤回/点相册直接闪退"，而线上只有服务端日志、拿不到堆栈，
 * 真机又常常不方便连 USB 抓 logcat —— 每次只能靠猜。
 *
 * 做法：装一个 `Thread.setDefaultUncaughtExceptionHandler`，把**未捕获异常的完整堆栈**
 * 写进 `filesDir/last-crash.txt`，然后照旧交回系统默认处理器（该崩还是崩，
 * 不改变任何崩溃行为，只多留一份现场）。
 *
 * 下次启动时 [take] 读走并**立刻删除**（只看最近一次，避免旧记录反复弹）；
 * `AppRoot` 用一次弹窗把它显示出来 + 一键复制，用户贴到聊天里就能定位。
 *
 * 为什么不用第三方崩溃平台：这个项目没有、也不打算为了一个问题引依赖；
 * 本地留档 + 一次复制已经够用。
 */
object CrashLog {

    private const val FILE_NAME = "last-crash.txt"

    /** 留档上限：堆栈再长也够用，又不至于把文件写成几 MB */
    private const val MAX_CHARS = 64_000

    @Volatile
    private var installed = false

    /**
     * 装处理器（幂等）。**必须在 Application.onCreate 的最前面调用** ——
     * 装晚了就漏掉启动阶段的崩溃，而"一进 App 就闪退"恰恰是最需要现场的那类。
     */
    fun install(context: Context) {
        if (installed) return
        installed = true
        val app = context.applicationContext
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            // 留档本身绝不能再抛：任何失败都吞掉，然后照常交给系统
            runCatching {
                val buffer = StringWriter()
                PrintWriter(buffer).use { error.printStackTrace(it) }
                val version = runCatching { BuildConfig.VERSION_NAME }.getOrDefault("?")
                val time = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date())
                val text = buildString {
                    append("v").append(version).append("  ").append(time)
                    append("  thread=").append(thread.name).append('\n')
                    append(buffer.toString())
                }
                File(app.filesDir, FILE_NAME).writeText(text.take(MAX_CHARS))
            }
            previous?.uncaughtException(thread, error)
        }
    }

    /** 取走上一次崩溃的现场（读完即删）。没有崩溃过就返回 null */
    fun take(context: Context): String? {
        val file = File(context.filesDir, FILE_NAME)
        if (!file.exists()) return null
        val text = runCatching { file.readText() }.getOrNull()
        runCatching { file.delete() }
        return text?.takeIf { it.isNotBlank() }
    }
}
