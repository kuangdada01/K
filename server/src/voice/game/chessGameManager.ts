/**
 * ============================================================
 * 房间对战象棋：服务端权威对局管理器
 * ============================================================
 * 每房间最多一个对局槽位（邀请 → 对局 → 终局留档），棋局状态只存在
 * 于服务端；客户端仅上报"意图"，走子合法性/回合归属/胜负判定全部
 * 经 @k/shared 的同源引擎在此校验（设计见 docs/voice-chess-plan.md §3/§5）。
 *
 * 生命周期钩子：成员移除（离房/顶替/断线）与房间关闭经 hub 的监听注入
 * （onMemberRemoved/onRoomClosed），消息入口经 messageHandlers 的
 * ctx.chess 分发（默认实例 chessGames，测试可另建实例注入假 hub）。
 *
 * 断线宽限：棋手连接断开（含顶号）不立即判负——启动
 * GAME_DISCONNECT_GRACE_MS 宽限，同 userId 重新 join 即恢复；
 * 主动 leave（reason=left）立即判负。
 *
 * 棋钟（二期）：每方总时长 + 单步上限（env 可覆盖），任一耗尽判负
 * （reason=timeout）。每着广播 clocks（剩余毫秒 + 轮到方计时锚点），
 * 客户端据此本地走秒。悔棋（二期）：请求-应答制，撤回请求方最近一着
 * （对方已应手时连应手一并撤回）；终局时经 persistGame 落库留档。
 *
 * 暂停（三期）：任一棋手 game-pause 即全房暂停 —— 冻结前先把轮到方
 * 已耗时间从剩余时长里扣掉、deadline 归 0、撤单步定时器，广播
 * game-paused（clocks.paused=true）；暂停期间走子被拒（game-paused），
 * 悔棋生效重新起表也会跳过（armTurnTimer 对暂停态直接归零）。
 * 任一棋手 game-resume 即恢复，重新为轮到方起表并广播 game-resumed。
 */

import { randomUUID } from 'node:crypto';
import {
  applyMove,
  boardToFen,
  createInitialGameState,
  GAME_CLOCK_PER_MOVE_MS,
  GAME_CLOCK_TOTAL_MS,
  GAME_DISCONNECT_GRACE_MS,
  GAME_INVITE_EXPIRY_MS,
  isInCheck,
  moveToChineseNotation,
  pieceSide,
  undoMove,
  type ChessCaptured,
  type ChessClocks,
  type ChessGameState,
  type ChessPlayerInfo,
  type ChessSide,
  type ChessSideChoice,
  type ChessSquare,
} from '@k/shared';
import { logger } from '../../lib/logger';
import * as hubModule from '../hub';
import type { MemberRemovedReason } from '../hub';
import * as voiceGameRepo from '../../repositories/voice-game.repo';

/** 连接/用户的最小形状（结构化类型：不依赖 messageHandlers 的 VoiceWs，避免环依赖） */
export interface ChessUser {
  id: number;
  username: string;
  avatar: string | null;
}

export interface ChessSendable {
  send(data: string): void;
}

