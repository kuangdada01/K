package top.kuangdada.k.nativeapp.download

import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import android.util.Log
import androidx.core.content.ContextCompat

/**
 * ============================================================
 * 下载与安装（系统 DownloadManager）—— 原生版
 * ============================================================
 * 从 `:app`（WebView 宿主）的 `feature/download/DownloadController.kt` 移植。
 * 那个版本由 JS 桥驱动（一次性的、回调写死在构造器里）；原生版的这个实例
 * **挂在全局依赖图里长期存活**，所以回调改成可空 + 可后设（见 [onCompleted]）。
 *
 * 为什么用系统 DownloadManager 而不是自己开线程下：
 *  · 下载跑在**系统进程**里，App 切后台/被杀也继续（APK 十几 MB，弱网下很常见）；
 *  · 自带通知栏进度与"点击打开"；
 *  · 命中系统下载缓存，重复点更新不会重复下载。
 *
 * APK 自更新链路：`start(url, installAfter = true)` → 完成广播 → [query] → 安装 Intent。
 *
 * ⚠️ 两个必须由**集成方**（Manifest/UI）负责的事，本类刻意不做：
 *  1. `AndroidManifest.xml` 需要 `REQUEST_INSTALL_PACKAGES`（否则 Android 8+ 根本拉不起安装页）；
 *  2. Android 13+ 下载完成通知需要 `POST_NOTIFICATIONS` 运行时权限。
 */
class DownloadController(private val context: Context) {

    /**
     * 一次下载的结果快照。
     *
     * `status` 用字符串而不是枚举：这个值要跨层传到 UI/日志，
     * 字符串在日志里一眼可读（`completed` / `failed`），也避免枚举被混淆后失去可读性。
     */
    data class Result(
        val id: Long,
        val status: String,
        val uri: String?,
        val fileName: String?,
    ) {
        val isCompleted: Boolean get() = status == STATUS_COMPLETED
    }

    /**
     * 下载终态回调（完成/失败）。**可空且可后设**。
     *
     * 为什么不像 `:app` 那样写成构造器参数：这个控制器会作为全局单例挂在依赖图里，
     * 而 UI 是短命的（旋屏/返回键都会重建）。构造器注入会把"某个已经销毁的页面"
     * 永久钉在回调上 → 内存泄漏 + 回调打到死对象上。
     * 现在的用法是：页面 `onStart` 里 `onCompleted = {...}`，`onStop` 里置回 null。
     */
    var onCompleted: ((Result) -> Unit)? = null

    private val manager: DownloadManager? =
        context.getSystemService(Context.DOWNLOAD_SERVICE) as? DownloadManager

    /** 需要在下完后自动拉起安装的下载 id（APK 自更新）。放内存里：进程重启后下载结果还在，但"要不要装"就丢了，属可接受 */
    private val installOnComplete = mutableSetOf<Long>()

