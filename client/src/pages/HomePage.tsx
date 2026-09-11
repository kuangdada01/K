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
import PostCard from '../components/post/PostCard';
import { loadPostDetail } from '../router/composerChunks';
const LazyProfileOverlay = lazy(() => import('../components/profile/ProfileOverlay'));
// 帖子详情浮层（含评论树）按需加载：首页此前静态引入它，把整块实现算进了首屏 chunk。
// 信息流卡片 hover/touch 时会预取（见 PostCard），所以正常点开没有额外等待。
const LazyPostDetail = lazy(loadPostDetail);
import RecommendCard from '../components/RecommendCard';
import IcpFooter from '../components/IcpFooter';
import MusicPlayer from '../components/MusicPlayer';
import EmptyState from '../components/ui/EmptyState';
import { useFollow } from '../state/cache';
import { useInfiniteScrollSentinel } from '../hooks/useInfiniteScrollSentinel';
import { usePostsFeed, feedPostsFlat, updatePostsFeed } from '../hooks/usePostsFeed';
import { usePostEventsSync } from '../hooks/usePostEventsSync';
import { useRecommendFollow } from '../hooks/useRecommendFollow';
import { useScrollRestore } from '../hooks/useScrollRestore';
import { usePullToRefresh, PULL_CIRCUMFERENCE } from '../hooks/usePullToRefresh';
import {
  getScrollTarget,
  readScrollY,
  writeScrollY,
  persistScrollY,
  loadPersistedScrollY,
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

  const [refreshing, setRefreshing] = useState(false);

  const initialPostId = urlPostId ? parseInt(urlPostId) : queryPostId ? parseInt(queryPostId) : null;
  // 同步读取 sessionStorage，首次渲染就拿到 postId，不等 useEffect
  const [overlayPostId, setOverlayPostId] = useState<number | null>(() => {
    if (initialPostId) return initialPostId;
    const reopenId = sessionStorage.getItem('reopenPostId');
    if (reopenId) {
      sessionStorage.removeItem('reopenPostId');
      return parseInt(reopenId);
    }
    return null;
  });
  const [skipOverlayAnim, setSkipOverlayAnim] = useState(() => !!sessionStorage.getItem('reopenPostId'));
  // 打开详情页时记住卡片上正在看的图片索引，详情页/全屏首屏定位到同一张
  const [overlayImageIndex, setOverlayImageIndex] = useState(0);
  const [profileUserId, setProfileUserId] = useState<number | null>(null);

  // /post/:id 路由参数变化时同步 overlay（渲染期 prev 值模式，与 PostDetail 一致）：
  // 参数为 null（关闭后回到 /）时不覆盖状态，保持关闭动画语义
  const [prevInitialPostId, setPrevInitialPostId] = useState<number | null>(null);
  if (initialPostId !== null && initialPostId !== prevInitialPostId) {
    setPrevInitialPostId(initialPostId);
    setOverlayPostId(initialPostId);
  }

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

  // 无限滚动：滚动到底部哨兵时加载下一页（自内联 IntersectionObserver effect 拆出，行为不变：
  // threshold 0.1、仅 hasNextPage 且非加载下一页时触发；fetchNextPage 为 React Query
  // 稳定引用，直接作为 onLoadMore 传入，observer 重建条件与原 effect 依赖一致）
  const loadMoreRef = useRef<HTMLDivElement>(null);
  useInfiniteScrollSentinel(loadMoreRef, {
    hasMore: hasNextPage,
    loading: isFetchingNextPage,
    onLoadMore: fetchNextPage,
  });

  // 推荐关注：列表加载 + 关注成功/失败 + 400ms 移除动画（自 useRecommendFollow 拆出，行为不变）
  const { recommendUsers, removingIds, handleRecommendFollow } = useRecommendFollow({
    user,
    openLoginPrompt,
    setFollowStatus,
  });

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

  // 帖子事件 → 信息流缓存实时同步（自 usePostEventsSync 拆出，行为不变；
  // 含 post:created 无载荷时的 refetch 分支）
  usePostEventsSync(queryClient, refetch);

  const handleLikeChange = useCallback(
    (postId: number, liked: boolean, likeCount: number) => {
      updatePostsFeed(queryClient, (prev) =>
        prev.map((p) => (p.id === postId ? { ...p, liked: liked ? 1 : 0, like_count: likeCount } : p))
      );
    },
    [queryClient]
  );

  const handleCommentChange = useCallback(
    (postId: number, commentCount: number) => {
      updatePostsFeed(queryClient, (prev) =>
        prev.map((p) => (p.id === postId ? { ...p, comment_count: commentCount } : p))
      );
    },
    [queryClient]
  );

  const handlePostClick = useCallback((postId: number, imageIndex?: number) => {
    setOverlayImageIndex(imageIndex ?? 0);
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

  return (
    <>
      {/* Pull-to-refresh indicator — always rendered, ref-driven for zero latency */}
      <div
        ref={pullIndicatorRef}
        className={`${styles.pullIndicator}${refreshing ? ` ${styles.refreshing}` : ''}`}
        style={{ height: 0, overflow: 'hidden' }}
      >
        {/* Progress circle (shown during pull, hidden during refresh) */}
        <svg className={styles.pullProgress} width="28" height="28" viewBox="0 0 28 28">
          <circle cx="14" cy="14" r="12" fill="none" stroke="var(--border-color)" strokeWidth="2.5" />
          <circle
            ref={pullProgressRef}
            cx="14"
            cy="14"
            r="12"
            fill="none"
            stroke="var(--accent)"
            strokeWidth="2.5"
            strokeDasharray={`0 ${PULL_CIRCUMFERENCE}`}
            strokeLinecap="round"
            transform="rotate(-90 14 14)"
          />
        </svg>
        {/* Spinner (shown during refresh) */}
        <div className={styles.pullSpinner} />
      </div>
      <div className={styles.layout} ref={containerRef}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-secondary)' }}>加载中...</div>
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
                        onClick={() => {
                          refetch();
                        }}
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
                  {posts.map((post) => (
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
                    <div
                      ref={loadMoreRef}
                      style={{ textAlign: 'center', padding: 16, color: 'var(--text-secondary)' }}
                    >
                      {isFetchingNextPage ? '加载中...' : ''}
                    </div>
                  )}
                </>
              )}

              {overlayPostId &&
                createPortal(
                  <Suspense fallback={null}>
                    <LazyPostDetail
                      postId={overlayPostId}
                      initialImageIndex={overlayImageIndex}
                      onClose={() => {
                        setSkipOverlayAnim(false);
                        handlePostClose();
                      }}
                      onLikeChange={handleLikeChange}
                      onCommentChange={handleCommentChange}
                      noAnimation={skipOverlayAnim}
                    />
                  </Suspense>,
                  document.body
                )}

              {profileUserId &&
                createPortal(
                  <Suspense fallback={null}>
                    <LazyProfileOverlay userId={profileUserId} onClose={() => setProfileUserId(null)} />
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
