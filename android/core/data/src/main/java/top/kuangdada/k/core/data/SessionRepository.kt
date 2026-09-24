package top.kuangdada.k.core.data

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import top.kuangdada.k.core.data.model.AuthResponse
import top.kuangdada.k.core.data.model.ForgotPasswordRequest
import top.kuangdada.k.core.data.model.LoginRequest
import top.kuangdada.k.core.data.model.RegisterRequest
import top.kuangdada.k.core.data.model.ResetPasswordRequest
import top.kuangdada.k.core.data.model.SendCodeRequest
import top.kuangdada.k.core.data.model.User

/**
 * ============================================================
 * 会话仓库（SessionRepository）
 * ============================================================
 * 全局单例式持有：**一个进程内只有一份登录态**，避免"首页登录了、消息页还是游客"
 * 这类由多份状态引起的错乱（Web 版靠 AuthContext 保证，原生用 StateFlow 保证）。
 *
 * 设计要点：
 *  · token 落 EncryptedSharedPreferences（[TokenStore]），内存只保留状态流；
 *  · 冷启动时若本地有 token，**先用缓存身份进入已登录态**，同时后台用 `/auth/me` 校验
 *    —— 服务端改密会让 token 立即失效，所以校验失败必须能退回游客态；
 *  · 401 只标记"会话失效"，由 UI 决定何时弹登录（后台轮询的 401 不该踢掉正在看的页面）。
 */
