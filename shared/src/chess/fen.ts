/**
 * ============================================================
 * 棋盘 ⇄ FEN 编解码
 * ============================================================
 * 采用象棋界通用的单行 FEN 记法：斜杠分隔 10 行，从 r=9（黑方底线）
 * 排到 r=0（红方底线）；大写=红、小写=黑、数字=连续空点；
 * 行棋方 'w'=红先、'b'=黑。初始局面：
 *   rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w
 */

import type { ChessBoard, ChessPiece, ChessSide } from './types';

export const CHESS_INITIAL_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w';

const ALL_PIECES = new Set<string>(['R', 'N', 'B', 'A', 'K', 'C', 'P', 'r', 'n', 'b', 'a', 'k', 'c', 'p']);

/** 解析 FEN → 棋盘与行棋方；格式非法抛 Error（引擎内部与测试使用，客户端不接触原始串） */
export function parseFen(fen: string): { board: ChessBoard; turn: ChessSide } {
  const parts = fen.trim().split(/\s+/);
  const [boardStr, turnChar] = parts;
  if (boardStr === undefined || (turnChar !== 'w' && turnChar !== 'b')) {
    throw new Error(`非法象棋 FEN（行棋方）: ${fen}`);
  }
  const rows = boardStr.split('/');
  if (rows.length !== 10) throw new Error(`非法象棋 FEN（行数）: ${fen}`);
  const board: ChessBoard = new Array(90).fill(null);
  for (let i = 0; i < 10; i++) {
    const row = rows[i];
    if (row === undefined) throw new Error(`非法象棋 FEN（行数）: ${fen}`);
    const r = 9 - i;
    let f = 0;
    for (const ch of row) {
      if (ch >= '1' && ch <= '9') {
        f += Number(ch);
      } else if (ALL_PIECES.has(ch)) {
        if (f > 8) throw new Error(`非法象棋 FEN（越界）: ${fen}`);
        board[r * 9 + f] = ch as ChessPiece;
        f += 1;
      } else {
        throw new Error(`非法象棋 FEN（字符 ${ch}）: ${fen}`);
      }
    }
    if (f !== 9) throw new Error(`非法象棋 FEN（列数）: ${fen}`);
  }
  return { board, turn: turnChar === 'w' ? 'red' : 'black' };
}

/** 棋盘 + 行棋方 → FEN（positionKey 与协议广播共用） */
export function boardToFen(board: ChessBoard, turn: ChessSide): string {
  const rows: string[] = [];
  for (let r = 9; r >= 0; r--) {
    let row = '';
    let empty = 0;
    for (let f = 0; f < 9; f++) {
      const p = board[r * 9 + f];
      if (p) {
        if (empty > 0) {
          row += String(empty);
          empty = 0;
        }
        row += p;
      } else {
        empty += 1;
      }
    }
    if (empty > 0) row += String(empty);
    rows.push(row);
  }
  return `${rows.join('/')} ${turn === 'red' ? 'w' : 'b'}`;
}

/** 棋子所属阵营（大写=红） */
export function pieceSide(piece: ChessPiece): ChessSide {
  return piece === piece.toUpperCase() ? 'red' : 'black';
}
