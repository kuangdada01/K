package top.kuangdada.k.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ============================================================
 * `SessionCache` 的契约测试
 * ============================================================
 * 这个容器现在是「页面离开组合后数据还在」的唯一依靠（公告、章节、关注列表、资料、详情……），
 * 它的两条语义一旦写错，表现全是**用户能看见但代码不报错**的问题：
 *
 *  · `get` 在过期后返回 null → 每次进页面还是空白（缓存形同虚设）；
 *  · `isFresh` 恒为 true → 数据永远不刷新（别人改了资料我这边一直旧）；
 *  · 容量淘汰写成 FIFO → 刚看过的那一份被踢掉，又去重新拉。
 *
 * 时钟由构造参数注入，所以这里的过期用例**不睡线程**（不会偶发失败）。
 */
class SessionCacheTest {

    /** 可控时钟：测试里用 `now = ...` 手动推进时间 */
    private class FakeClock {
        var now: Long = 0L
        val source: () -> Long = { now }
    }

    @Test
    fun `没写过时读不到也不新鲜`() {
        val cache = SessionCache<String, Int>()
        assertNull(cache.get("missing"))
        assertFalse(cache.isFresh("missing"))
        assertNull(cache.ageMs("missing"))
    }

    @Test
    fun `写入后能读到且新鲜期内为真`() {
        val clock = FakeClock()
        val cache = SessionCache<String, Int>(ttlMs = 100, clock = clock.source)

        cache.put("a", 1)

        assertEquals(1, cache.get("a"))
        assertTrue(cache.isFresh("a"))
        assertEquals(0L, cache.ageMs("a"))

        clock.now = 99
        assertTrue(cache.isFresh("a"))
    }

    @Test
    fun `过期后仍能当种子但不新鲜`() {
        val clock = FakeClock()
        val cache = SessionCache<String, Int>(ttlMs = 100, clock = clock.source)
        cache.put("a", 1)

        clock.now = 100

        // ★ 两条必须同时成立：页面还要能先用旧值把首帧画出来（get），
        //   只是不再认为它是"刚拉过的"（isFresh）。
        assertEquals(1, cache.get("a"))
        assertFalse(cache.isFresh("a"))
        assertEquals(100L, cache.ageMs("a"))
    }

    @Test
    fun `超过容量淘汰最久未使用的一份`() {
        val cache = SessionCache<String, Int>(maxEntries = 2, ttlMs = SessionCache.NEVER)

        cache.put("a", 1)
        cache.put("b", 2)
        // 访问 a：它变成"最近用过"，要被淘汰的是 b（不是 a）
        assertEquals(1, cache.get("a"))
        cache.put("c", 3)

        assertEquals(1, cache.get("a"))
        assertNull(cache.get("b"))
        assertEquals(3, cache.get("c"))
    }

    @Test
    fun `单条失效只影响那一条`() {
        val cache = SessionCache<String, Int>(ttlMs = SessionCache.NEVER)
        cache.put("a", 1)
        cache.put("b", 2)

        cache.invalidate("a")

        assertNull(cache.get("a"))
        assertFalse(cache.isFresh("a"))
        assertEquals(2, cache.get("b"))
        assertTrue(cache.isFresh("b"))
    }

    @Test
    fun `clear 清空全部`() {
        val cache = SessionCache<String, Int>(ttlMs = SessionCache.NEVER)
        cache.put("a", 1)
        cache.put("b", 2)

        cache.clear()

        assertNull(cache.get("a"))
        assertNull(cache.get("b"))
    }

    @Test
    fun `永不过期的数据在很久以后依然新鲜`() {
        val clock = FakeClock()
        val cache = SessionCache<String, Int>(ttlMs = SessionCache.NEVER, clock = clock.source)
        cache.put("chapter", 1)

        clock.now = 365L * 24 * 60 * 60 * 1000 // 一年

        assertTrue(cache.isFresh("chapter"))
        assertEquals(1, cache.get("chapter"))
    }
}
