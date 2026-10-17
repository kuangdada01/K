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
            // 关注关系变了：关注/粉丝列表的**首屏缓存**必须作废，
            // 否则 2 分钟内再进那个列表，行尾按钮还是"关注/已关注"的旧状态。
            followListCache.clear()
            FollowResult(isFollowing = r.isFollowing, followersCount = r.followersCount)
        }
    }

    /** 关系统结果：关注状态 + 目标用户的最新粉丝数 */
    data class FollowResult(val isFollowing: Boolean, val followersCount: Int)

    // ---------------- 关注 / 粉丝列表（2026-10-03） ----------------

    /** 列表方向：他关注了谁 / 谁关注了他 */
    enum class FollowListKind {
        /** Ta 关注了谁（`GET /api/friends/following/:id`） */
        Following,

        /** 谁关注了 Ta（`GET /api/friends/followers/:id`） */
        Followers,
    }

    /**
     * 列表里的一个人。关系字段来自服务端（按**查看者**算好），
     * UI 直接用来画行尾按钮（关注 / 已关注 / 互相关注 / 回关）——不要在 UI 里重算。
     */
    data class FollowUser(
        val id: Long,
        val username: String,
        /** 头像**相对路径**（可能为 null）；绝对地址由页面经 UserRepository 解析 */
        val avatarPath: String?,
        val bio: String,
        val isFollowing: Boolean,
        val followsViewer: Boolean,
        val isMutual: Boolean,
    )

    /** 一页列表（[FollowListPage.hasMore] 为 false 就是最后一页） */
    data class FollowListPage(
        val users: List<FollowUser>,
        val total: Int,
        val page: Int,
        val hasMore: Boolean,
    )

    /**
     * **首屏缓存**（`目标用户 + 方向 + 搜索词` → 第一页）。
     *
     * 为什么需要：关注/粉丝列表的状态存在页面里（`FollowTabState`），页面离开组合就没了 ——
     * 以前每次进来都是空列表 + 两次请求 + 整页转圈。列表内容在一两分钟内不会变，
     * 放这里之后重进先画缓存，只有超过 [FOLLOW_LIST_TTL_MS] 才静默刷新。
     *
     * 只缓存**第一页**：翻页结果按用户滚动位置才有意义，缓存它反而会造成
     * "第二次进来只有前 60 条"这种半截列表；搜索词为空时才缓存（搜索是即时行为）。
     * 键里带 `viewer` 的 id 是必须的（同 [cache]）：换账号后关系字段全变了，
     * 复用上一个人的列表会让按钮画错。
     */
    private data class FollowListKey(
        val viewerId: Long,
        val targetId: Long,
        val kind: FollowListKind,
        val query: String,
    )

    private val followListCache = SessionCache<FollowListKey, FollowListPage>(
        maxEntries = 16,
        ttlMs = FOLLOW_LIST_TTL_MS,
    )

    /** 缓存的列表内容（不管新不新）。UI 用它做首帧种子；null = 没拉过 */
    fun cachedFollowList(
        targetId: Long,
        kind: FollowListKind,
        query: String? = null,
    ): FollowListPage? = followListCache.get(followListKey(targetId, kind, query))

    /** 这份首屏还在新鲜期内吗 —— 页面据此决定要不要静默刷新 */
    fun isFollowListFresh(
        targetId: Long,
        kind: FollowListKind,
        query: String? = null,
    ): Boolean = followListCache.isFresh(followListKey(targetId, kind, query))

    private fun followListKey(targetId: Long, kind: FollowListKind, query: String?) =
        FollowListKey(
            viewerId = viewerId(),
            targetId = targetId,
            kind = kind,
            query = query?.trim().orEmpty(),
        )

    /**
     * 拉某个用户的关注/粉丝列表的一页（分页形状，**必须带 page** —— 老形状没有关系字段）。
     *
     * 排序在**服务端**：共同关注优先（互关 → 我关注了 Ta → Ta 关注了我 → 用户名升序）。
     * 客户端按返回顺序展示即可，翻页窗口按服务端顺序切 —— 本地重排会让跨页顺序错乱。
     *
     * 成功后把每行的关注状态喂进状态缓存（[putStatus]）：从列表点进某人的主页时，
     * 首帧按钮就是对的，不用再等 `GET /friends/status/:id` 回来。
     */
    suspend fun list(
        targetId: Long,
        kind: FollowListKind,
        page: Int,
        limit: Int = 30,
        query: String? = null,
    ): ApiResult<FollowListPage> {
        if (!session.isLoggedIn) return ApiResult.Failure(ApiError.Unauthorized())
        return call {
            val q = query?.trim()?.takeIf { it.isNotEmpty() }
            val r = when (kind) {
                FollowListKind.Following ->
                    session.api.friends.following(targetId, page, limit, q)
                FollowListKind.Followers ->
                    session.api.friends.followers(targetId, page, limit, q)
            }
            for (u in r.users) putStatus(u.id, u.isFollowing != 0)
            val pageResult = FollowListPage(
                users = r.users.map {
                    FollowUser(
                        id = it.id,
                        username = it.username,
                        avatarPath = it.avatar,
                        bio = it.bio,
                        isFollowing = it.isFollowing != 0,
                        followsViewer = it.followsViewer != 0,
                        isMutual = it.isMutual != 0,
                    )
                },
                total = r.total,
                page = r.page,
                hasMore = r.hasMore,
            )
            // 只缓存第一页（见 followListCache 的注释）；第二页起是"滚动出来的"，不留
            if (page == 1) followListCache.put(followListKey(targetId, kind, q), pageResult)
            pageResult
        }
    }

    private suspend fun <T> call(block: suspend () -> T): ApiResult<T> =
        withContext(Dispatchers.IO) {
            try {
                ApiResult.Success(block())
            } catch (t: Throwable) {
                ApiResult.Failure(mapErrorFromThrowable(t))
            }
        }
}

/**
 * 关注/粉丝列表首屏的新鲜期（2 分钟）。
 *
 * 比帖子列表长：这类列表的变化（谁关注了谁）是低频事件，而且真正的关注动作
 * 会经 `putStatus` 就地改状态；2 分钟内反复进出不必重复打两个接口。
 */
private const val FOLLOW_LIST_TTL_MS = 2 * 60_000L
