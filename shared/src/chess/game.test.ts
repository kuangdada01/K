/**
 * ============================================================
 * 象棋引擎测试
 * ============================================================
 * - FEN 编解码：初始局面、往返一致、非法串报错
 * - 走法特例：蹩马腿、塞象眼、象不过河、炮翻山、仕帅九宫、兵过河
 * - 合法性：送将禁手（牵制）、将帅照面禁手
 * - 终局：将死、困毙（中国象棋判负而非和）、三次重复局面判和、子力不足判和
 * - perft 基准：初始局面 44 / 1920 / 79666（公开标准值，锁死走法生成正确性）
 *
 * 测试用 FEN 均为手工构造并逐子核验过的最小局面（构造过程见各用例注释）。
 * 坐标：f 0-8 纵线、r 0-9 横线（0=红方底线）；FEN 从 r=9 排到 r=0。
 */

import { describe, expect, it } from 'vitest';
import { boardToFen, parseFen, CHESS_INITIAL_FEN, pieceSide } from './fen';
import { applyToBoard, at, legalMoves, isInCheck, pseudoMovesFrom } from './index';
import { applyMove, createInitialGameState, positionKey, undoMove } from './game';
import { moveToChineseNotation } from './notation';
import type { ChessBoard, ChessGameState, ChessSquare } from './types';

const sq = (f: number, r: number): ChessSquare => ({ f, r });

/** 落点集合转排序后的 "f,r" 键数组（单字符坐标，字典序即数值序），便于全等比较 */
function toKeys(moves: ReturnType<typeof pseudoMovesFrom>): string[] {
  return moves.map((m) => `${m.to.f},${m.to.r}`).sort();
}

/** 从 FEN 直接构造"进行中"对局状态（终局判定测试用） */
function stateFromFen(fen: string): ChessGameState {
  const { board, turn } = parseFen(fen);
  return {
    board,
    turn,
    status: 'playing',
    statusReason: null,
    moves: [],
    checkFlags: [],
    positionKeys: [positionKey(board, turn)],
  };
}

function perft(board: ChessBoard, turn: 'red' | 'black', depth: number): number {
  if (depth === 0) return 1;
  let n = 0;
  for (const m of legalMoves(board, turn)) {
    n += perft(applyToBoard(board, m), turn === 'red' ? 'black' : 'red', depth - 1);
  }
  return n;
}

describe('FEN 编解码', () => {
  it('初始局面解析：32 子、红黑各 16、红先', () => {
    const { board, turn } = parseFen(CHESS_INITIAL_FEN);
    expect(turn).toBe('red');
    const pieces = board.filter((p) => p !== null);
    expect(pieces).toHaveLength(32);
    expect(pieces.filter((p) => pieceSide(p!) === 'red').length).toBe(16);
    expect(at(board, 4, 0)).toBe('K');
    expect(at(board, 4, 9)).toBe('k');
    expect(at(board, 1, 2)).toBe('C');
    expect(at(board, 0, 3)).toBe('P');
    expect(at(board, 0, 6)).toBe('p');
  });

  it('FEN 往返一致（初始局面 + 中盘局面）', () => {
    expect(boardToFen(parseFen(CHESS_INITIAL_FEN).board, 'red')).toBe(CHESS_INITIAL_FEN);
    const mid = '2r1ak3/4a4/4b4/9/9/9/9/4B4/4A4/2R1K4 b';
    const parsed = parseFen(mid);
    expect(boardToFen(parsed.board, parsed.turn)).toBe(mid);
  });

  it('非法 FEN 报错：行数/未知字符/行棋方', () => {
    expect(() => parseFen('rnbakabnr w')).toThrow();
    expect(() => parseFen('rnbakabnr/9/9/9/9/9/9/9/9/RNBKABNR w')).toThrow(); // 末行列数≠9
    expect(() => parseFen('x9/9/9/9/9/9/9/9/9/9 w')).toThrow();
    expect(() => parseFen('9/9/9/9/9/9/9/9/9/9 x')).toThrow();
  });
});

