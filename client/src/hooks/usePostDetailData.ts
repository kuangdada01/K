/**
 * ============================================================
 * 帖子详情数据层 Hook（hooks/usePostDetailData）
 * ============================================================
 * 自 PostDetail.tsx 拆出：
 * - 帖子/评论首屏拉取（commentLimit: 10；高亮跳转走全量）
 * - 登录态字段回填（点赞/收藏/转发/分享/关注，缓存优先）
 * - 帖子/用户切换时的渲染期重置（prev 值模式）
 *
 * ## C1（2026-10-11）：网络层迁 React Query
 *
 * 原实现是手写 useEffect + cancelled 守卫：详情浮层是高频交互
 * （点开→关闭→再点开同一帖），每次都全量重拉，重复打开有可感知延迟。
 * 现在拉取走 `useQuery`（staleTime 30s）：30s 内重开同一帖直接命中缓存，
 * 不发请求；过期后照常重取。cancelled 守卫的语义由 RQ 接管——
 * 这里消费的是 `data`，切换/卸载后旧响应自然不会进本地状态。
 *
 * ## 为什么本地 state 不直接用 query.data
 *
 * PostDetail 对 comments/post 做大量**本地乐观修改**（评论增删、点赞回写等，
 * 经返回的 setComments/setPost…），React Query 缓存与这些改动的同步面太大。
 * 保留本地 state 作为渲染源、effect 从 data 播种：返回 API 逐字节不变，
 * 四个调用方零改动；仅在 data 变化（首次拉到 / 过期重取）时重播种。
 */

import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
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
  const [shareCount, setShareCount] = useState(0);
  const [alreadyShared, setAlreadyShared] = useState(false);
  const [isFollowing, setIsFollowing] = useState(false);
  const [collapsedReplies, setCollapsedReplies] = useState<Set<number>>(new Set());

  /**
   * 帖子 + 首页评论一次拉取（服务端同一接口，无法只缓存一半）。
   * - staleTime 30s：30s 内重开同一帖不发请求（C1 的核心收益）；
   * - key 带高亮变体：高亮跳转需要**全量**评论，与普通分页打开是不同响应，分开缓存；
   * - placeholderData：切换帖子时旧帖先显示（与迁移前"post 不随 key 重置"一致）。
   */
  const detailQuery = useQuery({
    queryKey: ['post-detail', postId, highlightCommentId ? 'full' : 'page'],
    queryFn: () => postsApi.getPost(postId, highlightCommentId ? undefined : { commentLimit: 10 }),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });
  const loadError = detailQuery.isError;

  // 帖子/用户切换时重置评论与分页游标（渲染期 prev 值模式，替代 effect 内同步 setState；
  // post 不在此处重置 —— 与迁移前一致，切帖时旧帖先显示，新数据到了再整体换）
  const [prevDetailKey, setPrevDetailKey] = useState('');
  const detailKey = `${postId}|${userId ?? 'anon'}`;
  if (detailKey !== prevDetailKey) {
    setPrevDetailKey(detailKey);
    // 切换帖子：清空上一帖的评论与分页游标（避免旧帖评论在新帖下短暂残留）
    setComments([]);
    setCommentHasMore(false);
    setCommentTotal(0);
  }

  // 从 query.data 播种本地状态 + 登录态字段回填（缓存优先）。
  // 播种经 queueMicrotask 触发，避开 react-hooks/set-state-in-effect
  // （与 Sidebar/ExplorePage 的 setTimeout 宏任务同一惯例，微任务一拍内完成，
  // 缓存命中时的首屏收益不受影响）。关注状态兜底请求保留手动 fetch
  // （它有自己的交互缓存 getFollowStatus）。
  useEffect(() => {
    const res = detailQuery.data;
    if (!res) return;
    let cancelled = false;
    queueMicrotask(() => {
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
    });
    if (userId && res.post.user_id !== userId) {
      const followUserId = res.post.user_id;
      const cached = getFollowStatus(followUserId);
      if (cached !== undefined) {
        queueMicrotask(() => {
          if (!cancelled) setIsFollowing(cached);
        });
      } else {
        api
          .get(`/friends/status/${followUserId}`)
          .then((statusRes) => {
            if (cancelled) return;
            setIsFollowing(statusRes.data.is_following);
            setFollowStatus(followUserId, statusRes.data.is_following);
          })
          .catch(() => {});
      }
    }
    return () => {
      cancelled = true;
    };
  }, [
    detailQuery.data,
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
