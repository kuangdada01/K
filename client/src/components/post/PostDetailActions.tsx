/**
 * ============================================================
 * 帖子详情底部操作栏（PostDetailActions）
 * ============================================================
 * 从 PostDetail 抽出的纯展示组件：点赞/评论/转发/分享/收藏五个按钮。
 * 状态与业务逻辑全部由 PostDetail 持有，经 props 注入。
 */
import type { RefObject } from 'react';
import { MessageCircle, Share2, Bookmark, Repeat2 } from 'lucide-react';
import RepostCheck from '../icons/RepostCheck';
import styles from './PostDetail.module.css';

interface PostDetailActionsProps {
  liked: boolean;
  likeCount: number;
  commentsCount: number;
  reposted: boolean;
  repostCount: number;
  shareCount: number;
  bookmarked: boolean;
  showTooltip: boolean;
  /** 点赞红心 SVG（PostDetail 直接操作 DOM 填色，ref 由主组件持有） */
  heartRef: RefObject<SVGSVGElement | null>;
  onLike: () => void;
  onComment: () => void;
  onRepost: () => void;
  onShare: () => void;
  onBookmark: () => void;
}

export default function PostDetailActions({
  liked,
  likeCount,
  commentsCount,
  reposted,
  repostCount,
  shareCount,
  bookmarked,
  showTooltip,
  heartRef,
  onLike,
  onComment,
  onRepost,
  onShare,
  onBookmark,
}: PostDetailActionsProps) {
  return (
    <div className={styles.actions}>
      <button
        className={`${styles.actionBtn} ${liked ? styles.liked : ''}`}
        onClick={onLike}
        aria-label={liked ? '取消点赞' : '点赞'}
      >
        <svg
          ref={heartRef}
          xmlns="http://www.w3.org/2000/svg"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path
            d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"
            fill="none"
            stroke="currentColor"
          />
        </svg>
        <span className={styles.actionCount}>{likeCount}</span>
      </button>
      <button className={styles.actionBtn} onClick={onComment} aria-label="评论">
        <MessageCircle size={24} />
        <span className={styles.actionCount}>{commentsCount}</span>
      </button>
      <button
        className={`${styles.actionBtn} ${reposted ? styles.reposted : ''}`}
        onClick={onRepost}
        aria-label={reposted ? '取消转发' : '转发'}
      >
        {reposted ? <RepostCheck size={28} /> : <Repeat2 size={28} />}
        {repostCount > 0 && <span className={styles.actionCount}>{repostCount}</span>}
      </button>
      <button className={`${styles.actionBtn} ${styles.shareTooltip}`} onClick={onShare} aria-label="分享">
        <Share2 size={24} />
        {shareCount > 0 && <span className={styles.actionCount}>{shareCount}</span>}
        {showTooltip && <span className={styles.shareTooltipText}>已复制链接</span>}
      </button>
      <button
        className={`${styles.actionBtn} ${styles.bookmarkBtn} ${bookmarked ? styles.bookmarked : ''}`}
        onClick={onBookmark}
        aria-label={bookmarked ? '取消收藏' : '收藏'}
      >
        <Bookmark size={24} fill={bookmarked ? 'currentColor' : 'none'} />
      </button>
    </div>
  );
}
