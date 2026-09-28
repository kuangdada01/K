/**
 * ============================================================
 * 中文纵线记谱（棋谱着法，如"炮二平五"、"马8进7"）
 * ============================================================
 * 规则（中国象棋竞赛规则的标准记法）：
 * - 纵线号 = 9 - f（双方一致）：红方视角右起 一~九（汉字），黑方视角左起 1~9；
 * - 动词：横向平移 = 平；向敌方前进 = 进；回撤 = 退（红方进为 r+1，黑方为 r-1）；
 * - 斜行子（马/相/象/仕/士）进退后跟**目标纵线**；直行子（车/炮/帅/将/兵/卒）
 *   平跟目标纵线、进退跟**步数**；
 * - 同线同类子 ≥2 时用 前/中/后（4~5 个用 前二三…后）前缀消歧并**省略原纵线**
 *   （"前"指更靠近敌方的那个）。
 */

import type { ChessBoard, ChessMove, ChessPiece, ChessSide } from './types';
import { pieceSide } from './fen';

const PIECE_CHARS: Record<ChessSide, Record<string, string>> = {
  red: { k: '帅', a: '仕', b: '相', r: '车', n: '马', c: '炮', p: '兵' },
  black: { k: '将', a: '士', b: '象', r: '车', n: '马', c: '炮', p: '卒' },
};

const RED_NUMS = ['一', '二', '三', '四', '五', '六', '七', '八', '九'] as const;

function fileLabel(f: number, side: ChessSide): string {
  const n = 9 - f; // 1..9
  return side === 'red' ? RED_NUMS[n - 1]! : String(n);
}

/** 棋子显示名（按棋子自身阵营取字：红"兵"、黑"卒"）—— 语音播报"吃X"用 */
export function pieceDisplayName(piece: ChessPiece): string {
  return PIECE_CHARS[pieceSide(piece)][piece.toLowerCase()]!;
}

/** 同线同类子消歧前缀（idx 按"靠敌方优先"排序后的序号） */
function disambiguate(count: number, idx: number): string {
  if (count === 2) return idx === 0 ? '前' : '后';
  if (count === 3) return (['前', '中', '后'] as const)[idx]!;
  // 4~5 个同线（多兵一线的极端局面）：前、二、三…、后
  if (idx === 0) return '前';
  if (idx === count - 1) return '后';
  return RED_NUMS[idx]!; // 二、三…
}

/**
 * 计算一着棋的中文记谱。需传入**走子前**的棋盘（同线消歧要看原局）。
 * 服务端在每着广播时计算并入库；客户端只展示。
 */
export function moveToChineseNotation(board: ChessBoard, move: ChessMove): string {
  const side = pieceSide(move.piece);
  const t = move.piece.toLowerCase();
  const pieceChar = PIECE_CHARS[side][t]!;
  const dr = move.to.r - move.from.r;
  const dir = dr === 0 ? '平' : side === 'red' ? (dr > 0 ? '进' : '退') : dr < 0 ? '进' : '退';

  // 同线同类子（帅/将唯一，无需消歧）
  let head = pieceChar + fileLabel(move.from.f, side);
  if (t !== 'k') {
    const sameFile: number[] = [];
    for (let r = 0; r <= 9; r++) {
      const p = board[r * 9 + move.from.f];
      if (p && p.toLowerCase() === t && pieceSide(p) === side) sameFile.push(r);
    }
    if (sameFile.length > 1) {
      // "前" = 更靠近敌方：红方 r 大者在前，黑方 r 小者在前
      const ordered =
        side === 'red' ? [...sameFile].sort((a, b) => b - a) : [...sameFile].sort((a, b) => a - b);
      const idx = ordered.indexOf(move.from.r);
      head = disambiguate(ordered.length, idx) + pieceChar;
    }
  }

  // 斜行子（马象仕）进退跟目标纵线；直行子平跟目标纵线、进退跟步数
  //（步数：红方用汉字、黑方用阿拉伯数字）
  const diagonal = t === 'n' || t === 'b' || t === 'a';
  let tail: string;
  if (dir === '平' || diagonal) {
    tail = fileLabel(move.to.f, side);
  } else {
    const steps = Math.abs(dr);
    tail = side === 'red' ? RED_NUMS[steps - 1]! : String(steps);
  }
  return `${head}${dir}${tail}`;
}
