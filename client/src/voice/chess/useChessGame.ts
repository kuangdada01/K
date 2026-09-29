/**
 * ============================================================
 * 房间对战象棋：客户端状态 hook（voice/chess/useChessGame）
 * ============================================================
 * 服务端权威：本 hook 只维护"视图状态"（当前盘面/邀请/求和/暂停/终局横幅），
 * 所有走子合法性、回合归属、胜负判定都在服务端（chessGameManager.ts +
 * @k/shared 同源引擎）。收到 game-error 时以 toast 提示语义化原因。
 *
 * 由 useVoiceSessionController 实例化并注入两个运行期依赖：
 * - getSelfUserId：会话身份（服务端可能校正访客占位 id，必须实时读）；
 * - send：经 VoiceSession.sendChessMessage 上行。
 * 依赖经 ref 读取，动作引用稳定，可安全进入深层的依赖数组/memo。
 * ============================================================
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChessCaptured,
  ChessClocks,
  ChessGameClientMsg,
  ChessGameEndReason,
  ChessGameServerMsg,
  ChessMove,
  ChessPlayerInfo,
  ChessSide,
  ChessSideChoice,
  ChessGameStatus,
} from '@k/shared';
import { pieceSide } from '@k/shared';
import { showToast } from '../../components/ui/Toast';

/** 走子后追加被吃子（red = 红方吃获的黑子） */
function appendCaptured(captured: ChessCaptured, move: ChessMove): ChessCaptured {
  if (!move.captured) return captured;
  return pieceSide(move.piece) === 'red'
    ? { ...captured, red: [...captured.red, move.captured] }
    : { ...captured, black: [...captured.black, move.captured] };
}

/** 盘面视图状态（棋盘渲染 + 席位判定所需的最小集合） */
export interface ChessGameView {
  gameId: string;
  red: ChessPlayerInfo;
  black: ChessPlayerInfo;
  fen: string;
  turn: ChessSide;
  status: ChessGameStatus;
  lastMove: ChessMove | null;
  moveCount: number;
  /** 已点"再来一局"的玩家（终局后；null=无人点过，=自己则等待对方） */
  rematchBy: number | null;
  /** 双方剩余总时长 + 轮到方计时锚点（超时判负由服务端裁决，这里只展示） */
  clocks: ChessClocks;
  /** 全部着法的中文记谱（棋谱条） */
  notations: string[];
  /** 被吃子陈列：red = 红方吃获的黑子 */
  captured: ChessCaptured;
}

/** 收到的对局邀请 */
export interface ChessInviteView {
  inviteId: string;
  from: ChessPlayerInfo;
  side: ChessSideChoice;
  expiresAt: number;
}

/** 我发出的待应答邀请（"等待对方应答"横幅；inviteId 是本地占位，服务端回执不带回它） */
export interface ChessOutgoingView {
  inviteId: string;
  toUserId: number;
  toName: string;
}

/** 终局横幅（对局结束后保留，直到用户关闭或新对局开始） */
export interface ChessEndedView {
  result: 'red-win' | 'black-win' | 'draw';
  reason: ChessGameEndReason;
}

export interface ChessUiState {
  game: ChessGameView | null;
  invite: ChessInviteView | null;
  outgoing: ChessOutgoingView | null;
  /** 对方发来的未决求和（发起方 userId） */
  drawOfferFrom: number | null;
  /** 对方发来的未决悔棋请求（发起方 userId） */
  undoOfferFrom: number | null;
  ended: ChessEndedView | null;
  /** 面板是否可见（对局/邀请/待应答横幅任一存在即显示） */
  showPanel: boolean;
  /** 复盘弹窗打开中（打开时面板在空闲态也渲染） */
  reviewOpen: boolean;
  /** 复盘弹窗预选的对局（终局横幅"复盘"直达；null=显示列表） */
  reviewGameId: string | null;
}

