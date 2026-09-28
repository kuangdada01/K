/**
 * 棋谱回放折叠测试：合法着法序列折叠出每手盘面；
 * 非法/损坏着法停在最后一致处（不抛错）；空序列 = 仅初始局面。
 */
import { describe, expect, it } from 'vitest';
import { CHESS_INITIAL_FEN } from '@k/shared';
import { foldGame } from './review';

describe('foldGame', () => {
  it('空序列：仅初始局面', () => {
    const plies = foldGame([]);
    expect(plies).toHaveLength(1);
    expect(plies[0]!.fen).toBe(CHESS_INITIAL_FEN);
    expect(plies[0]!.lastMove).toBeNull();
  });

  it('两着序列：折叠出 3 个局面，轮次交替、lastMove 对应', () => {
    const plies = foldGame([
      { from: { f: 7, r: 2 }, to: { f: 4, r: 2 }, piece: 'C', captured: null },
      { from: { f: 1, r: 9 }, to: { f: 2, r: 7 }, piece: 'n', captured: null },
    ]);
    expect(plies).toHaveLength(3);
    expect(plies[0]!.turn).toBe('red');
    expect(plies[1]!.turn).toBe('black');
    expect(plies[1]!.lastMove).toMatchObject({ from: { f: 7, r: 2 }, to: { f: 4, r: 2 } });
    expect(plies[2]!.turn).toBe('red');
    expect(plies[2]!.lastMove).toMatchObject({ from: { f: 1, r: 9 }, to: { f: 2, r: 7 } });
  });

  it('损坏记录：非法着法处停止折叠，不抛错', () => {
    const plies = foldGame([
      { from: { f: 7, r: 2 }, to: { f: 4, r: 2 }, piece: 'C', captured: null },
      { from: { f: 4, r: 0 }, to: { f: 4, r: 9 }, piece: 'K', captured: null }, // 帅飞九宫外：非法
    ]);
    expect(plies).toHaveLength(2); // 只折叠出第一着
  });
});
