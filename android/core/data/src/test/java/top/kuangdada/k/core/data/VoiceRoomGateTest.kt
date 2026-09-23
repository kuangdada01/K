package top.kuangdada.k.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import top.kuangdada.k.core.data.model.VOICE_MAX_ROOM_SIZE

/**
 * ============================================================
 * 语音房进房闸门 · 纯逻辑单测
 * ============================================================
 * 这组用例的存在理由：闸门写错**不会报任何错**，只表现为两个极端之一 ——
 *  · 判据写松（例如 `<=`）：满员房间照旧放行，用户撞服务端「房间已满」，回到改之前的状态；
 *  · 判据写紧（例如拿镜像常量当 12 用）：明明还有空位的房间进不去，且没有任何提示。
 * 所以边界必须穷举，并用事实来源常量把"10"这个数钉住。
 */
class VoiceRoomGateTest {

    @Test
    fun `空房可进`() {
        assertTrue(canJoinVoiceRoom(0))
    }

    @Test
    fun `还有空位（max-1）可进`() {
        assertTrue(canJoinVoiceRoom(VOICE_MAX_ROOM_SIZE - 1))
    }

    @Test
    fun `正好满（max）不可进——与 Web 端 count 大于等于上限 的判据一致`() {
        assertFalse(canJoinVoiceRoom(VOICE_MAX_ROOM_SIZE))
    }

    @Test
    fun `已超员（max+1）不可进`() {
        assertFalse(canJoinVoiceRoom(VOICE_MAX_ROOM_SIZE + 1))
    }

    @Test
    fun `安卓镜像常量与服务端事实来源一致（都是 10）`() {
        // shared/src/constants/voice.ts: `export const VOICE_MAX_ROOM_SIZE = 10;`
        // 服务端 server/src/voice/messageHandlers.ts:72 按它拒绝 join。
        // 这里改一次就必须同步改 shared —— 两端数值逐字相同是唯一允许的镜像方式。
        assertEquals(10, VOICE_MAX_ROOM_SIZE)
        // 显式传 max 的两个边界：钉死"满员"这条线的两侧，不依赖默认参数
        assertTrue(canJoinVoiceRoom(9, VOICE_MAX_ROOM_SIZE))
        assertFalse(canJoinVoiceRoom(10, VOICE_MAX_ROOM_SIZE))
    }
}
