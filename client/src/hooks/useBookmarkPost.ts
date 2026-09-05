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
    events.emit('post:bookmark', { postId, bookmarked: !wasBookmarked });
    try {
      if (wasBookmarked) {
        await postsApi.unbookmarkPost(postId);
      } else {
        await postsApi.bookmarkPost(postId);
      }
    } catch {
      setBookmarked(wasBookmarked);
      setBookmarkedCache(postId, wasBookmarked);
    }
  }, [bookmarked, user, postId, openLoginPrompt, setBookmarkedCache]);

  return { bookmarked, setBookmarked, toggle };
}
