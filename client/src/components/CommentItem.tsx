/**
 * ============================================================
 * 评论条目组件 (CommentItem)
 * ============================================================
 * 帖子详情中的单条评论（含回复标签、点赞、删除、回复、折叠操作）
 * 纯展示组件，状态与数据请求由 PostDetail 管理
 * ============================================================
 */

import { Heart, Trash2, ChevronDown, ChevronUp } from 'lucide-react';
import { Comment } from '../types';
import { formatAbsoluteTime, resolveMediaUrl } from '../utils';
import styles from './CommentItem.module.css';

interface CommentItemProps {
  comment: Comment;
  isReply: boolean;
  isCollapsed: boolean;
  hasReplies: boolean;
  replyCount: number;
  activeHighlighted: boolean;
  currentUserId: number | null | undefined;
  innerRef?: React.Ref<HTMLDivElement>;
  onProfileClick: (userId: number) => void;
  onReply: (comment: Comment) => void;
  onToggleReplies: (commentId: number) => void;
  onLike: (commentId: number) => void;
  onDelete: (commentId: number) => void;
}

export default function CommentItem({
  comment,
  isReply,
  isCollapsed,
  hasReplies,
  replyCount,
  activeHighlighted,
  currentUserId,
  innerRef,
  onProfileClick,
  onReply,
  onToggleReplies,
  onLike,
  onDelete,
}: CommentItemProps) {
  return (
    <div key={comment.id} id={`comment-${comment.id}`} className={`${styles.comment} ${isReply ? styles.replyItem : ''}`}>
      <div className={styles.avatarLink} onClick={() => onProfileClick(comment.user_id)} style={{ cursor: 'pointer' }}>
        {comment.avatar ? (
          <img src={resolveMediaUrl(comment.avatar) || ''} alt="" className={styles.avatar} />
        ) : (
          <div className={styles.avatarPlaceholder}>
            {comment.username.charAt(0).toUpperCase()}
          </div>
        )}
      </div>
      <div ref={innerRef} style={{ flex: 1 }} className={activeHighlighted ? styles.highlight : ''}>
        <div className={styles.content}>
          <span className={styles.usernameLink} onClick={() => onProfileClick(comment.user_id)} style={{ cursor: 'pointer' }}>{comment.username}</span>
          {isReply && comment.parent_username && (
            <span className={styles.replyTag}>@{comment.parent_username}</span>
          )}
          {comment.content}
        </div>
        <div className={styles.actionsRow}>
          <span className={styles.time}>{formatAbsoluteTime(comment.created_at)}</span>
          <button
            className={styles.replyBtn}
            onClick={() => onReply(comment)}
          >
            回复
          </button>
          {!isReply && hasReplies && (
            <button
              className={styles.collapseBtn}
              onClick={() => onToggleReplies(comment.id)}
            >
              {isCollapsed ? (
                <>
                  <ChevronDown size={14} />
                  <span>展开{replyCount}条回复</span>
                </>
              ) : (
                <>
                  <ChevronUp size={14} />
                  <span>收起回复</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, flexShrink: 0 }}>
        <button
          className={`${styles.likeBtn} ${comment.liked ? styles.liked : ''}`}
          onClick={() => onLike(comment.id)}
        >
          <Heart size={14} fill="none" stroke="currentColor" />
          {comment.like_count > 0 && <span>{comment.like_count}</span>}
        </button>
        {comment.user_id === currentUserId && (
          <button
            className={styles.deleteBtn}
            onClick={() => onDelete(comment.id)}
            title="删除评论"
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>
    </div>
  );
}
