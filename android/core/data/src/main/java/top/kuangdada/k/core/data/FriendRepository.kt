package top.kuangdada.k.core.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * ============================================================
 * 关注仓库（FriendRepository）
 * ============================================================
 * 只覆盖他人主页真正用到的那三件事：查关注状态、关注、取消关注
 * （`server/src/routes/friends.ts` 还有搜索/推荐/粉丝列表等端点，本轮不接）。
 *
 * **为什么需要一个仓库、而不是页面里直接调 `session.api.friends`**：
 * 关注状态是**跨页面共享**的 —— 同一个人可能从首页卡片、帖子详情、搜索页三个入口
 * 进到主页，每次都要先知道"关注了没有"才能把按钮画对（关注 / 已关注）。
 * 没有缓存的话每进一次就发一次 `GET /friends/status/:id`，用户看到的是按钮
 * 先画成「关注」、随后跳成「已关注」（一帧的闪烁，且每次进都在闪）。
 * 仓库是进程级单例，缓存留在它这里，页面离开组合也不丢。
 *
 * **为什么不做成 StateFlow**：关注状态是"某个用户对某个用户"的二维关系，
 * 做成单个全局流会让所有主页互相触发重组；页面只需要在进入时读一次、
 * 自己操作后改自己那份 state（见 [UserProfileScreen]）。
 * 与 [BookRepository] 同一套：仓库存缓存，UI 持有可见状态。
 *
 * ⚠️ **缓存必须带"是谁的视角"**：A 关注了 B，退出登录换成 C 之后，
 * 缓存里那条 `B -> true` 是 A 的视角，直接复用会让 C 看到「已关注」。
 * 所以缓存键是 `(观察者 id, 目标 id)`，观察者取自会话里当前登录用户。
 */
class FriendRepository(private val session: SessionRepository) {

    /**
     * 关注状态缓存：`(观察者 id, 目标 id) -> 是否关注`。
     *
     * 只在**登录状态下**写入（未登录时服务端 401，本来也拿不到状态）。
     */
    @Volatile
    private var cache: Map<Pair<Long, Long>, Boolean> = emptyMap()

    /** 当前登录用户 id（未登录为 0）—— 缓存键里的"观察者" */
    private fun viewerId(): Long = session.tokens.userId

    /**
     * 上次已知的关注状态（**不发请求**）。
     *
     * @return null = 没查过 / 不是这个观察者的缓存 → 调用方需要发一次 [status]
     */
    fun cachedStatus(targetId: Long): Boolean? {
        val viewer = viewerId()
        if (viewer <= 0L) return null
        return cache[viewer to targetId]
    }

    /** 把状态写进缓存（关注/取关成功后调用，让别处进来时首帧就是对的） */
    fun putStatus(targetId: Long, isFollowing: Boolean) {
        val viewer = viewerId()
        if (viewer <= 0L) return
        cache = cache + ((viewer to targetId) to isFollowing)
    }

    /**
     * 查关注状态（`GET /api/friends/status/:id`，需登录）。
     *
     * 成功即回填缓存；失败**不动**缓存（页面拿到的是 ApiResult，可以自己决定是
     * 保持旧值还是报错）。未登录时不发请求，直接返回失败 —— 少一次必然 401 的往返。
     */
    suspend fun status(targetId: Long): ApiResult<Boolean> {
        if (!session.isLoggedIn) return ApiResult.Failure(ApiError.Unauthorized())
        return call {
            val r = session.api.friends.status(targetId)
            putStatus(targetId, r.isFollowing)
            r.isFollowing
        }
    }

    /**
     * 关注 / 取消关注。
     *
     * 返回服务端给的**最新关注状态与粉丝数** —— 粉丝数要回填到页面上那个统计数字，
     * 不然"点了关注，粉丝数还是旧的"（两个数字来自不同接口，服务端不会帮你同步）。
     *
     * 不做乐观翻转：关注是**一次性、低频**的动作（不像点赞），
     * 先翻转再回滚反而会在弱网下出现"点了一下先是已关注、一秒钟后又变回来"的闪烁。
     */
    suspend fun setFollowing(targetId: Long, following: Boolean): ApiResult<FollowResult> {
        if (!session.isLoggedIn) return ApiResult.Failure(ApiError.Unauthorized())
        return call {
            val r = if (following) {
                session.api.friends.follow(targetId)
            } else {
                session.api.friends.unfollow(targetId)
            }
            // **以响应里的 is_following 为准**，不拿"请求成功"当结果：
            // POST 走 INSERT OR IGNORE（重复关注也是 200）、DELETE 对没关注过的也返回 200。
            putStatus(targetId, r.isFollowing)
            FollowResult(isFollowing = r.isFollowing, followersCount = r.followersCount)
        }
    }

    /** 关系统结果：关注状态 + 目标用户的最新粉丝数 */
    data class FollowResult(val isFollowing: Boolean, val followersCount: Int)

    private suspend fun <T> call(block: suspend () -> T): ApiResult<T> =
        withContext(Dispatchers.IO) {
            try {
                ApiResult.Success(block())
            } catch (t: Throwable) {
                ApiResult.Failure(mapErrorFromThrowable(t))
            }
        }
}
