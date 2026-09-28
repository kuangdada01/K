/**
 * ============================================================
 * 中国象棋棋盘（components/voice/chess/ChessBoard）
 * ============================================================
 * SVG 渲染 9×10 交点盘面：河界、九宫斜线、棋子、选子高亮、
 * 合法落点提示（由 @k/shared 同源引擎计算）、上一步标记。
 * 视角：flipped=true 时黑方在下（引擎坐标不变，仅显示翻转）。
 * 交互仅对"轮到己方"的棋手开放；观战者只读。
 * ============================================================
 */

import { useMemo, useState } from 'react';
import { legalMoves, parseFen, pieceSide, type ChessMove, type ChessSide, type ChessSquare } from '@k/shared';
import styles from './chess.module.css';

const CELL = 60; // 相邻交点间距
const MARGIN = 36; // 盘面边距
const W = CELL * 8 + MARGIN * 2;
const H = CELL * 9 + MARGIN * 2;
const PIECE_R = 26; // 棋子半径

/** 棋子汉字（红简体 / 黑传统，是最常见的对照盘面写法） */
const PIECE_CHARS: Record<string, string> = {
  K: '帅',
  A: '仕',
  B: '相',
  R: '车',
  N: '马',
  C: '炮',
  P: '兵',
  k: '將',
  a: '士',
  b: '象',
  r: '車',
  n: '馬',
  c: '砲',
  p: '卒',
};

/** 炮位/兵位的初始标记点（画小角标，纯装饰） */
const STAR_POINTS: ReadonlyArray<readonly [number, number]> = [
  [1, 2],
  [7, 2],
  [1, 7],
  [7, 7],
  [0, 3],
  [2, 3],
  [4, 3],
  [6, 3],
  [8, 3],
  [0, 6],
  [2, 6],
  [4, 6],
  [6, 6],
  [8, 6],
];

