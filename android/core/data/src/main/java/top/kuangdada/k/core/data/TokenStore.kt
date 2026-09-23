package top.kuangdada.k.core.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * ============================================================
 * 令牌存储（TokenStore）
 * ============================================================
 * 与 Web 版的差异（这是原生重写的一个安全收益）：
 *   WebView 版把 JWT 放在 `localStorage` 的 `k_token`，任何脚本都能读；
 *   原生版放进 **EncryptedSharedPreferences**（Android Keystore 里的 AES 主密钥包装），
 *   磁盘上是密文。文档 §2.3 也提到「安卓端要配安全存储」。
 *
 * 降级策略：少数机型/ROM 上 Keystore 会抛（已知的 OEM 兼容问题、用户清除凭据、
 * 锁屏类型变更等）。**此时退回普通 SharedPreferences 并标记 `degraded`**，
 * 而不是让 App 直接起不来 —— 可用性优先，但把降级事实暴露出去（设置页可提示）。
 */
class TokenStore(context: Context) {

    private val appContext = context.applicationContext

    /** 是否发生了降级（Keystore 不可用 → 明文 prefs） */
    var degraded: Boolean = false
        private set

    private val prefs: SharedPreferences by lazy {
        try {
            val masterKey = MasterKey.Builder(appContext)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            EncryptedSharedPreferences.create(
                appContext,
                FILE_ENCRYPTED,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
        } catch (t: Throwable) {
            degraded = true
            appContext.getSharedPreferences(FILE_FALLBACK, Context.MODE_PRIVATE)
        }
    }

    /** JWT。null 表示未登录 —— 与服务端「无 token 即游客」的语义一致 */
    var token: String?
        get() = prefs.getString(KEY_TOKEN, null)
        set(value) {
            prefs.edit().apply {
                if (value.isNullOrEmpty()) remove(KEY_TOKEN) else putString(KEY_TOKEN, value)
            }.apply()
        }

    /**
     * 当前登录用户 id（本地缓存，仅用于 UI 判断「这条帖子是不是我发的」之类）。
     * **不作为权限依据** —— 服务端每次请求都会用 token 里的身份重新判定。
     */
    var userId: Long
        get() = prefs.getLong(KEY_USER_ID, 0L)
        set(value) = prefs.edit().putLong(KEY_USER_ID, value).apply()

    /** 自定义服务器地址（空 = 用 BuildConfig.DEFAULT_SERVER_URL） */
    var serverOverride: String?
        get() = prefs.getString(KEY_SERVER, null)
        set(value) {
            prefs.edit().apply {
                if (value.isNullOrEmpty()) remove(KEY_SERVER) else putString(KEY_SERVER, value)
            }.apply()
        }

    fun clearAuth() {
        prefs.edit().remove(KEY_TOKEN).remove(KEY_USER_ID).apply()
    }

    private companion object {
        const val FILE_ENCRYPTED = "k_secure"
        const val FILE_FALLBACK = "k_secure_plain"
        const val KEY_TOKEN = "k_token"
        const val KEY_USER_ID = "k_user_id"
        const val KEY_SERVER = "k_server"
    }
}
