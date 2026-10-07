package top.kuangdada.k.core.data

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Response
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import top.kuangdada.k.core.data.api.AdminApi
import top.kuangdada.k.core.data.api.AnnouncementApi
import top.kuangdada.k.core.data.api.AuthApi
import top.kuangdada.k.core.data.api.BookApi
import top.kuangdada.k.core.data.api.ComposerApi
import top.kuangdada.k.core.data.api.EventApi
import top.kuangdada.k.core.data.api.FriendsApi
import top.kuangdada.k.core.data.api.MessageApi
import top.kuangdada.k.core.data.api.NotificationsApi
import top.kuangdada.k.core.data.api.PostApi
import top.kuangdada.k.core.data.api.TtsApi
import top.kuangdada.k.core.data.api.UserApi
import top.kuangdada.k.core.data.api.VoiceApi
import java.util.concurrent.TimeUnit

/**
 * ============================================================
 * HTTP 客户端（KApi）
 * ============================================================
 * 四个必须对齐服务端的点：
 *
 * 1. **Bearer 鉴权**：`Authorization: Bearer <jwt>`（server/src/middleware/auth.ts）。
 * 2. **滑动续期**：token 签发满 24h 后的任意已认证请求，服务端用响应头
 *    `X-Refreshed-Token` 回一张新 token（server/src/lib/jwt.ts）。**必须读这个头并落盘**
 *    —— 不读的话，一直在用的用户在 7 天到点后会被静默登出，且极难复现。
 * 3. **会话代次（P1-3.1）**：每个请求在发出时捕获 [sessionEpoch] 的当前值，
 *    迟到的续期 token / 401 只有仍属当前会话才允许改动本地状态
 *    （判定逻辑见 [TokenCaptureLogic]，规则细节在那里）。
 * 4. **超时**：Web 版 axios 是 15s；原生保持一致，避免“同一网络下网页能开、App 打不开”。
 *
 * 唯一的例外是**视频上传**：它走 [mediaClient]（读 60s / 写 120s），见那里的注释。
 */
