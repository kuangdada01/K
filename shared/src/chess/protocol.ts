/**
 * ============================================================
 * 房间对战象棋：WS 协议消息形状（/api/voice/ws，前缀 game-）
 * ============================================================
 * 复用语音信令通道与 hub 广播（设计见 docs/voice-chess-plan.md §4）。
 * C→S 消息由服务端逐字段窄化校验；S→C 消息中的棋盘均为类 FEN 串
 * （见 fen.ts）。这里只定义形状，服务端校验/状态机在
 * server/src/voice/game/chessGameManager.ts。
 *
 * 二期新增：棋钟（clocks/deadline，超时判负）、中文记谱（notation）、
 * 被吃子陈列（captured）、悔棋请求-应答（game-undo-*）、长将判负（perpetual）。
 */

import type { ChessGameStatus, ChessMove, ChessPiece, ChessSide, ChessSquare } from './types';

/** 对局参与者身份（服务端以 hub 在线成员信息填充；含访客负数 id） */
export interface ChessPlayerInfo {
  userId: number;
  username: string;
  avatar: string | null;
}

/** 邀请时发起方选边：执红 / 执黑 / 服务端开局时随机 */
export type ChessSideChoice = 'red' | 'black' | 'random';

/** 对局结束原因：引擎级 + 对局层（timeout=超时判负；perpetual=长将判负） */
export type ChessGameEndReason =
  | 'checkmate'
  | 'stalemate'
  | 'insufficient'
  | 'repetition'
  | 'perpetual'
  | 'resign'
  | 'disconnect'
  | 'timeout'
  | 'agreement';

/**
 * 双方剩余总时长（毫秒）。turnStartedAt/deadline 为**轮到方**的计时锚点：
 * deadline = turnStartedAt + min(每步限时, 轮到方剩余总时长)；轮到方的真实
 * 剩余 = min(clocks[turn], deadline - Date.now())，客户端据此本地走秒。
 * 终局后 deadline = 0（不再计时）。
 * paused（三期）：对局被暂停时为 true（deadline 同步归 0，双方棋钟冻结），
 * 客户端据此停止走秒、禁用走子；快照携带它，刷新/重连后恢复暂停态。
 */
export interface ChessClocks {
  red: number;
  black: number;
  turnStartedAt: number;
  deadline: number;
  paused?: boolean;
}

/** 被吃子陈列：red = 红方吃获的黑子，black = 黑方吃获的红子 */
export interface ChessCaptured {
  red: ChessPiece[];
  black: ChessPiece[];
}

// ---- C→S ----

export interface ChessGameInviteMsg {
  type: 'game-invite';
  toUserId: number;
  side: ChessSideChoice;
}

export interface ChessGameInviteRespondMsg {
  type: 'game-invite-respond';
  inviteId: string;
  accept: boolean;
}

export interface ChessGameInviteCancelMsg {
  type: 'game-invite-cancel';
  inviteId: string;
}

/** seq = 该步在着法序列中的序号（0 起，等于服务端 moves.length），单调防重放 */
export interface ChessGameMoveMsg {
  type: 'game-move';
  gameId: string;
  seq: number;
  from: ChessSquare;
  to: ChessSquare;
}

export interface ChessGameResignMsg {
  type: 'game-resign';
  gameId: string;
}

export interface ChessGameDrawOfferMsg {
  type: 'game-draw-offer';
  gameId: string;
}

export interface ChessGameDrawRespondMsg {
  type: 'game-draw-respond';
  gameId: string;
  accept: boolean;
}

/** 再来一局：点击方对刚结束的对局请求重开；
 *  双方都点击时立即开新局（随机换边），无需接受/拒绝步骤 */
export interface ChessGameRematchMsg {
  type: 'game-rematch';
  gameId: string;
}

/** 悔棋：请求方撤回自己最近一着（对方已应手时连着应手一并撤回），需对方同意 */
export interface ChessGameUndoOfferMsg {
  type: 'game-undo-offer';
  gameId: string;
}

export interface ChessGameUndoRespondMsg {
  type: 'game-undo-respond';
  gameId: string;
  accept: boolean;
}

/** 暂停对局：任一棋手点击即全房暂停（棋钟冻结、双方停走）；重复请求静默忽略 */
export interface ChessGamePauseMsg {
  type: 'game-pause';
  gameId: string;
}

/** 继续对局：暂停期间任一棋手可恢复，服务端为轮到方重新起表 */
export interface ChessGameResumeMsg {
  type: 'game-resume';
  gameId: string;
}

export interface ChessGameRematchRespondMsg {
  type: 'game-rematch-respond';
  gameId: string;
}

/** C→S 对局消息联合（服务端 switch 分发用） */
export type ChessGameClientMsg =
  | ChessGameInviteMsg
  | ChessGameInviteRespondMsg
  | ChessGameInviteCancelMsg
  | ChessGameMoveMsg
  | ChessGameResignMsg
  | ChessGameDrawOfferMsg
  | ChessGameDrawRespondMsg
  | ChessGameUndoOfferMsg
  | ChessGameUndoRespondMsg
  | ChessGameRematchMsg
  | ChessGameRematchRespondMsg
  | ChessGamePauseMsg
  | ChessGameResumeMsg;

// ---- S→C ----