    private var registered = false

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(receiverContext: Context?, intent: Intent?) {
            if (intent?.action != DownloadManager.ACTION_DOWNLOAD_COMPLETE) return
            val id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L)
            if (id <= 0L) return
            val result = query(id)
            Log.d(TAG, "下载完成 id=$id status=${result.status} uri=${result.uri}")
            // 先取出标记再安装：安装 Intent 会把 App 切到后台，回调放最后保证 UI 状态先更新
            if (installOnComplete.remove(id) && result.isCompleted) {
                installDownloadedApk(id)
            }
            onCompleted?.invoke(result)
        }
    }

    fun register() {
        if (registered) return
        val filter = IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE)
        // 坑：DownloadManager 的完成广播由**系统**发出。targetSdk 33+ 起不显式声明
        // RECEIVER_EXPORTED / RECEIVER_NOT_EXPORTED 会直接抛 SecurityException 崩溃；
        // 这里必须 EXPORTED（系统在别的 uid 上发）。
        ContextCompat.registerReceiver(context, receiver, filter, ContextCompat.RECEIVER_EXPORTED)
        registered = true
    }

    fun unregister() {
        if (!registered) return
        // 忘记注册过/已被系统回收时 unregisterReceiver 会抛 IllegalArgumentException，
        // 而"页面退出"这条路径上崩一次是不可接受的，所以吞掉只记日志。
        try {
            context.unregisterReceiver(receiver)
        } catch (e: Exception) {
            Log.w(TAG, "反注册下载广播失败", e)
        }
        registered = false
    }

    /**
     * 入队一个下载。
     *
     * @param installAfter 下完后是否自动拉起 APK 安装（自更新用）
     * @return DownloadManager 的下载 id；失败返回 null（调用方据此提示用户，不要静默）
     */
    fun start(
        url: String,
        fileName: String? = null,
        mimeType: String? = null,
        installAfter: Boolean = false,
    ): Long? {
        val mgr = manager ?: run {
            Log.w(TAG, "DownloadManager 不可用")
            return null
        }
        val safeName = sanitize(fileName?.takeIf { it.isNotBlank() } ?: defaultName(url))
        val request = DownloadManager.Request(Uri.parse(url)).apply {
            setTitle(safeName)
            // 可见 + 完成后保留通知：用户能从通知栏直达文件（也顺带证明下载真的在跑）
            setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, safeName)
            // APK 自更新不能被"仅 Wi-Fi"卡住：弱网/流量环境下用户点了更新就该下
            setAllowedOverMetered(true)
            setAllowedOverRoaming(true)
            if (!mimeType.isNullOrBlank()) setMimeType(mimeType)
        }
        return try {
            val id = mgr.enqueue(request)
            if (installAfter) installOnComplete.add(id)
            Log.d(TAG, "下载入队 id=$id name=$safeName url=$url")
            id
        } catch (e: Exception) {
            // 常见原因：URL 非法、目标文件名冲突、存储不可写。
            Log.w(TAG, "下载入队失败: $url", e)
            null
        }
    }

    /** 查询下载状态：status ∈ downloading | completed | failed | pending | unknown */
    fun query(id: Long): Result {
        val mgr = manager ?: return Result(id, STATUS_UNKNOWN, null, null)
        return try {
            // DownloadManager.query 在 API 27 上无 @NonNull 标注，实际可能返回 null（个别 ROM）
            val cursor = mgr.query(DownloadManager.Query().setFilterById(id))
            cursor?.use { c ->
                if (!c.moveToFirst()) return Result(id, STATUS_UNKNOWN, null, null)
                val statusIndex = c.getColumnIndex(DownloadManager.COLUMN_STATUS)
                val localUriIndex = c.getColumnIndex(DownloadManager.COLUMN_LOCAL_URI)
                val titleIndex = c.getColumnIndex(DownloadManager.COLUMN_TITLE)
                val status = if (statusIndex < 0) {
                    STATUS_UNKNOWN
                } else {
                    when (c.getInt(statusIndex)) {
                        DownloadManager.STATUS_SUCCESSFUL -> STATUS_COMPLETED
                        DownloadManager.STATUS_FAILED -> STATUS_FAILED
                        DownloadManager.STATUS_RUNNING -> STATUS_DOWNLOADING
                        DownloadManager.STATUS_PENDING, DownloadManager.STATUS_PAUSED -> STATUS_PENDING
                        else -> STATUS_UNKNOWN
                    }
                }
                Result(
                    id = id,
                    status = status,
                    uri = if (localUriIndex >= 0) c.getString(localUriIndex) else null,
                    fileName = if (titleIndex >= 0) c.getString(titleIndex) else null,
                )
            } ?: Result(id, STATUS_UNKNOWN, null, null)
        } catch (e: Exception) {
            Log.w(TAG, "查询下载状态失败 id=$id", e)
            Result(id, STATUS_UNKNOWN, null, null)
        }
    }

    /** 安装一个已下载完的 id 对应的 APK（未授权"安装未知应用"时引导去系统设置） */
    fun installDownloadedApk(id: Long): Boolean {
        val uri = try {
            manager?.getUriForDownloadedFile(id)
        } catch (e: Exception) {
            Log.w(TAG, "取下载文件 Uri 失败 id=$id", e)
            null
        }
        if (uri == null) {
            // 文件被用户在"下载"里删了 / 被清理器清了，是真实可发生的情况
            Log.w(TAG, "下载文件不存在或已被清理 id=$id")
            return false
        }
        return installApk(uri)
    }

    /**
     * 拉起系统安装器。
     *
     * @return true = 安装页已拉起；false = 已跳去"安装未知应用"设置页，或彻底失败。
     *   Android 8+ 未授权时**必须引导到设置**，静默返回会让用户以为"点了更新没反应"。
     */
    fun installApk(uri: Uri): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !canInstallPackages()) {
            Log.d(TAG, "未授权安装未知应用，引导到系统设置")
            openUnknownSourcesSettings()
            return false
        }
        return try {
            context.startActivity(
                Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(uri, APK_MIME)
                    // 下载得到的 content:// 来自 DownloadManager，必须显式授权读
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                }
            )
            true
        } catch (e: Exception) {
            Log.w(TAG, "拉起安装失败", e)
            false
        }
    }

    /**
     * 是否已授权"安装未知应用"。
     *
     * 这是主 agent 的集成工作里"下载完成后能不能直接装"的判断依据，
     * 所以做成 public 而不是藏在 [installApk] 里。
     */
    fun canInstallPackages(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.packageManager.canRequestPackageInstalls()

    private fun openUnknownSourcesSettings() {
        val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // 带上 package: 才能直接落在本应用的开关页，而不是让用户在一堆 App 里找
            Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).setData(
                Uri.parse("package:${context.packageName}")
            )
        } else {
            Intent(Settings.ACTION_SECURITY_SETTINGS)
        }
        try {
            context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {
            // 少数定制 ROM 没有这个 Activity
            Log.w(TAG, "打开安装权限设置失败", e)
        }
    }

    companion object {
        private const val TAG = "KDownload"
        private const val APK_MIME = "application/vnd.android.package-archive"

        const val STATUS_DOWNLOADING = "downloading"
        const val STATUS_COMPLETED = "completed"
        const val STATUS_FAILED = "failed"
        const val STATUS_PENDING = "pending"
        const val STATUS_UNKNOWN = "unknown"

        // ---- 纯函数（无 Android 依赖），单测可直接覆盖 ----

        /**
         * URL → 默认文件名（去掉 query，取最后一段**路径**；没有路径或路径为空则给兜底名）。
         *
         * 与 `:app` 原版的差异（这是移植时**修掉**的一个真实 bug）：
         * 原版直接 `substringAfterLast('/')`，于是 `https://host`（没有路径）会得到
         * **域名本身** `host` 当文件名（参考实现自己的单测就这么断言的）。
         * 域名当文件名虽然能下载成功，但"下载"页里会莫名出现一个叫 host 的文件。
         * 这里先把 scheme + authority 摘掉，再取最后一段，行为更合理。
         */
        internal fun defaultName(url: String): String {
            val withoutQuery = url.substringBefore('?').substringBefore('#')
            // 摘掉 "scheme://authority"：authority 里也可能有 '/'（如 "host/"），所以用 indexOf
            val schemeEnd = withoutQuery.indexOf("://")
            val path = if (schemeEnd >= 0) {
                val afterScheme = withoutQuery.substring(schemeEnd + 3)
                val slash = afterScheme.indexOf('/')
                if (slash >= 0) afterScheme.substring(slash + 1) else ""
            } else {
                withoutQuery
            }
            return path.substringAfterLast('/').ifBlank { "download" }
        }

        /**
         * 文件名净化：不能带路径分隔符，否则 DownloadManager 会拒绝或写到别处；
         * 同时限制长度（超长名在部分 ROM 上会直接失败）。
         */
        internal fun sanitize(name: String): String =
            name.replace(Regex("[\\\\/:*?\"<>|]"), "_").take(120)
    }
}
