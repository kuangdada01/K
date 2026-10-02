/**
 * ============================================================
 * 对战象棋面板（components/voice/chess/ChessGamePanel）
 * ============================================================
 * 屏幕共享舞台下方的对局容器：邀请横幅（收到的/发出的）、对局状态条
 * （双方席位/棋钟/轮次/将军提示）、棋盘、被吃子陈列、棋谱条、
 * 暂停/继续、求和/悔棋/认输操作、终局横幅。
 * 空闲时整个面板不渲染（对局入口在成员卡上的"对弈"按钮）。
 *
 * 棋钟：服务端权威（超时由服务端裁决判负），这里只按广播的
 * clocks（剩余总时长 + 轮到方计时锚点）本地走秒展示。
 * 暂停：clocks.paused 为唯一事实来源（game-paused/resumed/快照都带），
 * 暂停时停走秒、棋盘不可走子并蒙遮罩；任一棋手都能点"继续对局"。
 * ============================================================
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Crown, RotateCcw, Swords, Undo2, Volume2, VolumeX } from 'lucide-react';
import { findKing, isInCheck, parseFen, type ChessClocks, type ChessSide, type ChessSquare } from '@k/shared';
import { useVoice } from '../../../context/VoiceContext';
import {
  getSoundLoadState,
  playChessSound,
  subscribeSoundLoad,
  type ChessSound,
} from '../../../voice/chess/sounds';
import { showToast } from '../../ui/Toast';
import ChessBoard from './ChessBoard';
import ChessReviewModal from './ChessReviewModal';
import styles from './chess.module.css';

const END_REASON_TEXT: Record<string, string> = {
  checkmate: '将死',
  stalemate: '困毙',
  insufficient: '双方均无进攻子力',
  repetition: '三次重复局面',
  perpetual: '长将判负',
  resign: '认输',
  disconnect: '对方断线超时',
  timeout: '超时判负',
  agreement: '双方同意',
};

/** 毫秒 → m:ss（棋钟展示口径；负值按 0 处理） */
function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** 某侧当前剩余：轮到方取 总时长 与 单步期限 的较小者（与服务端的判定一致）；
 *  暂停时双方冻结（服务端已在暂停时把已耗时间扣进 remaining）；
 *  clockOffset = 服务端 - 本机的钟差：deadline 是服务端口径的绝对时间，
 *  先把本机 now 校准过去，两台设备时钟有偏差时双方看到的剩余才一致 */
function remainingOf(
  clocks: ChessClocks,
  side: ChessSide,
  turn: ChessSide,
  playing: boolean,
  paused: boolean,
  now: number,
  clockOffset = 0
): number {
  if (!playing || paused || side !== turn) return Math.max(0, clocks[side]);
  return Math.max(0, Math.min(clocks[side], clocks.deadline - (now + clockOffset)));
}

