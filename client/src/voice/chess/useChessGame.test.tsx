/**
 * ============================================================
 * 对战象棋客户端状态测试（voice/chess/useChessGame.test）
 * ============================================================
 * 用 renderHook + 受控 send/身份注入，覆盖服务端 game-* 消息到
 * 视图状态的映射与动作上行：
 * - 邀请生命周期：received → outgoing 横幅；result 回执清横幅并按
 *   declined/expired/cancelled 提示
 * - 对局：started 建盘（红先/初始盘面）、moved 增量更新（lastMove/seq）、
 *   ended 置终局横幅、snapshot 全量恢复
 * - 席位判定：mySideOf 按 red/black userId 命中，观战者 null
 * - 动作：inviteUser/move/resign/offerDraw/respondDraw 发出的上行消息形状
 * - reset：全部状态清空（离房复位）
 */

import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ChessGameMovedMsg, ChessGameServerMsg, ChessGameStartedMsg } from '@k/shared';
import { useChessGame } from './useChessGame';

// toast 是模块级单例（showToast 只在 <Toast/> 挂载后才入队），这里直接盯调用
vi.mock('../../components/ui/Toast', () => ({ showToast: vi.fn() }));
import { showToast } from '../../components/ui/Toast';

const ALICE = { userId: 1, username: 'alice', avatar: null };
const BOB = { userId: 2, username: 'bob', avatar: null };
const INITIAL_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w';

function makeHook(selfUserId: number) {
  const sent: unknown[] = [];
  const hook = renderHook(() =>
    useChessGame({
      getSelfUserId: () => selfUserId,
      send: (msg) => sent.push(msg),
    })
  );
  const feed = (msg: ChessGameServerMsg) => act(() => hook.result.current.onChessMessage(msg));
  return { hook, sent, feed };
}

const CLOCKS = { red: 600000, black: 600000, turnStartedAt: 1000, deadline: 90000 };

// 返回具体消息类型而不是联合：测试里用展开覆盖 clocks 时 TS 才能收窄成功
const startedMsg = (red = ALICE, black = BOB): ChessGameStartedMsg => ({
  type: 'game-started',
  gameId: 'g1',
  red,
  black,
  fen: INITIAL_FEN,
  turn: 'red',
  clocks: CLOCKS,
});

const movedMsg = (
  seq: number,
  turn: 'red' | 'black',
  status: 'playing' | 'red-win' = 'playing'
): ChessGameMovedMsg => ({
  type: 'game-moved',
  gameId: 'g1',
  seq,
  move: { from: { f: 7, r: 2 }, to: { f: 4, r: 2 }, piece: 'C', captured: null },
  fen: 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P4P1P1/1C2C4/9/RNBAKABNR b',
  turn,
  check: false,
  status,
  notation: '炮二平五',
  clocks: CLOCKS,
});

/** 进行中的快照（重进房/观战者后进房） */
const playingSnapshot = (gameId: string): ChessGameServerMsg => ({
  type: 'game-snapshot',
  gameId,
  red: ALICE,
  black: BOB,
  fen: INITIAL_FEN,
  turn: 'red',
  status: 'playing',
  lastMove: { from: { f: 0, r: 0 }, to: { f: 0, r: 1 }, piece: 'R', captured: null },
  moveCount: 3,
  endReason: null,
  clocks: CLOCKS,
  captured: { red: ['p'], black: [] },
  notations: ['兵九进一'],
});

/** 终局快照（服务端在"房间空掉 / 开下一局"之前一直保留那一局，join 时补发） */
const endedSnapshot = (
  gameId: string,
  status: 'red-win' | 'black-win' | 'draw' = 'black-win'
): ChessGameServerMsg => ({
  type: 'game-snapshot',
  gameId,
  red: ALICE,
  black: BOB,
  fen: INITIAL_FEN,
  turn: 'black',
  status,
  endReason: 'checkmate',
  lastMove: { from: { f: 7, r: 2 }, to: { f: 4, r: 6 }, piece: 'C', captured: 'p' },
  moveCount: 3,
  clocks: CLOCKS,
  captured: { red: ['p'], black: [] },
  notations: ['炮二平五', '卒3进1', '炮五进四'],
});

