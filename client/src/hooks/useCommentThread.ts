/**
 * ============================================================
 * 评论线程交互 Hook（hooks/useCommentThread）
 * ============================================================
 * 自 PostDetail.tsx 拆出（行为逐字节不变）：
 * - 评论提交（handleComment：未登录拦截 / close_comments 守卫 / 403 分支 toast /
 *   post:comment 事件 / onCommentChange 回调 / 追加后滚动定位）
 * - 评论分页续拉（loadMoreComments：afterId 游标 + 去重追加 + has_more/total 更新）
 * - 评论删除（handleDeleteComment / confirmDeleteComment：级联过滤 + 总数回推 + emit/回调 + toast）
 * - 评论点赞（handleCommentLike：乐观更新 + 失败回滚）
 * - 回复线程折叠/展开（toggleReplies）与回复入口（handleReply：未登录弹登录、进入回复态、聚焦输入框）
 *
 * 所有权约定：评论数据层 state（comments/commentHasMore/commentTotal）由 usePostDetailData
 * 持有（首屏 fetch 注入 + 帖子切换渲染期重置），本 hook 作为参数接收、经 setter 读写；
 * 交互层 state（commentsLoadingMore/replyingTo/newComment/submitting/deleteTargetId）
 * 在本 hook 内声明并返回。collapsedReplies 的 getter 留在组件供渲染（buildVisibleComments），
 * 本 hook 经 setCollapsedReplies 承担折叠/展开写入。commentsLoadingMore 的帖子切换渲染期
 * 重置（prev 值模式）随 state 移入本 hook，与组件/数据层其他渲染期重置同一时刻生效。
 */

