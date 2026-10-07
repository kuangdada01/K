/**
 * ============================================================
 * 中国象棋棋盘（components/voice/chess/ChessBoard）
 * ============================================================
 * SVG 渲染 9×10 交点盘面：河界、九宫斜线、棋子、选子高亮、
 * 合法落点提示（由 @k/shared 同源引擎计算）、上一步标记。
 * 视角：flipped=true 时黑方在下（引擎坐标不变，仅显示翻转）。
 * 交互仅对"轮到己方"的棋手开放；观战者只读。
 *
 * 质感与 Android 端 ChessBoardView 同一套：外框/盘面/立体棋子，色值一一同源
 * （Android 侧是 BoardColors）。盘面木纹用真实贴图（Poly Haven `oak_veneer_01`，
 * CC0 免版权，调浅后 ~72KB）。两端同时挂两个棋盘（面板 + 复盘弹窗）时 <defs>
 * 的 id 会重复 —— 渐变内容完全一致，解析到第一份不影响显示。
 * ============================================================
 */

import { useMemo, useState } from 'react';
import { legalMoves, parseFen, pieceSide, type ChessMove, type ChessSide, type ChessSquare } from '@k/shared';
import styles from './chess.module.css';
import woodUrl from './wood3.jpg';

const CELL = 60; // 相邻交点间距
const MARGIN = 36; // 盘面边距
const W = CELL * 8 + MARGIN * 2;
const H = CELL * 9 + MARGIN * 2;
const PIECE_R = 26; // 棋子半径
/** 炮位/兵位角标几何：臂贴着网格线（距线 GAP）、从靠近交点的内角向外伸 LEN */
const STAR_GAP = 2;
const STAR_LEN = 9;

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

/**
 * 炮位/兵位角标：每个象限一条"贴线 L"——竖臂贴着纵线、横臂贴着横线，
 * 角在靠近交点的内角、臂向外伸（与参考 App 逐像素比对得出）。
 * 边缘点只画盘内侧的象限（外侧越出纵边）。
 */
function starMarkPath(f: number, r: number, vx: (f: number) => number, vy: (r: number) => number): string {
  const x = vx(f);
  const y = vy(r);
  let d = '';
  for (const sx of [-1, 1]) {
    if (f === 0 && sx < 0) continue;
    if (f === 8 && sx > 0) continue;
    for (const sy of [-1, 1]) {
      const cx = x + sx * STAR_GAP;
      const cy = y + sy * STAR_GAP;
      const xo = x + sx * (STAR_GAP + STAR_LEN);
      const yo = y + sy * (STAR_GAP + STAR_LEN);
      d += `M ${xo} ${cy} L ${cx} ${cy} L ${cx} ${yo} `;
    }
  }
  return d;
}

/**
 * 棋子字"墨迹居中"：字体把汉字墨迹画在 em 框里的位置因设备/字体而异
 * （如"兵"的腿会顶到内圈下缘），baseline 规则对不齐。渲染后量出每个字的
 * 实际墨迹包围盒（getBBox），把字平移到"墨迹中心 == 内圈圆心"——
 * 与设备字体无关，严格居中。jsdom 没有 getBBox，测试环境直接跳过。
 */
