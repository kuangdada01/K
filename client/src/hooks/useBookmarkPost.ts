/**
 * ============================================================
 * 收藏交互 Hook（useBookmarkPost）
 * ============================================================
 * PostDetail 收藏逻辑抽取：乐观更新 + 全局缓存同步 + 失败回滚。
 */

import { useCallback, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useBookmark } from '../state/cache';
import { events } from '../state/events';
import { showToast } from '../components/ui/Toast';
import * as postsApi from '../api/posts';

export function useBookmarkPost(postId: number) {
  const { user, openLoginPrompt } = useAuth();
  const { setBookmarked: setBookmarkedCache } = useBookmark();
  const [bookmarked, setBookmarked] = useState(false);

  /** 在途闸门：`toggle` 依赖 [bookmarked]，重渲染前双击会读到同一个旧值
   *  连发两次请求（详见 useLikePost 同名注释） */
  const inFlightRef = useRef(false);

  const toggle = useCallback(async () => {
    if (!user) {
      openLoginPrompt();
      return;
    }
    if (inFlightRef.current) return;
    inFlightRef.current = true;
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
    } finally {
      inFlightRef.current = false;
    }
  }, [bookmarked, user, postId, openLoginPrompt, setBookmarkedCache]);

  return { bookmarked, setBookmarked, toggle };
}