describe('useChessGame', () => {
  it('空闲态：showPanel=false，面板不渲染', () => {
    const { hook } = makeHook(1);
    expect(hook.result.current.showPanel).toBe(false);
    expect(hook.result.current.game).toBeNull();
  });

  it('收到邀请：invite 就位；回执 declined 清横幅并提示', () => {
    const { hook, feed } = makeHook(1);
    feed({
      type: 'game-invite-received',
      inviteId: 'inv1',
      from: BOB,
      side: 'red',
      expiresAt: Date.now() + 30000,
    });
    expect(hook.result.current.showPanel).toBe(true);
    expect(hook.result.current.invite?.inviteId).toBe('inv1');

    // 不匹配的回执不影响已收到的邀请
    feed({ type: 'game-invite-result', inviteId: 'inv-other', outcome: 'declined' });
    expect(hook.result.current.invite?.inviteId).toBe('inv1');

    // 匹配的作废回执（发起方离房/撤销）清掉横幅
    feed({ type: 'game-invite-result', inviteId: 'inv1', outcome: 'cancelled' });
    expect(hook.result.current.invite).toBeNull();
  });

  it('开局：game 建盘并清邀请横幅；moved 增量更新；ended 置终局', () => {
    const { hook, feed } = makeHook(1);
    feed(startedMsg());
    expect(hook.result.current.game).toMatchObject({
      gameId: 'g1',
      turn: 'red',
      status: 'playing',
      moveCount: 0,
      lastMove: null,
    });
    expect(hook.result.current.mySideOf(1)).toBe('red');
    expect(hook.result.current.mySideOf(2)).toBe('black');
    expect(hook.result.current.mySideOf(99)).toBeNull();

    feed(movedMsg(0, 'black'));
    expect(hook.result.current.game).toMatchObject({
      turn: 'black',
      moveCount: 1,
      lastMove: { from: { f: 7, r: 2 }, to: { f: 4, r: 2 } },
    });

    feed({ type: 'game-ended', gameId: 'g1', result: 'red-win', reason: 'resign' });
    expect(hook.result.current.game?.status).toBe('red-win');
    expect(hook.result.current.ended).toEqual({ result: 'red-win', reason: 'resign' });

    // 终局后关闭面板 → 回到空闲
    act(() => hook.result.current.dismissEnded());
    expect(hook.result.current.showPanel).toBe(false);
  });

  it('快照恢复：断线重连/观战者后进房以快照为准', () => {
    const { hook, feed } = makeHook(99); // 观战者
    feed({
      type: 'game-snapshot',
      gameId: 'g9',
      red: ALICE,
      black: BOB,
      fen: INITIAL_FEN,
      turn: 'red',
      status: 'playing',
      lastMove: { from: { f: 0, r: 0 }, to: { f: 0, r: 1 }, piece: 'R', captured: null },
      moveCount: 3,
      endReason: null,
      clocks: CLOCKS,
      captured: { red: ['p'], black: [] },
      notations: ['兵九进一'],
    });
    expect(hook.result.current.game).toMatchObject({
      gameId: 'g9',
      moveCount: 3,
      notations: ['兵九进一'],
      captured: { red: ['p'], black: [] },
    });
    expect(hook.result.current.mySideOf(99)).toBeNull();
  });

  it('动作上行：邀请/走子/认输/求和的消息形状正确', () => {
    const { hook, sent } = makeHook(1);
    act(() => hook.result.current.inviteUser(2, 'bob', 'random'));
    expect(sent[sent.length - 1]).toEqual({ type: 'game-invite', toUserId: 2, side: 'random' });
    expect(hook.result.current.outgoing).toMatchObject({ toUserId: 2, toName: 'bob' });

    act(() => hook.result.current.move('g1', 0, { f: 7, r: 2 }, { f: 4, r: 2 }));
    expect(sent[sent.length - 1]).toEqual({
      type: 'game-move',
      gameId: 'g1',
      seq: 0,
      from: { f: 7, r: 2 },
      to: { f: 4, r: 2 },
    });

    act(() => hook.result.current.offerDraw('g1'));
    expect(sent[sent.length - 1]).toEqual({ type: 'game-draw-offer', gameId: 'g1' });
    act(() => hook.result.current.respondDraw('g1', false));
    expect(sent[sent.length - 1]).toEqual({ type: 'game-draw-respond', gameId: 'g1', accept: false });
    act(() => hook.result.current.resign('g1'));
    expect(sent[sent.length - 1]).toEqual({ type: 'game-resign', gameId: 'g1' });
    act(() => hook.result.current.respondInvite('inv1', true));
    expect(sent[sent.length - 1]).toEqual({ type: 'game-invite-respond', inviteId: 'inv1', accept: true });
    act(() => hook.result.current.cancelInvite('pending-2'));
    expect(sent[sent.length - 1]).toEqual({ type: 'game-invite-cancel', inviteId: 'pending-2' });
  });

  it('reset：清空全部状态（离房复位）', () => {
    const { hook, feed } = makeHook(1);
    feed(startedMsg());
    feed(movedMsg(0, 'black'));
    act(() => hook.result.current.reset());
    expect(hook.result.current).toMatchObject({
      game: null,
      invite: null,
      outgoing: null,
      drawOfferFrom: null,
      ended: null,
      showPanel: false,
    });
  });

  it('game-error：不影响既有状态（原因经 toast 提示）', () => {
    const { hook, feed } = makeHook(1);
    feed(startedMsg());
    expect(() => feed({ type: 'game-error', code: 'not-your-turn', message: '还没轮到你' })).not.toThrow();
    expect(hook.result.current.game?.gameId).toBe('g1');
  });
});

