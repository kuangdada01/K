/**
 * ============================================================
 * 搜索页 (SearchPage / ExplorePage)
 * ============================================================
 * 帖子搜索和浏览页面
 *
 * 功能:
 * - 顶部居中大搜索框（支持关键词搜索帖子标题/描述）
 * - 下方以缩略图网格展示所有帖子（3-4列自适应）
 * - 点击缩略图弹出帖子详情模态框（复用 PostDetail 组件）
 * - 支持加载更多分页
 * ============================================================
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search, X, Heart, MessageCircle, Layers, Play } from 'lucide-react';
import { getApiErrorMessage } from '../api/http';
import { listPosts, searchPosts } from '../api/posts';
import { resolveMediaUrl } from '../utils';
import { showToast } from '../components/ui/Toast';
import PostDetail from '../components/post/PostDetail';
import { useInfiniteScrollSentinel } from '../hooks/useInfiniteScrollSentinel';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { useExplorePostEventsSync } from '../hooks/useExplorePostEventsSync';
import { parsePostImages } from '../lib/parsePostImages';
import { Post } from '../types';
import styles from './ExplorePage.module.css';

export default function ExplorePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlTag = searchParams.get('tag');
  const [keyword, setKeyword] = useState('');
  const [posts, setPosts] = useState<Post[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [totalResults, setTotalResults] = useState(0);
  const [overlayPostId, setOverlayPostId] = useState<number | null>(null);

  const loadMoreRef = useRef<HTMLDivElement>(null);
  // 请求序号守卫：只有最新一次请求的响应才允许落地（旧的请求不再阻塞新请求，
  // 也不丢弃新请求——此前 loadingRef 直接 return 会把飞行中的新搜索静默吞掉）
  const reqSeqRef = useRef(0);
  // §5.2 首挂载双发请求修复：挂载时初始化 effect 已负责首次加载，
  // 搜索防抖 effect 首次运行且关键词为空时直接跳过，不再重复请求
  const initializedRef = useRef(false);

  // 加载帖子（首页全部 / 关键词搜索 / #话题精确搜索）
  const loadPosts = useCallback(async (pageNum: number, query: string, append: boolean) => {
    const seq = ++reqSeqRef.current;
    setLoading(true);

    try {
      const trimmed = query.trim();
      // 类型化 API 层：#话题精确搜索 / 关键词搜索 / 全部帖子
      const data = await (trimmed.startsWith('#') && trimmed.length > 1
        ? searchPosts('', pageNum, 20, trimmed.slice(1))
        : trimmed
          ? searchPosts(trimmed, pageNum, 20)
          : listPosts(pageNum, 20));
      if (seq !== reqSeqRef.current) return; // 已有更新的请求，丢弃过期响应
      const newPosts: Post[] = data.posts || [];

      setPosts((prev) => (append ? [...prev, ...newPosts] : newPosts));
      setHasMore(pageNum < data.totalPages);
      setTotalResults(data.total || 0);
      setPage(pageNum);
    } catch (err) {
      if (seq === reqSeqRef.current) {
        showToast(getApiErrorMessage(err, '加载失败，请稍后重试'));
      }
    } finally {
      if (seq === reqSeqRef.current) setLoading(false);
    }
  }, []);

  // 初始加载（延迟一帧执行：loadPosts 的同步前缀会 setState，
  // effect 内同步调用会触发 react-hooks/set-state-in-effect）
  // URL 携带 ?tag= 时（从帖子 #话题 跳转而来）直接发起话题搜索
  useEffect(() => {
    const timer = setTimeout(() => {
      if (urlTag) {
        setKeyword(`#${urlTag}`);
        setSearched(true);
        setOverlayPostId(null);
        loadPosts(1, `#${urlTag}`, false);
      } else {
        loadPosts(1, '', false);
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [loadPosts, urlTag]);

  // 搜索防抖：输入停止 500ms 后触发搜索（防抖值自 useDebouncedValue 拆出，
  // 延迟值不变，仅换实现方式）
  const debouncedKeyword = useDebouncedValue(keyword, 500);
  useEffect(() => {
    // §5.2 首挂载双发请求修复：挂载时 keyword 为空且初始化 effect 已发过
    // loadPosts(1,'',false)，首次运行直接跳过；输入触发搜索/清空回到全部不变
    if (!initializedRef.current) {
      initializedRef.current = true;
      if (!debouncedKeyword.trim()) return;
    }
    // 延迟一帧执行：loadPosts 的同步前缀会 setState，
    // effect 内同步调用会触发 react-hooks/set-state-in-effect（与初始化 effect 同模式）
    const timer = setTimeout(() => {
      if (debouncedKeyword.trim()) {
        setSearched(true);
        loadPosts(1, debouncedKeyword, false);
      } else {
        setSearched(false);
        loadPosts(1, '', false);
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [debouncedKeyword, loadPosts]);

  // 加载更多：哨兵可见时追加下一页（哨兵逻辑自 IntersectionObserver effect 拆出）
  const handleLoadMore = useCallback(() => {
    loadPosts(page + 1, keyword, true);
  }, [loadPosts, page, keyword]);

  // IntersectionObserver 自动加载更多（自 useInfiniteScrollSentinel 拆出，行为不变）
  useInfiniteScrollSentinel(loadMoreRef, {
    hasMore,
    loading,
    onLoadMore: handleLoadMore,
  });

  const handleClear = () => {
    setKeyword('');
    setSearched(false);
    // 清除 URL 中的 ?tag=，避免与"全部帖子"状态不一致
    if (urlTag) setSearchParams({}, { replace: true });
  };

  const handlePostChange = (postId: number, liked: boolean, likeCount: number) => {
    setPosts((prev) =>
      prev.map((p) => (p.id === postId ? { ...p, liked: liked ? 1 : 0, like_count: likeCount } : p))
    );
  };

  const handleCommentChange = (postId: number, commentCount: number) => {
    setPosts((prev) => prev.map((p) => (p.id === postId ? { ...p, comment_count: commentCount } : p)));
  };

  // 全部实时：任意页面点赞/转发/评论/删除/新增 后，网格立即同步
  // （事件订阅自 useExplorePostEventsSync 拆出，行为不变；本地列表形态，
  // 参照 useProfileEventsSync 的模式单独成文件）
  useExplorePostEventsSync({ keyword, loadPosts, setPosts });

  /**
   * 网格项派生数据预计算。
   *
   * 原实现把 getThumbnail / getMultiImageCount 直接写在 map 里，每个网格项
   * 每次渲染都对 image_url 做一遍 JSON.parse（两个函数各一次），而
   * 搜索词每敲一个字、点赞事件同步一次都会触发整页重渲染；两个函数还各自
   * 重复实现了 lib/parsePostImages 已有的解析逻辑。这里统一预计算一次。
   */
  const gridItems = useMemo(
    () =>
      posts.map((post) => {
        const images = post.images && post.images.length > 0 ? post.images : parsePostImages(post);
        const raw = post.video_cover || images[0] || post.image_url;
        // 原生端相对路径会指向 WebView 本地（404），必须转成服务器绝对地址
        return { post, thumbnail: resolveMediaUrl(raw) || raw, multiCount: images.length };
      }),
    [posts]
  );

  return (
    <div className={styles.page}>
      {/* 搜索框 */}
      <div className={styles.boxWrapper}>
        <div className={styles.inputContainer}>
          <span className={styles.inputIcon}>
            <Search size={20} />
          </span>
          <input
            className={styles.input}
            name="search"
            placeholder="搜索"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          {keyword && (
            <button className={styles.clearBtn} onClick={handleClear}>
              <X size={18} />
            </button>
          )}
        </div>
      </div>

      {/* 搜索结果信息 */}
      {searched && <div className={styles.resultInfo}>找到 {totalResults} 个相关帖子</div>}

      {/* 帖子网格 */}
      {posts.length > 0 ? (
        <>
          <div className={styles.grid}>
            {gridItems.map(({ post, thumbnail, multiCount }) => (
              <div key={post.id} className={styles.gridItem} onClick={() => setOverlayPostId(post.id)}>
                <img src={thumbnail} alt={post.title || post.description || ''} loading="lazy" />

                {/* 视频标识 */}
                {post.video_url && (
                  <span className={styles.videoBadge}>
                    <Play size={12} fill="white" />
                    视频
                  </span>
                )}

                {/* 多图标识 */}
                {!post.video_url && multiCount > 1 && (
                  <span className={styles.multiBadge}>
                    <Layers size={20} />
                  </span>
                )}

                {/* Hover 叠加层 */}
                <div className={styles.gridOverlay}>
                  <span className={styles.gridStat}>
                    <Heart size={18} fill="white" />
                    {post.like_count}
                  </span>
                  <span className={styles.gridStat}>
                    <MessageCircle size={18} fill="white" />
                    {post.comment_count}
                  </span>
                </div>
              </div>
            ))}
          </div>

          {/* 加载更多触发器 */}
          {hasMore && (
            <div ref={loadMoreRef} className={styles.loadMore}>
              {loading && <span style={{ color: 'var(--text-secondary)' }}>加载中...</span>}
            </div>
          )}
        </>
      ) : loading ? (
        <div className={styles.loading}>加载中...</div>
      ) : (
        <div className={styles.empty}>
          <Search size={48} className={styles.emptyIcon} />
          <div className={styles.emptyText}>{searched ? '未找到相关帖子' : '暂无帖子'}</div>
          {searched && <div className={styles.emptyHint}>试试其他关键词</div>}
        </div>
      )}

      {/* 帖子详情模态框 */}
      {overlayPostId && (
        <PostDetail
          postId={overlayPostId}
          onClose={() => setOverlayPostId(null)}
          onLikeChange={handlePostChange}
          onCommentChange={handleCommentChange}
        />
      )}
    </div>
  );
}
