/**
 * ============================================================
 * 中国象棋引擎 + 房间对战协议（@k/shared 主入口的 chess 段）
 * ============================================================
 * 引擎为纯函数、零依赖，双端同源：客户端做合法落点提示，
 * 服务端做权威校验（设计见 docs/voice-chess-plan.md §3/§7）。
 */

export * from './types';
export * from './fen';
export * from './moves';
export * from './check';
export * from './game';
export * from './notation';
export * from './protocol';
