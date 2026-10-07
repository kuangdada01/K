package top.kuangdada.k.core.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import top.kuangdada.k.core.data.model.AdminAnnouncementRow
import top.kuangdada.k.core.data.model.AdminPostRow
import top.kuangdada.k.core.data.model.AdminUserRow
import top.kuangdada.k.core.data.model.AnnouncementDto
import top.kuangdada.k.core.data.model.BanRequest
import top.kuangdada.k.core.data.model.CreateAnnouncementRequest
import top.kuangdada.k.core.data.model.ResetPasswordRequest2

/**
 * ============================================================
 * 管理后台仓库（server/src/routes/admin/）
 * ============================================================
 * 三个可服务端搜索 + 分页的列表（用户 / 帖子 / 公告），
 * **一律带 `page` 参数**（见 AdminApi 的注释：不带 page 会走老形状）。
 *
 * 服务端的权限与业务校验（都不能在客户端假装）：
 *  · 不能删除/重置/封禁管理员账号（`不能删除管理员账号` 等 400）
 *  · 不能删除自己的账号
 *  · 封禁天数只允许 1 / 7 / 30 / 365
 */
class AdminRepository(private val session: SessionRepository) {

    private val baseUrl: String get() = session.api.baseUrl

    data class Paged<T>(val items: List<T>, val page: Int, val totalPages: Int, val total: Int) {
        val hasMore: Boolean get() = page < totalPages
    }

    // ---- 用户 ----

    suspend fun users(page: Int = 1, query: String? = null): ApiResult<Paged<AdminUserRow>> = call {
        val r = session.api.admin.users(page = page, query = query?.takeIf { it.isNotBlank() })
        Paged(r.users, r.page, if (r.totalPages <= 0) 1 else r.totalPages, r.total)
    }

    suspend fun deleteUser(userId: Long): ApiResult<Unit> =
        call { session.api.admin.deleteUser(userId) }

    suspend fun resetPassword(userId: Long, password: String): ApiResult<Unit> =
        call { session.api.admin.resetPassword(userId, ResetPasswordRequest2(password)) }

    suspend fun ban(userId: Long, days: Int): ApiResult<String?> = call {
        session.api.admin.ban(userId, BanRequest(days)).bannedUntil
    }

    suspend fun unban(userId: Long): ApiResult<Unit> =
        call { session.api.admin.unban(userId) }

    /**
     * 轻量用户搜索（`GET /api/admin/users/search`，最多 10 条）。
     *
     * 给「新建公告 → 指定用户」用：那里要的是"按昵称/用户名找到那个账号并拿到 id"，
     * 而不是管理列表那种分页结果。按 id 精确查也走这个端点（服务端支持传数字 id）。
     */
    suspend fun searchUsers(query: String): ApiResult<List<AdminUserRow>> =
        call { session.api.admin.searchUsers(query).users }

    // ---- 帖子 ----

    suspend fun posts(page: Int = 1, query: String? = null): ApiResult<Paged<AdminPostRow>> = call {
        val r = session.api.admin.posts(page = page, query = query?.takeIf { it.isNotBlank() })
        Paged(r.posts, r.page, if (r.totalPages <= 0) 1 else r.totalPages, r.total)
    }

    suspend fun deletePost(postId: Long): ApiResult<Unit> =
        call { session.api.admin.deletePost(postId) }

    // ---- 公告（管理） ----

    suspend fun announcements(page: Int = 1, query: String? = null): ApiResult<Paged<AdminAnnouncementRow>> = call {
        val r = session.api.admin.announcements(page = page, query = query?.takeIf { it.isNotBlank() })
        Paged(r.announcements, r.page, if (r.totalPages <= 0) 1 else r.totalPages, r.total)
    }

    suspend fun createAnnouncement(title: String, content: String, targetUserId: Long?): ApiResult<AdminAnnouncementRow> =
        call {
            session.api.admin.createAnnouncement(
                CreateAnnouncementRequest(title = title, content = content, targetUserId = targetUserId)
            )
        }

    suspend fun deleteAnnouncement(id: Long): ApiResult<Unit> =
        call { session.api.admin.deleteAnnouncement(id) }

    // ---- 公告（用户侧） ----

    suspend fun myAnnouncements(): ApiResult<List<AnnouncementDto>> =
        call { session.api.announcements.list().announcements }

    suspend fun markAnnouncementRead(id: Long): ApiResult<Unit> =
        call { session.api.announcements.markRead(id) }

    /**
     * 帖子配图的绝对地址（服务端 `withImages` 给的是相对路径 + `images` 数组）。
     *
     * 注意**不能**拿 `AdminPostRow.imageUrl` 去渲染：那一列存的是**整个 JSON 数组字符串**
     * （形如 `["/uploads/a.jpg","/uploads/b.jpg"]`），直接塞给图片组件只会加载失败。
     * 用 [AdminPostRow.coverPath]（服务端补出来的 `images` 首项）才是对的。
     */
    fun resolve(path: String?): String? = resolveUrl(path, baseUrl)

    /** 头像绝对地址（用户列表/公告列表里的 `avatar` 是相对路径） */
    fun avatarUrl(path: String?): String? = resolveUrl(path, baseUrl)

    private suspend fun <T> call(block: suspend () -> T): ApiResult<T> =
        withContext(Dispatchers.IO) {
            try {
                ApiResult.Success(block())
            } catch (t: Throwable) {
                ApiResult.Failure(mapErrorFromThrowable(t))
            }
        }
}
