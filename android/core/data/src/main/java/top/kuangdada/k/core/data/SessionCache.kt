package top.kuangdada.k.core.data

/**
 * ============================================================
 * 会话内缓存（进程级，LRU + 新鲜期）
 * ============================================================
 * 这里放的是**跨页面存活**的数据：页面离开组合后它的 `remember` 会全部消失，
 * 而"进一次就该有"的内容（公告、章节正文、关注列表、资料……）必须留在仓库这一层，
 * 否则每次进来都要重新请求 + 转一次圈（用户反复反馈的问题）。
 *
 * ## 两条语义
 *  · [get]：拿上次的值（**不管新不新**）—— 页面用它做首帧种子，先画出来；
 *  · [isFresh]：这份值还在新鲜期内吗 —— 页面据此决定"要不要再发一次请求"。
 *
 * 只把 [get] 当种子、再用 [isFresh] 决定是否静默刷新，是这里推荐的标准用法：
 * 用户看到的是立即有内容，网络请求只在数据真的可能变了的时候才发生。
 *
 * ## 为什么是 LRU
 * 缓存键往往带用户 id / 搜索词（组合会无限增长）。`LinkedHashMap(accessOrder = true)`
 * 淘汰最久未使用的，容量上限保证长时间使用不会变成"无限增长的整站副本"。
 *
 * ## 线程
 * 仓库的读写在 UI 线程，写入在 IO 线程（`withContext(Dispatchers.IO)`），
 * 所以每个方法都 `@Synchronized`。`LinkedHashMap` 开了 accessOrder，`get` 本身就会改结构，
 * 不能只加 `@Volatile`。
 */
class SessionCache<K, V>(
    private val maxEntries: Int = DEFAULT_MAX_ENTRIES,
    private val ttlMs: Long = DEFAULT_TTL_MS,
    /**
     * 时钟。默认单调时钟（`nanoTime`）；单测注入可控值，避免 `Thread.sleep` 带来的脆弱用例。
     */
    private val clock: () -> Long = { System.nanoTime() / 1_000_000L },
) {

    private class Entry<V>(val value: V, val at: Long)

    private val entries = object : LinkedHashMap<K, Entry<V>>(16, 0.75f, true) {
        // 与 CommentRepository 的写法一致：Java 侧签名传的是可空的 Entry
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<K, Entry<V>>?): Boolean =
            size > maxEntries
    }

    /** 上次的值（不看新鲜期）；没写过返回 null */
    @Synchronized
    fun get(key: K): V? = entries[key]?.value

    /** 是否还在新鲜期内（没写过 = false） */
    @Synchronized
    fun isFresh(key: K): Boolean {
        val e = entries[key] ?: return false
        return ageMs(e) < ttlMs
    }

    /** 距离上次写入过了多久（ms）；没写过返回 null。给"需要自定义新鲜期"的调用方用 */
    @Synchronized
    fun ageMs(key: K): Long? = entries[key]?.let { ageMs(it) }

    @Synchronized
    fun put(key: K, value: V) {
        entries[key] = Entry(value, clock())
    }

    /** 单条失效（资料被编辑后调，让下一次读取重新拉） */
    @Synchronized
    fun invalidate(key: K) {
        entries.remove(key)
    }

    @Synchronized
    fun clear() {
        entries.clear()
    }

    private fun ageMs(entry: Entry<V>): Long = (clock() - entry.at).coerceAtLeast(0L)

    companion object {
        /** 默认容量：足够覆盖"几个用户 + 几个搜索词"的来回切换 */
        const val DEFAULT_MAX_ENTRIES = 32

        /**
         * 默认新鲜期（1 分钟）。
         *
         * 选 1 分钟而不是"永不过期"：这些数据（资料、列表）在别的端可能被改动，
         * 完全不刷新会让用户看到过期内容；而 1 分钟内反复进出不会产生任何请求。
         */
        const val DEFAULT_TTL_MS = 60_000L

        /**
         * 永不过期：给**内容不可变**的数据用（章节正文按 `章节文件` 索引，
         * 同一个文件的字节不会变）。取 `Long.MAX_VALUE / 2` 而不是最大值，
         * 是为了让 `age < ttl` 的比较不会因加法溢出。
         */
        const val NEVER = Long.MAX_VALUE / 2
    }
}
