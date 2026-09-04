/**
 * ============================================================
 * 首页 (HomePage)
 * ============================================================
 * 帖子信息流页面
 *
 * 功能:
 * - 帖子列表（React Query 缓存，切换页面不重载）
 * - 下拉刷新（hooks/usePullToRefresh）
 * - 右侧推荐关注卡片（RecommendCard 组件）
 * - 帖子详情 overlay（点击帖子卡片打开）
 * - 支持 /post/:id 分享链接直接打开帖子详情
 * ============================================================
 */

import { useState, useEffect, useRef, useCallback, Suspense, lazy } from 'react';
import { createPortal } from 'react-dom';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Search } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import api from '../api/http';
import PostCard from '../components/post/PostCard';
import PostDetail from '../components/post/PostDetail';
const LazyProfileOverlay = lazy(() => import('../components/profile/ProfileOverlay'));
import RecommendCard, { RecommendUser } from '../components/RecommendCard';
import IcpFooter from '../components/IcpFooter';
import MusicPlayer from '../components/MusicPlayer';
import EmptyState from '../components/ui/EmptyState';
import { useFollow } from '../state/cache';
import { events } from '../state/events';
import { showToast } from '../components/ui/Toast';
import { usePostsFeed, postsFeedKey, feedPostsFlat, updatePostsFeed } from '../hooks/usePostsFeed';
import type { Post } from '../types';
import { useScrollRestore } from '../hooks/useScrollRestore';
import { usePullToRefresh, PULL_CIRCUMFERENCE } from '../hooks/usePullToRefresh';
import {
  getScrollTarget, readScrollY, writeScrollY, persistScrollY, loadPersistedScrollY,
} from '../lib/scroll';
import styles from './HomePage.module.css';