describe('useChessGame 二期（棋钟/记谱/被吃子/悔棋）', () => {
  it('moved：记谱追加、被吃子累积、时钟更新', () => {
    const { hook, feed } = makeHook(1);
    feed(startedMsg());
    feed({
      type: 'game-moved',
      gameId: 'g1',
      seq: 0,
      move: { from: { f: 7, r: 2 }, to: { f: 4, r: 2 }, piece: 'C', captured: 'p' },
      fen: 'x b',
      turn: 'black',
      check: false,
      status: 'playing',
      notation: '炮二平五',
      clocks: { red: 590000, black: 600000, turnStartedAt: 2000, deadline: 89000 },
    });
    expect(hook.result.current.game).toMatchObject({
      moveCount: 1,
      notations: ['炮二平五'],
      clocks: { red: 590000, turnStartedAt: 2000 },
      captured: { red: ['p'], black: [] },
    });
  });

  it('悔棋：offered 置横幅；undone 恢复盘面/记谱/被吃子', () => {
    const { hook, feed } = makeHook(1);
    feed(startedMsg());
    feed(movedMsg(0, 'black'));
    feed({
      type: 'game-undo-offered',
      gameId: 'g1',
      from: 2,
    });
    expect(hook.result.current.undoOfferFrom).toBe(2);

    feed({
      type: 'game-undone',
      gameId: 'g1',
      fen: INITIAL_FEN,
      turn: 'red',
      status: 'playing',
      lastMove: null,
      moveCount: 0,
      clocks: CLOCKS,
      captured: { red: [], black: [] },
      notations: [],
    });
    expect(hook.result.current.game).toMatchObject({
      moveCount: 0,
      turn: 'red',
      notations: [],
      captured: { red: [], black: [] },
    });
    expect(hook.result.current.undoOfferFrom).toBeNull();
  });

  it('悔棋动作上行消息形状正确', () => {
    const { hook, sent } = makeHook(1);
    act(() => hook.result.current.offerUndo('g1'));
    expect(sent[sent.length - 1]).toEqual({ type: 'game-undo-offer', gameId: 'g1' });
    act(() => hook.result.current.respondUndo('g1', true));
    expect(sent[sent.length - 1]).toEqual({ type: 'game-undo-respond', gameId: 'g1', accept: true });
  });

  it('复盘弹窗状态：openReview/closeReview/reviewGameId；reset 一并关闭', () => {
    const { hook } = makeHook(1);
    expect(hook.result.current.reviewOpen).toBe(false);
    act(() => hook.result.current.openReview());
    expect(hook.result.current.reviewOpen).toBe(true);
    expect(hook.result.current.reviewGameId).toBeNull();
    act(() => hook.result.current.closeReview());
    expect(hook.result.current.reviewOpen).toBe(false);
    act(() => hook.result.current.openReview('g9'));
    expect(hook.result.current.reviewGameId).toBe('g9');
    act(() => hook.result.current.reset());
    expect(hook.result.current.reviewOpen).toBe(false);
    expect(hook.result.current.reviewGameId).toBeNull();
  });

  it('再来一局：offered/reset 映射、动作上行（乐观置位）', () => {
    const { hook, sent, feed } = makeHook(1);
    feed(startedMsg());
    feed(movedMsg(0, 'black'));
    feed({ type: 'game-rematch-offered', gameId: 'g1', from: 2 });
    expect(hook.result.current.game?.rematchBy).toBe(2);
    feed({ type: 'game-rematch-reset', gameId: 'g1' });
    expect(hook.result.current.game?.rematchBy).toBeNull();

    act(() => hook.result.current.rematch('g1'));
    expect(sent[sent.length - 1]).toEqual({ type: 'game-rematch', gameId: 'g1' });
    expect(hook.result.current.game?.rematchBy).toBe(1); // 乐观置位：按钮立即转"等待对方"
  });

  it('本端亲历的同一局：终局快照照常恢复（否则"结束了既没再来一局、也没收起"= 死局）', () => {
    const { hook, feed } = makeHook(1);
    feed(startedMsg());
    feed(endedSnapshot('g1'));
    expect(hook.result.current.game?.status).toBe('black-win');
    expect(hook.result.current.ended).toEqual({ result: 'black-win', reason: 'checkmate' });
    // 关闭横幅后回到空闲入口条
    act(() => hook.result.current.dismissEnded());
    expect(hook.result.current.showPanel).toBe(false);
  });

  it('undo-declined / ended（timeout）不影响既有状态', () => {
    const { hook, feed } = makeHook(1);
    feed(startedMsg());
    feed(movedMsg(0, 'black'));
    feed({ type: 'game-undo-declined', gameId: 'g1', by: 2 });
    feed({ type: 'game-ended', gameId: 'g1', result: 'black-win', reason: 'timeout' });
    expect(hook.result.current.game?.status).toBe('black-win');
    expect(hook.result.current.ended).toEqual({ result: 'black-win', reason: 'timeout' });
  });
});

