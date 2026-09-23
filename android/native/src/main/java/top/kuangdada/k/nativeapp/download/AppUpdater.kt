package top.kuangdada.k.nativeapp.download

import android.content.Context
import android.util.Log
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import top.kuangdada.k.core.data.ApiError
import top.kuangdada.k.core.data.ApiResult
import top.kuangdada.k.core.data.getOrNull
import top.kuangdada.k.core.data.resolveUrl
import top.kuangdada.k.nativeapp.AppGraph
import top.kuangdada.k.nativeapp.BuildConfig

/**
 * ============================================================
 * App 自更新检测（AppUpdater）
 * ============================================================
 * 对应服务端 `GET /api/app/version`（server/src/routes/meta.ts）：
 * ```json
 * { "version": "1.2.3", "apkUrl": "/downloads/k-app-1.2.3-release.apk", "notes": "..." }
 * ```
 * **`version === null` 是"未配置 → 无更新"的语义**，不是错误 —— 服务端用 `env.APP_VERSION ?? null`，
 * 不能配了个空串就当有更新，所以这里判 null/blank 后直接返回 [VersionInfo.latestVersion] = null。
 *
 * 关键设计：
 *  · **不新建 Retrofit/OkHttp 实例**：走 `:core:data` 已经装配好的东西 ——
 *    baseUrl 与 token 都从 [AppGraph] 的 session 里取。自己再建一套会多一份超时/鉴权语义，
 *    将来服务端换域名时也必然漏改一处。
 *  · **错误映射与仓库层同构**：[ApiError.Http] / [ApiError.Timeout] / [ApiError.Network] / [ApiError.Parse]，
 *    文案规则照抄 `:core:data/ApiError.kt`（那个 `mapError` 是 internal，跨模块拿不到，
 *    所以这里按同样的规则重写一遍，而不是复制实现细节）。
 *  · 这个端点**不需要登录**，但带上 token 无害（服务端忽略）；将来若加了灰度/白名单也能直接用。
 *  · 纯函数 [isNewer] 与网络零耦合，单测直接钉边界（见 `AppUpdaterTest`）。
 */
class AppUpdater(context: Context) {

    private val appContext = context.applicationContext
    private val session = AppGraph.from(appContext).session

    private val baseUrl: String get() = session.api.baseUrl

    /** 服务端返回的版本信息；[latestVersion] 为 null = 服务端未配置 = 无更新 */
    data class VersionInfo(
        val latestVersion: String?,
        val apkUrl: String?,
        val notes: String?,
    )

    /** 更新检测结果：UI 只看 [hasUpdate] / [latestVersion] / [apkUrl] / [notes] */
    data class UpdateCheck(
        val hasUpdate: Boolean,
        val latestVersion: String?,
        val apkUrl: String?,
        val notes: String?,
        val currentVersion: String,
    )