export default function HomePage() {
  const { user, openLoginPrompt } = useAuth();
  const { setFollowStatus } = useFollow();
  const queryClient = useQueryClient();
  const { id: urlPostId } = useParams();
  const [searchParams] = useSearchParams();
  const queryPostId = searchParams.get('postId');

  // 信息流：React Query 无限滚动缓存（等价原 cachedPosts 的"切页不重载"语义）
  const {
    data: feedData,
    isPending,
    isError,
    isFetching,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = usePostsFeed();
  const posts = feedPostsFlat(feedData);
  const loading = isPending || (isError && isFetching);
  const loadError = isError && !isFetching;

  const [recommendUsers, setRecommendUsers] = useState<RecommendUser[]>([]);
  const [removingIds, setRemovingIds] = useState<Set<number>>(new Set());
  const [refreshing, setRefreshing] = useState(false);

  const initialPostId = urlPostId ? parseInt(urlPostId) : (queryPostId ? parseInt(queryPostId) : null);
  // 同步读取 sessionStorage，首次渲染就拿到 postId，不等 useEffect
  const [overlayPostId, setOverlayPostId] = useState<number | null>(() => {
    if (initialPostId) return initialPostId;
    const reopenId = sessionStorage.getItem('reopenPostId');
    if (reopenId) { sessionStorage.removeItem('reopenPostId'); return parseInt(reopenId); }
    return null;
  });
  const [skipOverlayAnim, setSkipOverlayAnim] = useState(() => !!sessionStorage.getItem('reopenPostId'));
  const [profileUserId, setProfileUserId] = useState<number | null>(null);

  // Save scroll position continuously while on homepage
  useEffect(() => {
    const saveScroll = () => persistScrollY(readScrollY());
    const target = getScrollTarget();
    target.addEventListener('scroll', saveScroll, { passive: true });
    window.addEventListener('beforeunload', saveScroll);
    return () => {
      target.removeEventListener('scroll', saveScroll);
      window.removeEventListener('beforeunload', saveScroll);
    };
  }, []);

  // 滚动位置恢复（图片加载导致高度不足时的渐进重试）
  useScrollRestore(!!feedData);

  // 无限滚动：滚动到底部哨兵时加载下一页（参照 ExplorePage 的 IntersectionObserver 模式）
  const loadMoreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = loadMoreRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasNextPage && !isFetchingNextPage) {
          fetchNextPage();
        }
      },
      { threshold: 0.1 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Initial load: 推荐关注（游客也可看到，服务端返回随机用户）
  useEffect(() => {
    api.get('/friends/recommend').then(res => {
      setRecommendUsers(res.data.users);
    }).catch(() => {});
  }, []);

  // Pull-to-refresh — 用 ref 直接操作 DOM，零延迟跟手
  const containerRef = useRef<HTMLDivElement>(null);
  const pullIndicatorRef = useRef<HTMLDivElement>(null);
  const pullProgressRef = useRef<SVGCircleElement>(null);

  usePullToRefresh({
    containerRef,
    indicatorRef: pullIndicatorRef,
    progressRef: pullProgressRef,
    refreshing,
    setRefreshing,
    onRefresh: async () => {
      const res = await refetch();
      return res.isSuccess;
    },
  });

  // Post created → 实时插入首位，无需等待 refetch（app 无需手动刷新）
  useEffect(() => {
    const handler = (newPost?: Post | void) => {
      if (newPost && typeof newPost === 'object' && 'id' in newPost) {
        updatePostsFeed(queryClient, prev => [newPost as Post, ...prev.filter(p => p.id !== (newPost as Post).id)]);
      } else {
        // 无帖子载荷时（如发布后回执）整体重取，保持与历史行为一致
        refetch();
      }
    };
    events.on('post:created', handler as any);
    return () => { events.off('post:created', handler as any); };
  }, [refetch, queryClient]);

  // Post deleted → 立即从信息流移除，无需下拉或切页（修复 app 切页才更新）
  useEffect(() => {
    const handler = (deletedId: number) => {
      updatePostsFeed(queryClient, prev => prev.filter(p => p.id !== deletedId));
    };
    events.on('post:deleted', handler);
    return () => { events.off('post:deleted', handler); };
  }, [queryClient]);

  // Post updated（编辑）→ 失效重取，保证描述/图片实时
  useEffect(() => {
    const handler = () => { queryClient.invalidateQueries({ queryKey: postsFeedKey }); };
    events.on('post:updated', handler);
    return () => { events.off('post:updated', handler); };
  }, [queryClient]);

  // 全部状态实时：点赞/转发/评论 数在任意页面变更后，信息流立即同步（无需切页）
  useEffect(() => {
    const onLike = ({ postId, liked, likeCount }: { postId: number; liked: boolean; likeCount: number }) => {
      updatePostsFeed(queryClient, prev => prev.map(p => p.id === postId ? { ...p, liked: liked ? 1 : 0, like_count: likeCount } : p));
    };
    const onRepost = ({ postId, reposted, repostCount }: { postId: number; reposted: boolean; repostCount: number }) => {
      updatePostsFeed(queryClient, prev => prev.map(p => p.id === postId ? { ...p, reposted: reposted ? 1 : 0, repost_count: repostCount } : p));
    };
    const onComment = ({ postId, commentCount }: { postId: number; commentCount: number }) => {
      updatePostsFeed(queryClient, prev => prev.map(p => p.id === postId ? { ...p, comment_count: commentCount } : p));
    };
    events.on('post:like', onLike);
    events.on('post:repost', onRepost);
    events.on('post:comment', onComment);
    return () => {
      events.off('post:like', onLike);
      events.off('post:repost', onRepost);
      events.off('post:comment', onComment);
    };
  }, [queryClient]);

  // Follow changed → animate remove from recommend（mitt 事件总线）
  useEffect(() => {
    const handler = (userId: number) => {
      const inList = recommendUsers.some(u => u.id === userId);
      if (inList) {
        setRemovingIds(prev => new Set(prev).add(userId));
        setTimeout(() => {
          setRecommendUsers(prev => prev.filter(item => item.id !== userId));
          setRemovingIds(prev => {
            const next = new Set(prev);
            next.delete(userId);
            return next;
          });
        }, 400);
      }
    };
    events.on('follow:changed', handler);
    return () => { events.off('follow:changed', handler); };
  }, [recommendUsers]);

  const handleLikeChange = useCallback((postId: number, liked: boolean, likeCount: number) => {
    updatePostsFeed(queryClient, prev =>
      prev.map(p =>
        p.id === postId ? { ...p, liked: liked ? 1 : 0, like_count: likeCount } : p
      ));
  }, [queryClient]);

  const handleCommentChange = useCallback((postId: number, commentCount: number) => {
    updatePostsFeed(queryClient, prev =>
      prev.map(p =>
        p.id === postId ? { ...p, comment_count: commentCount } : p
      ));
  }, [queryClient]);

  const handlePostClick = useCallback((postId: number) => {
    setOverlayPostId(postId);
  }, []);

  const handlePostClose = useCallback(() => {
    setOverlayPostId(null);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const st = loadPersistedScrollY();
        if (st > 0) {
          writeScrollY(st);
        }
      });
    });
  }, []);

  const handleProfileClick = useCallback((userId: number) => {
    setProfileUserId(userId);
  }, []);

  /** 推荐卡片关注（静默失败，与原实现一致） */
  const handleRecommendFollow = async (u: RecommendUser) => {
    if (!user) { openLoginPrompt(); return; }
    try {
      await api.post(`/friends/${u.id}`);
      setFollowStatus(u.id, true);
      setRemovingIds(prev => new Set(prev).add(u.id));
      setTimeout(() => {
        setRecommendUsers(prev => prev.filter(item => item.id !== u.id));
        setRemovingIds(prev => {
          const next = new Set(prev);
          next.delete(u.id);
          return next;
        });
      }, 400);
      showToast('ヾ(≧▽≦*)o关注成功！');
    } catch {}
  };

  return (
    <>
    {/* Pull-to-refresh indicator — always rendered, ref-driven for zero latency */}
    <div ref={pullIndicatorRef} className={`${styles.pullIndicator}${refreshing ? ` ${styles.refreshing}` : ''}`} style={{ height: 0, overflow: 'hidden' }}>
      {/* Progress circle (shown during pull, hidden during refresh) */}
      <svg className={styles.pullProgress} width="28" height="28" viewBox="0 0 28 28">
        <circle cx="14" cy="14" r="12" fill="none" stroke="var(--border-color)" strokeWidth="2.5" />
        <circle ref={pullProgressRef} cx="14" cy="14" r="12" fill="none" stroke="var(--accent)"
          strokeWidth="2.5" strokeDasharray={`0 ${PULL_CIRCUMFERENCE}`} strokeLinecap="round"
          transform="rotate(-90 14 14)" />
      </svg>
      {/* Spinner (shown during refresh) */}
      <div className={styles.pullSpinner} />
    </div>
    <div
      className={styles.layout}
      ref={containerRef}
    >
      {loading ? (
        <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-secondary)' }}>
          加载中...
        </div>
      ) : (
      <>
      <div className={styles.feed}>
        {/* 页头 */}
        <div className={styles.feedHead}>
          <h1>首页</h1>
          <Link to="/explore" className={styles.searchBtn} aria-label="搜索">
            <Search size={22} />
          </Link>
        </div>
        {posts.length === 0 ? (
          <EmptyState>
            {loadError ? (
              <>
                <p style={{ marginBottom: 12 }}>加载失败，请检查网络连接</p>
                <button
                  onClick={() => { refetch(); }}
                  style={{
                    padding: '8px 24px',
                    background: 'var(--accent)',
                    color: 'white',
                    border: 'none',
                    borderRadius: 8,
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  重新加载
                </button>
              </>
            ) : (
              <>
                <h2 style={{ fontWeight: 300, marginBottom: 8 }}>欢迎来到 K</h2>
                {user ? (
                  <p>关注感兴趣的人，他们的帖子会出现在这里</p>
                ) : (
                  <p>浏览精彩内容，登录后即可互动</p>
                )}
              </>
            )}
          </EmptyState>
        ) : (
          <>
            {posts.map(post => (
              <PostCard
                key={post.id}
                post={post}
                onPostClick={handlePostClick}
                onProfileClick={handleProfileClick}
                onLikeChange={handleLikeChange}
              />
            ))}
            {/* 无限滚动哨兵：滚动到底部时加载下一页 */}
            {hasNextPage && (
              <div ref={loadMoreRef} style={{ textAlign: 'center', padding: 16, color: 'var(--text-secondary)' }}>
                {isFetchingNextPage ? '加载中...' : ''}
              </div>
            )}
          </>
        )}

        {overlayPostId && createPortal(
          <PostDetail
            postId={overlayPostId}
            onClose={() => { setSkipOverlayAnim(false); handlePostClose(); }}
            onLikeChange={handleLikeChange}
            onCommentChange={handleCommentChange}
            noAnimation={skipOverlayAnim}
          />,
          document.body
        )}

        {profileUserId && createPortal(
          <Suspense fallback={null}>
            <LazyProfileOverlay
              userId={profileUserId}
              onClose={() => setProfileUserId(null)}
            />
          </Suspense>,
          document.body
        )}
      </div>

      <div className={styles.sidebar}>
        <RecommendCard
          users={recommendUsers}
          removingIds={removingIds}
          onFollow={handleRecommendFollow}
        />
        {/* 音乐播放器：桌面端内嵌右栏，移动端使用浮窗版（App 全局渲染） */}
        <MusicPlayer inline />
      </div>
    </>
  )}
    </div>
    <IcpFooter />
    </>
  );
}
