/**
 * ============================================================
 * 帖子详情 · 评论列表（components/post/PostDetailComments）
 * ============================================================
 * 自 PostDetail.tsx 抽出（结构拆分，行为逐字节不变）：详情页中
 * 「帖子描述那条伪评论 + 可见评论列表 + 加载更多 + 列表末尾锚点」这一段。
 *
 * 拆分动机：PostDetail 同时承担「覆盖层外壳 / 媒体区 / 操作栏 / 评论线程」
 * 四件事，评论列表这一段是其中唯一自洽、可独立阅读的块。
 *
 * 可见评论列表在本组件内用 useMemo 计算（原先在 PostDetail 里），
 * 这样「评论数据的派生」与「评论的渲染」在同一处，PostDetail 不必再持有
 * visibleComments 这个中间量。
 *
 * 注意：外层不要加 memo。传入的 onReply / onToggleReplies / onLike / onDelete
 * 已由 useCommentThread 用 useCallback 固定引用（见该 hook 的注释），
 * 真正受益的是每条 CommentItem 的 memo；本组件本身很薄，再包一层没有收益。
 * ============================================================
 */

import { useMemo } from 'react';
import type { RefObject } from 'react';

import CommentItem from '../CommentItem';
import TaggedText from '../TaggedText';
import { buildVisibleComments } from '../../lib/comments';
import { resolveMediaUrl } from '../../utils';
import type { Comment, Post } from '../../types';
import styles from './PostDetail.module.css';

export interface PostDetailCommentsProps {
  /** 帖子（描述会作为第一条伪评论展示，与历史行为一致） */
  post: Post;
  comments: Comment[];
  /** 已折叠的评论 id 集合 */
  collapsedReplies: Set<number>;
  commentHasMore: boolean;
  commentTotal: number;
  commentsLoadingMore: boolean;
  currentUserId: number | undefined;
  /** 高亮定位到的评论 id（来自 ?comment= 深链/通知跳转） */
  activeHighlightId: number | null;
  /** 高亮评论的 DOM 引用（用于滚动定位） */
  highlightRef: RefObject<HTMLDivElement | null>;
  /** 列表末尾锚点（新增评论后滚动到这里） */
  endRef: RefObject<HTMLDivElement | null>;
  onLoadMore: () => void;
  onProfileClick: (userId: number) => void;
  onReply: (comment: Comment) => void;
  onToggleReplies: (commentId: number) => void;
  onLike: (commentId: number) => void;
  onDelete: (commentId: number) => void;
}

export default function PostDetailComments({
  post,
  comments,
  collapsedReplies,
  commentHasMore,
  commentTotal,
  commentsLoadingMore,
  currentUserId,
  activeHighlightId,
  highlightRef,
  endRef,
  onLoadMore,
  onProfileClick,
  onReply,
  onToggleReplies,
  onLike,
  onDelete,
}: PostDetailCommentsProps) {
  // 只依赖评论数据与折叠集合：输入框敲字不再重建整棵评论列表
  const visibleComments = useMemo(
    () => buildVisibleComments(comments, collapsedReplies),
    [comments, collapsedReplies]
  );

  return (
    <div className={styles.comments}>
      {post.description && (
        <div className={styles.comment}>
          {post.avatar ? (
            <img src={resolveMediaUrl(post.avatar) || ''} alt="" className={styles.commentAvatar} />
          ) : (
            <div className={styles.commentAvatarPlaceholder}>{post.username.charAt(0).toUpperCase()}</div>
          )}
          <div>
            <div className={styles.commentContent}>
              <span className={styles.commentUsername}>{post.username}</span>
              <TaggedText text={post.description} />
            </div>
          </div>
        </div>
      )}
      {visibleComments.map((item) => {
        if (!item) return null;
        const { comment, isReply, isCollapsed, hasReplies, replyCount } = item;
        const activeHighlighted = activeHighlightId === comment.id;

        return (
          <CommentItem
            key={comment.id}
            comment={comment}
            isReply={isReply}
            isCollapsed={isCollapsed}
            hasReplies={hasReplies}
            replyCount={replyCount}
            activeHighlighted={activeHighlighted}
            currentUserId={currentUserId}
            innerRef={activeHighlighted ? highlightRef : undefined}
            onProfileClick={onProfileClick}
            onReply={onReply}
            onToggleReplies={onToggleReplies}
            onLike={onLike}
            onDelete={onDelete}
          />
        );
      })}
      {commentHasMore && (
        <button className={styles.commentsLoadMore} onClick={onLoadMore} disabled={commentsLoadingMore}>
          {commentsLoadingMore ? '加载中…' : `加载更多评论（已加载 ${comments.length}/${commentTotal}）`}
        </button>
      )}
      <div ref={endRef} />
    </div>
  );
}
