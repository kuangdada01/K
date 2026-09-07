/**
 * ============================================================
 * 首页推荐关注 Hook（useRecommendFollow）
 * ============================================================
 * 自 client/src/pages/HomePage.tsx 拆出（纯搬移，行为不变）。
 *
 * 推荐关注卡片的状态机：
 * - recommendUsers：推荐列表。初始加载 listRecommended
 *   （游客也可看到，服务端返回随机用户；cancelled 守卫丢弃卸载后响应）
 * - removingIds：正在执行 400ms 移除动画的用户 ID 集合
 * - follow:changed 事件：命中列表时启动移除动画（依赖 recommendUsers 重订阅）
 * - 关注成功：写入关注缓存 → 加 removingIds → 400ms 后从列表移除并清理 removingIds
 * - 关注失败：仅提示"关注失败，请重试"，列表不动
 * - 未登录点关注：走 openLoginPrompt，不发请求
 *
 * 依赖数组与 HomePage 原版完全一致：
 *   初始加载 []; follow:changed 重订阅 [recommendUsers]
 * ============================================================
 */

import { useEffect, useState } from 'react';
import { follow, listRecommended } from '../api/friends';
import type { RecommendUser } from '../components/RecommendCard';
import { events } from '../state/events';
import { showToast } from '../components/ui/Toast';
import type { User } from '../types';

export interface UseRecommendFollowOptions {
  /** 当前登录用户（null=游客，关注时走登录提示） */
  user: User | null;
  /** 打开登录提示弹窗（未登录点关注时调用） */
  openLoginPrompt: () => void;
  /** 关注缓存写入（useFollow().setFollowStatus） */
  setFollowStatus: (userId: number, isFollowing: boolean) => void;
}

export interface UseRecommendFollowResult {
  /** 推荐关注列表（RecommendCard 直接消费） */
  recommendUsers: RecommendUser[];
  /** 正在执行移除动画的用户 ID 集合 */
  removingIds: Set<number>;
  /** 推荐卡片关注按钮 handler（未登录 → 登录提示；成功 → 400ms 移除动画） */
  handleRecommendFollow: (u: RecommendUser) => Promise<void>;
}

export function useRecommendFollow({
  user,
  openLoginPrompt,
  setFollowStatus,
}: UseRecommendFollowOptions): UseRecommendFollowResult {
  const [recommendUsers, setRecommendUsers] = useState<RecommendUser[]>([]);
  const [removingIds, setRemovingIds] = useState<Set<number>>(new Set());

  // Initial load: 推荐关注（游客也可看到，服务端返回随机用户）
  useEffect(() => {
    let cancelled = false;
    listRecommended()
      .then(({ users }) => {
        if (!cancelled) setRecommendUsers(users);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Follow changed → animate remove from recommend（mitt 事件总线）
  useEffect(() => {
    const handler = (userId: number) => {
      const inList = recommendUsers.some((u) => u.id === userId);
      if (inList) {
        setRemovingIds((prev) => new Set(prev).add(userId));
        setTimeout(() => {
          setRecommendUsers((prev) => prev.filter((item) => item.id !== userId));
          setRemovingIds((prev) => {
            const next = new Set(prev);
            next.delete(userId);
            return next;
          });
        }, 400);
      }
    };
    events.on('follow:changed', handler);
    return () => {
      events.off('follow:changed', handler);
    };
  }, [recommendUsers]);

  /** 推荐卡片关注 */
  const handleRecommendFollow = async (u: RecommendUser) => {
    if (!user) {
      openLoginPrompt();
      return;
    }
    try {
      await follow(u.id);
      setFollowStatus(u.id, true);
      setRemovingIds((prev) => new Set(prev).add(u.id));
      setTimeout(() => {
        setRecommendUsers((prev) => prev.filter((item) => item.id !== u.id));
        setRemovingIds((prev) => {
          const next = new Set(prev);
          next.delete(u.id);
          return next;
        });
      }, 400);
      showToast('ヾ(≧▽≦*)o关注成功！');
    } catch {
      showToast('关注失败，请重试');
    }
  };

  return { recommendUsers, removingIds, handleRecommendFollow };
}
