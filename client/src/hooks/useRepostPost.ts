/**
 * ============================================================
 * 转发交互 Hook（useRepostPost）
 * ============================================================
 * 统一 PostCard / PostDetail 两处转发逻辑：
 * - 登录门槛
 * - 乐观更新 + 全局缓存同步 + 失败回滚
 * - 成功/失败 toast 与原实现一致
 */

import { useCallback, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useRepost } from '../state/cache';
import { events } from '../state/events';
import { showToast } from '../components/ui/Toast';
import * as postsApi from '../api/posts';

export function useRepostPost(postId: number) {
  const { user, openLoginPrompt } = useAuth();
  const { setReposted: setRepostedCache } = useRepost();
  const [reposted, setReposted] = useState(false);
  const [repostCount, setRepostCount] = useState(0);

  const toggle = useCallback(async () => {
    if (!user) { openLoginPrompt(); return; }
    const wasReposted = reposted;
    const prevCount = repostCount;
    const newCount = wasReposted ? prevCount - 1 : prevCount + 1;

    setReposted(!wasReposted);
    setRepostCount(newCount);
    setRepostedCache(postId, !wasReposted);
    events.emit('post:repost', { postId, reposted: !wasReposted, repostCount: newCount });

    try {
      if (wasReposted) {
        await postsApi.unrepostPost(postId);
        showToast('取消转发成功');
      } else {
        await postsApi.repostPost(postId);
        showToast('转发成功');
      }
    } catch {
      setReposted(wasReposted);
      setRepostCount(prevCount);
      setRepostedCache(postId, wasReposted);
    }
  }, [reposted, repostCount, user, postId, openLoginPrompt, setRepostedCache]);

  return { reposted, setReposted, repostCount, setRepostCount, toggle };
}
