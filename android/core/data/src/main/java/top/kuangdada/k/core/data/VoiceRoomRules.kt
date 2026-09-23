package top.kuangdada.k.core.data

import top.kuangdada.k.core.data.model.VOICE_MAX_ROOM_SIZE

/**
 * ============================================================
 * 语音房「还能不能进」的判定（纯函数，可脱离真机单测）
 * ============================================================
 * 为什么要有这个函数：房间人数上限的**唯一事实来源**是服务端 join 时的拒绝
 * （`server/src/voice/messageHandlers.ts:72`，按 `VOICE_MAX_ROOM_SIZE` 回
 * 「房间已满（最多10人）」）。但安卓端此前**没有进房前的闸门**：房间列表页的卡片
 * 无条件调用 `onOpenRoom`，用户能点进一个必然被服务端拒掉的房间，
 * 观感就是"点了却莫名其妙进不去"（Web 端有这道闸：`client/src/pages/VoicePage.tsx:69`）。
 *
 * 为什么抽成**纯函数**而不是把 `>=` 直接写在 Composable 里：
 *  · 边界（空房 / 差一个 / 正好满 / 已超员）必须能被穷举单测钉住。写在 Composable 中的
 *    比较无法在 JVM 单测里覆盖（本工程的测试是脱离真机跑的，见 `run-kotlin-tests.mjs`）；
 *  · 判据只有一处，UI 与将来的调用方不会各自演化出"看起来差不多"的不同写法 ——
 *    镜像常量 [VOICE_MAX_ROOM_SIZE] 曾经就是"各写各的"写错（12 vs 10），
 *    症状是超员房间在客户端"看起来还能进"。
 *
 * 判据取 `<`：**满员（currentCount == max）即不可进**，与 Web 端 `count >= VOICE_MAX_ROOM_SIZE`
 * 逐字等价；负数（服务端数据异常/未取到）按"有空位"处理，交给服务端兜底拒绝，
 * 不在客户端凭空挡住一个可能其实有位置的房间。
 */
fun canJoinVoiceRoom(currentCount: Int, max: Int = VOICE_MAX_ROOM_SIZE): Boolean =
    currentCount < max
