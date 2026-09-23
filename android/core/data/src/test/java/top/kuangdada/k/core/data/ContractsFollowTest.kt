package top.kuangdada.k.core.data

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import top.kuangdada.k.core.data.api.FollowResultDto
import top.kuangdada.k.core.data.api.FollowStatusDto
import top.kuangdada.k.core.data.model.PostListWithMore
import top.kuangdada.k.core.data.model.UserProfile
import top.kuangdada.k.core.data.model.UserPostsResponse

/**
 * ============================================================
 * 「他人主页」的请求/响应契约测试
 * ============================================================
 * 这一页（首页卡片 → 帖子详情 → 点作者头像 → 他人主页）用到三个服务端接口，
 * 每一个都有"字段名写错就静默失效"的地方，全部在这里钉住：
 *
 *  1. `GET /api/friends/status/:id` → **`{ is_following }`**（蛇形，且**没有**粉丝数）。
 *     写成 `isFollowing` 的话 kotlinx.serialization 会走默认值 `false` ——
 *     表现出来是"关注过的人一进主页又变回未关注"，不报任何错。
 *  2. `POST` / `DELETE /api/friends/:id` → `{ is_following, followers_count }`。
 *     粉丝数必须回填到页面上那个数字，否则"点了关注，粉丝数还是旧的"。
 *     **只能认 `is_following`**：`POST` 走 `INSERT OR IGNORE`（重复关注也 200）、
 *     `DELETE` 对没关注过的也 200。
 *  3. `GET /api/users/:id` / `GET /api/users/:id/posts` → 他人主页的资料与作品网格
 *     （统计字段只在资料接口里，帖子接口的形状与信息流一致）。
 */
class ContractsFollowTest {

    /** 与 [KJson] 同一套配置 */
    private val json = Json { ignoreUnknownKeys = true; isLenient = true; explicitNulls = false }

    // ---------------- 关注状态 ----------------

    @Test
    fun `关注状态端点的字段是蛇形 is_following`() {
        val body = """{"is_following":true}"""
        val dto = json.decodeFromString(FollowStatusDto.serializer(), body)

        assertTrue("服务端返回的是 is_following（蛇形），写成驼峰会静默变成 false", dto.isFollowing)
    }

    @Test
    fun `关注状态为 false 与服务端省略字段都要能解析`() {
        assertEquals(
            false,
            json.decodeFromString(FollowStatusDto.serializer(), """{"is_following":false}""").isFollowing,
        )
        // 形状异常（少了字段）按"未关注"兜底：宁可让用户再点一次关注（幂等），
        // 也不能因为解析失败把整页打成错误页
        assertFalse(json.decodeFromString(FollowStatusDto.serializer(), "{}").isFollowing)
    }

    // ---------------- 关注 / 取关 ----------------

    @Test
    fun `关注成功返回最新状态与粉丝数`() {
        val body = """{"is_following":true,"followers_count":257}"""
        val dto = json.decodeFromString(FollowResultDto.serializer(), body)

        assertTrue(dto.isFollowing)
        // 粉丝数由服务端在关注/取关后现算 —— 页面必须回填这个值
        assertEquals(257, dto.followersCount)
    }

    @Test
    fun `取关成功返回 false 与减少后的粉丝数`() {
        val body = """{"is_following":false,"followers_count":256}"""
        val dto = json.decodeFromString(FollowResultDto.serializer(), body)

        assertFalse(dto.isFollowing)
        assertEquals(256, dto.followersCount)
    }

    @Test
    fun `重复关注也是 200 且返回已关注（不能拿请求成功当结果）`() {
        // POST 走 INSERT OR IGNORE：重复关注不会报错，`is_following` 仍是 true。
        // 客户端若按"请求成功就翻转本地状态"处理，连点两下会变成"取关"的观感
        val body = """{"is_following":true,"followers_count":257}"""
        val dto = json.decodeFromString(FollowResultDto.serializer(), body)
        assertTrue("以响应里的 is_following 为准，而不是自己猜", dto.isFollowing)
    }

    // ---------------- 他人主页的资料与帖子 ----------------

    @Test
    fun `他人资料页的统计字段只在 users 接口里`() {
        val body = """
            {"id":9,"username":"Kuangdada","avatar":"/uploads/avatars/a.jpg",
             "bio":"在做一款自己的社交 App","role":"user","created_at":"2026-01-01T00:00:00.000Z",
             "post_count":86,"followers_count":256,"following_count":48}
        """.trimIndent()
        val p = json.decodeFromString(UserProfile.serializer(), body)

        assertEquals(9L, p.id)
        assertEquals("Kuangdada", p.username)
        // 设计稿上的三个数字（帖子 / 粉丝 / 关注）就来自这三个字段
        assertEquals(86, p.postCount)
        assertEquals(256, p.followersCount)
        assertEquals(48, p.followingCount)
    }

    @Test
    fun `他人作品列表与信息流同形状（含分页字段）`() {
        val body = """
            {"posts":[{"id":11,"user_id":9,"title":"作品","description":"",
              "created_at":"2026-01-01T00:00:00.000Z","username":"Kuangdada","avatar":null,
              "like_count":1,"comment_count":2,"share_count":0,"repost_count":0,
              "images":["/uploads/posts/1.jpg"]}],
             "total":1,"page":1,"totalPages":1}
        """.trimIndent()
        val r = json.decodeFromString(UserPostsResponse.serializer(), body)

        assertEquals(1, r.posts.size)
        assertEquals(9L, r.posts[0].userId)
        assertEquals(1, r.totalPages)
        // 作品网格靠 images 出封面 —— 少了它整片网格会退化成"标题首字"占位
        assertEquals(listOf("/uploads/posts/1.jpg"), r.posts[0].images)
    }

    @Test
    fun `他人的转发列表是 has_more 形状（没有分页字段）`() {
        // `GET /api/users/:id/reposts` 的形状与 `GET /api/users/:id/posts` **不同**：
        // 服务端那份列表只做硬上限截断，所以给的是 `has_more` 而不是 total/totalPages。
        // 用错 DTO 的话 `posts` 能解析出来、`has_more` 永远是默认值 —— 静默失效。
        val body = """
            {"posts":[{"id":21,"user_id":3,"description":"转发的","created_at":"2026-01-01T00:00:00.000Z",
              "username":"原作者","avatar":null,"like_count":5,"comment_count":1,"share_count":0,
              "repost_count":2,"liked":1,"reposted":0,"images":[]}],
             "has_more":true}
        """.trimIndent()
        val r = json.decodeFromString(PostListWithMore.serializer(), body)

        assertEquals(1, r.posts.size)
        assertTrue("has_more 必须解析出来（列表可能被上限截断）", r.hasMore)
        // 登录状态列按**观察者**算：liked 是我点过没有，reposted 是我转过没有 ——
        // 转发列表里 reposted 为 0 是正常的（转过的是**被看的那个用户**）
        assertEquals(1, r.posts[0].liked)
        assertEquals(0, r.posts[0].reposted)
    }
}
