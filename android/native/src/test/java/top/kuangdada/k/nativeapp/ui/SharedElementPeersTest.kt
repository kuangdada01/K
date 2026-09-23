package top.kuangdada.k.nativeapp.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 共享元素「对面那一端在不在」的计数表（M5.8）。
 *
 * 它只有一个用途，但那个用途很关键：**目标端要据此决定"敢不敢在飞行接上前先把自己藏起来"**
 * （见 [shouldPreHideSharedElement]）。
 *  · 藏早了/藏错了（对面根本没有那一端，比如从搜索页返回首页）→ 封面会白白消失两百毫秒；
 *  · 不藏（对面明明在，比如视频详情返回信息流）→ 卡片那个视频位会先自己画一份在那儿
 *    "等"飞行过来（用户实测反馈："有播放器还是封面在等动画飞过去"）。
 *
 * 所以这里把三条约定钉死：一处声明不算对手、两处才算；撤销与声明成对；撤销不会把计数搞成负数。
 * `key` 用的是帖子视频封面那一族的真实 key（两端必须**同一个函数**生成，见 [postVideoKey]）。
 */
class SharedElementPeersTest {

    private val key = postVideoKey(42L)

    @Test
    fun single_declaration_has_no_counterpart() {
        val peers = SharedElementPeers()
        peers.declare(key)
        assertFalse(peers.hasCounterpart(key))
    }

    @Test
    fun two_declarations_mean_the_other_end_exists() {
        val peers = SharedElementPeers()
        peers.declare(key)
        peers.declare(key)
        assertTrue(peers.hasCounterpart(key))
    }

    /** 另一端离开组合（转场结束、列表回收）后，计数要跟着回去 —— 否则下一次"没有对手"的转场会误藏 */
    @Test
    fun release_is_symmetric() {
        val peers = SharedElementPeers()
        peers.declare(key)
        peers.declare(key)
        assertTrue(peers.hasCounterpart(key))

        peers.release(key)
        assertFalse(peers.hasCounterpart(key))

        peers.release(key)
        assertFalse(peers.hasCounterpart(key))
    }

    /** 撤销一个从没声明过的 key 不能把计数搞成负数（下一次 declare 就会变成 0 → 又误判） */
    @Test
    fun release_of_unknown_key_is_ignored() {
        val peers = SharedElementPeers()
        peers.release(key)
        peers.declare(key)
        assertFalse(peers.hasCounterpart(key))
    }

    /** 不同 key 互不影响（同屏多条视频帖各自算各自的） */
    @Test
    fun keys_are_independent() {
        val peers = SharedElementPeers()
        peers.declare(postVideoKey(1L))
        peers.declare(postVideoKey(1L))
        peers.declare(postVideoKey(2L))
        assertTrue(peers.hasCounterpart(postVideoKey(1L)))
        assertFalse(peers.hasCounterpart(postVideoKey(2L)))
    }
}