class SessionRepository(
    context: Context,
    val tokens: TokenStore,
) {

    sealed interface AuthState {
        /** 启动中：本地 token 存在但还没校验完（避免登录页闪一下） */
        data object Restoring : AuthState

        /** 游客 */
        data object Guest : AuthState

        /** 已登录 */
        data class LoggedIn(val user: User) : AuthState

        /** 令牌失效（服务端明确 401）——UI 据此提示重新登录 */
        data class Expired(val reason: String) : AuthState
    }

    private val appContext = context.applicationContext

    private val _state = MutableStateFlow<AuthState>(AuthState.Restoring)
    val state: StateFlow<AuthState> = _state.asStateFlow()

    /** 当前 token（网络层用；null = 游客） */
    val token: String? get() = tokens.token

    /** 是否已登录（含"本地有 token 但没校验完"的乐观情形，用于决定要不要显示入口） */
    val isLoggedIn: Boolean get() = !tokens.token.isNullOrEmpty()

    /**
     * 首帧用的头像地址（**上一次登录时落盘的那份**）。
     *
     * 用途：冷启动时 [state] 还是 `Restoring`、`/auth/me` 没回来，UI 拿不到 `LoggedIn.user`。
     * 没有它的话头像组件只能先画默认人像图标、等接口回来再换 —— 用户看到的就是
     * "**先有占位头像，然后变成自己头像**"（私信对话页里最扎眼：自己的头像每页都出现好几次）。
     *
     * 只作**降级/兜底**用：`authState` 一旦进入 `LoggedIn`，调用方应当优先用真值
     * （见 `AppShell` 里的取值顺序），所以换了头像不会卡在旧图上。
     *
     * 未登录（没有 token）时返回 null —— 不能拿上一个人的头像去渲染。
     */
    val cachedAvatar: String? get() = if (isLoggedIn) tokens.avatarUrl else null

    /** 同 [cachedAvatar]，首帧用的昵称 */
    val cachedUsername: String? get() = if (isLoggedIn) tokens.username else null

    /**
     * 把用户对象里的"身份展示字段"落盘（头像 / 昵称）。
     *
     * 在**每一个**拿到可信用户对象的时机调用：[restore] 校验成功、登录、注册、
     * 以及 [updateUser]（改资料/换头像后接口回传新对象）。这样落盘值总是"已知的最新"。</br>
     *
     * 为什么不存整个 `User` 对象（JSON）：能做但不必要 —— 现在只用到这两个字段，
     * 存两个字符串比引一套序列化便宜；将来需要更多字段时再一起挪到统一的快照里。
     */
    private fun persistIdentity(user: User) {
        tokens.userId = user.id
        tokens.avatarUrl = user.avatar
        tokens.username = user.username
    }

    val api: KApi = KApi(
        baseUrl = resolveBaseUrl(),
        tokenStore = tokens,
        onUnauthorized = {
            // 只做"标记失效"：不动 token（可能是某个后台请求的 token 竞争），
            // 由 UI 侧的下一次显式请求或 /auth/me 校验来最终决定。
            if (isLoggedIn) {
                _state.value = AuthState.Expired("登录已失效，请重新登录")
            }
        },
    )

    private fun resolveBaseUrl(): String =
        tokens.serverOverride?.takeIf { it.isNotBlank() } ?: BuildConfig.DEFAULT_SERVER_URL

    suspend fun restore() {
        if (!isLoggedIn) {
            _state.value = AuthState.Guest
            return
        }
        _state.value = AuthState.Restoring
        when (val result = runCatchingApi { api.auth.me() }) {
            is ApiResult.Success -> {
                persistIdentity(result.data)
                _state.value = AuthState.LoggedIn(result.data)
            }
            is ApiResult.Failure -> {
                val error = result.error
                // 网络问题不应该把已登录用户踢成游客（离线也要能看缓存内容）
                if (error is ApiError.Unauthorized || error is ApiError.Forbidden) {
                    tokens.clearAuth()
                    _state.value = AuthState.Expired(error.message)
                } else {
                    _state.value = AuthState.Guest
                }
            }
        }
    }

    suspend fun login(email: String, password: String): ApiResult<AuthResponse> {
        val result = runCatchingApi { api.auth.login(LoginRequest(email.trim(), password)) }
        if (result is ApiResult.Success) applyAuth(result.data)
        return result
    }

    suspend fun register(
        username: String,
        email: String,
        password: String,
        code: String,
    ): ApiResult<AuthResponse> {
        val result = runCatchingApi {
            api.auth.register(
                RegisterRequest(username.trim(), email.trim(), password, code.trim())
            )
        }
        if (result is ApiResult.Success) applyAuth(result.data)
        return result
    }

    suspend fun sendCode(email: String): ApiResult<String> =
        runCatchingApi { api.auth.sendCode(SendCodeRequest(email.trim())).message }

    suspend fun forgotPassword(email: String): ApiResult<String> =
        runCatchingApi { api.auth.forgotPassword(ForgotPasswordRequest(email.trim())).message }

    suspend fun resetPassword(email: String, code: String, password: String): ApiResult<String> =
        runCatchingApi {
            api.auth.resetPassword(ResetPasswordRequest(email.trim(), code.trim(), password)).message
        }

    fun logout() {
        tokens.clearAuth()
        _state.value = AuthState.Guest
    }

    /**
     * 用服务端返回的**最新用户对象**替换内存里的登录身份（token 不动）。
     *
     * 为什么必须有这个方法：`PUT /api/users/me`（改昵称/简介）与 `POST /api/users/avatar`
     * 都返回完整用户对象，但**内存里的 `AuthState.LoggedIn.user` 不会自己变** ——
     * 不接这一步的话，用户保存完昵称，主页/帖子卡片上的署名与头像仍是旧值
     * （要等下次冷启动 `/auth/me` 才刷新），看起来就像"保存没生效"。
     *
     * 只在**确实是已登录**时替换：登录弹层刚被关掉或令牌已失效时，不能凭一个旧请求的
     * 响应把状态从 Guest/Expired 拉回 LoggedIn。
     */
    fun applyUser(user: User) {
        val current = _state.value
        if (current !is AuthState.LoggedIn) return
        persistIdentity(user)
        _state.value = AuthState.LoggedIn(user)
    }

    private fun applyAuth(response: AuthResponse) {
        tokens.token = response.token
        persistIdentity(response.user)
        _state.value = AuthState.LoggedIn(response.user)
    }

    /** 把 Retrofit 的异常收敛成 [ApiResult]，仓库层与 UI 层不再碰 try/catch */
    private suspend fun <T> runCatchingApi(block: suspend () -> T): ApiResult<T> =
        withContext(Dispatchers.IO) {
            try {
                ApiResult.Success(block())
            } catch (t: Throwable) {
                ApiResult.Failure(mapErrorFromThrowable(t))
            }
        }
}
