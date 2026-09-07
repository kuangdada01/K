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
    if (!user) {
      openLoginPrompt();
      return;
    }
    const wasReposted = reposted;
    const prevCount = repostCount;
    const newCount = wasReposted ? prevCount - 1 : prevCount + 1;

    setReposted(!wasReposted);
    setRepostCount(newCount);
    setRepostedCache(postId, !wasReposted);

    try {
      if (wasReposted) {
        const res = await postsApi.unrepostPost(postId);
        showToast('取消转发成功');
        // 成功后才广播（服务端真值）：失败回滚不再让其他组件停留在错误状态
        setReposted(res.reposted);
        setRepostCount(res.repost_count);
        setRepostedCache(postId, res.reposted);
        events.emit('post:repost', { postId, reposted: res.reposted, repostCount: res.repost_count });
      } else {
        const res = await postsApi.repostPost(postId);
        showToast('转发成功');
        setReposted(res.reposted);
        setRepostCount(res.repost_count);
        setRepostedCache(postId, res.reposted);
        events.emit('post:repost', { postId, reposted: res.reposted, repostCount: res.repost_count });
      }
    } catch {
      setReposted(wasReposted);
      setRepostCount(prevCount);
      setRepostedCache(postId, wasReposted);
      // 回滚真值也要广播：此前失败回滚不 emit，经事件总线同步的其他组件停留在错误状态
      events.emit('post:repost', { postId, reposted: wasReposted, repostCount: prevCount });
      showToast('操作失败，请重试');
    }
  }, [reposted, repostCount, user, postId, openLoginPrompt, setRepostedCache]);

  return { reposted, setReposted, repostCount, setRepostCount, toggle };
}