describe('走法特例', () => {
  it('蹩马腿：腿位有子则两个跳位不可达，其余跳位正常', () => {
    // 红马 (4,4)，腿位 (4,5) 放红兵：跳 (3,6)/(5,6) 被蹩；其余 6 个跳位正常
    const { board } = parseFen('9/9/9/9/4P4/4N4/9/9/9/9 w');
    expect(toKeys(pseudoMovesFrom(board, sq(4, 4)))).toEqual(['2,3', '2,5', '3,2', '5,2', '6,3', '6,5']);
  });

  it('塞象眼与象不过河：中点有子不可飞', () => {
    // 红相 (2,0)：飞 (4,2) 的眼 (3,1) 被红仕占 → 只能飞 (0,2)
    const { board } = parseFen('9/9/9/9/9/9/9/9/3A5/2B1K4 w');
    expect(toKeys(pseudoMovesFrom(board, sq(2, 0)))).toEqual(['0,2']);
  });

  it('炮翻山：无屏风不吃、隔恰一子才吃、隔两子不吃', () => {
    const captures = (board: ChessBoard) =>
      pseudoMovesFrom(board, sq(4, 4))
        .filter((m) => m.captured !== null)
        .map((m) => `${m.to.f},${m.to.r}:${m.captured}`)
        .sort();
    // 无屏风：红炮 (4,4) 只滑行不吃（黑将 (4,9) 也不能隔空吃）
    const noScreen = parseFen('4k4/9/9/9/9/4C4/9/9/9/9 w');
    expect(captures(noScreen.board)).toEqual([]);
    // 恰一子屏风（红兵 (4,6)）：吃屏风后第一子黑卒 (4,8)
    const oneScreen = parseFen('4k4/4p4/9/4P4/9/4C4/9/9/9/9 w');
    expect(captures(oneScreen.board)).toEqual(['4,8:p']);
    // 两子屏风（红兵 (4,6) + 红兵 (4,7)）：屏风后第一子是己方 → 不吃
    const twoScreens = parseFen('4k4/4p4/4P4/4P4/9/4C4/9/9/9/9 w');
    expect(captures(twoScreens.board)).toEqual([]);
  });

  it('帅不出九宫、仕不出九宫', () => {
    const { board } = parseFen('9/9/9/9/9/9/9/9/9/4K4 w');
    expect(toKeys(pseudoMovesFrom(board, sq(4, 0)))).toEqual(['3,0', '4,1', '5,0']);
    const { board: b2 } = parseFen('9/9/9/9/9/9/9/9/9/3A1K3 w');
    expect(toKeys(pseudoMovesFrom(b2, sq(3, 0)))).toEqual(['4,1']);
  });

  it('兵：过河前只进；过河后可横移；永不后退', () => {
    // 红兵 (4,3) 未过河：只能进 (4,4)
    const before = parseFen('9/9/9/9/9/9/4P4/9/9/9 w');
    expect(toKeys(pseudoMovesFrom(before.board, sq(4, 3)))).toEqual(['4,4']);
    // 红兵 (4,6) 已过河：进 (4,7) + 横移 (3,6)/(5,6)
    const after = parseFen('9/9/9/4P4/9/9/9/9/9/9 w');
    expect(toKeys(pseudoMovesFrom(after.board, sq(4, 6)))).toEqual(['3,6', '4,7', '5,6']);
    // 黑卒 (4,5) 未过河（黑 r<=4 才算过河）：只能进 (4,4)
    const blackBefore = parseFen('9/9/9/9/4p4/9/9/9/9/9 w');
    expect(toKeys(pseudoMovesFrom(blackBefore.board, sq(4, 5)))).toEqual(['4,4']);
  });
});