import { useCallback, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { isAxiosError } from 'axios';

import * as postsApi from '../api/posts';
import { getApiErrorMessage } from '../api/http';
import { events } from '../state/events';
import { showToast } from '../components/ui/Toast';
import type { Comment } from '../types';

export interface UseCommentThreadOptions {
  postId: number;
  /** 评论数据层 state（usePostDetailData 持有：首屏 fetch 注入 / 切换重置） */
  comments: Comment[];
  setComments: Dispatch<SetStateAction<Comment[]>>;
  /** 分页 state（usePostDetailData 持有：首屏 fetch / 切换重置） */
  commentHasMore: boolean;
  setCommentHasMore: Dispatch<SetStateAction<boolean>>;
  commentTotal: number;
  setCommentTotal: Dispatch<SetStateAction<number>>;
  /** 折叠集合 setter（usePostDetailData 持有 getter 供渲染直接引用；本 hook 经 setter 承担折叠/展开写入） */
  setCollapsedReplies: Dispatch<SetStateAction<Set<number>>>;
  /** 已登录用户 id（未登录时评论/回复/点赞走 openLoginPrompt） */
  userId: number | undefined;
  /** 帖子是否关闭评论（post?.close_comments，0/1） */
  closeComments: number | undefined;
  /** 帖子/用户切换标识（与组件渲染期重置共用同一 key） */
  detailKey: string;
  openLoginPrompt: () => void;
  /** 评论数变化通知（与 usePostDetailData 注入的 onCommentChange 同源） */
  onCommentChange?: ((postId: number, commentCount: number) => void) | undefined;
}

export function useCommentThread({
  postId,
  comments,
  setComments,
  commentHasMore,
  setCommentHasMore,
  commentTotal,
  setCommentTotal,
  setCollapsedReplies,
  userId,
  closeComments,
  detailKey,
  openLoginPrompt,
  onCommentChange,
}: UseCommentThreadOptions) {
  const [commentsLoadingMore, setCommentsLoadingMore] = useState(false);
  const [replyingTo, setReplyingTo] = useState<{ id: number; username: string } | null>(null);
  const [newComment, setNewComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<number | null>(null);
  const commentsEndRef = useRef<HTMLDivElement>(null);
  const commentInputRef = useRef<HTMLInputElement>(null);

  // 帖子/用户切换时重置「续拉中」标志（渲染期 prev 值模式，与组件/数据层其他渲染期重置
  // 同一时刻生效；评论列表/分页/折叠的重置在 usePostDetailData 内同步完成）
  const [prevDetailKey, setPrevDetailKey] = useState('');
  if (detailKey !== prevDetailKey) {
    setPrevDetailKey(detailKey);
    setCommentsLoadingMore(false);
  }

  const handleComment = async () => {
    if (!userId) {
      openLoginPrompt();
      return;
    }
    if (!newComment.trim() || submitting || closeComments) return;
    setSubmitting(true);
    try {
      const res = await postsApi.createComment(postId, {
        content: newComment,
        parentId: replyingTo?.id || null,
      });
      // updater 必须纯函数：事件/回调副作用放在 setState 之外（StrictMode 下 updater 会双调用）
      const updated = [...comments, res];
      setComments(updated);
      const newTotal = commentTotal + 1;
      setCommentTotal(newTotal);
      onCommentChange?.(postId, newTotal);
      events.emit('post:comment', { postId, commentCount: newTotal });
      setNewComment('');
      setReplyingTo(null);
      setTimeout(() => commentsEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 403) {
        showToast('此帖子已关闭评论');
      } else {
        showToast(getApiErrorMessage(err, '评论发送失败，请重试'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  /** 向上续拉下一页评论：游标 = 已加载的最后一条顶级评论 id */
  const loadMoreComments = useCallback(async () => {
    if (commentsLoadingMore || !commentHasMore) return;
    const tops = comments.filter((c) => !c.parent_id);
    const lastTop = tops[tops.length - 1];
    if (!lastTop) return;
    setCommentsLoadingMore(true);
    try {
      const res = await postsApi.listCommentsPaged(postId, { afterId: lastTop.id, limit: 10 });
      setComments((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        return [...prev, ...res.comments.filter((c) => !seen.has(c.id))];
      });
      setCommentHasMore(!!res.has_more);
      setCommentTotal(res.total ?? commentTotal);
    } catch (err) {
      showToast(getApiErrorMessage(err, '评论加载失败，请重试'));
    } finally {
      setCommentsLoadingMore(false);
    }
  }, [
    commentsLoadingMore,
    commentHasMore,
    comments,
    commentTotal,
    postId,
    setComments,
    setCommentHasMore,
    setCommentTotal,
  ]);

  /**
   * 传给 CommentItem 的四个回调全部 useCallback 固定引用。
   *
   * 为什么必须做：CommentItem 已经是 memo 组件（见 CommentItem.tsx），但 memo 只做
   * 浅比较 —— 这四个回调此前是每次渲染新建的函数，于是「在评论框里敲一个字」
   * （newComment 变化 → PostDetail 重渲染）会让**每一条**评论都重渲染，
   * memo 形同虚设。依赖都是真实用到的值，不含 ref 技巧，行为与原来逐字一致。
   */
  const handleDeleteComment = useCallback((commentId: number) => {
    setDeleteTargetId(commentId);
  }, []);

  const toggleReplies = useCallback(
    (commentId: number) => {
      setCollapsedReplies((prev) => {
        const next = new Set(prev);
        if (next.has(commentId)) {
          next.delete(commentId);
        } else {
          next.add(commentId);
        }
        return next;
      });
    },
    [setCollapsedReplies]
  );

  /** 回复入口（原 CommentItem onReply 内联逻辑）：未登录弹登录、否则进入回复态并聚焦输入框 */
  const handleReply = useCallback(
    (comment: Comment) => {
      if (!userId) {
        openLoginPrompt();
        return;
      }
      setReplyingTo({ id: comment.id, username: comment.username });
      commentInputRef.current?.focus();
    },
    [userId, openLoginPrompt]
  );

  const handleCommentLike = useCallback(
    async (commentId: number) => {
      if (!userId) {
        openLoginPrompt();
        return;
      }
      const comment = comments.find((c) => c.id === commentId);
      if (!comment) return;

      const wasLiked = !!comment.liked;
      const prevCount = comment.like_count;

      setComments((prev) =>
        prev.map((c) =>
          c.id === commentId
            ? { ...c, liked: wasLiked ? 0 : 1, like_count: wasLiked ? prevCount - 1 : prevCount + 1 }
            : c
        )
      );

      try {
        if (wasLiked) {
          await postsApi.unlikeComment(commentId);
        } else {
          await postsApi.likeComment(commentId);
        }
      } catch {
        setComments((prev) =>
          prev.map((c) => (c.id === commentId ? { ...c, liked: wasLiked ? 1 : 0, like_count: prevCount } : c))
        );
        showToast('操作失败，请重试');
      }
    },
    // 依赖 comments：评论增删后回调需要看到最新列表。敲字（newComment）不影响它，
    // 所以评论列表在输入过程中保持稳定。
    [userId, openLoginPrompt, comments, setComments]
  );

  const confirmDeleteComment = async () => {
    if (deleteTargetId === null) return;
    try {
      await postsApi.deleteComment(deleteTargetId);
      const updated = comments.filter((c) => c.id !== deleteTargetId && c.parent_id !== deleteTargetId);
      setComments(updated);
      // 分页下总数按已加载列表的收缩量回推（被删回复可能级联多条）
      const newTotal = Math.max(0, commentTotal - (comments.length - updated.length));
      setCommentTotal(newTotal);
      onCommentChange?.(postId, newTotal);
      events.emit('post:comment', { postId, commentCount: newTotal });
      showToast('评论已删除');
    } catch (err) {
      showToast(getApiErrorMessage(err, '删除评论失败，请重试'));
    }
    setDeleteTargetId(null);
  };

  return {
    commentsLoadingMore,
    replyingTo,
    setReplyingTo,
    newComment,
    setNewComment,
    submitting,
    deleteTargetId,
    setDeleteTargetId,
    commentsEndRef,
    commentInputRef,
    handleComment,
    loadMoreComments,
    handleDeleteComment,
    confirmDeleteComment,
    handleCommentLike,
    toggleReplies,
    handleReply,
  };
}