    /**
     * 拉服务端版本信息。
     *
     * `Success(data)` 里的 `data.latestVersion == null` 表示"服务端未配置更新"，
     * 与 `Failure`（网络/HTTP/解析出错）是**两件事**：前者不该给用户任何提示，
     * 后者集成方通常也只记日志（更新检测失败不该打扰用户）。
     */
    suspend fun fetchVersionInfo(): ApiResult<VersionInfo> = withContext(Dispatchers.IO) {
        val url = baseUrl.trimEnd('/') + ENDPOINT
        var connection: HttpURLConnection? = null
        try {
            connection = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = CONNECT_TIMEOUT_MS
                readTimeout = READ_TIMEOUT_MS
                // 手动跟 3xx：HttpURLConnection 的自动重定向规则在各版本上不一致，显式处理更可控。
                // （nginx 把 /api 反代到后端时不会 301，但加一层不影响正确性。）
                instanceFollowRedirects = false
                setRequestProperty("Accept", "application/json")
                session.tokens.token?.takeIf { it.isNotBlank() }?.let {
                    setRequestProperty("Authorization", "Bearer $it")
                }
            }
            val code = connection.responseCode
            if (code !in 200..299) {
                val body = connection.errorStream?.use { it.readBytes().decodeToString() }
                Log.w(TAG, "版本检测失败 HTTP $code: ${body?.take(200)}")
                return@withContext ApiResult.Failure(mapHttp(code, body))
            }
            val body = connection.inputStream.use { it.readBytes().decodeToString() }
            val dto = parseVersionDto(body)
            ApiResult.Success(
                VersionInfo(
                    latestVersion = dto.version?.trim()?.takeIf { it.isNotEmpty() },
                    // 服务端给的是 `/downloads/...` 相对路径，必须拼成绝对地址再交给 DownloadManager，
                    // 否则它会把相对路径当非法 URL 抛异常
                    apkUrl = resolveUrl(dto.apkUrl, baseUrl),
                    notes = dto.notes?.takeIf { it.isNotBlank() },
                )
            )
        } catch (t: Throwable) {
            // 诊断价值：解析失败时得知道服务端到底返回了什么形状
            Log.w(TAG, "版本检测失败: $url", t)
            ApiResult.Failure(mapThrowable(t))
        } finally {
            connection?.disconnect()
        }
    }

    /** 便捷入口：查更新并顺手和本机版本比一次。本机版本取 [BuildConfig.VERSION_NAME]。 */
    suspend fun checkForUpdate(localVersion: String = BuildConfig.VERSION_NAME): ApiResult<UpdateCheck> {
        val current = localVersion.trim().ifBlank { DEFAULT_LOCAL_VERSION }
        return when (val result = fetchVersionInfo()) {
            is ApiResult.Success -> {
                val remote = result.data.latestVersion
                ApiResult.Success(
                    UpdateCheck(
                        hasUpdate = remote != null && isNewer(remote, current),
                        latestVersion = remote,
                        apkUrl = result.data.apkUrl,
                        notes = result.data.notes,
                        currentVersion = current,
                    )
                )
            }
            is ApiResult.Failure -> result
        }
    }

    /** 只要"最新版本号或 null"，不要 `ApiResult` 的简化入口（失败与无更新都返回 null） */
    suspend fun latestVersionOrNull(): String? = fetchVersionInfo().getOrNull()?.latestVersion

    companion object {
        private const val TAG = "KAppUpdater"

        /** 与 KApi 把 baseUrl 规范成"以 / 结尾"的语义对齐，这里直接拼相对段 */
        private const val ENDPOINT = "app/version"

        private const val CONNECT_TIMEOUT_MS = 10_000
        private const val READ_TIMEOUT_MS = 15_000

        /** VERSION_NAME 理论上不会为空；万一为空就当作 0，否则任何版本都会被判成"有更新" */
        private const val DEFAULT_LOCAL_VERSION = "0"

        // 服务端的 Json 约定（见 :core:data 的 KJson）：unknown 字段忽略、宽容解析。
        // 这里单独建一份是因为那个实例是 internal 的，跨模块取不到。
        private val KJson: Json = Json {
            ignoreUnknownKeys = true
            isLenient = true
            explicitNulls = false
            coerceInputValues = true
        }

        /** 响应 DTO —— 三个字段都可能缺失/为 null（服务端未配置时就是全 null） */
        internal data class VersionDto(
            val version: String? = null,
            val apkUrl: String? = null,
            val notes: String? = null,
        )

        /**
         * 解析 `/api/app/version` 的响应体。
         *
         * ⚠️ **为什么手写 JsonElement 解析而不是 `@Serializable` + `decodeFromString`**：
         * `:native` 的 build.gradle **没有应用 `org.jetbrains.kotlin.plugin.serialization`**
         * （只有 `:core:data` 用了），所以这个模块里 `@Serializable` 不会生成 serializer，
         * `VersionDto.serializer()` 直接编译不过（实测报 "Unresolved reference 'serializer'"）。
         * build.gradle 本次不在改动范围内，于是这里只用 **运行时** 的 `Json.parseToJsonElement`。
         * 三个字段、结构固定，代价可以接受；将来要给 `:native` 加序列化插件时再换回 `@Serializable`。
         *
         * 容错：字段必须是 JSON 字符串才算数（是数字/对象一律当缺失），
         * 整体不是 JSON 对象时抛 [kotlinx.serialization.SerializationException]，
         * 由上层映射成 [ApiError.Parse]。
         */
        internal fun parseVersionDto(body: String): VersionDto {
            val root = KJson.parseToJsonElement(body) as? JsonObject
                ?: throw SerializationException("版本接口返回的不是 JSON 对象")
            return VersionDto(
                version = root.stringOrNull("version"),
                apkUrl = root.stringOrNull("apkUrl"),
                notes = root.stringOrNull("notes"),
            )
        }

        private fun JsonObject.stringOrNull(key: String): String? =
            (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

        /**
         * 语义化版本比较 —— 实现见 [VersionCompare]（拆出去是为了能在 JVM 单测里直接断言：
         * 那个 object 不碰任何 Android API，而本类构造器要 Context/AppGraph）。
         */
        fun isNewer(remote: String, local: String): Boolean = VersionCompare.isNewer(remote, local)

        /** @return >0 表示 [remote] 比 [local] 新（即应该提示更新），0 表示相等 */
        fun compareVersions(remote: String, local: String): Int = VersionCompare.compare(remote, local)
    }
}