describe('将军判定', () => {
  it('马攻击与蹩腿影响将军判定', () => {
    // 红马 (2,8) 攻击黑将 (4,9)，腿位 (3,8)
    const checked = parseFen('4k4/2N6/9/9/9/9/9/9/9/7K1 w');
    expect(isInCheck(checked.board, 'black')).toBe(true);
    // 腿位 (3,8) 放黑子 → 蹩腿，不再将军
    const blocked = parseFen('4k4/2Nb5/9/9/9/9/9/9/9/7K1 w');
    expect(isInCheck(blocked.board, 'black')).toBe(false);
  });

  it('炮将军需要恰一子屏风', () => {
    // 黑仕 (4,8) 作屏风，红炮 (4,4) 将军黑将 (4,9)
    const checked = parseFen('4k4/4a4/9/9/9/4C4/9/9/9/9 w');
    expect(isInCheck(checked.board, 'black')).toBe(true);
    // 无屏风：炮不将军
    const noScreen = parseFen('4k4/9/9/9/9/4C4/9/9/9/9 w');
    expect(isInCheck(noScreen.board, 'black')).toBe(false);
  });

  it('兵的攻击：正前方一格；过河兵才有侧向攻击', () => {
    // 过河红兵 (4,8) 正前攻击黑将 (4,9)
    const front = parseFen('4k4/4P4/9/9/9/9/9/9/9/4K4 w');
    expect(isInCheck(front.board, 'black')).toBe(true);
    // 过河红兵 (4,6) 侧向攻击 (3,6) 处的黑将
    const side = parseFen('9/9/9/3kP4/9/9/9/9/9/9 w');
    expect(isInCheck(side.board, 'black')).toBe(true);
    // 未过河红兵 (4,1) 无侧向攻击：(3,1) 处黑将不被攻击
    const notCrossed = parseFen('9/9/9/9/9/9/9/3k5/4P4/9 w');
    expect(isInCheck(notCrossed.board, 'black')).toBe(false);
  });
});

describe('合法性与禁手', () => {
  it('送将禁手：被牵制的车不能离开将军线，沿线移动合法', () => {
    // 红帅 (3,0)、红车 (3,1)、黑车 (3,9)、黑将 (4,9)：
    // 红车被黑车牵制——横移离线即暴露红帅；纵向沿线移动仍挡线 → 只能沿 3 线走
    const { board } = parseFen('3rk4/9/9/9/9/9/9/9/3R5/3K5 w');
    const rookTos = legalMoves(board, 'red')
      .filter((m) => m.from.f === 3 && m.from.r === 1)
      .map((m) => m.to);
    expect(rookTos.every((t) => t.f === 3)).toBe(true);
    expect(rookTos.some((t) => t.r >= 2 && t.r <= 8)).toBe(true);
  });

  it('将帅照面禁手：同线无遮挡时，离开遮挡线的着法非法', () => {
    // 红帅 (4,1)、红兵 (4,6)（遮挡）、黑将 (4,9)：兵横移即照面 → 只能进 (4,7)
    const { board } = parseFen('4k4/9/9/4P4/9/9/9/9/4K4/9 w');
    const pawnTos = legalMoves(board, 'red')
      .filter((m) => m.piece === 'P')
      .map((m) => m.to);
    expect(pawnTos).toEqual([sq(4, 7)]);
  });
});

