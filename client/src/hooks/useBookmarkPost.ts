/**
 * ============================================================
 * 收藏交互 Hook（useBookmarkPost）
 * ============================================================
 * PostDetail 收藏逻辑抽取：乐观更新 + 全局缓存同步 + 失败回滚。
 */

import { useCallback, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useBookmark } from '../state/cache';
import { events } from '../state/events';
import { showToast } from '../components/ui/Toast';
import * as postsApi from '../api/posts';

export function useBookmarkPost(postId: number) {
  const { user, openLoginPrompt } = useAuth();
  const { setBookmarked: setBookmarkedCache } = useBookmark();
  const [bookmarked, setBookmarked] = useState(false);

  const toggle = useCallback(async () => {
    if (!user) {
      openLoginPrompt();
      return;
    }
    const wasBookmarked = bookmarked;
    setBookmarked(!wasBookmarked);
    setBookmarkedCache(postId, !wasBookmarked);
    try {
      if (wasBookmarked) {
        const res = await postsApi.unbookmarkPost(postId);
        // 成功后才广播（服务端真值）；失败回滚同样广播回滚真值，
        // 保证经事件总线同步的其他组件与本地状态一致
        setBookmarked(res.bookmarked);
        setBookmarkedCache(postId, res.bookmarked);
        events.emit('post:bookmark', { postId, bookmarked: res.bookmarked });
      } else {
        const res = await postsApi.bookmarkPost(postId);
        setBookmarked(res.bookmarked);
        setBookmarkedCache(postId, res.bookmarked);
        events.emit('post:bookmark', { postId, bookmarked: res.bookmarked });
      }
    } catch {
      setBookmarked(wasBookmarked);
      setBookmarkedCache(postId, wasBookmarked);
      events.emit('post:bookmark', { postId, bookmarked: wasBookmarked });
      showToast('收藏失败，请重试');
    }
  }, [bookmarked, user, postId, openLoginPrompt, setBookmarkedCache]);

  return { bookmarked, setBookmarked, toggle };
}
