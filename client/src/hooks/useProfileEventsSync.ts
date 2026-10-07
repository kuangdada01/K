/**
 * ============================================================
 * 用户主页帖子事件同步 Hook（useProfileEventsSync）
 * ============================================================
 * 自 client/src/components/profile/Profile.tsx 拆出（纯搬移，行为不变）。
 *
 * 订阅 mitt 事件总线，把增删改/点赞/转发/评论/关注实时同步到
 * 主页三份本地列表（posts / bookmarkedPosts / repostedPosts）与关注态：
 * - post:deleted   从三份列表移除
 * - post:like / post:repost / post:comment  就地更新三份列表对应字段
 * - post:created / post:updated  重新拉取 /users/:userId/posts（静默失败）
 * - follow:changed  命中当前主页用户时从关注缓存刷新 isFollowing
 *
 * 与首页 usePostEventsSync 的差异：主页操作的是组件本地 state 列表 +
 * API 重取，而非 React Query 信息流缓存；handler 集合（含 created/updated/
 * follow:changed）与数据流均不同，故单独成文件。
 *
 * 依赖数组：[userId, getFollowStatus, setPosts, setBookmarkedPosts,
 * setRepostedPosts, setIsFollowing]；后 4 个为 useProfileData 内部 useState 的
 * 稳定 setter（与 Profile 原版直接引用 useState setter 等价，恒稳定），
 * 实际重订阅时机与原版 [userId, getFollowStatus] 完全相同。
 * ============================================================
 */

import { useEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import api from '../api/http';
import { events } from '../state/events';
import type { Post } from '../types';

export interface UseProfileEventsSyncOptions {
  /** 当前主页用户 ID（undefined=未就绪；created/updated/follow 均不动作） */
  userId: number | undefined;
  /** 关注缓存读取（useFollow().getFollowStatus） */
  getFollowStatus: (userId: number) => boolean | undefined;
  setPosts: Dispatch<SetStateAction<Post[]>>;
  setBookmarkedPosts: Dispatch<SetStateAction<Post[]>>;
  setRepostedPosts: Dispatch<SetStateAction<Post[]>>;
  setIsFollowing: Dispatch<SetStateAction<boolean>>;
}

export function useProfileEventsSync({
  userId,
  getFollowStatus,
  setPosts,
  setBookmarkedPosts,
  setRepostedPosts,
  setIsFollowing,
}: UseProfileEventsSyncOptions): void {
  // 全部实时：点赞/转发/评论/删除/新增/更新/关注 均同步本页
  useEffect(() => {
    const onDeleted = (deletedId: number) => {
      setPosts((prev) => prev.filter((p) => p.id !== deletedId));
      setBookmarkedPosts((prev) => prev.filter((p) => p.id !== deletedId));
      setRepostedPosts((prev) => prev.filter((p) => p.id !== deletedId));
    };
    const onLike = ({ postId, liked, likeCount }: { postId: number; liked: boolean; likeCount: number }) => {
      const upd = (p: Post) => (p.id === postId ? { ...p, liked: liked ? 1 : 0, like_count: likeCount } : p);
      setPosts((prev) => prev.map(upd));
      setBookmarkedPosts((prev) => prev.map(upd));
      setRepostedPosts((prev) => prev.map(upd));
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
      const upd = (p: Post) =>
        p.id === postId ? { ...p, reposted: reposted ? 1 : 0, repost_count: repostCount } : p;
      setPosts((prev) => prev.map(upd));
      setBookmarkedPosts((prev) => prev.map(upd));
      setRepostedPosts((prev) => prev.map(upd));
    };
    const onComment = ({ postId, commentCount }: { postId: number; commentCount: number }) => {
      const upd = (p: Post) => (p.id === postId ? { ...p, comment_count: commentCount } : p);
      setPosts((prev) => prev.map(upd));
      setBookmarkedPosts((prev) => prev.map(upd));
      setRepostedPosts((prev) => prev.map(upd));
    };
    const onFollow = (uid: number) => {
      if (uid === userId) {
        const c = getFollowStatus(uid);
        if (c !== undefined) setIsFollowing(c);
      }
    };
    const onCreated = () => {
      if (userId)
        api
          .get(`/users/${userId}/posts`)
          .then((r) => setPosts(r.data.posts))
          .catch(() => {});
    };
    const onUpdated = () => {
      if (userId)
        api
          .get(`/users/${userId}/posts`)
          .then((r) => setPosts(r.data.posts))
          .catch(() => {});
    };
    events.on('post:deleted', onDeleted);
    events.on('post:like', onLike);
    events.on('post:repost', onRepost);
    events.on('post:comment', onComment);
    events.on('post:created', onCreated);
    events.on('post:updated', onUpdated);
    events.on('follow:changed', onFollow);
    return () => {
      events.off('post:deleted', onDeleted);
      events.off('post:like', onLike);
      events.off('post:repost', onRepost);
      events.off('post:comment', onComment);
      events.off('post:created', onCreated);
      events.off('post:updated', onUpdated);
      events.off('follow:changed', onFollow);
    };
  }, [userId, getFollowStatus, setPosts, setBookmarkedPosts, setRepostedPosts, setIsFollowing]);
}
