/**
 * ============================================================
 * 帖子详情数据层 Hook（hooks/usePostDetailData）
 * ============================================================
 * 自 PostDetail.tsx 拆出（行为逐字节不变）：
 * - 帖子/评论首屏拉取（commentLimit: 10；高亮跳转走全量）
 * - 登录态字段回填（点赞/收藏/转发/分享/关注，缓存优先）
 * - 帖子/用户切换时的渲染期重置（prev 值模式）
 * - P1 修复：cancelled 守卫，快速切换帖子时旧响应不落地
 */

import { useEffect, useState } from 'react';
import api from '../api/http';
import * as postsApi from '../api/posts';
import { computeInitialCollapsedIds } from '../lib/comments';
import type { LikeInfo } from '../state/cache';
import type { Comment, Post } from '../types';

export interface UsePostDetailDataOptions {
  postId: number;
  userId: number | undefined;
  highlightCommentId: number | null | undefined;
  getFollowStatus: (userId: number) => boolean | undefined;
  setFollowStatus: (userId: number, isFollowing: boolean) => void;
  getLikeInfo: (postId: number) => LikeInfo | undefined;
  getBookmarked: (postId: number) => boolean | undefined;
  getReposted: (postId: number) => boolean | undefined;
  /** 以下 setter 由交互 hooks（useLikePost/useBookmarkPost/useRepostPost）提供 */
  setLiked: (v: boolean) => void;
  setLikeCount: (v: number) => void;
  setBookmarked: (v: boolean) => void;
  setReposted: (v: boolean) => void;
  setRepostCount: (v: number) => void;
  /** 高亮评论定位完成后回调（setActiveHighlightId 由调用方持有） */
  onHighlight: (targetId: number) => void;
}

export function usePostDetailData({
  postId,
  userId,
  highlightCommentId,
  getFollowStatus,
  setFollowStatus,
  getLikeInfo,
  getBookmarked,
  getReposted,
  setLiked,
  setLikeCount,
  setBookmarked,
  setReposted,
  setRepostCount,
  onHighlight,
}: UsePostDetailDataOptions) {
  const [post, setPost] = useState<Post | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentHasMore, setCommentHasMore] = useState(false);
  const [commentTotal, setCommentTotal] = useState(0);
  const [loadError, setLoadError] = useState(false);
  const [shareCount, setShareCount] = useState(0);
  const [alreadyShared, setAlreadyShared] = useState(false);
  const [isFollowing, setIsFollowing] = useState(false);
  const [collapsedReplies, setCollapsedReplies] = useState<Set<number>>(new Set());

  // 帖子/用户切换时重置加载错误（渲染期 prev 值模式，替代 effect 内同步 setState）
  const [prevDetailKey, setPrevDetailKey] = useState('');
  const detailKey = `${postId}|${userId ?? 'anon'}`;
  if (detailKey !== prevDetailKey) {
    setPrevDetailKey(detailKey);
    setLoadError(false);
    // 切换帖子：清空上一帖的评论与分页游标（避免旧帖评论在新帖下短暂残留）
    setComments([]);
    setCommentHasMore(false);
    setCommentTotal(0);
  }

  // 加载评论，全部折叠，若有高亮评论ID则展开其祖先
  // （loadError/highlight 重置已在渲染期完成）
  useEffect(() => {
    // P1 修复：cancelled 守卫——快速切换帖子时，旧帖的响应晚到会覆盖新帖数据
    // （帖子/评论/点赞态错位）。依赖收敛为 userId，避免 user 对象身份变化触发重拉
    let cancelled = false;
    // 高亮跳转需要全量评论定位目标；普通打开按顶级评论分页（回复随顶级携带）
    postsApi
      .getPost(postId, highlightCommentId ? undefined : { commentLimit: 10 })
      .then(async (res) => {
        if (cancelled) return;
        setPost(res.post);
        setComments(res.comments);
        setCommentHasMore(!!res.comments_has_more);
        setCommentTotal(res.comments_total ?? res.comments.length);
        const cachedLike = getLikeInfo(postId);
        if (cachedLike) {
          setLiked(cachedLike.liked);
          setLikeCount(cachedLike.likeCount);
        } else {
          setLiked(!!res.post.liked);
          setLikeCount(res.post.like_count);
        }
        setShareCount(res.post.share_count || 0);
        setAlreadyShared(!!res.post.shared);
        const cachedBookmark = getBookmarked(postId);
        if (cachedBookmark !== undefined) {
          setBookmarked(cachedBookmark);
        } else {
          setBookmarked(!!res.post.bookmarked);
        }
        const cachedRepost = getReposted(postId);
        if (cachedRepost !== undefined) {
          setReposted(cachedRepost);
        } else {
          setReposted(!!res.post.reposted);
        }
        setRepostCount(res.post.repost_count || 0);
        if (userId && res.post.user_id !== userId) {
          const cached = getFollowStatus(res.post.user_id);
          if (cached !== undefined) {
            setIsFollowing(cached);
          } else {
            try {
              const statusRes = await api.get(`/friends/status/${res.post.user_id}`);
              if (cancelled) return;
              setIsFollowing(statusRes.data.is_following);
              setFollowStatus(res.post.user_id, statusRes.data.is_following);
            } catch {}
          }
        }
        if (cancelled) return;
        // 默认折叠所有回复线程；若有高亮评论ID则展开其祖先使目标可见
        setCollapsedReplies(computeInitialCollapsedIds(res.comments, highlightCommentId));

        // 重新渲染后滚动 + 高亮
        if (highlightCommentId) {
          const targetId = Number(highlightCommentId);
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const el = document.getElementById(`comment-${targetId}`);
              if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              onHighlight(targetId);
            });
          });
        }
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [
    postId,
    userId,
    getFollowStatus,
    setFollowStatus,
    getBookmarked,
    getLikeInfo,
    getReposted,
    highlightCommentId,
    setBookmarked,
    setLikeCount,
    setLiked,
    setRepostCount,
    setReposted,
    onHighlight,
  ]);

  return {
    post,
    setPost,
    comments,
    setComments,
    commentHasMore,
    setCommentHasMore,
    commentTotal,
    setCommentTotal,
    loadError,
    shareCount,
    setShareCount,
    alreadyShared,
    setAlreadyShared,
    isFollowing,
    setIsFollowing,
    collapsedReplies,
    setCollapsedReplies,
  };
}