export interface ChessActions {
  /** 向同房间成员发起对局邀请（本地立即进入"等待应答"态） */
  inviteUser: (toUserId: number, toName: string, side: ChessSideChoice) => void;
  /** 应答收到的邀请 */
  respondInvite: (inviteId: string, accept: boolean) => void;
  /** 撤销自己发出的邀请 */
  cancelInvite: (inviteId: string) => void;
  /** 走子（from/to 交点坐标；合法性由服务端校验） */
  move: (gameId: string, seq: number, from: { f: number; r: number }, to: { f: number; r: number }) => void;
  /** 认输 */
  resign: (gameId: string) => void;
  /** 求和（双方同意才和；对方未决求和时再求即判和） */
  offerDraw: (gameId: string) => void;
  /** 应答对方的求和 */
  respondDraw: (gameId: string, accept: boolean) => void;
  /** 请求悔棋（撤回自己最近一着；需对方同意） */
  offerUndo: (gameId: string) => void;
  /** 应答对方的悔棋请求 */
  respondUndo: (gameId: string, accept: boolean) => void;
  /** 再来一局：点击后等待对方；对方也点击即立即开新局（随机换边） */
  rematch: (gameId: string) => void;
  /** 暂停对局（任一棋手可触发；棋钟冻结、双方停走） */
  pause: (gameId: string) => void;
  /** 继续对局（暂停期间任一棋手可触发；服务端为轮到方重新起表） */
  resume: (gameId: string) => void;
  /** 关闭终局面板（回到空闲） */
  dismissEnded: () => void;
  /** 打开复盘弹窗（gameId 可选：终局横幅直达该局，否则显示对局列表） */
  openReview: (gameId?: string) => void;
  /** 关闭复盘弹窗 */
  closeReview: () => void;
  /** 会话结束/离房时清空全部状态（由控制器 resetState 调用） */
  reset: () => void;
}

export type ChessController = ChessUiState &
  ChessActions & {
    /** 某用户在对局中执哪方（观战者 null）；面板据此判定 mySide/myTurn */
    mySideOf: (userId: number) => ChessSide | null;
    /** 服务端 game-* 消息入口（控制器把它接进 VoiceSession 回调） */
    onChessMessage: (msg: ChessGameServerMsg) => void;
  };

const SIDE_LABEL: Record<ChessSideChoice, string> = {
  red: '执红先行',
  black: '执黑后行',
  random: '随机执子',
};
export { SIDE_LABEL as CHESS_SIDE_LABEL };

