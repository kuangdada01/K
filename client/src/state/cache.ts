/**
 * ============================================================
 * 交互状态缓存 hooks（基于 React Query 缓存，替代 4 个 Context）
 * ============================================================
 * 原 Follow/Like/Repost/Bookmark 四个 Context 本质是
 * "Map 缓存 + setState"，这里统一用 queryClient 缓存实现，
 * 对外保持与原 useFollow/useLike/useRepost/useBookmark 相同的
 * get/set 接口，组件行为完全不变。
 *
 * 注意: 所有 get/set 函数必须 useCallback 稳定化，否则消费方
 * 把它们放进 effect 依赖数组时，每次渲染都会触发 effect 重跑
 * （曾导致 PostDetail 展开回复后被重新折叠、重复请求）。
 *
 * 后续（P3）可进一步演进为 useMutation 乐观更新，缓存层无需再动。
 */

import { useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { queryClient } from './queryClient';

// ============================================================
// 交互状态缓存清理
// ============================================================

/**
 * 清空关注/点赞/转发/收藏四类交互缓存。
 * B5 修复：切换账号后调用，避免新账号看到上一个账号的"已关注/已赞"初始态。
 */
export function clearInteractionCaches(): void {
  queryClient.removeQueries({ queryKey: ['cache'] });
}

/**
 * P8 修复：登录后一次性灌满关注缓存（来自 GET /friends 关注列表），
 * 让 PostCard/PostDetail/Profile 的 follow 状态全部内存命中，消除首屏 N+1 请求。
 */
export function seedFollowedUsers(friendIds: number[]): void {
  for (const id of friendIds) {
    queryClient.setQueryData(followKey(id), true);
  }
}

// ============================================================
// 关注状态缓存
// ============================================================

const followKey = (userId: number) => ['cache', 'follow', userId] as const;

/** 关注状态缓存 hook（接口与原 useFollow 一致） */
export function useFollow() {
  const qc = useQueryClient();
  const getFollowStatus = useCallback(
    (userId: number): boolean | undefined => qc.getQueryData<boolean>(followKey(userId)),
    [qc]
  );
  const setFollowStatus = useCallback(
    (userId: number, isFollowing: boolean): void => {
      qc.setQueryData(followKey(userId), isFollowing);
    },
    [qc]
  );
  return useMemo(() => ({ getFollowStatus, setFollowStatus }), [getFollowStatus, setFollowStatus]);
}

// ============================================================
// 点赞缓存
// ============================================================

export interface LikeInfo {
  liked: boolean;
  likeCount: number;
}

const likeKey = (postId: number) => ['cache', 'like', postId] as const;

/** 点赞缓存 hook（接口与原 useLike 一致） */
export function useLike() {
  const qc = useQueryClient();
  const getLikeInfo = useCallback(
    (postId: number): LikeInfo | undefined => qc.getQueryData<LikeInfo>(likeKey(postId)),
    [qc]
  );
  const setLikeInfo = useCallback(
    (postId: number, liked: boolean, likeCount: number): void => {
      qc.setQueryData(likeKey(postId), { liked, likeCount });
    },
    [qc]
  );
  return useMemo(() => ({ getLikeInfo, setLikeInfo }), [getLikeInfo, setLikeInfo]);
}

// ============================================================
// 转发缓存
// ============================================================

const repostKey = (postId: number) => ['cache', 'repost', postId] as const;

/** 转发缓存 hook（接口与原 useRepost 一致） */
export function useRepost() {
  const qc = useQueryClient();
  const getReposted = useCallback(
    (postId: number): boolean | undefined => qc.getQueryData<boolean>(repostKey(postId)),
    [qc]
  );
  const setReposted = useCallback(
    (postId: number, reposted: boolean): void => {
      qc.setQueryData(repostKey(postId), reposted);
    },
    [qc]
  );
  return useMemo(() => ({ getReposted, setReposted }), [getReposted, setReposted]);
}

// ============================================================
// 收藏缓存
// ============================================================

const bookmarkKey = (postId: number) => ['cache', 'bookmark', postId] as const;

/** 收藏缓存 hook（接口与原 useBookmark 一致） */
export function useBookmark() {
  const qc = useQueryClient();
  const getBookmarked = useCallback(
    (postId: number): boolean | undefined => qc.getQueryData<boolean>(bookmarkKey(postId)),
    [qc]
  );
  const setBookmarked = useCallback(
    (postId: number, bookmarked: boolean): void => {
      qc.setQueryData(bookmarkKey(postId), bookmarked);
    },
    [qc]
  );
  return useMemo(() => ({ getBookmarked, setBookmarked }), [getBookmarked, setBookmarked]);
}
