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
  playSound: vi.fn(),
  toast: vi.fn(),
  /** 素材就位状态（面板据此改写喇叭标题 + 弹一次提示） */
  loadState: 'ready' as 'loading' | 'ready' | 'failed',
  loadListeners: [] as ((s: 'loading' | 'ready' | 'failed') => void)[],
}));

vi.mock('../../../context/VoiceContext', () => ({
  useVoice: () => ({
    chess: h.chess,
    participants: [{ userId: 1, username: 'alice', avatar: null }],
    activeRoomId: 7,
  }),
}));

vi.mock('../../ui/Toast', () => ({ showToast: h.toast }));

vi.mock('../../../voice/chess/sounds', () => ({
  playChessSound: h.playSound,
  getSoundLoadState: () => h.loadState,
  subscribeSoundLoad: (cb: (s: 'loading' | 'ready' | 'failed') => void) => {
    h.loadListeners.push(cb);
    return () => {
      h.loadListeners = h.loadListeners.filter((l) => l !== cb);
    };
  },
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
  h.playSound.mockClear();
  h.toast.mockClear();
  h.loadState = 'ready';
  h.loadListeners = [];
  sessionStorage.clear();
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

/**
describe('ChessGamePanel 音效素材状态', () => {
  it('素材就位：喇叭标题说明是"开"，不弹提示', () => {
    renderPanel({ game: playingGame(), ended: null });
    expect(screen.getByTestId('chess-sound-toggle').getAttribute('title')).toBe(
      '音效：开（落子 / 吃子 / 将军 / 绝杀）'
    );
    expect(h.toast).not.toHaveBeenCalled();
  });

  it('素材还在加载：标题点明"加载中"，不弹提示（不是失败，不该惊动用户）', () => {
    h.loadState = 'loading';
    renderPanel({ game: playingGame(), ended: null });
    expect(screen.getByTestId('chess-sound-toggle').getAttribute('title')).toContain('素材加载中');
    expect(h.toast).not.toHaveBeenCalled();
  });

  it('素材加载失败：标题改写 + 弹一条提示（只弹一次）', () => {
    h.loadState = 'loading';
    renderPanel({ game: playingGame(), ended: null });

    act(() => {
      h.loadListeners.forEach((cb) => cb('failed'));
    });

    expect(screen.getByTestId('chess-sound-toggle').getAttribute('title')).toContain('素材加载失败');
    expect(h.toast).toHaveBeenCalledTimes(1);
    expect(h.toast.mock.calls[0]![0]).toContain('音效素材加载失败');

    // 后续再来一次 failed（比如另一个音效也失败）不重复弹
    act(() => {
      h.loadListeners.forEach((cb) => cb('failed'));
    });
    expect(h.toast).toHaveBeenCalledTimes(1);
  });

  it('挂载时就已经是失败态：只改标题，不再重复弹提示（进房不该被老状态打扰）', () => {
    h.loadState = 'failed';
    renderPanel({ game: playingGame(), ended: null });
    expect(screen.getByTestId('chess-sound-toggle').getAttribute('title')).toContain('素材加载失败');
    expect(h.toast).not.toHaveBeenCalled();
  });
});

/**
 * 音效开关：**两态**（开 / 关）。
 *
 * 这里原本是"经典 / 合成 / 关"三态循环 + 一套实时合成的备用音效，09-29 连出两次事故：
 * 素材没就位时静默改播合成音；循环的「关 → 开」不回经典档，用户被永久卡在合成音上。
 * 备用音效已整体删除，开关只剩开 / 关。
 */
describe('ChessGamePanel 音效开关', () => {
  it('点击在开 / 关之间切换，并持久化偏好', () => {
    renderPanel({ game: playingGame(), ended: null });
    const toggle = screen.getByTestId('chess-sound-toggle');
    expect(toggle.getAttribute('title')).toContain('音效：开');

    fireEvent.click(toggle); // 开 → 关
    expect(toggle.getAttribute('title')).toBe('音效：关（点击开启）');
    expect(localStorage.getItem('voice:chessSound')).toBe('0');

    fireEvent.click(toggle); // 关 → 开
    expect(toggle.getAttribute('title')).toContain('音效：开');
    expect(localStorage.getItem('voice:chessSound')).toBe('1');
    localStorage.removeItem('voice:chessSound');
  });

  it('关闭后不再播放任何音效（走子不响）', () => {
    localStorage.setItem('voice:chessSound', '0');
    const panel = renderPanel({ game: playingGame({ moveCount: 0 }), ended: null });
    panel.update({
      game: playingGame({
        moveCount: 1,
        lastMove: {
          from: { f: 7, r: 2 },
          to: { f: 4, r: 2 },
          piece: 'C',
          captured: null,
        } as never,
      }),
    });
    expect(h.playSound).not.toHaveBeenCalled();
    localStorage.removeItem('voice:chessSound');
  });
});

/**
 * 邀请横幅在两个分支都要在。
 *
 * 存量坑：横幅原来只挂在"无对局"分支里 —— 一方收起棋盘（或刷新后本端不再摆残局）
 * 去点成员卡「对弈」邀请对方时，对面还摆着终局棋盘，这条横幅在他那边根本不存在，
 * 只能看着邀请过期（服务端 30s 后回 `expired`）。进行中的对局收不到邀请
 * （服务端 `game-busy`），所以放进对局分支不会干扰棋局。
 */
describe('ChessGamePanel 邀请横幅', () => {
  it('终局棋盘还摆着时，收到的邀请照样可见、可接受', () => {
    const respondInvite = vi.fn();
    h.chess = {
      game: mateGame(),
      ended: ENDED,
      invite: {
        inviteId: 'inv1',
        from: { userId: 2, username: 'bob', avatar: null },
        side: 'red',
        expiresAt: Date.now() + 30_000,
      },
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
      respondInvite,
      cancelInvite: vi.fn(),
      mySideOf: (userId: number) => (userId === 1 ? 'red' : userId === 2 ? 'black' : null),
    };
    render(<ChessGamePanel />);

    expect(screen.getByTestId('chess-board')).toBeTruthy(); // 残局棋盘仍在
    expect(screen.getByTestId('chess-ended')).toBeTruthy();
    expect(screen.getByTestId('chess-invite')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '接受' }));
    expect(respondInvite).toHaveBeenCalledWith('inv1', true);
  });
});