export default function ChessBoard({
  fen,
  lastMove,
  mySide,
  myTurn,
  flipped,
  kingHighlight,
  onMove,
}: {
  fen: string;
  lastMove: ChessMove | null;
  /** 我执哪方（null = 观战者，只读） */
  mySide: ChessSide | null;
  myTurn: boolean;
  flipped: boolean;
  /** 被绝杀方的老将位置（红光脉冲高亮；null 不显示） */
  kingHighlight?: ChessSquare | null;
  onMove: (from: ChessSquare, to: ChessSquare) => void;
}) {
  const { board, turn } = useMemo(() => parseFen(fen), [fen]);
  const [selected, setSelected] = useState<ChessSquare | null>(null);

  // 引擎坐标 → 视口坐标（flipped 仅翻转显示，引擎坐标恒为红方视角）
  const vx = (f: number) => MARGIN + (flipped ? 8 - f : f) * CELL;
  const vy = (r: number) => MARGIN + (flipped ? r : 9 - r) * CELL;

  const interactive = mySide !== null && myTurn;
  const targets = useMemo(() => {
    if (!interactive || !selected) return [] as ChessMove[];
    return legalMoves(board, turn).filter((m) => m.from.f === selected.f && m.from.r === selected.r);
  }, [interactive, selected, board, turn]);

  const handleSquare = (f: number, r: number): void => {
    if (!interactive) return;
    const piece = board[r * 9 + f] ?? null;
    if (selected && targets.some((m) => m.to.f === f && m.to.r === r)) {
      onMove(selected, { f, r });
      setSelected(null);
      return;
    }
    if (piece && pieceSide(piece) === mySide) {
      setSelected(selected && selected.f === f && selected.r === r ? null : { f, r });
      return;
    }
    setSelected(null);
  };

  return (
    <svg
      className={styles.board}
      viewBox={`0 0 ${W} ${H}`}
      data-testid="chess-board"
      role="img"
      aria-label="象棋棋盘"
    >
      {/* 盘底与边框 */}
      <rect x={0} y={0} width={W} height={H} rx={10} className={styles.boardBg} />
      <rect
        x={MARGIN - 8}
        y={MARGIN - 8}
        width={CELL * 8 + 16}
        height={CELL * 9 + 16}
        rx={4}
        className={styles.boardFrame}
      />

      {/* 横线 */}
      {Array.from({ length: 10 }, (_, r) => (
        <line
          key={`h${r}`}
          x1={MARGIN}
          y1={vy(r)}
          x2={MARGIN + 8 * CELL}
          y2={vy(r)}
          className={styles.gridLine}
        />
      ))}
      {/* 纵线：两侧贯通，中间被河界断开 */}
      {Array.from({ length: 9 }, (_, f) =>
        f === 0 || f === 8 ? (
          <line key={`v${f}`} x1={vx(f)} y1={vy(0)} x2={vx(f)} y2={vy(9)} className={styles.gridLine} />
        ) : (
          <g key={`v${f}`}>
            <line x1={vx(f)} y1={vy(0)} x2={vx(f)} y2={vy(4)} className={styles.gridLine} />
            <line x1={vx(f)} y1={vy(5)} x2={vx(f)} y2={vy(9)} className={styles.gridLine} />
          </g>
        )
      )}
      {/* 九宫斜线 */}
      <g className={styles.gridLine}>
        <line x1={vx(3)} y1={vy(0)} x2={vx(5)} y2={vy(2)} />
        <line x1={vx(5)} y1={vy(0)} x2={vx(3)} y2={vy(2)} />
        <line x1={vx(3)} y1={vy(7)} x2={vx(5)} y2={vy(9)} />
        <line x1={vx(5)} y1={vy(7)} x2={vx(3)} y2={vy(9)} />
      </g>
      {/* 炮位/兵位角标 */}
      {STAR_POINTS.map(([f, r]) => (
        <circle key={`s${f}-${r}`} cx={vx(f)} cy={vy(r)} r={2.5} className={styles.starPoint} />
      ))}
      {/* 楚河汉界 */}
      <text x={MARGIN + 2 * CELL} y={vy(4.5)} className={`${styles.riverText} ${styles.riverRed}`}>
        楚 河
      </text>
      <text x={MARGIN + 6 * CELL} y={vy(4.5)} className={`${styles.riverText} ${styles.riverBlack}`}>
        漢 界
      </text>

      {/* 被绝杀老将：红光脉冲（绝杀动画期间） */}
      {kingHighlight && (
        <circle
          cx={vx(kingHighlight.f)}
          cy={vy(kingHighlight.r)}
          r={PIECE_R + 7}
          className={styles.kingFlash}
          data-testid="chess-king-flash"
        />
      )}

      {/* 上一步标记 */}
      {lastMove && (
        <g>
          <circle cx={vx(lastMove.from.f)} cy={vy(lastMove.from.r)} r={7} className={styles.lastMoveMark} />
          <circle
            cx={vx(lastMove.to.f)}
            cy={vy(lastMove.to.r)}
            r={PIECE_R + 4}
            className={styles.lastMoveMark}
          />
        </g>
      )}

      {/* 棋子 */}
      {board.map((piece, i) => {
        if (!piece) return null;
        const f = i % 9;
        const r = Math.floor(i / 9);
        const isRed = pieceSide(piece) === 'red';
        const isSelected = !!selected && selected.f === f && selected.r === r;
        return (
          <g key={i} data-testid={`chess-piece-${f}-${r}`}>
            {isSelected && <circle cx={vx(f)} cy={vy(r)} r={PIECE_R + 5} className={styles.selectedRing} />}
            <circle
              cx={vx(f)}
              cy={vy(r)}
              r={PIECE_R}
              className={`${styles.piece} ${isRed ? styles.pieceRed : styles.pieceBlack}`}
            />
            <text
              x={vx(f)}
              y={vy(r)}
              className={`${styles.pieceText} ${isRed ? styles.pieceTextRed : styles.pieceTextBlack}`}
            >
              {PIECE_CHARS[piece] ?? '?'}
            </text>
          </g>
        );
      })}

      {/* 合法落点提示 */}
      {targets.map((m) => (
        <circle
          key={`t${m.to.f}-${m.to.r}`}
          cx={vx(m.to.f)}
          cy={vy(m.to.r)}
          r={board[m.to.r * 9 + m.to.f] ? PIECE_R + 4 : 8}
          className={board[m.to.r * 9 + m.to.f] ? styles.targetRing : styles.targetDot}
        />
      ))}

      {/* 交互层：每个交点一个透明热区（棋子 circle 会挡住事件，热区放在最上层） */}
      {Array.from({ length: 90 }, (_, i) => {
        const f = i % 9;
        const r = Math.floor(i / 9);
        return (
          <rect
            key={`hot${i}`}
            x={vx(f) - CELL / 2}
            y={vy(r) - CELL / 2}
            width={CELL}
            height={CELL}
            fill="transparent"
            data-testid={`chess-hot-${f}-${r}`}
            style={{ cursor: interactive ? 'pointer' : 'default' }}
            onClick={() => handleSquare(f, r)}
          />
        );
      })}
    </svg>
  );
}
