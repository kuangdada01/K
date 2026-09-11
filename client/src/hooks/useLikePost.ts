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

import { useCallback, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLike } from '../state/cache';
import { events } from '../state/events';
import { showToast } from '../components/ui/Toast';
import * as postsApi from '../api/posts';

interface UseLikePostOptions {
  /** 切换成功后回调（PostCard 用于触发父组件刷新） */
  onToggle?: (() => void) | undefined;
  /** 状态变化通知（父组件更新列表项） */
  onChange?: ((postId: number, liked: boolean, likeCount: number) => void) | undefined;
}

export function useLikePost(postId: number, options?: UseLikePostOptions) {
  const { user, openLoginPrompt } = useAuth();
  const { setLikeInfo } = useLike();
  const [liked, setLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(0);
  // 解构回调以便纳入依赖（与各组件原 handleLike 依赖一致）
  const onToggle = options?.onToggle;
  const onChange = options?.onChange;

  /**
   * 在途闸门：`toggle` 的依赖是 [liked, likeCount]，而这两者要等重渲染后才更新。
   * 快速双击时第二次调用读到的仍是旧的 liked/likeCount → 连发两次 likePost，
   * 服务端计数 +2 而本地乐观值只 +1；若第二次请求失败，回滚还会把计数写回更旧的
   * prevCount，与本地状态彻底脱节（信息流 staleTime 为 Infinity，可能长期不纠正）。
   * ref 不受渲染批次影响，可同步占位。
   */
  const inFlightRef = useRef(false);

  const toggle = useCallback(async () => {
    if (!user) {
      openLoginPrompt();
      return;
    }
    if (inFlightRef.current) return;
    inFlightRef.current = true;
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
      showToast('操作失败，请重试');
    } finally {
      inFlightRef.current = false;
    }
  }, [liked, likeCount, user, postId, openLoginPrompt, setLikeInfo, onToggle, onChange]);

  return { liked, setLiked, likeCount, setLikeCount, toggle };
}
