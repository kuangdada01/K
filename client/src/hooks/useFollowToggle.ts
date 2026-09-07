/**
 * ============================================================
 * 关注切换 Hook（useFollowToggle）
 * ============================================================
 * 自 PostCard / PostDetail 的 handleFollow 拆出（行为不变）：
 * - 登录门槛（useFollowUser().requireLogin，未登录弹登录提示并短路）
 * - follow/unfollow + 本地 isFollowing 切换
 * - toast 文案逐字节保留：'o(TヘTo)取消关注成功！' / 'ヾ(≧▽≦*)o关注成功！' / 失败 '操作失败'
 * - onSuccess 在成功切换后回调（PostCard 原 notifyChanged(post.user_id)
 *   所在位置；PostDetail 原 handleFollow 无此步骤，不传即不触发）
 *
 * 与 useFollowUser 的差异：useFollowUser 只提供 API + 全局缓存/事件，
 * 本 hook 收敛两处组件里的"切换流程"骨架（含本地状态与 toast）。
 * ============================================================
 */

import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useFollowUser } from './useFollowUser';
import { showToast } from '../components/ui/Toast';

export interface UseFollowToggleOptions {
  /** 目标用户 ID（undefined=详情未就绪，切换短路，对应 PostDetail 原 "if (!post) return" 守卫） */
  userId: number | undefined;
  isFollowing: boolean;
  setIsFollowing: Dispatch<SetStateAction<boolean>>;
  /** 成功切换后回调（PostCard 原 notifyChanged(post.user_id) 位置） */
  onSuccess?: () => void;
}

export function useFollowToggle({ userId, isFollowing, setIsFollowing, onSuccess }: UseFollowToggleOptions): {
  toggle: () => Promise<void>;
} {
  const { requireLogin, follow, unfollow } = useFollowUser();

  const toggle = useCallback(async () => {
    if (!requireLogin()) return;
    if (userId === undefined) return;
    try {
      if (isFollowing) {
        await unfollow(userId);
        setIsFollowing(false);
        showToast('o(TヘTo)取消关注成功！');
      } else {
        await follow(userId);
        setIsFollowing(true);
        showToast('ヾ(≧▽≦*)o关注成功！');
      }
      onSuccess?.();
    } catch {
      showToast('操作失败');
    }
  }, [requireLogin, userId, isFollowing, unfollow, follow, setIsFollowing, onSuccess]);

  return { toggle };
}
