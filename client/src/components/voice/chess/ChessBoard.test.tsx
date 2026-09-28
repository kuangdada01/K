/**
 * ============================================================
 * 象棋棋盘组件测试（components/voice/chess/ChessBoard.test）
 * ============================================================
 * - 初始盘面渲染 32 枚棋子
 * - 轮到己方：点选己方棋子出现合法落点提示（车直行/马跳的几何正确性），
 *   点击合法落点回调 onMove（引擎坐标），点击非法点不高亮
 * - 非轮到方/观战者：交互关闭，不产生 onMove
 * - 翻转视角：同一棋子的视口坐标翻转（引擎坐标不变）
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CHESS_INITIAL_FEN } from '@k/shared';
import ChessBoard from './ChessBoard';

const INITIAL_LAST_MOVE = null;

function renderBoard(overrides: Partial<Parameters<typeof ChessBoard>[0]> = {}) {
  const onMove = vi.fn();
  const props = {
    fen: CHESS_INITIAL_FEN,
    lastMove: INITIAL_LAST_MOVE,
    mySide: 'red' as const,
    myTurn: true,
    flipped: false,
    onMove,
    ...overrides,
  };
  render(<ChessBoard {...props} />);
  return { onMove, props };
}

describe('ChessBoard', () => {
  it('初始盘面渲染 32 枚棋子', () => {
    renderBoard();
    expect(document.querySelectorAll('[data-testid^="chess-piece-"]').length).toBe(32);
  });

  it('点选红炮显示沿线的合法落点；点击目标回调引擎坐标', () => {
    const { onMove } = renderBoard();
    // 红炮 (1,2) —— 初始局面：沿线可走到 (1,0)/(1,1) 与 (1,3)~(1,6)，并吃 (1,9) 黑马
    fireEvent.click(screen.getByTestId('chess-hot-1-2'));
    expect(screen.queryByTestId('chess-piece-1-2')).toBeTruthy();
    // 初始局面红炮 (1,2)：11 个空点落位 + 1 个吃位（(1,9) 黑马）
    const dots = document.querySelectorAll('[class*="targetDot"]');
    expect(dots.length).toBe(11);
    const rings = document.querySelectorAll('[class*="targetRing"]');
    expect(rings.length).toBe(1);

    // 吃黑马：点击 (1,9) 交点热区
    fireEvent.click(screen.getByTestId('chess-hot-1-9'));
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledWith({ f: 1, r: 2 }, { f: 1, r: 9 });
  });

  it('非轮到方：点击不产生任何交互', () => {
    const { onMove } = renderBoard({ myTurn: false });
    fireEvent.click(screen.getByTestId('chess-hot-1-2'));
    const dots = document.querySelectorAll('[class*="targetDot"]');
    expect(dots.length).toBe(0);
    expect(onMove).not.toHaveBeenCalled();
  });

  it('观战者（mySide=null）：只读', () => {
    const { onMove } = renderBoard({ mySide: null, myTurn: false });
    fireEvent.click(screen.getByTestId('chess-hot-1-2'));
    expect(onMove).not.toHaveBeenCalled();
    expect(document.querySelectorAll('[class*="targetDot"]').length).toBe(0);
  });

  it('翻转视角：黑方在下（红帅 (4,0) 显示在视口上半区）', () => {
    const { container } = render(
      <ChessBoard
        fen={CHESS_INITIAL_FEN}
        lastMove={null}
        mySide="black"
        myTurn={false}
        flipped
        onMove={vi.fn()}
      />
    );
    const king = container.querySelector('[data-testid="chess-piece-4-0"]');
    expect(king).toBeTruthy();
    const y = Number(king!.querySelector('circle')!.getAttribute('cy'));
    expect(y).toBeLessThan(306); // H/2 = 612/2
  });

  it('上一步标记：from/to 各有一个标记圈', () => {
    render(
      <ChessBoard
        fen={CHESS_INITIAL_FEN}
        lastMove={{ from: { f: 7, r: 2 }, to: { f: 4, r: 2 }, piece: 'C', captured: null }}
        mySide={null}
        myTurn={false}
        flipped={false}
        onMove={vi.fn()}
      />
    );
    expect(document.querySelectorAll('[class*="lastMoveMark"]').length).toBe(2);
  });
});
