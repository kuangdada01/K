package top.kuangdada.k.core.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull

/**
 * ============================================================
 * 主题偏好（DataStore）
 * ============================================================
 * 三态：跟随系统 / 强制浅色 / 强制深色。
 *
 * **为什么不用 EncryptedSharedPreferences**（token 用的是它）：主题不是机密，
 * 而加密存储要走 Keystore 解密、有可感知的耗时；冷启动时我们要在**第一帧之前**
 * 拿到主题值，越轻越好。
 *
 * **为什么要有 [readInitialBlocking]**：主题若在第一帧之后才异步生效，用户会看到
 * 一次"深色闪一下变浅色"（或反之）。所以启动时同步读一次，之后由 [flow] 驱动运行时切换。
 *
 * ★ 首帧读走 **SharedPreferences 镜像**（2026-09-28 审查项）：DataStore 的同步读要
 * 建目录/读文件，极端情况要靠 400ms 超时兜底 —— 那是白等的启动时间。写入时顺手
 * 镜像一份到普通 prefs（毫秒级），首帧读命中镜像就完全不碰 DataStore；
 * 无镜像（首次启动/镜像丢失）才退回 DataStore 同步读并补建镜像。
 */
class ThemePreference(private val context: Context) {

    /** 三种主题模式 */
    enum class Mode(val key: String) {
        System("system"),
        Light("light"),
        Dark("dark");

        companion object {
            /** 解析失败一律回落"跟随系统"（而不是崩或停在某个奇怪状态） */
            fun from(key: String?): Mode = entries.firstOrNull { it.key == key } ?: System
        }
    }

    private val store: DataStore<Preferences> get() = context.themeDataStore

    /** 镜像 prefs：只服务 [readInitialBlocking] 的首帧同步读（主题非机密，见类注释） */
    private val mirrorPrefs get() = context.getSharedPreferences("k_theme_mirror", Context.MODE_PRIVATE)

    val flow: Flow<Mode> = store.data.map { Mode.from(it[KEY_MODE]) }

    suspend fun set(mode: Mode) {
        store.edit { it[KEY_MODE] = mode.key }
        // DataStore 写成功后再落镜像：镜像只是首帧读的加速缓存，以 DataStore 为准
        mirrorPrefs.edit().putString(KEY_MIRROR, mode.key).apply()
    }

    /**
     * 启动时同步取值（供 `setContent` 之前调用）。
     *
     * 镜像命中（绝大多数启动）：<1ms，首帧零等待。无镜像才走 DataStore 同步读 ——
     * 超时兜底不能省：极端情况（存储慢/被占用）不该把启动卡住，超时就按"跟随系统"
     * 走，颜色最多闪一次，但不会 ANR。
     */
    fun readInitialBlocking(timeoutMillis: Long = 400L): Mode {
        mirrorPrefs.getString(KEY_MIRROR, null)?.let { return Mode.from(it) }
        val mode = runBlocking {
            withTimeoutOrNull(timeoutMillis) {
                runCatching { store.data.first() }.getOrNull()?.let { Mode.from(it[KEY_MODE]) }
            } ?: Mode.System
        }
        mirrorPrefs.edit().putString(KEY_MIRROR, mode.key).apply()
        return mode
    }

    private companion object {
        val KEY_MODE = stringPreferencesKey("theme_mode")

        /** 镜像 prefs 里的键（与 DataStore 的 KEY_MODE 同名同值域） */
        const val KEY_MIRROR = "theme_mode"
    }
}

/**
 * DataStore 单例。
 *
 * `preferencesDataStore` 委托**必须**是顶层属性：每次调用 `preferencesDataStore(name)`
 * 都会新建一个实例，而同一个文件上存在两个 DataStore 会直接抛
 * `IllegalStateException: There are multiple DataStores active for the same file`。
 */
private val Context.themeDataStore: DataStore<Preferences> by preferencesDataStore(name = "k_theme")