export interface ChessGameInviteReceivedMsg {
  type: 'game-invite-received';
  inviteId: string;
  from: ChessPlayerInfo;
  side: ChessSideChoice;
  /** 绝对过期时间（Date.now() 口径），客户端倒计时用 */
  expiresAt: number;
}

export interface ChessGameInviteResultMsg {
  type: 'game-invite-result';
  inviteId: string;
  outcome: 'accepted' | 'declined' | 'expired' | 'cancelled';
}

export interface ChessGameStartedMsg {
  type: 'game-started';
  gameId: string;
  red: ChessPlayerInfo;
  black: ChessPlayerInfo;
  fen: string;
  turn: ChessSide;
  clocks: ChessClocks;
}

export interface ChessGameMovedMsg {
  type: 'game-moved';
  gameId: string;
  seq: number;
  move: ChessMove;
  fen: string;
  turn: ChessSide;
  /** 该步后轮到方是否被将军（客户端据此提示"将军"） */
  check: boolean;
  status: ChessGameStatus;
  /** 该步的中文记谱（"炮二平五"） */
  notation: string;
  clocks: ChessClocks;
}

export interface ChessGameEndedMsg {
  type: 'game-ended';
  gameId: string;
  result: 'red-win' | 'black-win' | 'draw';
  reason: ChessGameEndReason;
}

/** 全量快照：新加入者/重连者/观战者恢复局面（终局后也会发，可看最终盘面） */
export interface ChessGameSnapshotMsg {
  type: 'game-snapshot';
  gameId: string;
  red: ChessPlayerInfo;
  black: ChessPlayerInfo;
  fen: string;
  turn: ChessSide;
  status: ChessGameStatus;
  /** status 非 playing 时的终局原因（刷新后恢复终局横幅用）；playing 时为 null */
  endReason: ChessGameEndReason | null;
  lastMove: ChessMove | null;
  moveCount: number;
  clocks: ChessClocks;
  captured: ChessCaptured;
  /** 全部着法的中文记谱（棋谱条用；终局快照也带） */
  notations: string[];
}

export interface ChessGameDrawOfferedMsg {
  type: 'game-draw-offered';
  gameId: string;
  from: number;
}

/** 求和被拒（接受时直接广播 game-ended，不发本消息） */
export interface ChessGameDrawDeclinedMsg {
  type: 'game-draw-declined';
  gameId: string;
  by: number;
}

/** 悔棋请求（发给对方；同意时广播 game-undone，拒绝时回发起方 game-undo-declined） */
export interface ChessGameUndoOfferedMsg {
  type: 'game-undo-offered';
  gameId: string;
  from: number;
}

export interface ChessGameUndoDeclinedMsg {
  type: 'game-undo-declined';
  gameId: string;
  by: number;
}

/** 悔棋生效广播：全房按此恢复盘面/棋钟/棋谱/被吃子 */
export interface ChessGameUndoneMsg {
  type: 'game-undone';
  gameId: string;
  fen: string;
  turn: ChessSide;
  status: ChessGameStatus;
  lastMove: ChessMove | null;
  moveCount: number;
  clocks: ChessClocks;
  captured: ChessCaptured;
  notations: string[];
}

/** 对方已点"再来一局"（本方按钮转为"点击开始"，点击即开局） */
export interface ChessGameRematchOfferedMsg {
  type: 'game-rematch-offered';
  gameId: string;
  from: number;
}

/** 未决的再来一局被清除（发起方离房）；客户端复位按钮态 */
export interface ChessGameRematchResetMsg {
  type: 'game-rematch-reset';
  gameId: string;
}

/** 对局已暂停（任一棋手触发）：clocks.paused=true、deadline=0，客户端冻结走秒并禁走 */
export interface ChessGamePausedMsg {
  type: 'game-paused';
  gameId: string;
  /** 触发暂停的棋手 userId（客户端据此区分自己/对方的操作做提示） */
  by: number;
  clocks: ChessClocks;
}

/** 对局继续：clocks.paused=false，deadline 已为轮到方重新起表 */
export interface ChessGameResumedMsg {
  type: 'game-resumed';
  gameId: string;
  by: number;
  clocks: ChessClocks;
}

export interface ChessGameErrorMsg {
  type: 'game-error';
  code:
    | 'not-in-room'
    | 'no-game'
    | 'game-busy'
    | 'bad-target'
    | 'bad-invite'
    | 'not-player'
    | 'not-your-turn'
    | 'game-paused'
    | 'bad-seq'
    | 'illegal-move'
    | 'bad-message';
  message: string;
}

/** S→C 对局消息联合（client 的 VoiceServerMessage 引用） */
export type ChessGameServerMsg =
  | ChessGameInviteReceivedMsg
  | ChessGameInviteResultMsg
  | ChessGameStartedMsg
  | ChessGameMovedMsg
  | ChessGameEndedMsg
  | ChessGameSnapshotMsg
  | ChessGameDrawOfferedMsg
  | ChessGameDrawDeclinedMsg
  | ChessGameUndoOfferedMsg
  | ChessGameUndoDeclinedMsg
  | ChessGameUndoneMsg
  | ChessGameRematchOfferedMsg
  | ChessGameRematchResetMsg
  | ChessGamePausedMsg
  | ChessGameResumedMsg
  | ChessGameErrorMsg;
