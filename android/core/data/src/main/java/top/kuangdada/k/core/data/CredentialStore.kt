package top.kuangdada.k.core.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * ============================================================
 * 凭证存储（CredentialStore）
 * ============================================================
 * 敏感凭证的**唯一**存储出口：登录 JWT 与访客语音房的所有权令牌。
 * 普通偏好（设置、身份展示字段）不得经它落盘，它也不存非凭证数据 ——
 * 两类数据的存储介质与清理规则完全不同（见 [TokenStore] 的类注释）。
 *
 * ## 降级策略（P1-3.2）：不再静默落明文
 * 少数机型/ROM 上 Keystore 会抛（OEM 兼容问题、用户清除凭据、锁屏类型变更等）。
 * 此前 TokenStore 会退回**普通 SharedPreferences 明文存 JWT** —— 等于把最敏感的
 * 凭证降到最低防护还无人知晓。现在改为**仅内存会话**：本次进程内功能照常
 * （[memoryOnly] = true 可供设置页提示），进程结束即清空，下次启动需要重新登录。
 *
 * ## 旧数据迁移与擦除
 * 历史版本留下两个明文位置：`k_secure_plain`（旧降级文件的 `k_token`）与
 * `voice_owner_tokens`（访客房令牌整文件）。首次成功打开加密存储时做**一次性迁移**：
 * 明文里的凭证搬进加密存储，随后擦除明文侧的凭证字段（保留其他字段不动）。
 * 迁移标记写在加密存储里 —— Keystore 不可用的那次启动跳过迁移，下次再试。
 */
interface CredentialStore {
    /** 登录 JWT；null = 未登录 */
    var token: String?

    /** 访客语音房的所有权令牌（删除房间时随 X-Voice-Owner-Token 带回；null = 无） */
    fun guestOwnerToken(roomId: Long): String?

    /** 记录访客语音房的所有权令牌（token 为 null 时删除该条） */
    fun setGuestOwnerToken(roomId: Long, token: String?)

    /** 本机持有所有权令牌的房间 id 集合（重启后恢复“我建的房”的删除入口用） */
    fun allGuestOwnerTokenIds(): Set<Long>

    /** 清除登录凭证（登出）。访客房令牌与登录账号无关，不在此列 */
    fun clearToken()

    /** 是否运行在仅内存模式（Keystore 不可用）—— 可供 UI 提示“重启后需重新登录” */
    val memoryOnly: Boolean

    /**
     * 擦除历史明文文件中的**凭证字段**（幂等）：
     * `k_secure_plain` 的 k_token 与 `voice_owner_tokens` 的全部条目。
     * 迁移时与登出时都会调用，保证旧明文不会复活。
     */
    fun eraseLegacyPlaintextCredentials()
}

/**
 * 基于 EncryptedSharedPreferences 的实现（Android Keystore 主密钥包装，磁盘密文）。
 * Keystore 创建失败 → 仅内存会话（不落明文）。
 */
class SecureCredentialStore(context: Context) : CredentialStore {

    private val appContext = context.applicationContext

    /** Keystore 不可用时的内存后备（token 与访客令牌各一份） */
    private val memoryToken = java.util.concurrent.atomic.AtomicReference<String?>(null)
    private val memoryGuestTokens = java.util.concurrent.ConcurrentHashMap<Long, String>()

    @Volatile
    private var memoryOnlyMode = false

    override val memoryOnly: Boolean get() = memoryOnlyMode

    /** 加密存储；首次访问时顺带做旧明文迁移（失败仅记录，不阻塞功能） */
    private val prefs: SharedPreferences? by lazy {
        try {
            val created = openEncrypted(FILE_ENCRYPTED) ?: error("打开加密存储失败")
            migrateLegacy(created)
            created
        } catch (t: Throwable) {
            // 仅内存会话：功能可用，但重启后需重新登录（不静默落明文，P1-3.2）
            memoryOnlyMode = true
            null
        }
    }

    /** 打开（或创建）一个加密 prefs 文件；Keystore 不可用时返回 null */
    private fun openEncrypted(file: String): SharedPreferences? = try {
        val masterKey = MasterKey.Builder(appContext)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            appContext,
            file,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    } catch (t: Throwable) {
        null
    }

    override var token: String?
        get() = if (memoryOnlyMode) memoryToken.get() else prefs?.getString(KEY_TOKEN, null)
        set(value) {
            if (memoryOnlyMode) {
                memoryToken.set(value)
                return
            }
            prefs?.edit()?.apply {
                if (value.isNullOrEmpty()) remove(KEY_TOKEN) else putString(KEY_TOKEN, value)
            }?.apply()
        }

