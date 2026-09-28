package top.kuangdada.k.nativeapp.download

import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log

/**
 * ============================================================
 * 更新包的获取方式：交给系统浏览器（v0.1.11 起）
 * ============================================================
 * **为什么放弃 App 内自更新**（原实现是 DownloadManager 下载 + 完成广播 + 拉起安装器）：
 * 那条链路必须声明 `REQUEST_INSTALL_PACKAGES`（Android 8+ 没它拉不起安装页），
 * 而「申请安装包权限 + 从网络下载 apk + 拉起安装器」正是国产安全软件启发式引擎
 * 判定"捆绑安装"的经典特征组合。2026-09-28 用户实测被腾讯手机管家报
 * `a.gray.BulimiaTGen.f`（灰色软件泛化特征码，实为误报）——**而且真的拦掉了安装**：
 * 他 09-27 晚上下载过 0.1.8 的 release 包，却一直停留在 09-24 的 debug 版本上。
 *
 * 现在：点「立即更新」→ 系统浏览器打开 APK 直链 → 浏览器下载 → 用户从下载列表点安装。
 * 代价是多两步手动操作；收益是**本 App 不再声明任何"安装应用"的权限**，
 * 也没有"下载可执行文件"的代码路径，从根上不参与那条特征组合。
 *
 * ⚠️ **必须把本 App 自己从浏览器候选里排除掉**：`AndroidManifest.xml` 里 K 声明了
 * `https://www.kuangdada.top` 的 deep link，而它的 `<data>` 没有路径限定 ——
 * 也就是说 `/apk/k-app-x.apk` 这个直链**同样会被 K 自己匹配到**。不排除的话，
 * 用户点「立即更新」后系统会把链接交给 K 自己打开（解析不出路径 → 回首页），
 * 表现就是"点了更新没反应/回到首页"，且极难联想到是这个原因。
 */
object UpdateLaunch {

    private const val TAG = "KUpdateLaunch"

    /**
     * 本 App 的入口 Activity 全限定名。
     *
     * 写成常量而不是 `MainActivity::class.java.name`：这个包（`download/`）刻意不依赖
     * `ui/` 与入口 Activity —— 它要能在纯 JVM 下被引用。[packageName] 侧由调用方给，
     * 所以 debug 包（`…nativeapp.debug`）也能正确构造 ComponentName。
     */
    private const val ENTRY_ACTIVITY = "top.kuangdada.k.nativeapp.MainActivity"

    /**
     * 地址是否可交给浏览器。
     *
     * 只认 http/https：`apkUrl` 虽然是我们自己配的服务端字段，但它是**服务端 JSON 下发的**，
     * 不校验 scheme 就等于把"拉起任意 Intent"的能力开放给了响应内容。
     */
    fun isOpenableUrl(url: String?): Boolean {
        val v = url?.trim().orEmpty()
        return v.startsWith("https://", ignoreCase = true) ||
            v.startsWith("http://", ignoreCase = true)
    }

    /**
     * 用浏览器打开 [url]。
     *
     * @return true = 已交给系统浏览器；false = 地址非法、或设备上没有可用的浏览器
     *   （调用方必须提示用户，不能静默 —— 点了没反应是最难排查的一类反馈）
     */
    fun openInBrowser(context: Context, url: String): Boolean {
        if (!isOpenableUrl(url)) {
            Log.w(TAG, "拒绝非 http(s) 的更新地址: $url")
            return false
        }
        val view = Intent(Intent.ACTION_VIEW, Uri.parse(url))
        val chooser = Intent.createChooser(view, null).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            // 把自己踢出候选（见类注释末段）。EXTRA_EXCLUDE_COMPONENTS 从 API 24 起可用，
            // 本项目 minSdk 27，无需分支。
            putExtra(
                Intent.EXTRA_EXCLUDE_COMPONENTS,
                arrayOf(ComponentName(context.packageName, ENTRY_ACTIVITY)),
            )
        }
        return try {
            context.startActivity(chooser)
            true
        } catch (e: ActivityNotFoundException) {
            // 极简 ROM / 精简平板可能一个浏览器都没有
            Log.w(TAG, "没有可用的浏览器: $url", e)
            false
        }
    }
}
