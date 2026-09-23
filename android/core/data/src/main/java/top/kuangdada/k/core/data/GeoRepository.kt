package top.kuangdada.k.core.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * ============================================================
 * 地理仓库（地图选点用：坐标 → 地点名）
 * ============================================================
 * 为什么用 BigDataCloud 而不是 Nominatim / 高德 / 腾讯：
 *  · Nominatim（nominatim.openstreetmap.org）与官方 OSM 瓦片在**国内直连超时**（实测），
 *    而 BigDataCloud 的 reverse-geocode-client 免 key、国内可直连、且支持 `localityLanguage=zh`
 *    返回中文地名（实测「广东省 / 深圳市 / 南山区 / 粤海街道」）；
 *  · 高德/腾讯/百度的逆地理都要申请 key 并绑定包名+签名，本项目当前没有这类账号体系依赖，
 *    先不上——要换成它们只需要替换本文件里的一个 URL 与解析。
 *
 * ⚠️ 这个 client **刻意不复用 KApi 的 OkHttpClient**：那是给自家服务端用的，带认证拦截器
 * 与统一 UA；把第三方域名塞进去会把 JWT/业务头一起发出去。这里单独一个干净 client。
 */
class GeoRepository {

    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS)
        .build()

    /**
     * 逆地理编码：坐标 → 「区·地点」这种可读地名。
     *
     * 返回空串表示"这个点没有可用地名"（例如海面上），调用方按"未标注位置"处理，
     * **不算失败** —— 免得用户在海上只能看到一句报错。
     */
    suspend fun reverse(lat: Double, lon: Double): ApiResult<String> = withContext(Dispatchers.IO) {
        try {
            val url = "https://api.bigdatacloud.net/data/reverse-geocode-client" +
                "?latitude=$lat&longitude=$lon&localityLanguage=zh"
            val request = Request.Builder()
                .url(url)
                .header("User-Agent", USER_AGENT)
                .header("Accept", "application/json")
                .build()
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    return@withContext ApiResult.Failure(
                        ApiError.Http(response.code, "地名解析失败（${response.code}）")
                    )
                }
                // OkHttp 5 起 response.body 是非空的（类型就是 ResponseBody），`?.` 是多余的
                val body = response.body.string().orEmpty()
                if (body.isBlank()) {
                    return@withContext ApiResult.Failure(ApiError.Parse("地名解析失败：响应为空"))
                }
                val payload = runCatching { json.decodeFromString<ReverseGeocode>(body) }.getOrNull()
                    ?: return@withContext ApiResult.Failure(ApiError.Parse("地名解析失败：返回格式异常"))
                ApiResult.Success(payload.toDisplayName())
            }
        } catch (t: Throwable) {
            ApiResult.Failure(mapErrorFromThrowable(t))
        }
    }

    private companion object {
        /**
         * 第三方接口要求带可识别的 UA（也便于对方在限流时联系我们）。
         * UA 里**不放**用户名/设备号这类可关联到个人的信息。
         */
        const val USER_AGENT = "KApp/0.1 (Android; +https://www.kuangdada.top)"

        val json = Json { ignoreUnknownKeys = true }
    }
}

@Serializable
private data class ReverseGeocode(
    val city: String = "",
    val locality: String = "",
    val principalSubdivision: String = "",
    val countryName: String = "",
    val localityInfo: LocalityInfo? = null,
) {
    /**
     * 展示名拼装（尽量短、尽量具体）：
     *  · 有"街道以上但比区更具体"的条目（informative order ≥ 10，如「深圳市高新技术产业园区」）
     *    → `南山区·深圳市高新技术产业园区`；
     *  · 否则 → `深圳市·南山区`；
     *  · 都没有（海上/无数据）→ 空串。
     */
    fun toDisplayName(): String {
        val poi = localityInfo?.informative
            ?.filter { it.order >= 10 }
            ?.maxByOrNull { it.order }
            ?.name
            ?.takeIf { it.isNotBlank() }
        val district = locality.ifBlank { city }
        return when {
            poi != null && district.isNotBlank() -> "$district·$poi"
            poi != null -> poi
            city.isNotBlank() && locality.isNotBlank() && city != locality -> "$city·$locality"
            locality.isNotBlank() -> locality
            city.isNotBlank() -> city
            principalSubdivision.isNotBlank() -> principalSubdivision
            else -> countryName
        }
    }
}

@Serializable
private data class LocalityInfo(
    val informative: List<LocalityEntry> = emptyList(),
)

@Serializable
private data class LocalityEntry(
    /** 行政层级：越大越具体（10 以上通常是园区/街区这类"点"） */
    val order: Int = 0,
    val name: String = "",
)