class KApi(
    baseUrl: String,
    tokenReader: () -> String?,
    tokenWriter: (String) -> Unit,
    /** 会话代次（登录/登出/换号时由会话层递增）；请求发出时捕获、响应时比对 */
    sessionEpoch: () -> Int,
    /** 401 时回调（参数 = 请求发出时的代次；由会话层比对当前代次后决定是否标记失效） */
    private val onUnauthorized: (epochAtSend: Int) -> Unit = {},
    /** 令牌被续期时的回调（会话层可据此更新内存态） */
    private val onTokenRefreshed: (String) -> Unit = {},
    enableLogging: Boolean = false,
) {

    /** 规范化：Retrofit 要求 baseUrl 以 / 结尾 */
    val baseUrl: String = if (baseUrl.endsWith("/")) baseUrl else "$baseUrl/"

    /** 续期/401 的代次判定（纯逻辑，抽出来便于单测） */
    private val tokenCapture = TokenCaptureLogic(
        readToken = tokenReader,
        writeToken = tokenWriter,
        currentEpoch = sessionEpoch,
        onUnauthorized = { epochAtSend -> onUnauthorized(epochAtSend) },
    )

    /**
     * 鉴权 + 续期捕获在**同一个**拦截器里完成：请求侧捕获代次、附加 Bearer，
     * 响应侧用同一个代次值做判定 —— 拆成两个拦截器就需要跨拦截器传上下文了。
     */
    private val authAndCaptureInterceptor = okhttp3.Interceptor { chain ->
        val epochAtSend = sessionEpoch()
        val request = chain.request()
        val token = tokenReader()
        val authorized = if (token.isNullOrEmpty() || request.header("Authorization") != null) {
            request
        } else {
            request.newBuilder().header("Authorization", "Bearer $token").build()
        }
        val response = chain.proceed(authorized)
        captureRefreshedToken(response, epochAtSend)
        response
    }

    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .addInterceptor(authAndCaptureInterceptor)
        .apply {
            if (enableLogging) {
                // 只在调试构建里挂（:core:data 的 build.gradle 用 debugImplementation 引入）
                runCatching {
                    val clazz = Class.forName("okhttp3.logging.HttpLoggingInterceptor")
                    val level = Class.forName("okhttp3.logging.HttpLoggingInterceptor\$Level")
                    val body = level.getField("BODY").get(null)
                    val instance = clazz.getConstructor(level).newInstance(body)
                    addInterceptor(instance as okhttp3.Interceptor)
                }
            }
        }
        .build()

    private val retrofit: Retrofit = Retrofit.Builder()
        .baseUrl(baseUrl)
        .client(client)
        .addConverterFactory(KJson.asConverterFactory("application/json".toMediaType()))
        .build()

    /**
     * 媒体上传专用通道（视频帖子）。
     *
     * 为什么单独一套：全局是 connect 15s / read 20s / write 30s，按普通 JSON 接口定的；
     * 而上行一个 1GB 的视频在 4G 上要十几分钟 —— 走全局通道会稳定超时，
     * 表现为「永远发布失败」，而服务端其实已经收下了整个文件（白白占磁盘）。
     *
     * 三个值的取法（都是**单块数据**的间隔上限，OkHttp 每次读写都会重新计时，
     * 所以"慢但在动"的上传不会被掐断；真正卡住仍会在这些秒数后失败）：
     *  · read 60s —— 服务端在收完整段 multipart 之前不会回任何字节，等它开口要容忍；
     *  · write 120s —— 弱网下单块 8KB 卡 2 分钟已经算掉线了；
     *  · **不设 callTimeout** —— 那是"整个请求"的硬上限，正是要放开的那个。
     *
     * 只放宽超时，**复用同一个 client**（`newBuilder`）：OkHttp 的连接池、线程池与
     * 已注册的拦截器都继承下来，Bearer 鉴权、X-Refreshed-Token 续期、401 回调一个都不会丢。
     */
    // ---- 接口代理全部 **by lazy**（2026-09-28 审查项）----
    // 每个 create() 都要做注解反射解析，14 个全量急切创建落在 Application.onCreate
    // 的主线程装配里，而首次真正用网络要等到首帧之后的 restore()。改成 lazy 后
    // 谁先被用谁创建，启动路径不再为没碰过的接口付反射成本。

    private val mediaClient: OkHttpClient by lazy {
        client.newBuilder()
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(120, TimeUnit.SECONDS)
            .build()
    }

    private val mediaRetrofit: Retrofit by lazy {
        Retrofit.Builder()
            .baseUrl(baseUrl)
            .client(mediaClient)
            .addConverterFactory(KJson.asConverterFactory("application/json".toMediaType()))
            .build()
    }

    /** 媒体上传专用接口（目前只有发视频用得到） */
    val composerMedia: ComposerApi by lazy { mediaRetrofit.create(ComposerApi::class.java) }

    val auth: AuthApi by lazy { retrofit.create(AuthApi::class.java) }
    val posts: PostApi by lazy { retrofit.create(PostApi::class.java) }
    val books: BookApi by lazy { retrofit.create(BookApi::class.java) }
    val users: UserApi by lazy { retrofit.create(UserApi::class.java) }
    /** 关注（server/src/routes/friends.ts）：他人主页的关注按钮与关注状态 */
    val friends: FriendsApi by lazy { retrofit.create(FriendsApi::class.java) }
    val voice: VoiceApi by lazy { retrofit.create(VoiceApi::class.java) }
    /** 云端朗读（`/api/tts`）：房间文字聊天的「朗读」云端音色，与 Web 端同一接口 */
    val tts: TtsApi by lazy { retrofit.create(TtsApi::class.java) }
    val messages: MessageApi by lazy { retrofit.create(MessageApi::class.java) }
    val composer: ComposerApi by lazy { retrofit.create(ComposerApi::class.java) }
    val events: EventApi by lazy { retrofit.create(EventApi::class.java) }
    val admin: AdminApi by lazy { retrofit.create(AdminApi::class.java) }
    val announcements: AnnouncementApi by lazy { retrofit.create(AnnouncementApi::class.java) }
    // 通知接口。原先因为 release(R8) 下 create() 抛 ClassCastException 被摘掉，
    // 根因是 R8 的「接口合并」把服务接口并走了（见 :native/proguard-rules.pro）——
    // 规则修好后这里恢复注册，`NotificationApi` 与其它服务接口走同一套 create。
    val notifications: NotificationsApi by lazy { retrofit.create(NotificationsApi::class.java) }

    /**
     * 分享用的 PostApi 之外，这里再暴露一个 baseUrl 便于各仓库拼绝对媒体地址。
     * （已经作为 public val baseUrl 存在，此处仅作说明。）
     */

    /**
     * 读取滑动续期下发的新 token 并落盘（代次与“本地已有 token”两个闸门在
     * [TokenCaptureLogic] 里，规则见那边的类注释）。
     *
     * 为什么**不**在这里处理 401 清理：401 的处理需要清跨账号缓存、跳登录页，
     * 属于会话层的职责；放在网络层会让"一个后台轮询的 401"把正在看的页面踢掉。
     * 这里只把 401 事件（带发出时的代次）转出去，由会话层决定要不要真的登出。
     */
    private fun captureRefreshedToken(response: Response, epochAtSend: Int) {
        val headerName = "X-Refreshed-Token"
        val fresh = response.header(headerName) ?: response.header(headerName.lowercase())
        if (tokenCapture.handleRefreshedToken(fresh, epochAtSend) && fresh != null) {
            onTokenRefreshed(fresh)
        }
        tokenCapture.handleUnauthorizedIfMatches(response.code, epochAtSend)
    }
}
