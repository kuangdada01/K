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

    /**
     * ★★ **身份展示字段的内存快照**（2026-09-24）。
     *
     * 为什么必须有这一层（用户实测反馈：**"消息对话框里我的头像每次进入又要重新加载"、
     * 形态是"先空/默认人像，再变真头像"**）：
     *
     * [avatarUrl] / [username] 的 getter 每次都走 `prefs.getString(...)`，而 `prefs` 是
     * **EncryptedSharedPreferences** —— 它底层要经过 Android Keystore 解主密钥、再逐条做
     * AES 解密。冷启动第一次访问时这段开销可达**几十到上百毫秒**，而且是同步的。
     *
     * `AppShell.myAvatarUrl` 的取值顺序是「`LoggedIn.user.avatar` ?: [cachedAvatar]」：
     * 冷启动那一刻 `authState` 还是 `Restoring`（没有 `LoggedIn.user`），于是**必然**落到
     * `?:` 这一支去读盘。首帧读不出来 → `Avatar(url = null)` → **只画兜底人像图标**；
     * 等读盘完成 / `/auth/me` 回来 → URL 才出现 → 图片淡入。
     * 用户看到的就是"先默认人像、再变真头像"，而且**只有自己那头像**会这样
     * （对方的头像由会话列表接口一次性带回，不存在这段空窗）。
     *
     * 解法：在**任何同步读盘发生之前**（[AppGraph] 构造时、`Application.onCreate` 的主线程上，
     * 那时还没有任何帧要画）把两个字段读进内存快照，之后所有 getter 都只读内存 → **首帧即有值**。
     *
     * 快照的**唯一失效点**是登录身份变化（登录 / 换头像 / 改昵称 / 退出登录），
     * 这些路径全部会走下面的 setter 或 [clearAuth]，两者都会刷新快照，所以不存在脏读。
     */
    private var avatarSnapshot: String? = null
    private var usernameSnapshot: String? = null

    /**
     * 预热身份快照。**在 `Application.onCreate` 里调用一次**（见 `AppGraph`），
     * 不要放进组合或首帧路径 —— 那样就失去了"提前读盘"的意义。
     *
     * 幂等：重复调用只是再读一次盘，无副作用。
     */
    fun warmIdentity() {
        // 读进局部变量再赋值：万一 prefs 自己抛（Keystore 异常），不能把已缓存的旧快照清掉
        val a = prefs.getString(KEY_AVATAR, null)
        val u = prefs.getString(KEY_USERNAME, null)
        avatarSnapshot = a
        usernameSnapshot = u
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

    /**
     * 当前登录用户的**头像地址**（本地缓存）。
     *
     * 为什么必须落盘（用户实测反馈："**私信对话页自己的头像还是先占位、再变真头像**"）：
     *
     * 冷启动时 [SessionRepository.state] 先是 `Restoring`，`/auth/me` 回来之前
     * `LoggedIn.user` 是**没有的** —— 于是 AppShell 传下去的 `myAvatar` 是 `null`，
     * 头像组件只好先画**默认人像图标**，等接口回来才换成真头像。那一跳就是用户看到的
     * "先占位、再变成自己头像"。
     *
     * 为什么不能只靠"等接口"：`/auth/me` 是一次网络往返（真机冷启动数百毫秒），
     * 而本地 prefs 是**同一帧就读得到**的。头像地址又不是机密（它只是
     * `/uploads/avatars/xxx.jpg` 这种公开路径），放进已经加密的 prefs 只是顺带。
     *
     * 只做**首帧降级用**：接口回来后 [SessionRepository] 会用服务端的最新值覆盖它，
     * 所以换头像不会因为这个缓存而"卡在旧图"。
     */
    var avatarUrl: String?
        /**
         * 读**内存快照**而不是 `prefs` —— 见上面 [warmIdentity] 的长注释：
         * 加密 prefs 的同步读盘会让首帧拿不到头像地址，表现成"先占位再变真头像"。
         */
        get() = avatarSnapshot
        set(value) {
            avatarSnapshot = value
            prefs.edit().apply {
                if (value.isNullOrEmpty()) remove(KEY_AVATAR) else putString(KEY_AVATAR, value)
            }.apply()
        }

    /** 当前登录用户的昵称（同上：只为首帧降级，接口回来后覆盖） */
    var username: String?
        get() = usernameSnapshot
        set(value) {
            usernameSnapshot = value
            prefs.edit().apply {
                if (value.isNullOrEmpty()) remove(KEY_USERNAME) else putString(KEY_USERNAME, value)
            }.apply()
        }

    fun clearAuth() {
        avatarSnapshot = null
        usernameSnapshot = null
        prefs.edit()
            .remove(KEY_TOKEN)
            .remove(KEY_USER_ID)
            // 头像/昵称也一起清：留着的话退出登录后、下一个人登录前的空窗期
            // 会拿**上一个用户**的头像去渲染（同一个 prefs 文件）
            .remove(KEY_AVATAR)
            .remove(KEY_USERNAME)
            .apply()
    }

    private companion object {
        const val FILE_ENCRYPTED = "k_secure"
        const val FILE_FALLBACK = "k_secure_plain"
        const val KEY_TOKEN = "k_token"
        const val KEY_USER_ID = "k_user_id"
        const val KEY_SERVER = "k_server"
        const val KEY_AVATAR = "k_avatar"
        const val KEY_USERNAME = "k_username"
    }
}
