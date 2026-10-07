/**
 * ============================================================
 * 对局状态机：走子应用、悔棋回退与终局判定
 * ============================================================
 * 终局口径（与 docs/voice-chess-plan.md §7 一致）：
 * - 将死/困毙：轮到方无任何合法着法 → 判负（无将 = 将死，有将 = 困毙，
 *   中国象棋两者都判负，与国际象棋的逼和不同）；
 * - 三次重复局面（棋盘 + 行棋方同串出现第三次）：若循环内一方**每着都将**
 *   （长将）则该方判负（perpetual，亚洲棋规的简化实现 —— 长捉禁着仍不在内）；
 *   否则判和；
 * - 双方均无进攻子力（仅剩帅/将 + 仕/相）→ 判和。
 *   单马/单炮对单将等"理论可和但难证"的局面不判和，
 *   会自然走向重复局面判和。
 */

import type { ChessBoard, ChessEndReason, ChessGameState, ChessMove, ChessSide, ChessSquare } from './types';
import { boardToFen, parseFen, CHESS_INITIAL_FEN } from './fen';
import { applyToBoard, at, sameSquare } from './moves';
import { isInCheck, legalMoves, other } from './check';
import { pieceSide } from './fen';

/** "棋盘 + 行棋方"串：重复局面判定与快照共用 */
export function positionKey(board: ChessBoard, turn: ChessSide): string {
  return boardToFen(board, turn);
}

export function createInitialGameState(): ChessGameState {
  const { board, turn } = parseFen(CHESS_INITIAL_FEN);
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

/** 双方均无进攻子力（车马炮兵全无）→ 判和 */
export function insufficientMaterial(board: ChessBoard): boolean {
  for (let r = 0; r <= 9; r++) {
    for (let f = 0; f <= 8; f++) {
      const p = at(board, f, r);
      if (!p) continue;
      const t = p.toLowerCase();
      if (t === 'r' || t === 'n' || t === 'c' || t === 'p') return false;
    }
  }
  return true;
}

/**
 * 三次重复局面的裁决：检查最后一次重复的循环内（两次同串局面之间的着法），
 * 若一方每着都将军（长将）则该方判负，否则判和。
 * 同串局面含行棋方 → 两次出现之间的着法数必为偶数，双方着数相等。
 */
function adjudicateRepetition(
  positionKeys: string[],
  moves: ChessMove[],
  checkFlags: boolean[],
  key: string
): { status: 'red-win' | 'black-win' | 'draw'; reason: ChessEndReason } {
  const firstIdx = positionKeys.indexOf(key);
  const cycleMoves = moves.slice(firstIdx);
  const cycleFlags = checkFlags.slice(firstIdx);
  const allCheck = (side: ChessSide): boolean => {
    let saw = false;
    for (let i = 0; i < cycleMoves.length; i++) {
      if (pieceSide(cycleMoves[i]!.piece) !== side) continue;
      saw = true;
      if (!cycleFlags[i]) return false;
    }
    return saw;
  };
  const redPerpetual = allCheck('red');
  const blackPerpetual = allCheck('black');
  if (redPerpetual && !blackPerpetual) return { status: 'black-win', reason: 'perpetual' };
  if (blackPerpetual && !redPerpetual) return { status: 'red-win', reason: 'perpetual' };
  return { status: 'draw', reason: 'repetition' };
}

/**
 * 应用一步棋：在当前合法着法中精确匹配 from→to（服务端权威校验的落点，
 * 客户端提示也用同一函数）。非法返回 null；合法返回**新**状态（不改动入参）。
 */
export function applyMove(state: ChessGameState, from: ChessSquare, to: ChessSquare): ChessGameState | null {
  if (state.status !== 'playing') return null;
  const legal = legalMoves(state.board, state.turn);
  const move = legal.find((m) => sameSquare(m.from, from) && sameSquare(m.to, to));
  if (!move) return null;

  const board = applyToBoard(state.board, move);
  const turn = other(state.turn);
  const moves: ChessMove[] = [...state.moves, move];
  const check = isInCheck(board, turn);
  const checkFlags: boolean[] = [...state.checkFlags, check];
  const key = positionKey(board, turn);
  const positionKeys = [...state.positionKeys, key];

  let status: ChessGameState['status'] = 'playing';
  let statusReason: ChessEndReason | null = null;
  const opponentHasMoves = legalMoves(board, turn).length > 0;
  if (!opponentHasMoves) {
    // 轮到方无合法着法：被将 = 将死；未被将 = 困毙。两者均判负。
    status = state.turn === 'red' ? 'red-win' : 'black-win';
    statusReason = check ? 'checkmate' : 'stalemate';
  } else if (positionKeys.filter((k) => k === key).length >= 3) {
    const adjudicated = adjudicateRepetition(positionKeys, moves, checkFlags, key);
    return {
      board,
      turn,
      status: adjudicated.status,
      statusReason: adjudicated.reason,
      moves,
      checkFlags,
      positionKeys,
    };
  } else if (insufficientMaterial(board)) {
    status = 'draw';
    statusReason = 'insufficient';
  }

  return { board, turn, status, statusReason, moves, checkFlags, positionKeys };
}

/**
 * 悔棋回退：撤销末尾 plies 着，回到该局面（行棋方随局面串恢复）。
 * 悔到的局面在历史上必然是"进行中"的合法局面（终局面不会被回退到 ——
 * 服务端只在终局前允许悔棋）。超出历史长度返回 null。
 */
export function undoMove(state: ChessGameState, plies = 1): ChessGameState | null {
  if (plies <= 0 || state.moves.length < plies) return null;
  const keep = state.moves.length - plies;
  const key = state.positionKeys[keep];
  if (!key) return null;
  const { board, turn } = parseFen(key);
  return {
    board,
    turn,
    status: 'playing',
    statusReason: null,
    moves: state.moves.slice(0, keep),
    checkFlags: state.checkFlags.slice(0, keep),
    positionKeys: state.positionKeys.slice(0, keep + 1),
  };
}
