/**
 * ============================================================
 * 棋局复盘弹窗（components/voice/chess/ChessReviewModal）
 * ============================================================
 * 两级视图：
 * - 列表：本房间终局留档（TanStack Query 拉取）+ 我的战绩（跨房间聚合）；
 * - 回放：选中一局后用同源引擎从初始局面逐着折叠（review.ts 的 foldGame），
 *   ⏮ ◀ ▶(自动播放) ⏭ 控制 + 记谱列表（点击跳转）。
 * 面板空闲时也可打开（VoiceRoomView 按 reviewOpen 渲染面板容器）。
 * ============================================================
 */

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Play,
  Square,
  Swords,
  X,
} from 'lucide-react';
import { getChessStats, getRoomGame, listRoomGames } from '../../../api/voice';
import type { VoiceGameDetail, VoiceGameSummary } from '../../../api/voice';
import { foldGame } from '../../../voice/chess/review';
import ChessBoard from './ChessBoard';
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

const RESULT_TEXT: Record<string, string> = { 'red-win': '红胜', 'black-win': '黑胜', draw: '和棋' };

/** 自动播放步进间隔（毫秒） */
const AUTO_PLAY_MS = 900;

export default function ChessReviewModal({
  roomId,
  selfId,
  initialGameId,
  onClose,
}: {
  roomId: number;
  selfId: number | null;
  /** 终局横幅"复盘"直达的对局 id；null 显示列表 */
  initialGameId: string | null;
  onClose: () => void;
}) {
  const [selectedGameId, setSelectedGameId] = useState<string | null>(initialGameId);
  // props 变化时在渲染期调整状态（React 官方推荐模式，避免 effect 内 setState 级联渲染）
  const [prevInitialGameId, setPrevInitialGameId] = useState(initialGameId);
  if (prevInitialGameId !== initialGameId) {
    setPrevInitialGameId(initialGameId);
    setSelectedGameId(initialGameId);
  }

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const gamesQuery = useQuery({
    queryKey: ['voice-games', roomId],
    queryFn: () => listRoomGames(roomId),
    // 弹窗内的弱实时数据：失败静默降级为空列表（与房间列表同一行为）
    retry: false,
  });

  const detailQuery = useQuery({
    queryKey: ['voice-game', roomId, selectedGameId],
    queryFn: () => getRoomGame(roomId, selectedGameId!),
    enabled: selectedGameId !== null,
    retry: false,
  });

  const statsQuery = useQuery({
    queryKey: ['chess-stats', selfId],
    queryFn: () => getChessStats(selfId!),
    enabled: selfId !== null,
    retry: false,
  });

  return (
    <div className={styles.reviewOverlay} onClick={onClose} data-testid="chess-review">
      <div className={styles.reviewModal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.reviewHeader}>
          <Swords size={16} />
          <b>{selectedGameId ? '棋局复盘' : '对局记录'}</b>
          {selfId !== null && !selectedGameId && (
            <span className={styles.reviewStats} data-testid="chess-stats">
              我的战绩：
              {statsQuery.data
                ? `${statsQuery.data.stats.wins}胜 ${statsQuery.data.stats.losses}负 ${statsQuery.data.stats.draws}和`
                : '—'}
            </span>
          )}
          <button className={styles.iconBtn} onClick={onClose} title="关闭">
            <X size={15} />
          </button>
        </div>

        {selectedGameId === null ? (
          <GameList
            games={gamesQuery.data?.games ?? []}
            hasMore={gamesQuery.data?.has_more ?? false}
            onPick={(gameId) => setSelectedGameId(gameId)}
          />
        ) : (
          <Playback detail={detailQuery.data?.game ?? null} onBack={() => setSelectedGameId(null)} />
        )}
      </div>
    </div>
  );
}

function GameList({
  games,
  hasMore,
  onPick,
}: {
  games: VoiceGameSummary[];
  hasMore: boolean;
  onPick: (gameId: string) => void;
}) {
  if (games.length === 0) {
    return <div className={styles.reviewEmpty}>本房间还没有终局留档（对局结束后自动保存）</div>;
  }
  return (
    <div className={styles.reviewList}>
      {games.map((g) => (
        <button key={g.game_id} className={styles.reviewRow} onClick={() => onPick(g.game_id)}>
          <span className={styles.reviewRowMain}>
            {g.red_name}（红） vs {g.black_name}（黑）
          </span>
          <span className={styles.reviewRowMeta}>
            {RESULT_TEXT[g.result] ?? g.result} · {END_REASON_TEXT[g.reason] ?? g.reason} · {g.move_count} 手
          </span>
        </button>
      ))}
      {hasMore && <div className={styles.reviewEmpty}>更早的对局可在房间删除前经 REST 分页拉取</div>}
    </div>
  );
}

