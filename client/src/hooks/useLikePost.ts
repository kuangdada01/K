/**
 * ============================================================
 * 点赞交互 Hook（useLikePost）
 * ============================================================
 * 统一 PostCard / PostDetail 两处点赞逻辑：
 * - 登录门槛
 * - 点赞乐观更新（立即变红），取消点赞成功后再更新
 * - 全局点赞缓存同步（state/cache）
 * - 失败回滚
 */

import { useCallback, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLike } from '../state/cache';
import { events } from '../state/events';
import * as postsApi from '../api/posts';

interface UseLikePostOptions {
  /** 切换成功后回调（PostCard 用于触发父组件刷新） */
  onToggle?: () => void;
  /** 状态变化通知（父组件更新列表项） */
  onChange?: (postId: number, liked: boolean, likeCount: number) => void;
}

export function useLikePost(postId: number, options?: UseLikePostOptions) {
  const { user, openLoginPrompt } = useAuth();
  const { setLikeInfo } = useLike();
  const [liked, setLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(0);
  // 解构回调以便纳入依赖（与各组件原 handleLike 依赖一致）
  const onToggle = options?.onToggle;
  const onChange = options?.onChange;

  const toggle = useCallback(async () => {
    if (!user) {
      openLoginPrompt();
      return;
    }
    const wasLiked = liked;
    const prevCount = likeCount;
    const newLikeCount = wasLiked ? prevCount - 1 : prevCount + 1;

    if (!wasLiked) {
      // 点赞：乐观更新，立即变红
      setLiked(true);
      setLikeCount(newLikeCount);
      setLikeInfo(postId, true, newLikeCount);
    }

    try {
      if (wasLiked) {
        await postsApi.unlikePost(postId);
        // 取消点赞：API 成功后才更新
        setLiked(false);
        setLikeCount(newLikeCount);
        setLikeInfo(postId, false, newLikeCount);
      } else {
        await postsApi.likePost(postId);
      }
      onToggle?.();
      onChange?.(postId, !wasLiked, newLikeCount);
      events.emit('post:like', { postId, liked: !wasLiked, likeCount: newLikeCount });
    } catch {
      if (!wasLiked) {
        setLiked(false);
        setLikeCount(prevCount);
        setLikeInfo(postId, false, prevCount);
      }
    }
  }, [liked, likeCount, user, postId, openLoginPrompt, setLikeInfo, onToggle, onChange]);

  return { liked, setLiked, likeCount, setLikeCount, toggle };
}
