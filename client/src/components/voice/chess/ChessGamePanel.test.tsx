/**
 * ============================================================
 * 象棋面板组件测试（components/voice/chess/ChessGamePanel.test）
 * ============================================================
 * 锁死"绝杀动画"的生命周期（2026-09 线上反馈）：
 * - 终局（checkmate）到达即播放"绝杀"覆盖层（棋盘震动 + 红光）；
 * - 覆盖层必须在 2.8s 后自行退场 —— **即使这段时间里还有别的消息写了 game**
 *   （典型：对方点「再来一局」→ game-rematch-offered）。此前计时器与
 *   [ended, game] 同一个 effect：game 一变先跑清理清掉定时器，而本次执行又被
 *   cmKeyRef 去重提前 return（不再补定时器）→ 红光与震动永不结束。
 *
 * 会话/语音播报/音效一律替身：本用例只关心"绝杀覆盖层什么时候消失"。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ChessGameView } from '../../../voice/chess/useChessGame';
import ChessGamePanel from './ChessGamePanel';

/** 挪到模块顶部：vi.mock 工厂会被提升，不能闭包引用普通变量 */
const h = vi.hoisted(() => ({
  chess: {} as Record<string, unknown>,
  announce: vi.fn(),
  playSound: vi.fn(),
}));

vi.mock('../../../context/VoiceContext', () => ({
  useVoice: () => ({
    chess: h.chess,
    participants: [{ userId: 1, username: 'alice', avatar: null }],
    activeRoomId: 7,
  }),
}));

vi.mock('../../../voice/chess/useChessTTS', () => ({
  useChessTTS: () => ({ enabled: false, supported: false, toggle: vi.fn(), announce: h.announce }),
}));

vi.mock('../../../voice/chess/sounds', () => ({
  getSoundPack: () => 'classic',
  setSoundPack: vi.fn(),
  playChessSound: h.playSound,
}));

const MATE_FEN = '3k5/R8/9/9/9/4R4/9/9/9/4R3K w';
const PLAY_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w';

/** 进行中的对局视图（红方视角、红方行棋）；棋钟锚点相对 Date.now()（假计时器下也成立） */
function playingGame(overrides: Partial<ChessGameView> = {}): ChessGameView {
  return {
    gameId: 'g1',
    red: { userId: 1, username: 'alice', avatar: null },
    black: { userId: 2, username: 'bob', avatar: null },
    fen: PLAY_FEN,
    turn: 'red',
    status: 'playing',
    lastMove: null,
    moveCount: 0,
    rematchBy: null,
    clocks: { red: 300_000, black: 300_000, turnStartedAt: Date.now(), deadline: Date.now() + 90_000 },
    notations: [],
    captured: { red: [], black: [] },
    ...overrides,
  } as ChessGameView;
}

/** 终局（绝杀）后的对局视图：红方被将死（黑胜） */
function mateGame(overrides: Partial<ChessGameView> = {}): ChessGameView {
  return {
    gameId: 'g1',
    red: { userId: 1, username: 'alice', avatar: null },
    black: { userId: 2, username: 'bob', avatar: null },
    fen: MATE_FEN,
    turn: 'black',
    status: 'red-win',
    lastMove: null,
    moveCount: 3,
    rematchBy: null,
    clocks: { red: 300_000, black: 300_000, turnStartedAt: 0, deadline: 0 },
    notations: ['炮二平五'],
    captured: { red: [], black: [] },
    ...overrides,
  } as ChessGameView;
}

const ENDED = { result: 'red-win', reason: 'checkmate' } as const;