export default function ChessGamePanel() {
  const voice = useVoice();
  const chess = voice.chess;
  const selfId = voice.participants[0]?.userId ?? null;
  const game = chess.game;
  const invite = chess.invite;
  const outgoing = chess.outgoing;
  const ended = chess.ended;

  const mySide = selfId !== null && game ? chess.mySideOf(selfId) : null;
  const playing = !!game && game.status === 'playing';
  // 暂停态以 clocks.paused 为准（服务端在 game-paused/resumed/快照里都带）：
  // 停走秒、停走子，双方都能看到也都能恢复
  const paused = playing && !!game.clocks.paused;
  const myTurn = playing && !paused && mySide !== null && game!.turn === mySide;

  // 本地走秒（500ms 步进足够平滑；对局结束/暂停即停表）
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!playing || paused) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [playing, paused]);

  // 将军提示由客户端用同源引擎从 FEN 现算（快照也无需额外字段）
  const check = useMemo(() => {
    if (!game || !playing) return false;
    try {
      const { board, turn } = parseFen(game.fen);
      return isInCheck(board, turn);
    } catch {
      return false;
    }
  }, [game, playing]);

  // 音效（走子/吃子/将军/终局）：**只有用户给的那一套素材**，开关两态（开 / 关）。
  //
  // 这里曾经是个"经典 / 合成 / 关"的三态循环 + 一套实时合成的备用音效。
  // 09-29 连着出了两次事（素材没就位时静默改播合成音；循环的「关 → 开」不回经典档，
  // 用户被永久卡在合成音上），所以备用音效连同档位一并删掉了 ——
  // 素材没就位就**不响**，并在这里把原因说出来（见下面的 loadState）。
  const [soundOn, setSoundOn] = useState(() => localStorage.getItem('voice:chessSound') !== '0');
  const soundOnRef = useRef(soundOn);
  useEffect(() => {
    soundOnRef.current = soundOn;
  }, []);

  /**
   * 素材的就位状态：`loading` / `ready` / `failed`。
   *
   * 为什么要把这件事摆到界面上：素材取不到时现在**什么都不会响**，
   * 用户只会以为"音效坏了"。第一次真失败就弹一条提示，标题也点明原因。
   */
  const [loadState, setLoadState] = useState(() => getSoundLoadState());
  useEffect(() => {
    // 只在"本次挂载期间**变成** failed"时提示：进房时已经坏掉的老状态不再重复弹
    let announced = getSoundLoadState() === 'failed';
    return subscribeSoundLoad((next) => {
      setLoadState(next);
      if (next === 'failed' && !announced) {
        announced = true;
        showToast('音效素材加载失败，本局暂时没有音效（可刷新页面重试）');
      }
    });
  }, []);

  const toggleSound = useCallback(() => {
    setSoundOn((on) => {
      localStorage.setItem('voice:chessSound', on ? '0' : '1');
      return !on;
    });
  }, []);

  const soundKeyRef = useRef('');
  useEffect(() => {
    if (!game || !playing) return;
    const key = `${game.gameId}:${game.moveCount}`;
    if (soundKeyRef.current === key) return;
    soundKeyRef.current = key;
    if (!soundOnRef.current || !game.lastMove) return;
    const kind: ChessSound = game.lastMove.captured ? 'capture' : 'move';
    playChessSound(kind);
    if (check) {
      window.setTimeout(() => playChessSound('check'), 200);
    }
  }, [game, playing, check]);

  // 终局音效：胜=上行小旋律 / 负=下行 / 和与观战=平音（绝杀/超时/认输同走此路径）
  const endSoundKeyRef = useRef('');
  useEffect(() => {
    if (!ended || !game) return;
    const key = `${game.gameId}:${ended.result}:${ended.reason}`;
    if (endSoundKeyRef.current === key) return;
    endSoundKeyRef.current = key;
    if (!soundOnRef.current) return;
    // 绝杀专属音（checkmate.m4a）：直接顶掉胜/负旋律 —— 绝杀事件本身比"谁赢了"更响
    if (ended.reason === 'checkmate') {
      playChessSound('checkmate');
      return;
    }
    let kind: ChessSound = 'end-draw';
    if (ended.result !== 'draw' && mySide) {
      const iWin =
        (ended.result === 'red-win' && mySide === 'red') ||
        (ended.result === 'black-win' && mySide === 'black');
      kind = iWin ? 'end-win' : 'end-lose';
    }
    playChessSound(kind);
  }, [ended, game, mySide]);

  // 绝杀动画（checkmate 专属）：棋盘震动 + 红光 + "绝杀"书法字浮现，
  // 持续 2.8s 后移除；对局双方与观战者本端各自播放。
  // ⚠️ 计时器必须与 [ended, game] 解耦另起一个 effect：这个 effect 的依赖里有
  // game —— 2.8s 内只要再来一条会写 game 的消息（对方点「再来一局」→
  // game-rematch-offered），React 会先跑上一次的清理函数清掉这里的定时器，
  // 而本次执行又被 cmKeyRef 去重提前 return（不再补定时器）→ 震动与红光
  // 永远不结束，棋盘上一直蒙着一层红雾。
  const [checkmateFx, setCheckmateFx] = useState(false);
  const cmKeyRef = useRef('');
  useEffect(() => {
    if (!ended || !game) return;
    if (ended.reason !== 'checkmate') return;
    const key = `${game.gameId}:cm`;
    if (cmKeyRef.current === key) return;
    cmKeyRef.current = key;
    setCheckmateFx(true);
  }, [ended, game]);
  useEffect(() => {
    if (!checkmateFx) return;
    const timer = window.setTimeout(() => setCheckmateFx(false), 2800);
    return () => window.clearTimeout(timer);
  }, [checkmateFx]);

  // 被绝杀方的老将位置（引擎同源 findKing，红光脉冲高亮）
  const mateKing = useMemo(() => {
    if (!checkmateFx || !game || !ended || ended.result === 'draw') return null;
    const loserSide = ended.result === 'red-win' ? 'black' : 'red';
    try {
      return findKing(parseFen(game.fen).board, loserSide);
    } catch {
      return null;
    }
  }, [checkmateFx, game, ended]);

  // 视角：棋手固定己方在下；观战者默认红下、可手动翻转
  const [spectatorFlipped, setSpectatorFlipped] = useState(false);
  const flipped = mySide === 'black' || (mySide === null && spectatorFlipped);

  const endedView = useMemo(() => {
    if (!ended || !game || mySide === null)
      return { text: ended ? '对局结束' : '', mine: null as boolean | null };
    if (ended.result === 'draw') return { text: '和棋', mine: null };
    const winnerIsMe =
      (ended.result === 'red-win' && mySide === 'red') ||
      (ended.result === 'black-win' && mySide === 'black');
    return { text: winnerIsMe ? '你赢了' : '你输了', mine: winnerIsMe };
  }, [ended, game, mySide]);

  // 终局说明显式写出胜方（绝杀/超时/认输都要一眼看到谁赢了）
  const endedDetail = useMemo(() => {
    if (!ended || !game) return '';
    if (ended.result === 'draw') return END_REASON_TEXT[ended.reason] ?? ended.reason;
    const winnerSide = ended.result === 'red-win' ? '红方' : '黑方';
    const winner = ended.result === 'red-win' ? game.red : game.black;
    return `${winnerSide} ${winner.username} 获胜 · ${END_REASON_TEXT[ended.reason] ?? ended.reason}`;
  }, [ended, game]);

  // 棋谱条：最近 4 着 + 总手数
  const notationTail = useMemo(() => {
    if (!game) return '';
    const tail = game.notations.slice(-4).join('，');
    return game.notations.length > 4 ? `…${tail}` : tail;
  }, [game]);

  const handleMove = (from: ChessSquare, to: ChessSquare) => {
    if (!game) return;
    chess.move(game.gameId, game.moveCount, from, to);
  };

  const handleResign = () => {
    if (!game) return;
    if (window.confirm('确定认输吗？')) chess.resign(game.gameId);
  };

  const handleUndo = () => {
    if (!game) return;
    chess.offerUndo(game.gameId);
  };

  const handleRematch = () => {
    if (!game) return;
    chess.rematch(game.gameId);
  };

  const handlePause = () => {
    if (!game) return;
    chess.pause(game.gameId);
  };

  const handleResume = () => {
    if (!game) return;
    chess.resume(game.gameId);
  };

  const seatCaptured = (side: ChessSide): string => {
    if (!game) return '';
    const pieces = side === 'red' ? game.captured.red : game.captured.black;
    return pieces.join(' ');
  };

  const clockLabel = (side: ChessSide): { text: string; low: boolean } => {
    if (!game) return { text: '--', low: false };
    const remaining = remainingOf(game.clocks, side, game.turn, playing, paused, now, chess.clockOffset);
    return { text: formatClock(remaining), low: playing && !paused && remaining < 20_000 };
  };

  // 复盘弹窗（空闲/对局两个分支都要能渲染 —— 空闲入口条与终局横幅都会打开它）
  const reviewModal =
    chess.reviewOpen && voice.activeRoomId !== null ? (
      <ChessReviewModal
        roomId={voice.activeRoomId}
        selfId={selfId}
        initialGameId={chess.reviewGameId}
        onClose={chess.closeReview}
      />
    ) : null;

  /*
   * 邀请横幅（收到的 / 等待应答的）：**两个分支都要渲染**。
   *
   * 以前只挂在"无对局"分支里 —— 于是一方收起棋盘（或刷新后本端不再摆残局）去点
   * 成员卡的「对弈」邀请对方时，对面还摆着终局棋盘，这条横幅在他那边根本不存在，
   * 只能眼睁睁看着邀请过期。进行中的对局收不到邀请（服务端 `game-busy`），
   * 所以放在对局分支里也不会干扰棋局。
   */
  const inviteBanners = (
    <>
      {invite && (
        <div className={styles.banner} data-testid="chess-invite">
          <Swords size={16} />
          <span>
            <b>{invite.from.username}</b> 邀你对弈（
            {invite.side === 'red' ? '他执红' : invite.side === 'black' ? '他执黑' : '随机执子'}）
          </span>
          <button className={styles.acceptBtn} onClick={() => chess.respondInvite(invite.inviteId, true)}>
            接受
          </button>
          <button className={styles.declineBtn} onClick={() => chess.respondInvite(invite.inviteId, false)}>
            拒绝
          </button>
        </div>
      )}
      {outgoing && (
        <div className={styles.banner} data-testid="chess-outgoing">
          <Swords size={16} />
          <span>
            已向 <b>{outgoing.toName}</b> 发出对局邀请，等待应答…
          </span>
          <button className={styles.declineBtn} onClick={() => chess.cancelInvite(outgoing.inviteId)}>
            撤销
          </button>
        </div>
      )}
    </>
  );

  if (!game) {
    // 无对局：只渲染邀请/待应答横幅
    return (
      <section className={styles.panel} data-testid="chess-panel">
        {!invite && !outgoing && (
          <div className={styles.idleBar} data-testid="chess-idle">
            <span>想杀一盘？点成员卡片上的「对弈」发起邀请</span>
            <button
              className={styles.declineBtn}
              onClick={() => chess.openReview()}
              data-testid="chess-review-entry"
            >
              对局记录
            </button>
          </div>
        )}
        {inviteBanners}
        {reviewModal}
      </section>
    );
  }

  const redClock = clockLabel('red');
  const blackClock = clockLabel('black');

  return (
    <section className={styles.panel} data-testid="chess-panel">
      {inviteBanners}
      {/* 状态条：席位 + 棋钟 + 轮次/将军 */}
      <div className={styles.statusBar}>
        <span className={`${styles.seat} ${game.turn === 'red' && playing ? styles.seatTurn : ''}`}>
          <i className={styles.seatRed}>红</i>
          {game.red.username}
          <b
            className={`${styles.clock} ${redClock.low ? styles.clockLow : ''} ${game.turn === 'red' && playing ? styles.clockActive : ''}`}
            data-testid="chess-clock-red"
          >
            {redClock.text}
          </b>
        </span>
        <span className={styles.vs} data-testid="chess-status">
          {playing
            ? paused
              ? '对局已暂停'
              : myTurn
                ? '轮到你走'
                : `轮到${game.turn === 'red' ? '红' : '黑'}方`
            : '对局结束'}
          {check && playing && !paused && <b className={styles.checkBadge}>将军！</b>}
        </span>
        <span className={`${styles.seat} ${game.turn === 'black' && playing ? styles.seatTurn : ''}`}>
          <b
            className={`${styles.clock} ${blackClock.low ? styles.clockLow : ''} ${game.turn === 'black' && playing ? styles.clockActive : ''}`}
            data-testid="chess-clock-black"
          >
            {blackClock.text}
          </b>
          {game.black.username}
          <i className={styles.seatBlack}>黑</i>
        </span>
        <button
          className={`${styles.iconBtn} ${soundOn ? styles.ttsOn : ''}`}
          onClick={toggleSound}
          title={
            !soundOn
              ? '音效：关（点击开启）'
              : loadState === 'failed'
                ? '音效：素材加载失败，本局没有音效（可刷新页面重试）'
                : loadState === 'loading'
                  ? '音效：开（素材加载中…）'
                  : '音效：开（落子 / 吃子 / 将军 / 绝杀）'
          }
          data-testid="chess-sound-toggle"
        >
          {soundOn ? <Volume2 size={14} /> : <VolumeX size={14} />}
        </button>
        {mySide === null && (
          <button className={styles.iconBtn} onClick={() => setSpectatorFlipped((v) => !v)} title="翻转视角">
            <RotateCcw size={14} />
          </button>
        )}
      </div>

      {/* 被吃子陈列（各自吃获的战利品） */}
      <div className={styles.capturedRow}>
        <span data-testid="chess-captured-red">红获：{seatCaptured('red') || '—'}</span>
        <span data-testid="chess-captured-black">黑获：{seatCaptured('black') || '—'}</span>
      </div>

      {chess.drawOfferFrom !== null && playing && (
        <div className={styles.banner} data-testid="chess-draw-offer">
          <Undo2 size={15} />
          <span>对方提议和棋</span>
          <button className={styles.acceptBtn} onClick={() => chess.respondDraw(game.gameId, true)}>
            同意
          </button>
          <button className={styles.declineBtn} onClick={() => chess.respondDraw(game.gameId, false)}>
            继续
          </button>
        </div>
      )}

      {chess.undoOfferFrom !== null && playing && (
        <div className={styles.banner} data-testid="chess-undo-offer">
          <Undo2 size={15} />
          <span>对方请求悔棋</span>
          <button className={styles.acceptBtn} onClick={() => chess.respondUndo(game.gameId, true)}>
            同意
          </button>
          <button className={styles.declineBtn} onClick={() => chess.respondUndo(game.gameId, false)}>
            拒绝
          </button>
        </div>
      )}

      <div
        className={checkmateFx ? styles.boardShake : undefined}
        style={{ display: 'flex', justifyContent: 'center', position: 'relative' }}
      >
        <ChessBoard
          fen={game.fen}
          lastMove={game.lastMove}
          mySide={mySide}
          myTurn={myTurn}
          flipped={flipped}
          kingHighlight={mateKing}
          onMove={handleMove}
        />
        {checkmateFx && (
          <div className={styles.mateOverlay} data-testid="chess-checkmate-fx">
            <span className={styles.mateSplash}>绝杀</span>
          </div>
        )}
        {paused && (
          <div className={styles.pauseOverlay} data-testid="chess-pause-overlay">
            <span className={styles.pauseBadge}>对局已暂停</span>
          </div>
        )}
      </div>

      {/* 棋谱条（中文记谱） */}
      {game.notations.length > 0 && (
        <div className={styles.notationStrip} data-testid="chess-notation">
          <span className={styles.moveCount}>第 {game.moveCount} 手</span>
          <span className={styles.notationText}>{notationTail}</span>
        </div>
      )}

      {/* 操作条：棋手显示暂停（暂停中转"继续"）/悔棋/求和/认输，观战显示观战提示 */}
      {playing && mySide !== null && (
        <div className={styles.actionBar}>
          {paused ? (
            <button className={styles.acceptBtn} onClick={handleResume} data-testid="chess-resume">
              继续对局
            </button>
          ) : (
            <button className={styles.declineBtn} onClick={handlePause} data-testid="chess-pause">
              暂停
            </button>
          )}
          {game.moveCount > 0 && (
            <button className={styles.declineBtn} onClick={handleUndo}>
              悔棋
            </button>
          )}
          <button className={styles.declineBtn} onClick={() => chess.offerDraw(game.gameId)}>
            求和
          </button>
          <button className={styles.declineBtn} onClick={handleResign}>
            认输
          </button>
        </div>
      )}
      {playing && mySide === null && (
        <div className={styles.actionBar}>
          <span className={styles.moveCount}>
            观战中（{game.red.username} vs {game.black.username}）{paused ? ' · 对局已暂停' : ''}
          </span>
        </div>
      )}

      {/* 兜底：对局已结束但没有终局信息（异常情况）也给出可操作的出口 */}
      {!playing && !ended && (
        <div className={styles.banner}>
          <span>对局结束</span>
          <button className={styles.declineBtn} onClick={chess.dismissEnded}>
            收起棋盘
          </button>
        </div>
      )}

      {/* 终局横幅：结果 + 大号"再来一局"主按钮（任一方点击即向对方发出新一局邀请） */}
      {!playing && ended && (
        <div className={styles.endedBlock} data-testid="chess-ended">
          <div className={styles.endedTitle}>
            <Crown size={18} />
            <b
              className={
                endedView.mine === true ? styles.winText : endedView.mine === false ? styles.loseText : ''
              }
            >
              {endedView.text}
            </b>
            <i className={styles.endedDetail}>{endedDetail}</i>
          </div>
          {mySide !== null && game.rematchBy === selfId && (
            <button className={styles.rematchBtn} disabled data-testid="chess-rematch">
              等待对方再来一局…
            </button>
          )}
          {mySide !== null && game.rematchBy !== null && game.rematchBy !== selfId && (
            <button className={styles.rematchBtn} onClick={handleRematch} data-testid="chess-rematch">
              对方想再来一局 · 点击开始
            </button>
          )}
          {mySide !== null && game.rematchBy === null && (
            <button className={styles.rematchBtn} onClick={handleRematch} data-testid="chess-rematch">
              再来一局
            </button>
          )}
          {mySide !== null && game.rematchBy === null && (
            <span className={styles.endedHint}>双方都点「再来一局」即立即开始下一盘（换边）</span>
          )}
          <div className={styles.endedActions}>
            <button className={styles.declineBtn} onClick={() => chess.openReview(game.gameId)}>
              复盘
            </button>
            <button className={styles.declineBtn} onClick={chess.dismissEnded} title="关闭棋盘">
              收起棋盘
            </button>
          </div>
        </div>
      )}

      {/* 绝杀闪现：将死瞬间的大字提示（1.8s 弹出并淡出，纯 CSS 挂载即播放） */}
      {ended?.reason === 'checkmate' && (
        <div className={styles.mateFlash} aria-hidden>
          绝杀！
        </div>
      )}
      {reviewModal}
    </section>
  );
}
