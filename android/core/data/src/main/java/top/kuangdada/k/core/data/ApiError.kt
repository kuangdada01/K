package top.kuangdada.k.core.data

import java.io.IOException
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * ============================================================
 * 错误模型（ApiError）
 * ============================================================
 * 服务端的错误信封是 `{ error: string }`，另外封禁时多一个 `banned: true`
 * （见 server/src/middleware/auth.ts）。这些语义必须在客户端**逐条还原**，
 * 否则用户看到的就是一句无信息量的"操作失败"。
 */
sealed interface ApiError {
    /** 服务端给的文案（能直接展示给用户） */
    val message: String

    /** 连不上/超时/DNS 失败 —— 不是服务端的错，文案要区分开 */
    data class Network(override val message: String = "网络连接失败，请检查网络后重试") : ApiError

    /** 请求超时 */
    data class Timeout(override val message: String = "请求超时，请重试") : ApiError

    /** 有响应但状态码 != 2xx */
    data class Http(
        val status: Int,
        override val message: String,
        val banned: Boolean = false,
    ) : ApiError

    /** 401：令牌缺失/过期/已失效（改密会使旧 token 立即失效） */
    data class Unauthorized(override val message: String = "登录已失效，请重新登录") : ApiError

    /** 403：权限不足或封禁期间写操作 */
    data class Forbidden(override val message: String, val banned: Boolean = false) : ApiError

    /** 响应能拿到但解析失败 —— 通常意味着 DTO 与服务端契约漂移，需要立即发现 */
    data class Parse(override val message: String, val cause: Throwable? = null) : ApiError

    data class Unknown(override val message: String, val cause: Throwable? = null) : ApiError
}

/**
 * 统一的错误文案入口：所有分支都是 [ApiError]，直接取 `message` 即可。
 * 这里再做一层容错，避免个别分支漏写 message 时 UI 显示空白。
 */
val ApiError.displayMessage: String
    get() = message.ifBlank { "操作失败，请重试" }

/**
 * 是不是"内容不存在"（HTTP 404）。
 *
 * 单独抽出来是因为**调用方要对它做完全不同的处理**：404 表示这条内容已经没了
 * （被删了 / 从没存在过），继续停在这一页没有意义；而超时、500 只是这一次没拿到，
 * 留在页面上让用户重试才是对的。混在一个 `error != null` 里就分不出来了。
 */
val ApiError.isNotFound: Boolean
    get() = this is ApiError.Http && status == 404

/**
 * 从任意异常提取 [ApiError]。
 *
 * 仓库层统一用它，避免每个仓库各写一遍分类逻辑。
 * `:core:data` 本来就依赖 Retrofit，所以直接判 `HttpException`（比反射干净得多）；
 * OkHttp 直连或 WebSocket 握手失败这类没有状态码的异常，落到 [mapError] 的 IOException 分支。
 */
internal fun mapErrorFromThrowable(t: Throwable): ApiError {
    if (t is retrofit2.HttpException) {
        val body = runCatching { t.response()?.errorBody()?.string() }.getOrNull()
        return mapError(t, t.code(), body)
    }
    return mapError(t)
}

/** 服务端错误信封 */
@Serializable
internal data class ErrorEnvelope(
    val error: String? = null,
    val banned: Boolean = false,
)

/** 解析用的 Json 实例：服务端字段是 snake_case，未知字段一律忽略（服务端只增不改） */
internal val KJson: Json = Json {
    ignoreUnknownKeys = true
    isLenient = true
    explicitNulls = false
    coerceInputValues = true
}

/**
 * 把异常/状态码翻译成 [ApiError]。
 *
 * 注意这里**不依赖具体异常类**（OkHttp 4/5 之间异常类型有迁移）：
 * 统一按「有没有 HTTP 状态码」和「是不是 IOException」分类，跨版本稳定。
 */
internal fun mapError(t: Throwable, responseCode: Int? = null, responseBody: String? = null): ApiError {
    if (responseCode != null) {
        val envelope = responseBody?.let {
            runCatching { KJson.decodeFromString(ErrorEnvelope.serializer(), it) }.getOrNull()
        }
        val serverMessage = envelope?.error?.takeIf { it.isNotBlank() }
        val banned = envelope?.banned == true
        return when (responseCode) {
            401 -> ApiError.Unauthorized()
            403 -> ApiError.Forbidden(serverMessage ?: "没有权限执行该操作", banned)
            else -> ApiError.Http(
                status = responseCode,
                message = serverMessage ?: defaultMessageFor(responseCode),
                banned = banned,
            )
        }
    }
    return when (t) {
        is IOException -> {
            // 超时在 OkHttp 里也是 IOException 的子类，文案要分开
            if (t.javaClass.simpleName.contains("Timeout", ignoreCase = true)) {
                ApiError.Timeout()
            } else {
                ApiError.Network()
            }
        }
        is kotlinx.serialization.SerializationException -> ApiError.Parse("服务端返回的数据格式异常", t)
        else -> ApiError.Unknown(t.message ?: "发生未知错误", t)
    }
}

private fun defaultMessageFor(code: Int): String = when (code) {
    400 -> "请求参数有误"
    404 -> "内容不存在或已被删除"
    429 -> "操作过于频繁，请稍后再试"
    in 500..599 -> "服务器繁忙，请稍后再试"
    else -> "请求失败（$code）"
}

/** 统一的调用结果 —— 仓库层只返回它，UI 层不必 try/catch */
sealed interface ApiResult<out T> {
    data class Success<T>(val data: T) : ApiResult<T>
    data class Failure(val error: ApiError) : ApiResult<Nothing>
}

/** 成功时取数据，失败时给兜底值（用于「次要信息失败不该让整页崩」的场景） */
fun <T> ApiResult<T>.getOrNull(): T? = (this as? ApiResult.Success)?.data

inline fun <T, R> ApiResult<T>.map(transform: (T) -> R): ApiResult<R> = when (this) {
    is ApiResult.Success -> ApiResult.Success(transform(data))
    is ApiResult.Failure -> this
}

/** 服务端 `message` 响应（验证码类接口）的便捷判定 */
@Serializable
data class ServerMessage(@SerialName("message") val message: String = "")