function Playback({ detail, onBack }: { detail: VoiceGameDetail | null; onBack: () => void }) {
  const plies = useMemo(() => foldGame(detail?.moves ?? []), [detail]);
  const [plyIndex, setPlyIndex] = useState(0);
  const [autoPlay, setAutoPlay] = useState(false);

  // 换对局时回到开局（渲染期调整，理由同上）
  const [renderedGameId, setRenderedGameId] = useState(detail?.game_id ?? null);
  if (renderedGameId !== (detail?.game_id ?? null)) {
    setRenderedGameId(detail?.game_id ?? null);
    setPlyIndex(0);
    setAutoPlay(false);
  }

  // 自动播放：每步由定时器推进（setState 在回调内，异步上下文允许）；
  // 播到终局自动停
  useEffect(() => {
    if (!autoPlay) return;
    if (plyIndex >= plies.length - 1) return;
    const timer = window.setTimeout(() => {
      const next = Math.min(plyIndex + 1, plies.length - 1);
      setPlyIndex(next);
      if (next >= plies.length - 1) setAutoPlay(false);
    }, AUTO_PLAY_MS);
    return () => window.clearTimeout(timer);
  }, [autoPlay, plyIndex, plies.length]);

  if (!detail) {
    return <div className={styles.reviewEmpty}>对局数据加载中…</div>;
  }

  const ply = plies[Math.min(plyIndex, plies.length - 1)] ?? plies[0]!;
  const atStart = plyIndex <= 0;
  const atEnd = plyIndex >= plies.length - 1;

  return (
    <div className={styles.reviewPlayback}>
      <div className={styles.reviewBoardWrap}>
        <ChessBoard
          fen={ply.fen}
          lastMove={ply.lastMove}
          mySide={null}
          myTurn={false}
          flipped={false}
          onMove={() => {}}
        />
      </div>
      <div className={styles.reviewSide}>
        <div className={styles.reviewResult}>
          {RESULT_TEXT[detail.result] ?? detail.result} · {END_REASON_TEXT[detail.reason] ?? detail.reason}
          <i>
            {detail.red_name}（红） vs {detail.black_name}（黑）
          </i>
        </div>
        <div className={styles.reviewControls}>
          <button
            className={styles.iconBtn}
            onClick={() => setPlyIndex(0)}
            disabled={atStart}
            title="回到开局"
          >
            <ChevronsLeft size={15} />
          </button>
          <button
            className={styles.iconBtn}
            onClick={() => setPlyIndex((i) => Math.max(0, i - 1))}
            disabled={atStart}
            title="上一着"
          >
            <ChevronLeft size={15} />
          </button>
          <button
            className={styles.iconBtn}
            onClick={() => {
              if (atEnd) setPlyIndex(0);
              setAutoPlay((v) => !v);
            }}
            title={autoPlay ? '停止自动播放' : '自动播放'}
          >
            {autoPlay ? <Square size={13} /> : <Play size={13} />}
          </button>
          <button
            className={styles.iconBtn}
            onClick={() => setPlyIndex((i) => Math.min(plies.length - 1, i + 1))}
            disabled={atEnd}
            title="下一着"
          >
            <ChevronRight size={15} />
          </button>
          <button
            className={styles.iconBtn}
            onClick={() => setPlyIndex(plies.length - 1)}
            disabled={atEnd}
            title="跳到终局"
          >
            <ChevronsRight size={15} />
          </button>
        </div>
        <ol className={styles.reviewMoves}>
          {detail.notations.map((n, i) => (
            <li key={i}>
              <button
                className={`${styles.reviewMoveRow} ${i + 1 === plyIndex ? styles.reviewMoveActive : ''}`}
                onClick={() => setPlyIndex(i + 1)}
              >
                {i + 1}. {n}
              </button>
            </li>
          ))}
        </ol>
        <button className={styles.declineBtn} onClick={onBack}>
          返回列表
        </button>
      </div>
    </div>
  );
}