/**
 * 终局残局护栏：**只有本端亲历的那一局才摆出来**。
 *
 * 服务端在"房间空掉 / 开下一局"之前一直保留那一局的终局态，而 `game-snapshot` 是
 * 成员 join 时补发的 → 不拦的话，"收起棋盘"只是把本端 state 置空，刷新 / 离房再
 * 进房时这份快照又把早就结束的棋盘摆回眼前
 * （用户实测："收起棋盘每次进来怎么还能看见，刷新也是会出现棋盘"）。
 * 安卓端 `ChessGameController` 从一期起就有这条护栏（`ChessGameControllerTest`
 * 的"收起棋盘后再收到同一局的终局快照 不会弹回来"），web 端一直漏了。
 */
describe('useChessGame 终局残局护栏（只摆本端亲历的那一局）', () => {
  it('收起棋盘后再收到同一局的终局快照：不会弹回来', () => {
    const { hook, feed } = makeHook(1);
    feed(startedMsg());
    feed({ type: 'game-ended', gameId: 'g1', result: 'black-win', reason: 'checkmate' });
    expect(hook.result.current.showPanel).toBe(true);

    act(() => hook.result.current.dismissEnded());
    expect(hook.result.current.showPanel).toBe(false);
    expect(hook.result.current.ended).toBeNull();

    // 之后重连 / 重进房补发的同一局终局快照必须被忽略
    feed(endedSnapshot('g1'));
    expect(hook.result.current.game).toBeNull();
    expect(hook.result.current.ended).toBeNull();
    expect(hook.result.current.showPanel).toBe(false);
  });

  it('冷启动进房：手上没有这一局 → 终局快照一律忽略（残局归"对局记录"）', () => {
    const { hook, feed } = makeHook(1); // 全新会话：什么都没收到过
    feed(endedSnapshot('cold-1'));
    expect(hook.result.current.game).toBeNull();
    expect(hook.result.current.ended).toBeNull();
    expect(hook.result.current.showPanel).toBe(false);
  });

  it('进行中的快照永远摆出来（重进房要能接着观战 / 接着下）', () => {
    const { hook, feed } = makeHook(2); // 掉线重连 / 后进房的观战者
    feed(playingSnapshot('g-live'));
    expect(hook.result.current.game?.gameId).toBe('g-live');
    expect(hook.result.current.game?.status).toBe('playing');
    expect(hook.result.current.ended).toBeNull();
    expect(hook.result.current.showPanel).toBe(true);
  });

  it('对方想再来一局、而本端手上没有这一局：不摆面板，但告诉他怎么开新局', () => {
    const { hook, feed } = makeHook(1); // 收起过 / 刷新过：手上什么都没有
    vi.mocked(showToast).mockClear();
    feed({ type: 'game-rematch-offered', gameId: 'gone', from: 2 });
    expect(hook.result.current.game).toBeNull();
    expect(hook.result.current.showPanel).toBe(false);
    // 对方那边正卡在"等待对方再来一局…"：不能默默丢掉这条消息
    expect(vi.mocked(showToast)).toHaveBeenCalledWith('对方想再来一局：点成员卡上的「对弈」就能开新局');
  });
});