    override fun guestOwnerToken(roomId: Long): String? =
        if (memoryOnlyMode) memoryGuestTokens[roomId]
        else prefs?.getString(keyGuestToken(roomId), null)

    override fun setGuestOwnerToken(roomId: Long, token: String?) {
        if (memoryOnlyMode) {
            if (token == null) memoryGuestTokens.remove(roomId) else memoryGuestTokens[roomId] = token
            return
        }
        prefs?.edit()?.apply {
            if (token.isNullOrEmpty()) remove(keyGuestToken(roomId)) else putString(keyGuestToken(roomId), token)
        }?.apply()
    }

    override fun allGuestOwnerTokenIds(): Set<Long> {
        if (memoryOnlyMode) return memoryGuestTokens.keys.toSet()
        val p = prefs ?: return emptySet()
        // EncryptedSharedPreferences 的 all 会把键解密回明文 —— 前缀匹配即可拿到房间 id
        return p.all.keys.mapNotNull { key ->
            if (key.startsWith(KEY_GUEST_TOKEN_PREFIX)) {
                key.removePrefix(KEY_GUEST_TOKEN_PREFIX).toLongOrNull()
            } else {
                null
            }
        }.toSet()
    }

    override fun clearToken() {
        token = null
        // 登出顺手擦一次历史明文（幂等）：旧版本留下的明文凭证不应比会话活得更久
        eraseLegacyPlaintextCredentials()
    }

    override fun eraseLegacyPlaintextCredentials() {
        runCatching {
            appContext.getSharedPreferences(LEGACY_FILE_FALLBACK, Context.MODE_PRIVATE)
                .edit().remove(LEGACY_KEY_TOKEN).apply()
        }
        runCatching {
            // voice_owner_tokens 里只有凭证（房间 id → 令牌），整文件清空即擦除凭证字段
            appContext.getSharedPreferences(LEGACY_FILE_VOICE_TOKENS, Context.MODE_PRIVATE)
                .edit().clear().apply()
        }
    }

    /**
     * 一次性迁移：把历史明文位置里的凭证搬进加密存储，再擦除来源侧。
     * 只在加密存储可用时执行；标记（KEY_MIGRATED）也写在加密存储里。
     * 来源两处：旧降级明文 `k_secure_plain` 的 k_token、明文 `voice_owner_tokens` 整文件。
     * （旧**加密**文件 `k_secure` 里遗留的 k_token 由 [TokenStore] 用它自己的实例迁移，
     * 避免两个 EncryptedSharedPreferences 实例指向同一文件。）
     */
    private fun migrateLegacy(secure: SharedPreferences) {
        if (secure.getBoolean(KEY_MIGRATED, false)) return
        runCatching {
            if (secure.getString(KEY_TOKEN, null) == null) {
                // 旧降级文件的明文 JWT（只搬 k_token，其余字段留给原文件）
                val plain = appContext.getSharedPreferences(LEGACY_FILE_FALLBACK, Context.MODE_PRIVATE)
                val plainToken = plain.getString(LEGACY_KEY_TOKEN, null)
                if (!plainToken.isNullOrEmpty()) {
                    secure.edit().putString(KEY_TOKEN, plainToken).apply()
                }
            }
            // 访客房令牌：明文整文件 → 加密存储
            val voice = appContext.getSharedPreferences(LEGACY_FILE_VOICE_TOKENS, Context.MODE_PRIVATE)
            for ((k, v) in voice.all) {
                val id = k.toLongOrNull()
                if (id != null && v is String && v.isNotEmpty()) {
                    secure.edit().putString(keyGuestToken(id), v).apply()
                }
            }
            // 擦明文 + 记标记（即使前两步没搬出任何东西也要标记，避免每次启动重扫）
            eraseLegacyPlaintextCredentials()
            secure.edit().putBoolean(KEY_MIGRATED, true).apply()
        }
    }

    private fun keyGuestToken(roomId: Long) = "${KEY_GUEST_TOKEN_PREFIX}$roomId"

    private companion object {
        /** 凭证专用加密文件（与 TokenStore 的身份展示字段分开） */
        const val FILE_ENCRYPTED = "k_credentials"
        const val KEY_TOKEN = "k_token"
        const val KEY_GUEST_TOKEN_PREFIX = "k_guest_owner_"
        const val KEY_MIGRATED = "k_migrated_v1"
        // 历史明文位置（迁移后擦除凭证字段）
        const val LEGACY_FILE_FALLBACK = "k_secure_plain"
        const val LEGACY_KEY_TOKEN = "k_token"
        const val LEGACY_FILE_VOICE_TOKENS = "voice_owner_tokens"
    }
}