/**
 * 异常 → [ApiError] 的映射，规则与 `:core:data/ApiError.kt` 的 `mapError` 保持一致
 * （那个函数是 internal，跨模块调用不到，所以在这里按同样的规则重写一份）。
 *
 * 刻意**不依赖具体异常类**：超时在 OkHttp/HttpURLConnection 里都是 IOException 的子类，
 * 靠类名里有没有 "Timeout" 来区分，跨实现版本稳定。
 */
private fun mapThrowable(t: Throwable): ApiError = when (t) {
    is java.io.IOException -> {
        if (t.javaClass.simpleName.contains("Timeout", ignoreCase = true)) {
            ApiError.Timeout()
        } else {
            ApiError.Network()
        }
    }
    is kotlinx.serialization.SerializationException -> ApiError.Parse("服务端返回的数据格式异常", t)
    else -> ApiError.Unknown(t.message ?: "发生未知错误", t)
}

/** 状态码 → [ApiError]，错误信封 `{ error, banned }` 与 `:core:data` 的约定一致 */
private fun mapHttp(code: Int, body: String?): ApiError {
    val envelope = body?.let { runCatching { parseErrorEnvelope(it) }.getOrNull() }
    val serverMessage = envelope?.first?.takeIf { it.isNotBlank() }
    val banned = envelope?.second == true
    return when (code) {
        401 -> ApiError.Unauthorized()
        403 -> ApiError.Forbidden(serverMessage ?: "没有权限执行该操作", banned)
        else -> ApiError.Http(code, serverMessage ?: defaultMessageFor(code))
    }
}

/**
 * 错误信封 `{ error: string, banned?: boolean }` → (message, banned)。
 * 同样不用 `@Serializable`（原因见 [AppUpdater.parseVersionDto] 的注释）。
 * 解不出来就当作没有服务端文案，退回状态码兜底文案。
 */
private fun parseErrorEnvelope(body: String): Pair<String?, Boolean> {
    val root = Json.parseToJsonElement(body) as? JsonObject ?: return null to false
    val message = (root["error"] as? JsonPrimitive)?.takeIf { it.isString }?.content
    // 不直接用 `booleanOrNull`：那个扩展在当前 Kotlin/serialization 组合下解析不到
    // （实测 Unresolved reference），自己判 content 更稳。服务端固定发 JSON boolean。
    val banned = (root["banned"] as? JsonPrimitive)?.content == "true"
    return message to banned
}

private fun defaultMessageFor(code: Int): String = when (code) {
    400 -> "请求参数有误"
    404 -> "内容不存在或已被删除"
    429 -> "操作过于频繁，请稍后再试"
    in 500..599 -> "服务器繁忙，请稍后再试"
    else -> "请求失败（$code）"
}