/** 渲染面板并返回"更新对局状态"入口（模拟后续 game-* 消息写 game） */
function renderPanel(initial: { game: ChessGameView; ended: unknown }) {
  const state = { ...initial };
  h.chess = {
    game: state.game,
    ended: state.ended,
    invite: null,
    outgoing: null,
    drawOfferFrom: null,
    undoOfferFrom: null,
    reviewOpen: false,
    reviewGameId: null,
    reset: vi.fn(),
    closeReview: vi.fn(),
    openReview: vi.fn(),
    dismissEnded: vi.fn(),
    rematch: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    mySideOf: (userId: number) => (userId === 1 ? 'red' : userId === 2 ? 'black' : null),
  };
  const view = render(<ChessGamePanel />);
  return {
    update(next: { game?: ChessGameView; ended?: unknown }) {
      if (next.game) h.chess.game = next.game;
      if (next.ended !== undefined) h.chess.ended = next.ended;
      view.rerender(<ChessGamePanel />);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  h.announce.mockClear();
  h.playSound.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ChessGamePanel 绝杀动画', () => {
  it('终局到达即播放"绝杀"覆盖层，2.8s 后自行退场', () => {
    renderPanel({ game: mateGame(), ended: ENDED });
    expect(screen.queryByTestId('chess-checkmate-fx')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(2800);
    });
    expect(screen.queryByTestId('chess-checkmate-fx')).toBeNull();
  });

  it('动画进行中收到"对方想再来一局"也照常退场（不被后续 game 写操作卡住）', () => {
    const panel = renderPanel({ game: mateGame(), ended: ENDED });
    expect(screen.queryByTestId('chess-checkmate-fx')).toBeTruthy();
    // 对方点「再来一局」：同一局上多了一条 game-rematch-offered → game 换新对象
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    panel.update({ game: mateGame({ rematchBy: 2 }) });
    expect(screen.queryByTestId('chess-checkmate-fx')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1900);
    });
    expect(screen.queryByTestId('chess-checkmate-fx')).toBeNull();
  });

  it('终局横幅给出"再来一局"出口（绝杀后不再只有兜底"对局结束"）', () => {
    renderPanel({ game: mateGame(), ended: ENDED });
    expect(screen.getByTestId('chess-ended')).toBeTruthy();
    expect(screen.getByTestId('chess-rematch').textContent).toBe('再来一局');
  });
});

describe('ChessGamePanel 暂停/继续', () => {
  it('进行中：操作条有"暂停"按钮、无遮罩；点击上行 game-pause', () => {
    const panel = renderPanel({ game: playingGame(), ended: null });
    expect(screen.getByTestId('chess-pause').textContent).toBe('暂停');
    expect(screen.queryByTestId('chess-pause-overlay')).toBeNull();
    fireEvent.click(screen.getByTestId('chess-pause'));
    expect(h.chess.pause).toHaveBeenCalledWith('g1');

    // 服务端广播 game-paused → clocks.paused 置位 → 转暂停态
    panel.update({
      game: playingGame({
        clocks: { red: 290_000, black: 300_000, turnStartedAt: 1_000, deadline: 0, paused: true },
      }),
    });
    expect(screen.getByTestId('chess-pause-overlay')).toBeTruthy();
    expect(screen.queryByTestId('chess-pause')).toBeNull();
    expect(screen.getByTestId('chess-resume').textContent).toBe('继续对局');
    fireEvent.click(screen.getByTestId('chess-resume'));
    expect(h.chess.resume).toHaveBeenCalledWith('g1');
  });

  it('暂停中：棋盘蒙遮罩、状态条提示、棋钟冻结不走秒', () => {
    renderPanel({
      game: playingGame({
        clocks: { red: 290_000, black: 300_000, turnStartedAt: 1_000, deadline: 0, paused: true },
      }),
      ended: null,
    });
    expect(screen.getByTestId('chess-pause-overlay').textContent).toContain('对局已暂停');
    expect(screen.getByTestId('chess-status').textContent).toContain('对局已暂停');
    const before = screen.getByTestId('chess-clock-red').textContent;
    act(() => {
      vi.advanceTimersByTime(2500);
    });
    expect(screen.getByTestId('chess-clock-red').textContent).toBe(before);
  });

  it('未暂停的正常对局棋钟照常走秒（暂停门控不误伤）', () => {
    renderPanel({ game: playingGame(), ended: null });
    const before = screen.getByTestId('chess-clock-red').textContent;
    act(() => {
      vi.advanceTimersByTime(2500);
    });
    expect(screen.getByTestId('chess-clock-red').textContent).not.toBe(before);
  });

  it('观战者看到暂停态：状态条提示"对局已暂停"，无暂停/继续按钮', () => {
    h.chess = {
      game: playingGame({
        clocks: { red: 290_000, black: 300_000, turnStartedAt: 1_000, deadline: 0, paused: true },
      }),
      ended: null,
      invite: null,
      outgoing: null,
      drawOfferFrom: null,
      undoOfferFrom: null,
      reviewOpen: false,
      reviewGameId: null,
      mySideOf: () => null,
    };
    render(<ChessGamePanel />);
    expect(screen.getByTestId('chess-status').textContent).toContain('对局已暂停');
    expect(screen.queryByTestId('chess-resume')).toBeNull();
    expect(screen.queryByTestId('chess-pause')).toBeNull();
  });
});