describe('终局判定', () => {
  it('初始局面：红先 44 步，perft(2)=1920，perft(3)=79666', () => {
    const { board, turn } = parseFen(CHESS_INITIAL_FEN);
    expect(legalMoves(board, turn)).toHaveLength(44);
    expect(perft(board, 'red', 2)).toBe(1920);
    expect(perft(board, 'red', 3)).toBe(79666);
  });

  it('将死判负', () => {
    // 黑将 (3,9)；红车 (4,4)→(4,9) 将军：该車被 (4,0) 車保护（不可吃），
    // 逃点 (3,8) 被 (0,8) 車控制 → 将死
    const state = stateFromFen('3k5/R8/9/9/9/4R4/9/9/9/4R3K w');
    const next = applyMove(state, sq(4, 4), sq(4, 9));
    expect(next).not.toBeNull();
    expect(next!.status).toBe('red-win');
    expect(next!.statusReason).toBe('checkmate');
  });

  it('困毙判负（中国象棋无子可走 = 输，不是逼和）', () => {
    // 黑将 (3,9)；红兵 (4,7)→(4,8)：黑将两个逃点 (4,9)/(3,8) 均被兵控制，
    // 且黑将未被将军 → 困毙
    const state = stateFromFen('3k5/9/4P4/9/9/9/9/9/9/5K3 w');
    const next = applyMove(state, sq(4, 7), sq(4, 8));
    expect(next).not.toBeNull();
    expect(next!.status).toBe('red-win');
    expect(next!.statusReason).toBe('stalemate');
  });

  it('三次重复局面判和', () => {
    // 双炮在两条空线上来回：第 8 步回到初始局面（第 3 次）→ 判和
    const seq: Array<[ChessSquare, ChessSquare]> = [
      [sq(1, 2), sq(1, 5)],
      [sq(7, 7), sq(7, 4)],
      [sq(1, 5), sq(1, 2)],
      [sq(7, 4), sq(7, 7)],
      [sq(1, 2), sq(1, 5)],
      [sq(7, 7), sq(7, 4)],
      [sq(1, 5), sq(1, 2)],
      [sq(7, 4), sq(7, 7)],
    ];
    let last = createInitialGameState();
    for (let i = 0; i < seq.length; i++) {
      const next = applyMove(last, seq[i]![0], seq[i]![1]);
      expect(next).not.toBeNull();
      last = next!;
      if (i < seq.length - 1) expect(last.status).toBe('playing');
    }
    expect(last.status).toBe('draw');
    expect(last.statusReason).toBe('repetition');
  });

  it('双方均无进攻子力判和', () => {
    // 红帅 (4,0)+红仕 (3,0)，黑将 (3,9)+黑士 (4,9)：一步后双方仅剩帅/仕/士 → 判和
    const state = stateFromFen('3ka4/9/9/9/9/9/9/9/9/3AK4 w');
    const next = applyMove(state, sq(3, 0), sq(4, 1));
    expect(next).not.toBeNull();
    expect(next!.status).toBe('draw');
    expect(next!.statusReason).toBe('insufficient');
  });

  it('applyMove：非法着法返回 null；合法着法不改动入参状态', () => {
    const state = createInitialGameState();
    const before = boardToFen(state.board, state.turn);
    // 帅走两步：非法
    expect(applyMove(state, sq(4, 0), sq(4, 2))).toBeNull();
    // 相飞越河：非法
    expect(applyMove(state, sq(2, 0), sq(4, 4))).toBeNull();
    // 炮 (1,2)→(1,5)：合法
    const next = applyMove(state, sq(1, 2), sq(1, 5));
    expect(next).not.toBeNull();
    expect(next!.turn).toBe('black');
    expect(next!.moves).toHaveLength(1);
    expect(boardToFen(state.board, state.turn)).toBe(before);
    expect(state.moves).toHaveLength(0);
  });
});

describe('悔棋回退（undoMove）', () => {
  it('撤 1 着（对方未应手）：回到自己走前的局面', () => {
    let state = createInitialGameState();
    state = applyMove(state, sq(1, 2), sq(1, 5))!;
    expect(state.moves).toHaveLength(1);
    const undone = undoMove(state, 1)!;
    expect(undone.moves).toHaveLength(0);
    expect(undone.turn).toBe('red');
    expect(undone.status).toBe('playing');
    expect(undone.positionKeys).toHaveLength(1);
    expect(boardToFen(undone.board, undone.turn)).toBe(CHESS_INITIAL_FEN);
  });

  it('撤 2 着（对方已应手）：连同对方应手一并撤销', () => {
    let state = createInitialGameState();
    state = applyMove(state, sq(1, 2), sq(1, 5))!;
    state = applyMove(state, sq(7, 7), sq(7, 4))!;
    expect(state.moves).toHaveLength(2);
    const undone = undoMove(state, 2)!;
    expect(undone.moves).toHaveLength(0);
    expect(undone.turn).toBe('red');
    expect(boardToFen(undone.board, undone.turn)).toBe(CHESS_INITIAL_FEN);
  });

  it('撤 1 着（对方已应手时只撤对方）：轮次随之翻转', () => {
    let state = createInitialGameState();
    state = applyMove(state, sq(1, 2), sq(1, 5))!;
    state = applyMove(state, sq(7, 7), sq(7, 4))!;
    const undone = undoMove(state, 1)!;
    expect(undone.moves).toHaveLength(1);
    expect(undone.turn).toBe('black');
  });

  it('超出历史长度 / 非法入参返回 null', () => {
    const state = createInitialGameState();
    expect(undoMove(state, 1)).toBeNull();
    expect(undoMove(state, 0)).toBeNull();
    const one = applyMove(state, sq(1, 2), sq(1, 5))!;
    expect(undoMove(one, 2)).toBeNull();
  });
});

