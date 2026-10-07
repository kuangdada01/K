/**
 * ============================================================
 * 关注操作 Hook（useFollowUser）
 * ============================================================
 * 收敛四处重复的关注逻辑的公共部分：
 * - 登录门槛（未登录弹登录提示）
 * - API 调用（api/friends.ts）
 * - 全局关注缓存同步（state/cache）
 * - 关注变化事件（供首页推荐卡片移除）
 *
 * 各调用点的 toast 文案与本地状态更新保持原样（组件各自处理），
 * 保证用户可见行为不变。
 */

import { useAuth } from '../context/AuthContext';
import { useFollow } from '../state/cache';
import { events } from '../state/events';
import * as friendsApi from '../api/friends';

export interface FollowResult {
  is_following: boolean;
  followers_count: number;
}

export function useFollowUser() {
  const { user, openLoginPrompt } = useAuth();
  const { setFollowStatus } = useFollow();

  /** 未登录时弹登录提示并返回 false */
  const requireLogin = (): boolean => {
    if (!user) {
      openLoginPrompt();
      return false;
    }
    return true;
  };

  /** 关注（同步全局缓存），返回服务端粉丝数 */
  const follow = async (targetId: number): Promise<FollowResult> => {
    const res = await friendsApi.follow(targetId);
    setFollowStatus(targetId, true);
    events.emit('follow:changed', targetId);
    return res;
  };

  /** 取消关注（同步全局缓存），返回服务端粉丝数 */
  const unfollow = async (targetId: number): Promise<FollowResult> => {
    const res = await friendsApi.unfollow(targetId);
    setFollowStatus(targetId, false);
    events.emit('follow:changed', targetId);
    return res;
  };

  /** 广播关注变化事件 */
  const notifyChanged = (targetId: number): void => {
    events.emit('follow:changed', targetId);
  };

  return { requireLogin, follow, unfollow, notifyChanged };
}