describe('useChessGame 三期（暂停/继续）', () => {
  it('game-paused/resumed：clocks 整体替换（paused 视图随之），对局其余状态不动', () => {
    const { hook, feed } = makeHook(1);
    feed(startedMsg());
    feed(movedMsg(0, 'black'));

    feed({
      type: 'game-paused',
      gameId: 'g1',
      by: 2,
      clocks: { red: 590000, black: 600000, turnStartedAt: 2000, deadline: 0, paused: true },
    });
    expect(hook.result.current.game?.clocks).toMatchObject({ red: 590000, paused: true, deadline: 0 });
    expect(hook.result.current.game?.status).toBe('playing');
    expect(hook.result.current.game?.moveCount).toBe(1);

    feed({
      type: 'game-resumed',
      gameId: 'g1',
      by: 2,
      clocks: { red: 590000, black: 600000, turnStartedAt: 9000, deadline: 99000, paused: false },
    });
    expect(hook.result.current.game?.clocks).toMatchObject({ deadline: 99000, paused: false });
  });

  it('非本局的暂停广播不落状态', () => {
    const { hook, feed } = makeHook(1);
    feed(startedMsg());
    feed({
      type: 'game-paused',
      gameId: 'other',
      by: 2,
      clocks: { red: 1, black: 1, turnStartedAt: 0, deadline: 0, paused: true },
    });
    expect(hook.result.current.game?.clocks.paused).toBeUndefined();
  });

  it('pause/resume 动作上行消息形状正确', () => {
    const { hook, sent } = makeHook(1);
    act(() => hook.result.current.pause('g1'));
    expect(sent[sent.length - 1]).toEqual({ type: 'game-pause', gameId: 'g1' });
    act(() => hook.result.current.resume('g1'));
    expect(sent[sent.length - 1]).toEqual({ type: 'game-resume', gameId: 'g1' });
  });
});

describe('useChessGame 棋钟对表（serverNow）', () => {
  it('带 serverNow 的 clocks 到达时记录钟差（服务端封包时刻 - 本机此刻）', () => {
    const { hook, feed } = makeHook(1);
    const skew = 55_000; // 模拟服务端比本机快 55 秒
    feed({ ...startedMsg(), clocks: { ...CLOCKS, serverNow: Date.now() + skew } });
    // 到达那一刻记下的偏差：处理耗时只有几毫秒，误差远小于 1 秒
    expect(hook.result.current.clockOffset).toBeGreaterThan(skew - 1_000);
    expect(hook.result.current.clockOffset).toBeLessThanOrEqual(skew);

    // 每条带 clocks 的消息都刷新（game-moved 带来新的 serverNow 就以它为准）
    feed({ ...movedMsg(0, 'black'), clocks: { ...CLOCKS, serverNow: Date.now() + skew / 5 } });
    expect(hook.result.current.clockOffset).toBeGreaterThan(skew / 5 - 1_000);
    expect(hook.result.current.clockOffset).toBeLessThanOrEqual(skew / 5);
  });

  it('旧服务端不带 serverNow 时钟差保持 0（退回本机口径）', () => {
    const { hook, feed } = makeHook(1);
    feed(startedMsg());
    expect(hook.result.current.clockOffset).toBe(0);
  });
});