interface PendingInvite {
  inviteId: string;
  from: ChessPlayerInfo;
  toUserId: number;
  side: ChessSideChoice;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

/** 棋钟运行态：剩余总时长 + 轮到方计时锚点（广播给客户端走秒） */
interface GameClock {
  remaining: { red: number; black: number };
  turnStartedAt: number;
  deadline: number;
  timer: NodeJS.Timeout | null;
  /** 暂停中：棋钟冻结（deadline=0、定时器已撤）；恢复时 armTurnTimer 重新起表 */
  paused?: boolean;
}

interface ChessGame {
  gameId: string;
  red: ChessPlayerInfo;
  black: ChessPlayerInfo;
  state: ChessGameState;
  clock: GameClock;
  /** 中文记谱（与 state.moves 一一对应；悔棋时同步裁剪） */
  notations: string[];
  startedAt: number;
  /** 走子/终局之外的裁决结果（认输/断线/超时/求和），优先于 state.status 展示 */
  adjudicated?: {
    result: 'red-win' | 'black-win' | 'draw';
    reason: 'resign' | 'disconnect' | 'timeout' | 'agreement';
  };
  /** 已终局并已广播 game-ended（endGame 的幂等标记；判据说明见 endGame） */
  ended: boolean;
  /** 进行中断线的棋手 → 宽限计时器 */
  graces: Map<number, NodeJS.Timeout>;
  /** 未决求和的发起方 userId（同时最多一个） */
  drawOfferBy?: number;
  /** 未决悔棋的发起方 userId（同时最多一个） */
  undoOfferBy?: number;
  /** 已点"再来一局"的玩家 userId（终局后；双方都点即开新局） */
  rematchBy?: number;
}

interface RoomSlot {
  invite?: PendingInvite;
  /** playing 或 finished（终局保留供后进房者看盘面，下次邀请时清掉） */
  game?: ChessGame;
}

export interface ChessGameManagerDeps {
  broadcast: typeof hubModule.broadcast;
  sendToUser: typeof hubModule.sendToUser;
  getMemberRoomId: typeof hubModule.getMemberRoomId;
  getRoomCount: typeof hubModule.getRoomCount;
  onMemberRemoved: typeof hubModule.onMemberRemoved;
  onRoomClosed: typeof hubModule.onRoomClosed;
  /** 终局留档（voice-game.repo；失败不影响对局） */
  persistGame: typeof voiceGameRepo.insertVoiceGameRecord;
}

interface ChessTimings {
  inviteExpiryMs: number;
  disconnectGraceMs: number;
  clockTotalMs: number;
  clockPerMoveMs: number;
}

/** 正整数环境变量（非法回落默认值；时效类配置统一走这里） */
function envMs(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const timings: ChessTimings = {
  inviteExpiryMs: envMs('VOICE_GAME_INVITE_MS', GAME_INVITE_EXPIRY_MS),
  disconnectGraceMs: envMs('VOICE_GAME_GRACE_MS', GAME_DISCONNECT_GRACE_MS),
  clockTotalMs: envMs('VOICE_GAME_CLOCK_TOTAL_MS', GAME_CLOCK_TOTAL_MS),
  clockPerMoveMs: envMs('VOICE_GAME_CLOCK_PER_MOVE_MS', GAME_CLOCK_PER_MOVE_MS),
};

/** 测试缩短时效用（真实时钟 setTimeout；集成测试据此等待过期/宽限/超时） */
export function configureChessTimingsForTests(overrides: Partial<ChessTimings>): void {
  Object.assign(timings, overrides);
}

function isSideChoice(v: unknown): v is ChessSideChoice {
  return v === 'red' || v === 'black' || v === 'random';
}

function parseSquare(v: unknown): ChessSquare | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const f = o.f;
  const r = o.r;
  if (typeof f !== 'number' || !Number.isInteger(f) || f < 0 || f > 8) return null;
  if (typeof r !== 'number' || !Number.isInteger(r) || r < 0 || r > 9) return null;
  return { f, r };
}

export function createChessGameManager(deps: ChessGameManagerDeps) {
  const slots = new Map<number, RoomSlot>();

  const sendTo = (ws: ChessSendable, message: unknown): void => ws.send(JSON.stringify(message));
  const sendError = (ws: ChessSendable, code: string, message: string): void =>
    sendTo(ws, { type: 'game-error', code, message });

  const playerOf = (game: ChessGame, userId: number): ChessSide | null => {
    if (game.red.userId === userId) return 'red';
    if (game.black.userId === userId) return 'black';
    return null;
  };

  const opponentOf = (game: ChessGame, side: ChessSide): ChessPlayerInfo =>
    side === 'red' ? game.black : game.red;

  /**
   * 作废一条未决邀请并**通知双方**。
   *
   * 为什么必须两边都发：只通知发起方时，被邀方的邀请横幅会**一直挂着** ——
   * 这里的 `clearTimeout` 已经把过期定时器清掉，所以它连"30s 后自动消失"
   * 那条兜底都没有了，只能等被邀方去点接受/拒绝（那会拿到 bad-invite）
   * 或者离房。两端客户端都是按 `invite.inviteId` 匹配清理横幅的，所以
   * 这条通知对两边都有效（发起方清"等待应答"、被邀方清"收到邀请"）。
   */
  const clearInvite = (slot: RoomSlot, outcome: 'expired' | 'cancelled' | 'declined'): void => {
    const invite = slot.invite;
    if (!invite) return;
    clearTimeout(invite.timer);
    delete slot.invite;
    const payload = { type: 'game-invite-result', inviteId: invite.inviteId, outcome };
    deps.sendToUser(invite.from.userId, payload);
    // 被邀方可能已离房：sendToUser 对不在线的用户是无操作，不需要额外判空
    deps.sendToUser(invite.toUserId, payload);
  };

  /** 被吃子陈列：red = 红方吃获的黑子 */
  const capturedOf = (game: ChessGame): ChessCaptured => {
    const captured: ChessCaptured = { red: [], black: [] };
    for (const m of game.state.moves) {
      if (m.captured) (pieceSide(m.piece) === 'red' ? captured.red : captured.black).push(m.captured);
    }
    return captured;
  };

  const clocksOf = (game: ChessGame): ChessClocks => ({
    red: Math.max(0, Math.round(game.clock.remaining.red)),
    black: Math.max(0, Math.round(game.clock.remaining.black)),
    turnStartedAt: game.clock.turnStartedAt,
    deadline: game.clock.deadline,
    paused: !!game.clock.paused,
    // 封包时刻的服务端时钟：客户端据此对表（校准设备时钟偏差后本地走秒）
    serverNow: Date.now(),
  });

  const snapshotOf = (game: ChessGame) => ({
    type: 'game-snapshot' as const,
    gameId: game.gameId,
    red: game.red,
    black: game.black,
    fen: boardToFen(game.state.board, game.state.turn),
    turn: game.state.turn,
    status: game.adjudicated ? game.adjudicated.result : game.state.status,
    endReason: game.adjudicated
      ? game.adjudicated.reason
      : game.state.status !== 'playing'
        ? game.state.statusReason
        : null,
    lastMove: game.state.moves.length > 0 ? game.state.moves[game.state.moves.length - 1]! : null,
    moveCount: game.state.moves.length,
    clocks: clocksOf(game),
    captured: capturedOf(game),
    notations: [...game.notations],
  });

  const clearGraces = (game: ChessGame): void => {
    for (const timer of game.graces.values()) clearTimeout(timer);
    game.graces.clear();
  };

  /** 释放对局全部计时器（终局/清槽共用） */
  const clearTimers = (game: ChessGame): void => {
    clearGraces(game);
    if (game.clock.timer) {
      clearTimeout(game.clock.timer);
      game.clock.timer = null;
    }
  };

  /**
   * 为轮到方起表：deadline = 现在 + min(单步上限, 剩余总时长)。
   * 悔棋后同样调用（重新起表，不返还已耗时间）。暂停态直接归零不起表
   * （悔棋应答可能发生在暂停期间），恢复时经 handleResume 再起表。
   */
  const armTurnTimer = (roomId: number, game: ChessGame): void => {
    if (game.clock.timer) {
      clearTimeout(game.clock.timer);
      game.clock.timer = null;
    }
    if (game.state.status !== 'playing' || game.adjudicated || game.clock.paused) {
      game.clock.deadline = 0;
      return;
    }
    const side = game.state.turn;
    const limit = Math.min(timings.clockPerMoveMs, game.clock.remaining[side]);
    game.clock.turnStartedAt = Date.now();
    game.clock.deadline = game.clock.turnStartedAt + limit;
    game.clock.timer = setTimeout(() => {
      game.clock.timer = null;
      const slot = slots.get(roomId);
      if (!slot || slot.game !== game || game.adjudicated || game.state.status !== 'playing') return;
      logger.info({ roomId, gameId: game.gameId, side }, '语音：象棋棋手超时判负');
      endGame(roomId, game, side === 'red' ? 'black-win' : 'red-win', 'timeout');
    }, limit);
  };

  /**
   * 终局：广播 game-ended 并落库留档。幂等（已终局直接返回）。
   *
   * ⚠️ 幂等判据只能用 game.ended，**不能看 game.state.status**：
   * 引擎裁决的终局（绝杀/困毙/子力不足/重复局面/长将）由 handleMove 走到，
   * 而 handleMove 是「先把 game.state 换成终局态、再调本函数裁决」，于是
   * state.status 已经不是 playing —— 拿它判断会被误认为"早就终局过"直接 return，
   * 结果：game-ended 永不广播、终局留档也丢。客户端表现 = 盘面停住 + 兜底
   * "对局结束"（没有绝杀动画、没有再来一局），刷新拿到 game-snapshot 才恢复正常
   * （线上实测）。认输/求和/超时/断线这些是"先裁决再改 state"，所以一直没暴露。
   */
  const endGame = (
    roomId: number,
    game: ChessGame,
    result: 'red-win' | 'black-win' | 'draw',
    reason:
      | 'checkmate'
      | 'stalemate'
      | 'insufficient'
      | 'repetition'
      | 'perpetual'
      | 'resign'
      | 'disconnect'
      | 'timeout'
      | 'agreement'
  ): void => {
    if (game.ended) return; // 幂等：已终局
    game.ended = true;
    if (reason === 'resign' || reason === 'disconnect' || reason === 'timeout' || reason === 'agreement') {
      game.adjudicated = { result, reason };
    }
    clearTimers(game);
    game.clock.deadline = 0;
    game.clock.paused = false; // 终局不存在"暂停"态（终局快照不再携带 paused）
    delete game.drawOfferBy;
    delete game.undoOfferBy;
    logger.info({ roomId, gameId: game.gameId, result, reason }, '语音：象棋对局结束');
    deps.broadcast(roomId, { type: 'game-ended', gameId: game.gameId, result, reason });
    // 终局留档（与广播同刻；失败只记日志，不影响对局结束）
    try {
      deps.persistGame({
        roomId,
        gameId: game.gameId,
        redUserId: game.red.userId,
        blackUserId: game.black.userId,
        redName: game.red.username,
        blackName: game.black.username,
        result,
        reason,
        moves: game.state.moves,
        notations: game.notations,
        startedAt: game.startedAt,
      });
    } catch (err) {
      logger.warn({ roomId, gameId: game.gameId, err }, '语音：象棋终局留档失败');
    }
  };

  const gamePlaying = (slot: RoomSlot | undefined): ChessGame | undefined => {
    if (!slot?.game) return undefined;
    return slot.game.adjudicated || slot.game.state.status !== 'playing' ? undefined : slot.game;
  };

  // ---- 消息处理（messageHandlers 的 game-* 前缀统一分发到这里）----

  function handleMessage(
    user: ChessUser,
    ws: ChessSendable,
    msg: { type: string } & Record<string, unknown>
  ): void {
    switch (msg.type) {
      case 'game-invite':
        return handleInvite(user, ws, msg);
      case 'game-invite-respond':
        return handleInviteRespond(user, ws, msg);
      case 'game-invite-cancel':
        return handleInviteCancel(user, ws, msg);
      case 'game-move':
        return handleMove(user, ws, msg);
      case 'game-resign':
        return handleResign(user, ws, msg);
      case 'game-draw-offer':
        return handleDrawOffer(user, ws, msg);
      case 'game-draw-respond':
        return handleDrawRespond(user, ws, msg);
      case 'game-undo-offer':
        return handleUndoOffer(user, ws, msg);
      case 'game-undo-respond':
        return handleUndoRespond(user, ws, msg);
      case 'game-rematch':
      case 'game-rematch-respond': // 两种按钮态都发它，服务端同一处理
        return handleRematch(user, ws, msg);
      case 'game-pause':
        return handlePause(user, ws, msg);
      case 'game-resume':
        return handleResume(user, ws, msg);
      default:
        return sendError(ws, 'bad-message', `未知的对局消息: ${msg.type}`);
    }
  }

  function handleInvite(user: ChessUser, ws: ChessSendable, msg: Record<string, unknown>): void {
    const roomId = deps.getMemberRoomId(user.id);
    if (roomId === undefined) return sendError(ws, 'not-in-room', '请先加入语音房间');
    const toUserId = msg.toUserId;
    const side = msg.side;
    if (typeof toUserId !== 'number' || !Number.isInteger(toUserId) || toUserId === user.id) {
      return sendError(ws, 'bad-target', '邀请对象无效');
    }
    if (!isSideChoice(side)) return sendError(ws, 'bad-message', '选边无效');
    if (deps.getMemberRoomId(toUserId) !== roomId) {
      return sendError(ws, 'bad-target', '对方不在此房间');
    }
    const slot = slots.get(roomId) ?? {};
    if (gamePlaying(slot)) return sendError(ws, 'game-busy', '本房间已有对局进行中');
    if (slot.invite) return sendError(ws, 'game-busy', '已有待处理的邀请');

    const inviteId = randomUUID();
    const timer = setTimeout(() => {
      const current = slots.get(roomId);
      if (current?.invite?.inviteId !== inviteId) return;
      clearInvite(current, 'expired');
    }, timings.inviteExpiryMs);
    slot.invite = {
      inviteId,
      from: { userId: user.id, username: user.username, avatar: user.avatar },
      toUserId,
      side,
      expiresAt: Date.now() + timings.inviteExpiryMs,
      timer,
    };
    slots.set(roomId, slot);
    deps.sendToUser(toUserId, {
      type: 'game-invite-received',
      inviteId,
      from: slot.invite.from,
      side,
      expiresAt: slot.invite.expiresAt,
    });
  }

  function handleInviteRespond(user: ChessUser, ws: ChessSendable, msg: Record<string, unknown>): void {
    const inviteId = msg.inviteId;
    if (typeof inviteId !== 'string') return sendError(ws, 'bad-invite', '邀请无效');
    const roomId = deps.getMemberRoomId(user.id);
    if (roomId === undefined) return sendError(ws, 'bad-invite', '请先加入语音房间');
    const slot = slots.get(roomId);
    const invite = slot?.invite;
    if (!slot || !invite || invite.inviteId !== inviteId || invite.toUserId !== user.id) {
      return sendError(ws, 'bad-invite', '邀请不存在或已过期');
    }
    clearTimeout(invite.timer);
    delete slot.invite;
    if (msg.accept !== true) {
      deps.sendToUser(invite.from.userId, { type: 'game-invite-result', inviteId, outcome: 'declined' });
      return;
    }
    if (gamePlaying(slot)) return sendError(ws, 'game-busy', '本房间已有对局进行中');
    // 选边：side 是发起方的选择（random 在开局时落定）
    const fromRed = invite.side === 'red' ? true : invite.side === 'black' ? false : Math.random() < 0.5;
    startNewGame(
      roomId,
      slot,
      fromRed ? invite.from : { userId: user.id, username: user.username, avatar: user.avatar },
      fromRed ? { userId: user.id, username: user.username, avatar: user.avatar } : invite.from
    );
  }

  /** 建局并广播 game-started（邀请接受与"再来一局"共用） */
  function startNewGame(
    roomId: number,
    slot: RoomSlot,
    red: ChessPlayerInfo,
    black: ChessPlayerInfo
  ): ChessGame {
    const now = Date.now();
    const game: ChessGame = {
      gameId: randomUUID(),
      red,
      black,
      state: createInitialGameState(),
      clock: {
        remaining: { red: timings.clockTotalMs, black: timings.clockTotalMs },
        turnStartedAt: now,
        deadline: now + timings.clockPerMoveMs,
        timer: null,
      },
      notations: [],
      startedAt: now,
      ended: false,
      graces: new Map(),
    };
    slot.game = game;
    armTurnTimer(roomId, game);
    logger.info(
      { roomId, gameId: game.gameId, red: game.red.userId, black: game.black.userId },
      '语音：象棋对局开始'
    );
    deps.broadcast(roomId, {
      type: 'game-started',
      gameId: game.gameId,
      red: game.red,
      black: game.black,
      fen: boardToFen(game.state.board, game.state.turn),
      turn: game.state.turn,
      clocks: clocksOf(game),
    });
    return game;
  }

  function handleInviteCancel(user: ChessUser, ws: ChessSendable, msg: Record<string, unknown>): void {
    const inviteId = msg.inviteId;
    if (typeof inviteId !== 'string') return sendError(ws, 'bad-invite', '邀请无效');
    const roomId = deps.getMemberRoomId(user.id);
    if (roomId === undefined) return sendError(ws, 'bad-invite', '请先加入语音房间');
    const slot = slots.get(roomId);
    const invite = slot?.invite;
    if (!slot || !invite || invite.from.userId !== user.id) {
      return sendError(ws, 'bad-invite', '邀请不存在或已过期');
    }
    /*
     * inviteId 对不上也放行 —— 这是**协议本身的缺口**，不是客户端的 bug：
     * handleInvite 只把真实 inviteId 发给被邀方（`game-invite-received`），
     * 发起方**从来没有拿到过它**，所以两端客户端发撤销时只能回传一个本地占位串
     * （Web 端是 `pending-<toUserId>`，Android 端同口径）。
     * 严格比对 inviteId 的结果是「撤销」按钮点了必然报"邀请不存在或已过期"，
     * 邀请只能等对方应答或 30s 过期 —— 线上表现就是这个按钮是坏的。
     *
     * 为什么放宽是安全的：① 房间里同时最多一条待处理邀请（handleInvite 里
     * `slot.invite` 已存在就报 game-busy）；② 上面已经把身份钉死成
     * `invite.from.userId === user.id`，即**只有发起方本人**能走到这里，
     * 被邀方或旁观者冒充撤销一样会被挡掉。所以"本人 + 房间里那条唯一邀请"
     * 足以定位，不缺任何校验强度。
     */
    if (invite.inviteId !== inviteId) {
      logger.warn(
        { roomId, got: inviteId, actual: invite.inviteId },
        '语音：象棋撤销邀请的 inviteId 不匹配（发起方拿不到真实 id），按发起方本人撤销处理'
      );
    }
    clearInvite(slot, 'cancelled');
  }

  function handleMove(user: ChessUser, ws: ChessSendable, msg: Record<string, unknown>): void {
    const roomId = deps.getMemberRoomId(user.id);
    if (roomId === undefined) return sendError(ws, 'no-game', '当前没有进行中的对局');
    const slot = slots.get(roomId);
    const game = gamePlaying(slot);
    if (!slot || !game || msg.gameId !== game.gameId) {
      return sendError(ws, 'no-game', '当前没有进行中的对局');
    }
    const side = playerOf(game, user.id);
    if (!side) return sendError(ws, 'not-player', '你不是本局棋手');
    // 暂停期间一律停走（先于回合校验：此时报"还没轮到你"会误导）
    if (game.clock.paused) return sendError(ws, 'game-paused', '对局已暂停，请先继续对局');
    if (game.state.turn !== side) return sendError(ws, 'not-your-turn', '还没轮到你');
    if (msg.seq !== game.state.moves.length) {
      return sendError(ws, 'bad-seq', '着法序号不匹配');
    }
    const from = parseSquare(msg.from);
    const to = parseSquare(msg.to);
    if (!from || !to) {
      /*
       * 把原始载荷一起记下来：这个分支以前只有一句「着法坐标无效」，而客户端
       * 真出这个错的时候，报文往往"看着挺正常" —— 09-29 安卓端的起因就是
       * kotlinx 默认省略等于默认值的字段，坐标为 0 的分量被吃掉，
       * 报文成了 `{"from":{},"to":{"r":1}}`。没有原始载荷就只能靠猜端点/时序。
       */
      logger.warn(
        { roomId, userId: user.id, from: msg.from, to: msg.to },
        '语音：象棋着法坐标无法解析（客户端报文里的 from/to 缺字段或越界）'
      );
      return sendError(ws, 'bad-message', '着法坐标无效');
    }
    // 超时兜底：着法与超时同刻到达时以钟为准（定时器随后广播 game-ended）
    if (Date.now() > game.clock.deadline) return sendError(ws, 'no-game', '已超时判负');
    const next = applyMove(game.state, from, to);
    if (!next) return sendError(ws, 'illegal-move', '这步棋不合法');

    // 扣除本轮用时并重新起表（先算记谱——需要走子前的棋盘）
    const notation = moveToChineseNotation(game.state.board, next.moves[next.moves.length - 1]!);
    const elapsed = Date.now() - game.clock.turnStartedAt;
    game.clock.remaining[side] = Math.max(0, game.clock.remaining[side] - elapsed);
    game.state = next;
    game.notations.push(notation);
    delete game.drawOfferBy;
    delete game.undoOfferBy;
    const seq = next.moves.length - 1;
    deps.broadcast(roomId, {
      type: 'game-moved',
      gameId: game.gameId,
      seq,
      move: next.moves[seq]!,
      fen: boardToFen(next.board, next.turn),
      turn: next.turn,
      check: isInCheck(next.board, next.turn),
      status: next.status,
      notation,
      clocks: clocksOf(game),
    });
    if (next.status !== 'playing' && next.statusReason) {
      endGame(roomId, game, next.status, next.statusReason);
    } else {
      armTurnTimer(roomId, game);
    }
  }

  function handleResign(user: ChessUser, ws: ChessSendable, msg: Record<string, unknown>): void {
    const roomId = deps.getMemberRoomId(user.id);
    if (roomId === undefined) return sendError(ws, 'no-game', '当前没有进行中的对局');
    const slot = slots.get(roomId);
    const game = gamePlaying(slot);
    if (!slot || !game || msg.gameId !== game.gameId) {
      return sendError(ws, 'no-game', '当前没有进行中的对局');
    }
    const side = playerOf(game, user.id);
    if (!side) return sendError(ws, 'not-player', '你不是本局棋手');
    endGame(roomId, game, side === 'red' ? 'black-win' : 'red-win', 'resign');
  }

  function handleDrawOffer(user: ChessUser, ws: ChessSendable, msg: Record<string, unknown>): void {
    const roomId = deps.getMemberRoomId(user.id);
    if (roomId === undefined) return sendError(ws, 'no-game', '当前没有进行中的对局');
    const slot = slots.get(roomId);
    const game = gamePlaying(slot);
    if (!slot || !game || msg.gameId !== game.gameId) {
      return sendError(ws, 'no-game', '当前没有进行中的对局');
    }
    const side = playerOf(game, user.id);
    if (!side) return sendError(ws, 'not-player', '你不是本局棋手');
    const opponent = opponentOf(game, side);
    // 对方已有未决求和时再收到我方求和 = 双方都同意 → 直接判和
    if (game.drawOfferBy !== undefined && game.drawOfferBy !== user.id) {
      endGame(roomId, game, 'draw', 'agreement');
      return;
    }
    game.drawOfferBy = user.id;
    deps.sendToUser(opponent.userId, { type: 'game-draw-offered', gameId: game.gameId, from: user.id });
  }

  function handleDrawRespond(user: ChessUser, ws: ChessSendable, msg: Record<string, unknown>): void {
    const roomId = deps.getMemberRoomId(user.id);
    if (roomId === undefined) return sendError(ws, 'no-game', '当前没有进行中的对局');
    const slot = slots.get(roomId);
    const game = gamePlaying(slot);
    if (!slot || !game || msg.gameId !== game.gameId) {
      return sendError(ws, 'no-game', '当前没有进行中的对局');
    }
    const side = playerOf(game, user.id);
    if (!side) return sendError(ws, 'not-player', '你不是本局棋手');
    if (game.drawOfferBy === undefined || game.drawOfferBy === user.id) {
      return sendError(ws, 'bad-message', '没有待应答的求和');
    }
    const offeredBy = game.drawOfferBy;
    delete game.drawOfferBy;
    if (msg.accept === true) {
      endGame(roomId, game, 'draw', 'agreement');
      return;
    }
    deps.sendToUser(offeredBy, { type: 'game-draw-declined', gameId: game.gameId, by: user.id });
  }

  /** 悔棋请求：撤回自己最近一着（对方已应手时连应手一并撤回），需对方同意 */
  function handleUndoOffer(user: ChessUser, ws: ChessSendable, msg: Record<string, unknown>): void {
    const roomId = deps.getMemberRoomId(user.id);
    if (roomId === undefined) return sendError(ws, 'no-game', '当前没有进行中的对局');
    const slot = slots.get(roomId);
    const game = gamePlaying(slot);
    if (!slot || !game || msg.gameId !== game.gameId) {
      return sendError(ws, 'no-game', '当前没有进行中的对局');
    }
    const side = playerOf(game, user.id);
    if (!side) return sendError(ws, 'not-player', '你不是本局棋手');
    const ownMoves = game.state.moves.filter((m) => pieceSide(m.piece) === side).length;
    if (ownMoves === 0) return sendError(ws, 'bad-message', '你还没有走出可悔的棋');
    if (game.undoOfferBy === user.id) return; // 重复请求静默忽略
    // 已有对方未决请求时替换之（后请求优先），原请求方收到拒绝回执
    if (game.undoOfferBy !== undefined) {
      deps.sendToUser(game.undoOfferBy, { type: 'game-undo-declined', gameId: game.gameId, by: user.id });
    }
    game.undoOfferBy = user.id;
    const opponent = opponentOf(game, side);
    deps.sendToUser(opponent.userId, { type: 'game-undo-offered', gameId: game.gameId, from: user.id });
  }

  function handleUndoRespond(user: ChessUser, ws: ChessSendable, msg: Record<string, unknown>): void {
    const roomId = deps.getMemberRoomId(user.id);
    if (roomId === undefined) return sendError(ws, 'no-game', '当前没有进行中的对局');
    const slot = slots.get(roomId);
    const game = gamePlaying(slot);
    if (!slot || !game || msg.gameId !== game.gameId) {
      return sendError(ws, 'no-game', '当前没有进行中的对局');
    }
    const side = playerOf(game, user.id);
    if (!side) return sendError(ws, 'not-player', '你不是本局棋手');
    if (game.undoOfferBy === undefined || game.undoOfferBy === user.id) {
      return sendError(ws, 'bad-message', '没有待应答的悔棋请求');
    }
    const requesterId = game.undoOfferBy;
    delete game.undoOfferBy;
    if (msg.accept !== true) {
      deps.sendToUser(requesterId, { type: 'game-undo-declined', gameId: game.gameId, by: user.id });
      return;
    }
    // 撤销着数：末着是请求方的 → 撤 1 着；末着是对方应手 → 连应手一并撤（撤 2 着）
    const requesterSide = playerOf(game, requesterId)!;
    const hist = game.state.moves;
    const plies = pieceSide(hist[hist.length - 1]!.piece) === requesterSide ? 1 : 2;
    const undone = undoMove(game.state, plies);
    if (!undone) return sendError(ws, 'bad-message', '没有可悔的棋');
    game.state = undone;
    game.notations.length = Math.max(0, game.notations.length - plies);
    delete game.drawOfferBy;
    armTurnTimer(roomId, game); // 重新起表（已耗时间不返还）
    logger.info({ roomId, gameId: game.gameId, requesterId, plies }, '语音：象棋悔棋生效');
    deps.broadcast(roomId, {
      type: 'game-undone',
      gameId: game.gameId,
      fen: boardToFen(undone.board, undone.turn),
      turn: undone.turn,
      status: undone.status,
      lastMove: undone.moves.length > 0 ? undone.moves[undone.moves.length - 1]! : null,
      moveCount: undone.moves.length,
      clocks: clocksOf(game),
      captured: capturedOf(game),
      notations: [...game.notations],
    });
  }

  /**
   * 再来一局：终局后双方各点一次即直接开新局（随机换边）。
   * 第一人点击 → 对方收到 game-rematch-offered（按钮转高亮"点击开始"）；
   * 第二人点击（game-rematch-respond 同义）→ 立即开局，无接受/拒绝步骤。
   */
  function handleRematch(user: ChessUser, ws: ChessSendable, msg: Record<string, unknown>): void {
    const roomId = deps.getMemberRoomId(user.id);
    if (roomId === undefined) return sendError(ws, 'no-game', '当前没有已结束的对局');
    const slot = slots.get(roomId);
    const game = slot?.game;
    if (!slot || !game || msg.gameId !== game.gameId) {
      return sendError(ws, 'no-game', '当前没有已结束的对局');
    }
    if (gamePlaying(slot)) return sendError(ws, 'bad-message', '对局还在进行中');
    const side = playerOf(game, user.id);
    if (!side) return sendError(ws, 'not-player', '你不是本局棋手');
    if (game.rematchBy === user.id) return; // 重复点击静默忽略
    if (game.rematchBy !== undefined) {
      // 对方已点过 → 立即开新局（双方仍需都在房间）
      if (
        deps.getMemberRoomId(game.red.userId) !== roomId ||
        deps.getMemberRoomId(game.black.userId) !== roomId
      ) {
        delete game.rematchBy;
        return sendError(ws, 'bad-target', '对方已不在房间，无法再来一局');
      }
      if (slot.invite) clearInvite(slot, 'cancelled'); // 未决邀请一并作废
      delete game.rematchBy;
      // 随机换边（对局惯例：重开交换先后手）
      const swap = Math.random() < 0.5;
      startNewGame(roomId, slot, swap ? game.black : game.red, swap ? game.red : game.black);
      return;
    }
    game.rematchBy = user.id;
    const opponent = opponentOf(game, side);
    deps.sendToUser(opponent.userId, { type: 'game-rematch-offered', gameId: game.gameId, from: user.id });
  }

  /**
   * 暂停：任一棋手可触发（观战者 not-player）。冻结前先把轮到方已耗的
   * 时间从剩余时长里扣掉 —— turnStartedAt 在恢复时会重置，不先扣就会
   * 白送这段暂停时间。重复请求与已暂停时的再暂停都静默忽略（幂等）。
   */
  function handlePause(user: ChessUser, ws: ChessSendable, msg: Record<string, unknown>): void {
    const roomId = deps.getMemberRoomId(user.id);
    if (roomId === undefined) return sendError(ws, 'no-game', '当前没有进行中的对局');
    const slot = slots.get(roomId);
    const game = gamePlaying(slot);
    if (!slot || !game || msg.gameId !== game.gameId) {
      return sendError(ws, 'no-game', '当前没有进行中的对局');
    }
    const side = playerOf(game, user.id);
    if (!side) return sendError(ws, 'not-player', '你不是本局棋手');
    if (game.clock.paused) return; // 已暂停：静默忽略
    const turn = game.state.turn;
    const elapsed = Date.now() - game.clock.turnStartedAt;
    game.clock.remaining[turn] = Math.max(0, game.clock.remaining[turn] - elapsed);
    game.clock.paused = true;
    if (game.clock.timer) {
      clearTimeout(game.clock.timer);
      game.clock.timer = null;
    }
    game.clock.deadline = 0;
    logger.info({ roomId, gameId: game.gameId, by: user.id }, '语音：象棋对局暂停');
    deps.broadcast(roomId, {
      type: 'game-paused',
      gameId: game.gameId,
      by: user.id,
      clocks: clocksOf(game),
    });
  }

  /** 继续：暂停期间任一棋手可触发；为轮到方重新起表（单步上限重新计满） */
  function handleResume(user: ChessUser, ws: ChessSendable, msg: Record<string, unknown>): void {
    const roomId = deps.getMemberRoomId(user.id);
    if (roomId === undefined) return sendError(ws, 'no-game', '当前没有进行中的对局');
    const slot = slots.get(roomId);
    const game = gamePlaying(slot);
    if (!slot || !game || msg.gameId !== game.gameId) {
      return sendError(ws, 'no-game', '当前没有进行中的对局');
    }
    const side = playerOf(game, user.id);
    if (!side) return sendError(ws, 'not-player', '你不是本局棋手');
    if (!game.clock.paused) return; // 未在暂停：静默忽略
    game.clock.paused = false;
    armTurnTimer(roomId, game);
    logger.info({ roomId, gameId: game.gameId, by: user.id }, '语音：象棋对局继续');
    deps.broadcast(roomId, {
      type: 'game-resumed',
      gameId: game.gameId,
      by: user.id,
      clocks: clocksOf(game),
    });
  }

  // ---- 生命周期（hub 钩子 / join 钩子）----

  /** 成员移除：邀请作废、棋手判负或进入断线宽限、空房清理 */
  function handleMemberRemoved(roomId: number, userId: number, reason: MemberRemovedReason): void {
    const slot = slots.get(roomId);
    if (slot?.invite && (slot.invite.from.userId === userId || slot.invite.toUserId === userId)) {
      // 邀请相关方离房/断线：作废并通知双方（被邀方据此清掉收到的邀请横幅）
      const invite = slot.invite;
      clearTimeout(invite.timer);
      delete slot.invite;
      const payload = { type: 'game-invite-result', inviteId: invite.inviteId, outcome: 'cancelled' };
      deps.sendToUser(invite.from.userId, payload);
      deps.sendToUser(invite.toUserId, payload);
    }
    // 终局留档上的未决"再来一局"：任一棋手离房 → 复位对方按钮态
    if (
      slot?.game &&
      slot.game.rematchBy !== undefined &&
      (slot.game.rematchBy === userId || slot.game.red.userId === userId || slot.game.black.userId === userId)
    ) {
      const finished = slot.game;
      delete finished.rematchBy;
      const other = finished.red.userId === userId ? finished.black : finished.red;
      deps.sendToUser(other.userId, { type: 'game-rematch-reset', gameId: finished.gameId });
    }
    const game = gamePlaying(slot);
    if (game) {
      const side = playerOf(game, userId);
      if (side) {
        if (reason === 'left') {
          endGame(roomId, game, side === 'red' ? 'black-win' : 'red-win', 'resign');
        } else if (!game.graces.has(userId)) {
          // 断线/被顶号：宽限期内同 userId 重新 join 则恢复（棋钟继续走，超时仍判负）
          const timer = setTimeout(() => {
            game.graces.delete(userId);
            if (gamePlaying(slot) === game) {
              logger.info({ roomId, gameId: game.gameId, userId }, '语音：象棋棋手断线超时判负');
              endGame(roomId, game, side === 'red' ? 'black-win' : 'red-win', 'disconnect');
            }
          }, timings.disconnectGraceMs);
          game.graces.set(userId, timer);
        }
      }
    }
    // 房间已空：清理槽位（终局留档已落库，内存态随之释放）
    if (deps.getRoomCount(roomId) === 0) {
      const dead = slots.get(roomId);
      if (dead?.invite) clearTimeout(dead.invite.timer);
      if (dead?.game) clearTimers(dead.game);
      slots.delete(roomId);
    }
  }

  /** 成员加入：恢复断线棋手的宽限计时，并向新加入者/观战者推送对局快照 */
  function handleJoined(roomId: number, userId: number): void {
    const slot = slots.get(roomId);
    if (!slot?.game) return;
    const game = slot.game;
    const graceTimer = game.graces.get(userId);
    if (graceTimer) {
      clearTimeout(graceTimer);
      game.graces.delete(userId);
      logger.info({ roomId, gameId: game.gameId, userId }, '语音：象棋棋手重连恢复');
    }
    deps.sendToUser(userId, snapshotOf(game));
  }

  /** 房间被删除：终止对局并清理（成员会收到 room-closed，无需再广播对局消息） */
  function handleRoomClosed(roomId: number): void {
    const slot = slots.get(roomId);
    if (!slot) return;
    if (slot.invite) clearTimeout(slot.invite.timer);
    if (slot.game) clearTimers(slot.game);
    slots.delete(roomId);
  }

  /** 测试辅助：注入/查询内部状态（生产代码不要使用） */
  function __inspect(roomId: number): RoomSlot | undefined {
    return slots.get(roomId);
  }

  return {
    handleMessage,
    handleMemberRemoved,
    handleJoined,
    handleRoomClosed,
    __inspect,
  };
}

export type ChessGameManager = ReturnType<typeof createChessGameManager>;

/** 生产单例：挂接 hub 生命周期钩子（测试经 createChessGameManager 自建实例注入假 hub） */
export const chessGames = createChessGameManager({
  broadcast: hubModule.broadcast,
  sendToUser: hubModule.sendToUser,
  getMemberRoomId: hubModule.getMemberRoomId,
  getRoomCount: hubModule.getRoomCount,
  onMemberRemoved: hubModule.onMemberRemoved,
  onRoomClosed: hubModule.onRoomClosed,
  persistGame: voiceGameRepo.insertVoiceGameRecord,
});

hubModule.onMemberRemoved((roomId, userId, reason) => chessGames.handleMemberRemoved(roomId, userId, reason));
hubModule.onRoomClosed((roomId) => chessGames.handleRoomClosed(roomId));
