/**
 * ============================================================
 * 房间对战象棋共享常量（@k/shared，双端）
 * ============================================================
 */

/** 对局邀请有效期：超时自动作废并通知发起方 */
export const GAME_INVITE_EXPIRY_MS = 30_000;

/** 棋手断线宽限：期间同 userId 重新 join 恢复对局，超时判负（覆盖客户端 3s 自动重连抖动） */
export const GAME_DISCONNECT_GRACE_MS = 30_000;

/** game-move 连接级最小发送间隔：合法走子天然受回合约束，该间隔只挡异常刷帧 */
export const GAME_MOVE_MIN_INTERVAL_MS = 150;

/**
 * 棋钟默认值（服务端可用环境变量 VOICE_GAME_CLOCK_TOTAL_MS /
 * VOICE_GAME_CLOCK_PER_MOVE_MS 覆盖）：每方总时长 + 单步上限，
 * 任一耗尽判负（reason: 'timeout'）。总时长是主钟，单步上限防拖延。
 */
export const GAME_CLOCK_TOTAL_MS = 10 * 60_000;
export const GAME_CLOCK_PER_MOVE_MS = 90_000;
