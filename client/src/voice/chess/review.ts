/**
 * ============================================================
 * 棋谱回放折叠（voice/chess/review）
 * ============================================================
 * 终局留档只存着法序列；回放时用同源引擎从初始局面逐着推进，
 * 得到每一手的盘面（fen/轮次/最后一着）。applyMove 会逐着重新校验
 * 合法性 —— 记录损坏（非法着法）时停在最后一致处，不抛错。
 * ============================================================
 */

import { applyMove, boardToFen, createInitialGameState, type ChessMove, type ChessSide } from '@k/shared';

export interface ChessReviewPly {
  fen: string;
  turn: ChessSide;
  lastMove: ChessMove | null;
}

/** 着法序列 → 每一手的盘面（含初始局面，长度 = 着数 + 1） */
export function foldGame(moves: ChessMove[]): ChessReviewPly[] {
  let state = createInitialGameState();
  const plies: ChessReviewPly[] = [
    { fen: boardToFen(state.board, state.turn), turn: state.turn, lastMove: null },
  ];
  for (const m of moves) {
    const next = applyMove(state, m.from, m.to);
    if (!next) break;
    state = next;
    plies.push({
      fen: boardToFen(state.board, state.turn),
      turn: state.turn,
      lastMove: m,
    });
  }
  return plies;
}
