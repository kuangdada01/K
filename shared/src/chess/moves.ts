/**
 * ============================================================
 * 伪合法着法生成（不考虑己方被将，合法性过滤在 check.ts）
 * ============================================================
 * 全部特殊规则在此落实：蹩马腿、塞象眼、炮翻山（隔子吃）、
 * 象不过河、仕帅不出九宫、兵过河横移、将帅不照面（照面按"被将"
 * 处理，见 check.ts 的 isInCheck）。
 */

import type { ChessBoard, ChessMove, ChessPiece, ChessSide, ChessSquare } from './types';
import { pieceSide } from './fen';

export const ORTHO: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [0, -1],
  [1, 0],
  [-1, 0],
];

/** 马 8 个跳位的（df, dr）与其蹩腿点（腿在马位旁、沿长轴朝目标方向一步） */
const KNIGHT_JUMPS: ReadonlyArray<readonly [number, number, number, number]> = [
  [1, 2, 0, 1],
  [-1, 2, 0, 1],
  [1, -2, 0, -1],
  [-1, -2, 0, -1],
  [2, 1, 1, 0],
  [-2, 1, -1, 0],
  [2, -1, 1, 0],
  [-2, -1, -1, 0],
];

/** 象 4 个田字位（df, dr）与其塞眼点（中点） */
const ELEPHANT_JUMPS: ReadonlyArray<readonly [number, number, number, number]> = [
  [2, 2, 1, 1],
  [-2, 2, -1, 1],
  [2, -2, 1, -1],
  [-2, -2, -1, -1],
];

export function inBoard(f: number, r: number): boolean {
  return f >= 0 && f <= 8 && r >= 0 && r <= 9;
}

export function at(board: ChessBoard, f: number, r: number): ChessPiece | null {
  return board[r * 9 + f] ?? null;
}

/** 九宫：f 3-5；红 r 0-2、黑 r 7-9 */
export function inPalace(side: ChessSide, f: number, r: number): boolean {
  return f >= 3 && f <= 5 && (side === 'red' ? r >= 0 && r <= 2 : r >= 7 && r <= 9);
}

/** 兵是否已过河（红 r>=5、黑 r<=4） */
function pawnCrossed(side: ChessSide, r: number): boolean {
  return side === 'red' ? r >= 5 : r <= 4;
}

function sameSquare(a: ChessSquare, b: ChessSquare): boolean {
  return a.f === b.f && a.r === b.r;
}

export function applyToBoard(board: ChessBoard, move: ChessMove): ChessBoard {
  const next = board.slice();
  next[move.from.r * 9 + move.from.f] = null;
  next[move.to.r * 9 + move.to.f] = move.piece;
  return next;
}

/** 某交点上某方棋子的伪合法着法（吃己方子不生成） */
export function pseudoMovesFrom(board: ChessBoard, sq: ChessSquare): ChessMove[] {
  const piece = at(board, sq.f, sq.r);
  if (!piece) return [];
  const side = pieceSide(piece);
  const out: ChessMove[] = [];
  const push = (f: number, r: number): void => {
    const target = at(board, f, r);
    if (target && pieceSide(target) === side) return;
    out.push({ from: sq, to: { f, r }, piece, captured: target });
  };

  switch (piece.toLowerCase()) {
    case 'k': {
      // 帅/将：九宫内直行一步
      for (const [df, dr] of ORTHO) {
        const f = sq.f + df;
        const r = sq.r + dr;
        if (inBoard(f, r) && inPalace(side, f, r)) push(f, r);
      }
      break;
    }
    case 'a': {
      // 仕/士：九宫内斜行一步
      for (const [df, dr] of [
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1],
      ] as const) {
        const f = sq.f + df;
        const r = sq.r + dr;
        if (inBoard(f, r) && inPalace(side, f, r)) push(f, r);
      }
      break;
    }
    case 'b': {
      // 相/象：田字 + 塞象眼 + 不过河
      for (const [df, dr, eyeF, eyeR] of ELEPHANT_JUMPS) {
        const f = sq.f + df;
        const r = sq.r + dr;
        if (!inBoard(f, r)) continue;
        if (side === 'red' ? r > 4 : r < 5) continue;
        if (at(board, sq.f + eyeF, sq.r + eyeR) !== null) continue;
        push(f, r);
      }
      break;
    }
    case 'n': {
      // 马：日字 + 蹩马腿
      for (const [df, dr, legF, legR] of KNIGHT_JUMPS) {
        const f = sq.f + df;
        const r = sq.r + dr;
        if (!inBoard(f, r)) continue;
        if (at(board, sq.f + legF, sq.r + legR) !== null) continue;
        push(f, r);
      }
      break;
    }
    case 'r': {
      // 车：直线滑行，遇子止（敌子可吃）
      for (const [df, dr] of ORTHO) {
        let f = sq.f + df;
        let r = sq.r + dr;
        while (inBoard(f, r)) {
          const target = at(board, f, r);
          if (target) {
            if (pieceSide(target) !== side) push(f, r);
            break;
          }
          push(f, r);
          f += df;
          r += dr;
        }
      }
      break;
    }
    case 'c': {
      // 炮：不吃子时同车（遇子止）；吃子须隔恰一子（翻山）
      for (const [df, dr] of ORTHO) {
        let f = sq.f + df;
        let r = sq.r + dr;
        while (inBoard(f, r) && at(board, f, r) === null) {
          push(f, r);
          f += df;
          r += dr;
        }
        if (!inBoard(f, r)) continue; // 屏风在界外
        let f2 = f + df;
        let r2 = r + dr;
        while (inBoard(f2, r2) && at(board, f2, r2) === null) {
          f2 += df;
          r2 += dr;
        }
        if (inBoard(f2, r2) && pieceSide(at(board, f2, r2)!) !== side) push(f2, r2);
      }
      break;
    }
    case 'p': {
      // 兵/卒：过河前只进；过河后可横移；永不后退
      const forward = side === 'red' ? 1 : -1;
      const r = sq.r + forward;
      if (inBoard(sq.f, r)) push(sq.f, r);
      if (pawnCrossed(side, sq.r)) {
        if (inBoard(sq.f - 1, sq.r)) push(sq.f - 1, sq.r);
        if (inBoard(sq.f + 1, sq.r)) push(sq.f + 1, sq.r);
      }
      break;
    }
    default:
      break;
  }
  return out;
}

/** 某方全部伪合法着法（将帅照面不算"吃将"——照面约束在 isInCheck 统一处理） */
export function pseudoMovesForSide(board: ChessBoard, side: ChessSide): ChessMove[] {
  const out: ChessMove[] = [];
  for (let r = 0; r <= 9; r++) {
    for (let f = 0; f <= 8; f++) {
      const p = at(board, f, r);
      if (p && pieceSide(p) === side) out.push(...pseudoMovesFrom(board, { f, r }));
    }
  }
  return out;
}

export { sameSquare };
