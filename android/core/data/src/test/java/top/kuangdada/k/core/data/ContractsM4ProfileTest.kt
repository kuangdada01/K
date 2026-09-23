package top.kuangdada.k.core.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import top.kuangdada.k.core.data.model.UpdateProfileRequest
import top.kuangdada.k.core.data.model.User

/**
 * ============================================================
 * 「编辑资料」的请求/响应契约测试
 * ============================================================
 * 这一页有两个**写错就静默出事**的地方，都在这里钉住：
 *
 *  1. `PUT /api/users/me` 的请求体：界面上写的「昵称」必须落到服务端字段 **`username`**
 *     （服务端只有这一列，见 shared/src/schemas/user.ts）。写成 `nickname`/`name` 的话，
 *     zod 的 `updateProfileSchema` 会把整个 body 解析成 `{}` —— 服务端照常返回 200，
 *     但**什么都没改**，用户看到的是"保存成功但没生效"。
 *  2. 两个字段都是 optional，代表"未提供 = 保持原值"。所以序列化时**必须真的省略 null**
 *     （`explicitNulls = false`），否则会送 `{"username":null,"bio":null}`
 *     —— zod 的 `.optional()` **不接受 null**，那是 400，比不改还糟。
 *
 * 响应侧对着 `user.repo.ts` 的 `updateProfile` SELECT 列表：id / username / email /
 * avatar / bio / role / created_at（**没有**统计字段，统计只在 GET /users/:id）。
 */
class ContractsM4ProfileTest {

    /** 与 [KJson] 同一套配置（`explicitNulls = false` 是这里的关键） */
    private val json = Json { ignoreUnknownKeys = true; isLenient = true; explicitNulls = false }

    @Test
    fun `只改简介时不发送 username 字段`() {
        val body = json.encodeToString(
            UpdateProfileRequest.serializer(),
            UpdateProfileRequest(username = null, bio = "新简介"),
        )
        val obj = json.parseToJsonElement(body).jsonObject

        assertFalse("username 为 null 时必须整个字段省略，而不是送 null", obj.containsKey("username"))
        assertEquals("新简介", obj["bio"]?.toString()?.trim('"'))
    }

    @Test
    fun `改昵称时字段名是 username 而不是 nickname`() {
        val body = json.encodeToString(
            UpdateProfileRequest.serializer(),
            UpdateProfileRequest(username = "旷达", bio = "简介"),
        )
        val obj = json.parseToJsonElement(body).jsonObject

        assertEquals("旷达", obj["username"]?.toString()?.trim('"'))
        assertFalse("服务端没有 nickname 字段，多送它只会被 zod 静默丢掉", obj.containsKey("nickname"))
        assertFalse(obj.containsKey("name"))
    }

    @Test
    fun `两个都为空时请求体里没有 null`() {
        val body = json.encodeToString(UpdateProfileRequest.serializer(), UpdateProfileRequest())
        assertFalse("zod 的 optional 不接受 null", body.contains("null"))
    }

    @Test
    fun `更新接口的响应能解析成 User 且不含统计字段`() {
        val body = """
            {"id":7,"username":"旷达","email":"k@example.com","avatar":"/uploads/avatars/avatar-1.jpg",
             "bio":"在做一款自己的社交 App","role":"user","created_at":"2026-09-13T07:19:34.025Z"}
        """.trimIndent()
        val user = json.decodeFromString(User.serializer(), body)

        assertEquals(7L, user.id)
        assertEquals("旷达", user.username)
        // 邮箱只在这个接口与 /auth/me 上返回 —— 编辑页的只读邮箱框靠它
        assertEquals("k@example.com", user.email)
        assertEquals("/uploads/avatars/avatar-1.jpg", user.avatar)
        assertEquals("在做一款自己的社交 App", user.bio)
        assertFalse(user.isAdmin)
        // 统计字段是 GET /users/:id 才有的，这里必须保持 null
        // （拿这个响应去覆盖 UserProfile 会把帖子数/粉丝数清零）
        assertNull(user.postCount)
        assertNull(user.followersCount)
        assertNull(user.followingCount)
    }

    @Test
    fun `公开资料响应不含邮箱`() {
        val body = """
            {"id":7,"username":"旷达","avatar":null,"bio":"","role":null,
             "created_at":"2026-01-01T00:00:00.000Z","post_count":3,"followers_count":1,"following_count":2}
        """.trimIndent()
        val profile = json.decodeFromString(top.kuangdada.k.core.data.model.UserProfile.serializer(), body)

        assertEquals(3, profile.postCount)
        assertEquals(1, profile.followersCount)
        assertNull(profile.avatar)
        // UserProfile 里根本没有 email 字段 —— 编辑页的邮箱只能来自会话里的 User
        assertTrue(profile.bio.isEmpty())
    }
}