describe('长将判负（三次重复 + 循环内每着都将）', () => {
  it('红车循环长将：第 3 次重复时红方判负（而非判和）', () => {
    // 黑将 (3,9)、红车 (4,9)（正将军）、红帅 (7,0)。
    // 循环节 = 黑将横移 + 红车跟将（4 着），第 3 次出现同串局面在第 10 着；
    // 循环内红方每着都是将军 → 红长将判负（黑胜）。
    const state = stateFromFen('3kR4/9/9/9/9/9/9/9/9/7K1 b');
    const seq: Array<[ChessSquare, ChessSquare]> = [
      [sq(3, 9), sq(3, 8)], // 黑将避将
      [sq(4, 9), sq(3, 9)], // 红车跟将（将军）
      [sq(3, 8), sq(4, 8)], // 黑将避将
      [sq(3, 9), sq(4, 9)], // 红车跟将（将军）
      [sq(4, 8), sq(3, 8)],
      [sq(4, 9), sq(3, 9)],
      [sq(3, 8), sq(4, 8)],
      [sq(3, 9), sq(4, 9)],
      [sq(4, 8), sq(3, 8)], // 第 9 着后：红方视角局面第 3 次出现 → 长将裁决
    ];
    let last = state;
    for (let i = 0; i < seq.length; i++) {
      const next = applyMove(last, seq[i]![0], seq[i]![1]);
      expect(next, `第 ${i + 1} 着`).not.toBeNull();
      last = next!;
      if (i < seq.length - 1) expect(last.status).toBe('playing');
    }
    expect(last.status).toBe('black-win');
    expect(last.statusReason).toBe('perpetual');
  });
});

describe('中文记谱（moveToChineseNotation）', () => {
  it('炮二平五（红炮 (7,2)→(4,2)）', () => {
    const { board } = parseFen(CHESS_INITIAL_FEN);
    expect(moveToChineseNotation(board, { from: sq(7, 2), to: sq(4, 2), piece: 'C', captured: null })).toBe(
      '炮二平五'
    );
  });

  it('马8进7（黑马 (1,9)→(2,7)，黑方用阿拉伯数字）', () => {
    const { board } = parseFen(CHESS_INITIAL_FEN);
    expect(moveToChineseNotation(board, { from: sq(1, 9), to: sq(2, 7), piece: 'n', captured: null })).toBe(
      '马8进7'
    );
  });

  it('兵九进一 / 帅五进一（直行子进退跟步数，红方汉字）', () => {
    const { board } = parseFen(CHESS_INITIAL_FEN);
    expect(moveToChineseNotation(board, { from: sq(0, 3), to: sq(0, 4), piece: 'P', captured: null })).toBe(
      '兵九进一'
    );
    expect(moveToChineseNotation(board, { from: sq(4, 0), to: sq(4, 1), piece: 'K', captured: null })).toBe(
      '帅五进一'
    );
  });

  it('车二进四式：直行子进退的步数（红车 (7,0)→(7,4)）', () => {
    const { board } = parseFen(CHESS_INITIAL_FEN);
    // 红车 (7,0) 直进 4 步到 (7,4)：纵线二（9-7=2），进四
    expect(moveToChineseNotation(board, { from: sq(7, 0), to: sq(7, 4), piece: 'R', captured: null })).toBe(
      '车二进四'
    );
  });

  it('同线双车消歧：前车/后车且省略原纵线', () => {
    // 红双车同在 f0：(0,5) 与 (0,0) —— 走 (0,5)（靠敌方）的是"前车"
    const { board } = parseFen('9/9/9/9/R8/9/9/9/9/R7K w');
    expect(moveToChineseNotation(board, { from: sq(0, 5), to: sq(1, 5), piece: 'R', captured: null })).toBe(
      '前车平八'
    );
    expect(moveToChineseNotation(board, { from: sq(0, 0), to: sq(1, 0), piece: 'R', captured: null })).toBe(
      '后车平八'
    );
  });

  it('吃子也按动作记录：炮八进七打马（屏风后吃子）', () => {
    const { board } = parseFen(CHESS_INITIAL_FEN);
    // 记谱只看几何：f=1 的红炮（纵线八）向上进 7 步吃 (1,9)，记"炮八进七"
    expect(moveToChineseNotation(board, { from: sq(1, 2), to: sq(1, 9), piece: 'C', captured: 'n' })).toBe(
      '炮八进七'
    );
  });
});
