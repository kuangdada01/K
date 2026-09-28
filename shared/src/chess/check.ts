/**
 * ============================================================
 * 将军判定与合法着法过滤
 * ============================================================
 * isInCheck 用"定向扫描"而非全量伪合法着法扫描：直线方向同时覆盖
 * 车、炮（隔一屏风）与将帅照面（纵向第一子是敌帅/将），马按
 * "反查 8 个攻击位 + 蹩腿"判定，兵按攻击方向判定；仕/相永远攻击
 * 不到对方九宫，无需参与。合法着法 = 伪合法 - 走后己方被将/照面。
 */

import type { ChessBoard, ChessMove, ChessSide } from './types';
import { pieceSide } from './fen';
import { applyToBoard, at, inBoard, ORTHO, pseudoMovesFrom } from './moves';

export function other(side: ChessSide): ChessSide {
  return side === 'red' ? 'black' : 'red';
}

export function findKing(board: ChessBoard, side: ChessSide): { f: number; r: number } | null {
  const target = side === 'red' ? 'K' : 'k';
  for (let r = 0; r <= 9; r++) {
    for (let f = 0; f <= 8; f++) {
      if (at(board, f, r) === target) return { f, r };
    }
  }
  return null;
}

/** 马"反查"表：从被将点看，攻击者的偏移与其蹩腿点偏移（相对被将点；
 *  腿 = 马 + 沿长轴朝被将点一步 = 被将点 + (sign(df), dr) 当 |df|=2，其余对称） */
const KNIGHT_ATTACKERS: ReadonlyArray<readonly [number, number, number, number]> = [
  [-1, -2, -1, -1],
  [1, -2, 1, -1],
  [-1, 2, -1, 1],
  [1, 2, 1, 1],
  [-2, -1, -1, -1],
  [2, -1, 1, -1],
  [-2, 1, -1, 1],
  [2, 1, 1, 1],
];

/** side 的帅/将当前是否被攻击（含将帅照面 —— 照面等价于被将，走成照面的棋不合法） */
export function isInCheck(board: ChessBoard, side: ChessSide): boolean {
  const k = findKing(board, side);
  if (!k) return true; // 防御式：无帅/将按被将处理（正常对局不会出现）
  const enemy = other(side);

  for (const [df, dr] of ORTHO) {
    // 第一子：车（敌）或照面（纵向第一子为敌帅/将）
    let f = k.f + df;
    let r = k.r + dr;
    while (inBoard(f, r) && at(board, f, r) === null) {
      f += df;
      r += dr;
    }
    if (!inBoard(f, r)) continue;
    const first = at(board, f, r)!;
    if (pieceSide(first) === enemy) {
      const t = first.toLowerCase();
      if (t === 'r' || (t === 'k' && df === 0)) return true;
    }
    // 炮：越过屏风（屏风可为任意一方棋子）找第二子
    let f2 = f + df;
    let r2 = r + dr;
    while (inBoard(f2, r2) && at(board, f2, r2) === null) {
      f2 += df;
      r2 += dr;
    }
    if (inBoard(f2, r2)) {
      const second = at(board, f2, r2)!;
      if (pieceSide(second) === enemy && second.toLowerCase() === 'c') return true;
    }
  }

  // 马：8 个攻击位（各自带蹩腿判定）
  for (const [df, dr, legF, legR] of KNIGHT_ATTACKERS) {
    const f = k.f + df;
    const r = k.r + dr;
    if (!inBoard(f, r)) continue;
    const p = at(board, f, r);
    if (!p || pieceSide(p) !== enemy || p.toLowerCase() !== 'n') continue;
    if (at(board, k.f + legF, k.r + legR) === null) return true;
  }

  // 兵/卒：正前方一格（敌兵向我的前进方向），过河兵另有两侧
  // 敌方为黑时，黑兵在 (f, r+1) 攻击 (f, r)；敌方为红时反之。
  const forwardFrom = enemy === 'black' ? 1 : -1;
  const p = at(board, k.f, k.r + forwardFrom);
  if (p && pieceSide(p) === enemy && p.toLowerCase() === 'p') return true;
  // 过河敌兵的侧向攻击：兵在 (f±1, r)，且该兵已过河（过河条件按兵所在行判断）
  for (const df of [-1, 1] as const) {
    const sp = at(board, k.f + df, k.r);
    if (!sp || pieceSide(sp) !== enemy || sp.toLowerCase() !== 'p') continue;
    const crossed = enemy === 'black' ? k.r <= 4 : k.r >= 5;
    if (crossed) return true;
  }
  return false;
}

/** 合法着法：伪合法 - 走后己方被将/照面 */
export function legalMoves(board: ChessBoard, turn: ChessSide): ChessMove[] {
  const out: ChessMove[] = [];
  for (let r = 0; r <= 9; r++) {
    for (let f = 0; f <= 8; f++) {
      const p = at(board, f, r);
      if (!p || pieceSide(p) !== turn) continue;
      for (const m of pseudoMovesFrom(board, { f, r })) {
        if (!isInCheck(applyToBoard(board, m), turn)) out.push(m);
      }
    }
  }
  return out;
}