function centerPieceGlyph(el: SVGTextElement | null, cx: number, cy: number): void {
  if (!el || typeof el.getBBox !== 'function') return;
  el.removeAttribute('transform');
  const bb = el.getBBox();
  const dx = cx - (bb.x + bb.width / 2);
  const dy = cy - (bb.y + bb.height / 2);
  if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
    el.setAttribute('transform', `translate(${dx.toFixed(2)} ${dy.toFixed(2)})`);
  }
}

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
      {/* ---- 渐变/滤镜定义：色值与 Android 端 BoardColors 一一对应 ---- */}
      <defs>
        <clipPath id="chessFaceClip">
          <rect x={18} y={18} width={W - 36} height={H - 39} rx={8} />
        </clipPath>
        {/* 外框深木 / 盘面浅木（竖向渐变） */}
        <linearGradient id="chessFrameGrad" x1="0" y1="0" x2="0" y2={H} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#8f5f35" />
          <stop offset="1" stopColor="#5f3f1d" />
        </linearGradient>
        <linearGradient id="chessFaceGrad" x1="0" y1={18} x2="0" y2={H - 21} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#f2d9a4" />
          <stop offset="1" stopColor="#e3bc80" />
        </linearGradient>
        {/* 盘面中央提亮 / 角部压暗 */}
        <radialGradient
          id="chessFaceSheen"
          cx={W / 2}
          cy={H * 0.38}
          r={W * 0.62}
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#ffffff" stopOpacity={0.14} />
          <stop offset="1" stopColor="#ffffff" stopOpacity={0} />
        </radialGradient>
        <radialGradient
          id="chessFaceVignette"
          cx={W / 2}
          cy={H / 2}
          r={W * 0.52}
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0.55" stopColor="#000000" stopOpacity={0} />
          <stop offset="1" stopColor="#000000" stopOpacity={0.08} />
        </radialGradient>
        {/* 棋子：受光盘体（高光偏左上）/ 镜面高光（收在盘体内，避免溢出成白雾） */}
        <radialGradient id="chessPieceBody" cx="0.34" cy="0.31" r="0.8">
          <stop offset="0" stopColor="#fcf3db" />
          <stop offset="0.55" stopColor="#f2dfb2" />
          <stop offset="1" stopColor="#d5b478" />
        </radialGradient>
        <radialGradient id="chessPieceSheen" cx="0.35" cy="0.3" r="0.5">
          <stop offset="0" stopColor="#ffffff" stopOpacity={0.3} />
          <stop offset="1" stopColor="#ffffff" stopOpacity={0} />
        </radialGradient>
      </defs>

      {/* ---- 静态盘面：落影（右下偏）→ 外框 → 盘面（渐变/提亮/木纹/压暗/雕刻缝）→ 网格外框 ---- */}
      <rect x={3} y={5} width={W - 6} height={H - 9} rx={13} fill="rgba(0,0,0,0.26)" />
      <rect x={4.5} y={7.5} width={W - 8} height={H - 11.5} rx={14} fill="rgba(0,0,0,0.12)" />
      <rect
        x={1.5}
        y={1.5}
        width={W - 3}
        height={H - 6}
        rx={12}
        fill="url(#chessFrameGrad)"
        stroke="rgba(63,42,20,0.55)"
        strokeWidth={1.2}
      />
      <rect x={18} y={18} width={W - 36} height={H - 39} rx={8} fill="url(#chessFaceGrad)" />
      {/* 真实木纹贴图（Poly Haven `oak_veneer_01`，CC0）：整幅盖满盘面，slice 裁边 */}
      <g clipPath="url(#chessFaceClip)">
        <image
          href={woodUrl}
          x={18}
          y={18}
          width={W - 36}
          height={H - 39}
          preserveAspectRatio="xMidYMid slice"
        />
      </g>
      <rect x={18} y={18} width={W - 36} height={H - 39} rx={8} fill="url(#chessFaceSheen)" />
      <rect x={18} y={18} width={W - 36} height={H - 39} rx={8} fill="url(#chessFaceVignette)" />
      <rect
        x={18}
        y={18}
        width={W - 36}
        height={H - 39}
        rx={8}
        fill="none"
        stroke="rgba(0,0,0,0.3)"
        strokeWidth={1.2}
      />
      {/* 网格外框：双线（外粗内细，经典盘面画法） */}
      <rect
        x={MARGIN - 9}
        y={MARGIN - 9}
        width={CELL * 8 + 18}
        height={CELL * 9 + 18}
        rx={4}
        className={styles.gridBorderOuter}
      />
      <rect
        x={MARGIN - 3.5}
        y={MARGIN - 3.5}
        width={CELL * 8 + 7}
        height={CELL * 9 + 7}
        rx={2}
        className={styles.gridBorderInner}
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
      {/* 炮位/兵位角标：经典四角 L 形短线 */}
      {STAR_POINTS.map(([f, r]) => (
        <path key={`s${f}-${r}`} d={starMarkPath(f, r, vx, vy)} className={styles.starMark} />
      ))}
      {/* 楚河汉界（刻木棕，单色 —— 与 Android 端一致，不再红黑双色） */}
      <text x={MARGIN + 2 * CELL} y={vy(4.5)} className={styles.riverText}>
        楚 河
      </text>
      <text x={MARGIN + 6 * CELL} y={vy(4.5)} className={styles.riverText}>
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

      {/* 棋子：右下月牙落影（两枚与子同大的实心黑圆偏移右下，被盘体盖住只露边缘）
          + 受光渐变盘体 + 盘体内高光 + 外缘环 + 内圈刻线（与 Android 端 drawPiece 同构） */}
      {board.map((piece, i) => {
        if (!piece) return null;
        const f = i % 9;
        const r = Math.floor(i / 9);
        const isRed = pieceSide(piece) === 'red';
        const isSelected = !!selected && selected.f === f && selected.r === r;
        return (
          <g key={i} data-testid={`chess-piece-${f}-${r}`}>
            {isSelected && <circle cx={vx(f)} cy={vy(r)} r={PIECE_R + 6} className={styles.selectedRing} />}
            <circle cx={vx(f) + 3} cy={vy(r) + 4} r={PIECE_R} fill="rgba(0,0,0,0.32)" />
            <circle cx={vx(f) + 5.5} cy={vy(r) + 7} r={PIECE_R} fill="rgba(0,0,0,0.15)" />
            <circle cx={vx(f)} cy={vy(r)} r={PIECE_R} fill="url(#chessPieceBody)" />
            <circle
              cx={vx(f) - PIECE_R * 0.34}
              cy={vy(r) - PIECE_R * 0.42}
              r={PIECE_R * 0.48}
              fill="url(#chessPieceSheen)"
            />
            <circle cx={vx(f)} cy={vy(r)} r={PIECE_R} className={styles.pieceRing} />
            <circle
              cx={vx(f)}
              cy={vy(r)}
              r={PIECE_R * 0.76}
              className={isRed ? styles.innerRingRed : styles.innerRingBlack}
            />
            <text
              x={vx(f)}
              y={vy(r)}
              ref={(t) => centerPieceGlyph(t, vx(f), vy(r))}
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
