package top.kuangdada.k.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ============================================================
 * 续期 / 401 的代次判定测试（TokenCaptureLogic，P1-3.1）
 * ============================================================
 * 对应维护方案 3.1 的验收：
 *  - 挂起 A 账号请求 → 登出（换代次）→ A 迟到的续期 token / 401 不再影响当前会话；
 *  - 本地无 token（已登出清空）时，续期响应不得把凭证写回来；
 *  - 同代次的正常滑动续期不受影响。
 */
class TokenCaptureLogicTest {

    private class Fixture(epoch: Int) {
        var currentEpoch = epoch
        var stored: String? = null
        val writes = mutableListOf<String>()
        val unauthorizedEpochs = mutableListOf<Int>()

        val logic = TokenCaptureLogic(
            readToken = { stored },
            writeToken = { fresh ->
                writes += fresh
                stored = fresh
            },
            currentEpoch = { currentEpoch },
            onUnauthorized = { epochAtSend -> unauthorizedEpochs += epochAtSend },
        )
    }

    @Test
    fun `同代次的续期正常落盘（滑动续期不换会话）`() {
        val f = Fixture(epoch = 3)
        f.stored = "token-old"

        val written = f.logic.handleRefreshedToken("token-new", epochAtSend = 3)

        assertTrue(written)
        assertEquals(listOf("token-new"), f.writes)
    }

    @Test
    fun `换会后迟到的续期被丢弃（A 的续期不得覆盖 B 的凭证）`() {
        val f = Fixture(epoch = 3)
        f.stored = "token-A"
        // 请求发出时代次 3；响应回来前登出/换号 → 当后代次 4
        f.currentEpoch = 4
        f.stored = "token-B"

        val written = f.logic.handleRefreshedToken("token-A-refreshed", epochAtSend = 3)

        assertFalse(written)
        assertTrue(f.writes.isEmpty())
        assertEquals("token-B", f.stored)
    }

    @Test
    fun `本地无 token（已登出）时续期不得写回凭证`() {
        val f = Fixture(epoch = 3)
        f.stored = null

        val written = f.logic.handleRefreshedToken("token-late", epochAtSend = 3)

        assertFalse(written)
        assertEquals(null, f.stored)
    }

    @Test
    fun `空值或与本地相同的 token 不落盘`() {
        val f = Fixture(epoch = 1)
        f.stored = "token-same"

        assertFalse(f.logic.handleRefreshedToken(null, epochAtSend = 1))
        assertFalse(f.logic.handleRefreshedToken("", epochAtSend = 1))
        assertFalse(f.logic.handleRefreshedToken("token-same", epochAtSend = 1))
        assertTrue(f.writes.isEmpty())
    }

    @Test
    fun `同代次的 401 转交会话层（带发出时代次）`() {
        val f = Fixture(epoch = 5)

        f.logic.handleUnauthorizedIfMatches(responseCode = 401, epochAtSend = 5)

        assertEquals(listOf(5), f.unauthorizedEpochs)
    }

    @Test
    fun `换会后迟到的 401 不转交（B 不被 A 的过期 401 踢下线）`() {
        val f = Fixture(epoch = 5)
        f.currentEpoch = 6

        f.logic.handleUnauthorizedIfMatches(responseCode = 401, epochAtSend = 5)

        assertTrue(f.unauthorizedEpochs.isEmpty())
    }

    @Test
    fun `非 401 状态码不转交`() {
        val f = Fixture(epoch = 1)

        f.logic.handleUnauthorizedIfMatches(responseCode = 500, epochAtSend = 1)
        f.logic.handleUnauthorizedIfMatches(responseCode = 200, epochAtSend = 1)

        assertTrue(f.unauthorizedEpochs.isEmpty())
    }
}
