/**
 * ============================================================
 * 搜索页帖子事件同步 Hook（useExplorePostEventsSync）
 * ============================================================
 * 自 client/src/pages/ExplorePage.tsx 拆出（纯搬移，行为不变）。
 *
 * 订阅 mitt 事件总线，把增删改/点赞/转发/评论实时同步到搜索页的
 * 本地 posts 列表（与 usePostEventsSync 操作 React Query 信息流缓存、
 * useProfileEventsSync 操作主页三份本地列表不同，本 hook 是
 * "本地单列表"形态，数据流最小，故单独成文件）：
 * - post:deleted   立即从列表移除
 * - post:like / post:repost / post:comment  就地更新对应字段
 * - post:created / post:updated  按当前 keyword 重新加载第一页
 *
 * 依赖数组 [keyword, loadPosts, setPosts]：keyword/loadPosts 重订阅
 * 时机与原版 [keyword, loadPosts] 完全相同（setPosts 为稳定 setter）。
 * ============================================================
 */

import { useEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { events } from '../state/events';
import type { Post } from '../types';

export interface UseExplorePostEventsSyncOptions {
  /** 当前搜索关键词（post:created/post:updated 重新加载时使用） */
  keyword: string;
  /** 重新加载当前列表（post:created/post:updated 触发；ExplorePage 的 loadPosts） */
  loadPosts: (pageNum: number, query: string, append: boolean) => Promise<void>;
  setPosts: Dispatch<SetStateAction<Post[]>>;
}

export function useExplorePostEventsSync({
  keyword,
  loadPosts,
  setPosts,
}: UseExplorePostEventsSyncOptions): void {
  // 全部实时：任意页面点赞/转发/评论/删除/新增 后，网格立即同步
  useEffect(() => {
    const onLike = ({ postId, liked, likeCount }: { postId: number; liked: boolean; likeCount: number }) =>
      setPosts((prev) =>
        prev.map((p) => (p.id === postId ? { ...p, liked: liked ? 1 : 0, like_count: likeCount } : p))
      );
    const onRepost = ({
      postId,
      reposted,
      repostCount,
    }: {
      postId: number;
      reposted: boolean;
      repostCount: number;
    }) =>
      setPosts((prev) =>
        prev.map((p) =>
          p.id === postId ? { ...p, reposted: reposted ? 1 : 0, repost_count: repostCount } : p
        )
      );
    const onComment = ({ postId, commentCount }: { postId: number; commentCount: number }) =>
      setPosts((prev) => prev.map((p) => (p.id === postId ? { ...p, comment_count: commentCount } : p)));
    const onDeleted = (deletedId: number) => setPosts((prev) => prev.filter((p) => p.id !== deletedId));
    const onCreated = () => loadPosts(1, keyword, false);
    const onUpdated = () => loadPosts(1, keyword, false);
    events.on('post:like', onLike);
    events.on('post:repost', onRepost);
    events.on('post:comment', onComment);
    events.on('post:deleted', onDeleted);
    events.on('post:created', onCreated);
    events.on('post:updated', onUpdated);
    return () => {
      events.off('post:like', onLike);
      events.off('post:repost', onRepost);
      events.off('post:comment', onComment);
      events.off('post:deleted', onDeleted);
      events.off('post:created', onCreated);
      events.off('post:updated', onUpdated);
    };
  }, [keyword, loadPosts, setPosts]);
}
