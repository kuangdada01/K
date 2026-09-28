package top.kuangdada.k.nativeapp.download

import android.content.Context
import android.util.Log

/**
 * ============================================================
 * 「已跳过的更新版本」（UpdateSkipStore）
 * ============================================================
 * 用户点过「以后再说」——或者直接把弹窗关掉——的那个版本号。**只记一个**。
 *
 * 语义（用户 09-27 定：**"取消就等下一次版本更新再弹窗"**）：
 *  · 判定用**相等**，不是"大于已跳过" —— 服务端版本只要**变了**（前进到 0.1.2，
 *    甚至回滚到一个仍比本机新的 0.1.0），就该重新提示；
 *  · 装上新版本后本机版本追平，`hasUpdate` 变成 false，这条记录自然失效，
 *    所以不需要"安装成功后清理"这类额外动作。
 *
 * 为什么不用 DataStore（主题偏好那套）：这里只在**网络回来之后**读一次字符串，
 * 不参与首帧渲染，普通 SharedPreferences 一次同步读足够了，少一层协程。
 * 也**不能**用 EncryptedSharedPreferences（token 用的那个）：它不是机密，
 * 而 Keystore 解密的耗时不值得（主题偏好那边做过同样的取舍）。
 */
class UpdateSkipStore(context: Context) {

    private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** 已跳过的版本号；没跳过、或存的是空白 → null（一律当作"没跳过"） */
    fun skippedVersion(): String? =
        prefs.getString(KEY_SKIPPED, null)?.trim()?.takeIf { it.isNotEmpty() }

    /** 记下"这一版我这次不装"。空白版本号直接忽略（脏数据不该让下次永远不提示） */
    fun markSkipped(version: String) {
        val v = version.trim()
        if (v.isEmpty()) return
        prefs.edit().putString(KEY_SKIPPED, v).apply()
        Log.i(TAG, "已记下跳过的版本：$v")
    }

    /** 清掉记录（当前没有调用点；留给将来"设置里手动检查更新"那类入口重新提示用） */
    fun clear() {
        prefs.edit().remove(KEY_SKIPPED).apply()
    }

    private companion object {
        const val PREFS = "k_update"
        const val KEY_SKIPPED = "skipped_version"
        const val TAG = "KUpdateSkip"
    }
}
