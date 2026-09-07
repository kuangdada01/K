/**
 * ============================================================
 * 首页信息流事件同步 Hook（usePostEventsSync）
 * ============================================================
 * 自 client/src/pages/HomePage.tsx 拆出（纯搬移，行为不变）。
 *
 * 订阅 mitt 事件总线，把帖子增删改/点赞/转发/评论实时同步到
 * React Query 信息流缓存（updatePostsFeed 就地更新，避免整页重载）：
 * - post:created   有新帖时插入首位；无载荷时整体 refetch（发布回执兼容历史行为）
 * - post:deleted   立即从信息流移除（修复 app 切页才更新的问题）
 * - post:updated   失效信息流查询，触发重取（保证编辑后描述/图片实时）
 * - post:like / post:repost / post:comment  就地更新对应计数/状态字段
 *
 * 各 effect 依赖数组与 HomePage 原版完全一致：
 *   post:created          [refetch, queryClient]
 *   其余三个（deleted / updated / like·repost·comment）  [queryClient]
 *
 * 与 useProfileEventsSync（Profile 版）的差异：本 hook 操作的是
 * React Query 信息流缓存，Profile 版操作的是组件本地 state 列表，
 * 两者 handler 集合与数据流不同，故分别成文件。
 * ============================================================
 */

import { useEffect } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { events } from '../state/events';
import type { Post } from '../types';
import { postsFeedKey, updatePostsFeed, usePostsFeed } from './usePostsFeed';

/** usePostsFeed 返回值的 refetch（类型跟随 usePostsFeed，运行时原样透传） */
type PostsFeedRefetch = ReturnType<typeof usePostsFeed>['refetch'];

export function usePostEventsSync(queryClient: QueryClient, refetch: PostsFeedRefetch): void {
  // Post created → 实时插入首位，无需等待 refetch（app 无需手动刷新）
  useEffect(() => {
    const handler = (newPost?: Post | void) => {
      if (newPost && typeof newPost === 'object' && 'id' in newPost) {
        updatePostsFeed(queryClient, (prev) => [
          newPost as Post,
          ...prev.filter((p) => p.id !== (newPost as Post).id),
        ]);
      } else {
        // 无帖子载荷时（如发布后回执）整体重取，保持与历史行为一致
        refetch();
      }
    };
    events.on('post:created', handler);
    return () => {
      events.off('post:created', handler);
    };
  }, [refetch, queryClient]);

  // Post deleted → 立即从信息流移除，无需下拉或切页（修复 app 切页才更新）
  useEffect(() => {
    const handler = (deletedId: number) => {
      updatePostsFeed(queryClient, (prev) => prev.filter((p) => p.id !== deletedId));
    };
    events.on('post:deleted', handler);
    return () => {
      events.off('post:deleted', handler);
    };
  }, [queryClient]);

  // Post updated（编辑）→ 失效重取，保证描述/图片实时
  useEffect(() => {
    const handler = () => {
      queryClient.invalidateQueries({ queryKey: postsFeedKey });
    };
    events.on('post:updated', handler);
    return () => {
      events.off('post:updated', handler);
    };
  }, [queryClient]);

  // 全部状态实时：点赞/转发/评论 数在任意页面变更后，信息流立即同步（无需切页）
  useEffect(() => {
    const onLike = ({ postId, liked, likeCount }: { postId: number; liked: boolean; likeCount: number }) => {
      updatePostsFeed(queryClient, (prev) =>
        prev.map((p) => (p.id === postId ? { ...p, liked: liked ? 1 : 0, like_count: likeCount } : p))
      );
    };
    const onRepost = ({
      postId,
      reposted,
      repostCount,
    }: {
      postId: number;
      reposted: boolean;
      repostCount: number;
    }) => {
      updatePostsFeed(queryClient, (prev) =>
        prev.map((p) =>
          p.id === postId ? { ...p, reposted: reposted ? 1 : 0, repost_count: repostCount } : p
        )
      );
    };
    const onComment = ({ postId, commentCount }: { postId: number; commentCount: number }) => {
      updatePostsFeed(queryClient, (prev) =>
        prev.map((p) => (p.id === postId ? { ...p, comment_count: commentCount } : p))
      );
    };
    events.on('post:like', onLike);
    events.on('post:repost', onRepost);
    events.on('post:comment', onComment);
    return () => {
      events.off('post:like', onLike);
      events.off('post:repost', onRepost);
      events.off('post:comment', onComment);
    };
  }, [queryClient]);
}
