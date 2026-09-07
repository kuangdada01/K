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
 * 四个同构 hook 现由 makeInteractionCache 工厂收敛生成
 * （自四份手写实现拆出，行为不变）：工厂返回带 useCallback
 * get/set 的 hook，各导出 hook 仅做 getter/setter 命名适配。
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
// 交互缓存工厂（makeInteractionCache）
// ============================================================

/**
 * 收拢"keyFn 定位缓存 + 读缓存/写缓存"的同构逻辑，生成带 useCallback
 * get/set 的缓存 hook（useFollow/useLike/useRepost/useBookmark 均由它生成）：
 * - get(id)        读缓存值（未命中返回 undefined）
 * - set(id, ...)   写缓存值；pack 提供时用它把 setter 入参组装成缓存值
 *   （如 useLike 的 (liked, likeCount) => ({ liked, likeCount })），
 *   缺省时 setter 的最后一个参数即缓存值（boolean 类缓存）。
 */
function makeInteractionCache<TValue, TSetArgs extends unknown[] = [TValue]>(
  name: string,
  keyFn: (id: number) => readonly unknown[],
  pack?: (...args: TSetArgs) => TValue
): () => {
  get: (id: number) => TValue | undefined;
  set: (id: number, ...args: TSetArgs) => void;
} {
  // name：缓存语义名（'follow'/'like'/'repost'/'bookmark'）。当前仅作标识保留，
  // 为 P3 演进 useMutation 乐观更新预留命名空间/错误定位，行为不依赖它。
  void name;
  return function useInteractionCache() {
    const qc = useQueryClient();
    const get = useCallback((id: number): TValue | undefined => qc.getQueryData<TValue>(keyFn(id)), [qc]);
    const set = useCallback(
      (id: number, ...args: TSetArgs): void => {
        const value = pack ? pack(...args) : (args[args.length - 1] as unknown as TValue);
        qc.setQueryData(keyFn(id), value);
      },
      // keyFn/pack 为工厂模块级常量（外部不可变），无需也不应列入依赖
      [qc]
    );
    return useMemo(() => ({ get, set }), [get, set]);
  };
}

// ============================================================
// 关注状态缓存
// ============================================================

const followKey = (userId: number) => ['cache', 'follow', userId] as const;
const useFollowCache = makeInteractionCache<boolean>('follow', followKey);

/** 关注状态缓存 hook（接口与原 useFollow 一致） */
export function useFollow() {
  const { get, set } = useFollowCache();
  return useMemo(() => ({ getFollowStatus: get, setFollowStatus: set }), [get, set]);
}

// ============================================================
// 点赞缓存
// ============================================================

export interface LikeInfo {
  liked: boolean;
  likeCount: number;
}

const likeKey = (postId: number) => ['cache', 'like', postId] as const;
// TValue/TSetArgs 均由 pack 推断（显式传 TValue 会跳过对 pack 的类型参数推断）
const useLikeCache = makeInteractionCache('like', likeKey, (liked: boolean, likeCount: number) => ({
  liked,
  likeCount,
}));

/** 点赞缓存 hook（接口与原 useLike 一致） */
export function useLike() {
  const { get, set } = useLikeCache();
  return useMemo(() => ({ getLikeInfo: get, setLikeInfo: set }), [get, set]);
}

// ============================================================
// 转发缓存
// ============================================================

const repostKey = (postId: number) => ['cache', 'repost', postId] as const;
const useRepostCache = makeInteractionCache<boolean>('repost', repostKey);

/** 转发缓存 hook（接口与原 useRepost 一致） */
export function useRepost() {
  const { get, set } = useRepostCache();
  return useMemo(() => ({ getReposted: get, setReposted: set }), [get, set]);
}

// ============================================================
// 收藏缓存
// ============================================================

const bookmarkKey = (postId: number) => ['cache', 'bookmark', postId] as const;
const useBookmarkCache = makeInteractionCache<boolean>('bookmark', bookmarkKey);

/** 收藏缓存 hook（接口与原 useBookmark 一致） */
export function useBookmark() {
  const { get, set } = useBookmarkCache();
  return useMemo(() => ({ getBookmarked: get, setBookmarked: set }), [get, set]);
}