export function useChessGame(deps: {
  getSelfUserId: () => number;
  send: (msg: ChessGameClientMsg) => void;
}): ChessController {
  const [game, setGame] = useState<ChessGameView | null>(null);
  const [invite, setInvite] = useState<ChessInviteView | null>(null);
  const [outgoing, setOutgoing] = useState<ChessOutgoingView | null>(null);
  const [drawOfferFrom, setDrawOfferFrom] = useState<number | null>(null);
  const [undoOfferFrom, setUndoOfferFrom] = useState<number | null>(null);
  const [ended, setEnded] = useState<ChessEndedView | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewGameId, setReviewGameId] = useState<string | null>(null);
  // deps 经 ref 读取：onChessMessage/动作保持稳定引用，不随渲染重建
  //（effect 内同步最新值 —— 与控制器里 chatActionsRef 的同一做法）
  const depsRef = useRef(deps);
  useEffect(() => {
    depsRef.current = deps;
  }, [deps]);

  /**
   * game 的**同步镜像**。
   *
   * 为什么不能直接读 state：`game-snapshot` 那条护栏要判"手上有没有这一局"
   * （见下面的 game-snapshot 分支），而 onChessMessage 是 `[]` 依赖的稳定回调 ——
   * 读 state 拿到的是闭包里的旧值，靠 useEffect 回填又太晚（同一轮里可能连来
   * 两条消息）。所以 game 的每一处写入都走下面两个小工具，顺带把镜像更新掉。
   */
  const gameRef = useRef<ChessGameView | null>(null);

  /** 写 game 的唯一入口（镜像与 state 同步，判据不会错位） */
  const writeGame = useCallback((next: ChessGameView | null): void => {
    gameRef.current = next;
    setGame(next);
  }, []);

  /** 按 gameId 命中才打补丁（等价于 `setGame(prev => prev?.gameId === id ? … : prev)`） */
  const patchGame = useCallback(
    (gameId: string, patch: (prev: ChessGameView) => ChessGameView): void => {
      const prev = gameRef.current;
      if (!prev || prev.gameId !== gameId) return;
      writeGame(patch(prev));
    },
    [writeGame]
  );

  const onChessMessage = useCallback(
    (msg: ChessGameServerMsg): void => {
      switch (msg.type) {
        case 'game-invite-received':
          setInvite({ inviteId: msg.inviteId, from: msg.from, side: msg.side, expiresAt: msg.expiresAt });
          break;
        case 'game-invite-result': {
          // 发出的邀请：收到任一回执即清"等待应答"横幅（每客户端同时最多一个）
          setOutgoing(null);
          // 收到的邀请：服务端作废（发起方离房/撤销）时按 inviteId 清横幅
          setInvite((prev) => (prev && prev.inviteId === msg.inviteId ? null : prev));
          if (msg.outcome === 'declined') showToast('对方拒绝了你的对局邀请');
          else if (msg.outcome === 'expired') showToast('对局邀请已过期');
          else if (msg.outcome === 'cancelled') showToast('对局邀请已取消');
          break;
        }
        case 'game-started':
          writeGame({
            gameId: msg.gameId,
            red: msg.red,
            black: msg.black,
            fen: msg.fen,
            turn: msg.turn,
            status: 'playing',
            lastMove: null,
            moveCount: 0,
            rematchBy: null,
            clocks: msg.clocks,
            notations: [],
            captured: { red: [], black: [] },
          });
          setInvite(null);
          setOutgoing(null);
          setDrawOfferFrom(null);
          setUndoOfferFrom(null);
          setEnded(null);
          break;
        case 'game-moved':
          patchGame(msg.gameId, (prev) => ({
            ...prev,
            fen: msg.fen,
            turn: msg.turn,
            status: msg.status,
            lastMove: msg.move,
            moveCount: msg.seq + 1,
            clocks: msg.clocks,
            notations: [...prev.notations, msg.notation],
            captured: appendCaptured(prev.captured, msg.move),
          }));
          setDrawOfferFrom(null);
          setUndoOfferFrom(null);
          break;
        case 'game-ended':
          patchGame(msg.gameId, (prev) => ({ ...prev, status: msg.result }));
          setDrawOfferFrom(null);
          setUndoOfferFrom(null);
          setEnded({ result: msg.result, reason: msg.reason });
          break;
        case 'game-snapshot': {
          /*
           * ★ **已经结束、且不是本端亲历的对局，一律不摆出来**（与安卓端
           *   `ChessGameController` 的同一条护栏对齐）。
           *
           * 服务端在"房间空掉 / 开下一局"之前**一直保留那一局的终局态**，而快照是
           * 成员 join 时补发的 → 不拦的话，"收起棋盘"只是把本端 state 置空，刷新 /
           * 重进房时这份快照又把早就结束的棋盘摆回眼前
           * （用户实测："收起棋盘每次进来怎么还能看见，刷新也是会出现棋盘"）。
           * 残局的归属是「对局记录」，不是房间面板。
           *
           * 判据用"手上有没有这一局"（gameRef 同 id）而不是时间戳：
           *  · 在房里看着它结束 → 手上一直有 → 照常恢复终局横幅（不然"结束了但既没有
           *    再来一局、也没有收起棋盘"= 死局，线上踩过）；
           *  · 冷启动 / 刷新 / 离房再进房 / 收起过 → 手上没有 → 忽略这条快照。
           * 进行中的对局**永远显示**（重进房要能接着观战 / 接着下）。
           *
           * 代价：终局残局不自动恢复就没有"再来一局"入口 —— 这是刻意的取舍，
           * 入口交给成员卡「对弈」（握手成功即开新局，服务端对已结束的对局不再拦截邀请）。
           */
          const known = gameRef.current;
          if (msg.status !== 'playing' && known?.gameId !== msg.gameId) break;
          writeGame({
            gameId: msg.gameId,
            red: msg.red,
            black: msg.black,
            fen: msg.fen,
            turn: msg.turn,
            status: msg.status,
            lastMove: msg.lastMove,
            moveCount: msg.moveCount,
            rematchBy: null,
            clocks: msg.clocks,
            notations: msg.notations,
            captured: msg.captured,
          });
          // 终局快照必须恢复 ended 横幅：否则刷新后"对局结束但没有
          // 再来一局/复盘/收起"，面板无法操作（线上实测卡死）
          setEnded(
            msg.status !== 'playing' ? { result: msg.status, reason: msg.endReason ?? 'agreement' } : null
          );
          break;
        }
        case 'game-draw-offered':
          setDrawOfferFrom(msg.from);
          break;
        case 'game-draw-declined':
          showToast('对方拒绝了求和');
          break;
        case 'game-undo-offered':
          setUndoOfferFrom(msg.from);
          break;
        case 'game-undo-declined':
          showToast('对方拒绝了你的悔棋请求');
          break;
        case 'game-rematch-offered': {
          const hold = gameRef.current;
          if (!hold || hold.gameId !== msg.gameId) {
            // 手上没有这一局（收起过 / 刷新过 / 后来才进房）：终局面板摆不出来，
            // 也就没有那颗"点击开始"的按钮。但**不能当没这回事** —— 对方那边正卡在
            // "等待对方再来一局…"，得让本端知道并给出可行的动作（成员卡「对弈」）。
            showToast('对方想再来一局：点成员卡上的「对弈」就能开新局');
            break;
          }
          writeGame({ ...hold, rematchBy: msg.from });
          break;
        }
        case 'game-rematch-reset':
          patchGame(msg.gameId, (prev) => ({ ...prev, rematchBy: null }));
          break;
        case 'game-undone':
          // 悔棋生效：全房按广播恢复盘面/棋钟/记谱/被吃子
          patchGame(msg.gameId, (prev) => ({
            ...prev,
            fen: msg.fen,
            turn: msg.turn,
            status: msg.status,
            lastMove: msg.lastMove,
            moveCount: msg.moveCount,
            clocks: msg.clocks,
            notations: msg.notations,
            captured: msg.captured,
          }));
          setDrawOfferFrom(null);
          setUndoOfferFrom(null);
          break;
        case 'game-paused':
        case 'game-resumed': {
          // 暂停/继续：clocks 是唯一事实来源（paused/deadline 都在里面），
          // 视图层不再单独维护 paused 字段
          const paused = msg.type === 'game-paused';
          patchGame(msg.gameId, (prev) => ({ ...prev, clocks: msg.clocks }));
          if (msg.by !== depsRef.current.getSelfUserId()) {
            showToast(paused ? '对方暂停了对局' : '对方继续了对局');
          }
          break;
        }
        case 'game-error':
          showToast(msg.message);
          break;
        default:
          break;
      }
    },
    [writeGame, patchGame]
  );

  const inviteUser = useCallback((toUserId: number, toName: string, side: ChessSideChoice) => {
    setOutgoing({ inviteId: `pending-${toUserId}`, toUserId, toName });
    depsRef.current.send({ type: 'game-invite', toUserId, side });
  }, []);

  const respondInvite = useCallback((inviteId: string, accept: boolean) => {
    setInvite(null);
    depsRef.current.send({ type: 'game-invite-respond', inviteId, accept });
  }, []);

  const cancelInvite = useCallback((inviteId: string) => {
    setOutgoing(null);
    depsRef.current.send({ type: 'game-invite-cancel', inviteId });
  }, []);

  const move = useCallback(
    (gameId: string, seq: number, from: { f: number; r: number }, to: { f: number; r: number }) => {
      depsRef.current.send({ type: 'game-move', gameId, seq, from, to });
    },
    []
  );

  const resign = useCallback((gameId: string) => {
    depsRef.current.send({ type: 'game-resign', gameId });
  }, []);

  const offerDraw = useCallback((gameId: string) => {
    depsRef.current.send({ type: 'game-draw-offer', gameId });
  }, []);

  const respondDraw = useCallback((gameId: string, accept: boolean) => {
    setDrawOfferFrom(null);
    depsRef.current.send({ type: 'game-draw-respond', gameId, accept });
  }, []);

  const offerUndo = useCallback((gameId: string) => {
    depsRef.current.send({ type: 'game-undo-offer', gameId });
  }, []);

  const respondUndo = useCallback((gameId: string, accept: boolean) => {
    setUndoOfferFrom(null);
    depsRef.current.send({ type: 'game-undo-respond', gameId, accept });
  }, []);

  const rematch = useCallback(
    (gameId: string) => {
      const self = depsRef.current.getSelfUserId();
      patchGame(gameId, (prev) => (prev.rematchBy === null ? { ...prev, rematchBy: self } : prev));
      depsRef.current.send({ type: 'game-rematch', gameId });
    },
    [patchGame]
  );

  const pause = useCallback((gameId: string) => {
    depsRef.current.send({ type: 'game-pause', gameId });
  }, []);

  const resume = useCallback((gameId: string) => {
    depsRef.current.send({ type: 'game-resume', gameId });
  }, []);

  const dismissEnded = useCallback(() => {
    writeGame(null);
    setEnded(null);
  }, [writeGame]);

  const openReview = useCallback((gameId?: string) => {
    setReviewGameId(gameId ?? null);
    setReviewOpen(true);
  }, []);

  const closeReview = useCallback(() => {
    setReviewOpen(false);
    setReviewGameId(null);
  }, []);

  const reset = useCallback(() => {
    writeGame(null);
    setInvite(null);
    setOutgoing(null);
    setDrawOfferFrom(null);
    setUndoOfferFrom(null);
    setEnded(null);
    setReviewOpen(false);
    setReviewGameId(null);
  }, [writeGame]);

  return useMemo(
    () => ({
      game,
      invite,
      outgoing,
      drawOfferFrom,
      undoOfferFrom,
      ended,
      showPanel: !!(game || invite || outgoing),
      reviewOpen,
      reviewGameId,
      /** 某用户在对局中执哪方（观战者 null）；面板据此判定 mySide/myTurn */
      mySideOf(userId: number): ChessSide | null {
        if (!game) return null;
        if (game.red.userId === userId) return 'red';
        if (game.black.userId === userId) return 'black';
        return null;
      },
      onChessMessage,
      inviteUser,
      respondInvite,
      cancelInvite,
      move,
      resign,
      offerDraw,
      respondDraw,
      offerUndo,
      respondUndo,
      rematch,
      pause,
      resume,
      dismissEnded,
      openReview,
      closeReview,
      reset,
    }),
    [
      game,
      invite,
      outgoing,
      drawOfferFrom,
      undoOfferFrom,
      ended,
      reviewOpen,
      reviewGameId,
      onChessMessage,
      offerUndo,
      respondUndo,
      rematch,
      pause,
      resume,
      openReview,
      closeReview,
      inviteUser,
      respondInvite,
      cancelInvite,
      move,
      resign,
      offerDraw,
      respondDraw,
      dismissEnded,
      reset,
    ]
  );
}
