/**
 * ============================================================
 * 帖子卡片组件 (PostCard)
 * ============================================================
 * 用于首页信息流中展示单个帖子
 *
 * 功能:
 * - 图片轮播（帖子完全可见时自动播放3秒切换，不可见时显示封面）
 * - 视频预加载（帖子完全可见时封面显示2.5秒后自动播放）
 * - 点赞/取消点赞（乐观更新UI）
 * - 关注/取消关注用户
 * - 分享链接复制
 * - 点击打开帖子详情
 * ============================================================
 */

import { useState, useEffect, useRef, useMemo, memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { MessageCircle, Share2, Repeat2 } from 'lucide-react';
import RepostCheck from '../icons/RepostCheck';
import { followStatus } from '../../api/friends';
import { Post } from '../../types';
import { useAuth } from '../../context/AuthContext';
import { useVoiceInRoom } from '../../context/VoiceContext';
import { useFollow, useLike, useRepost } from '../../state/cache';
import { useFollowUser } from '../../hooks/useFollowUser';
import { useLikePost } from '../../hooks/useLikePost';
import { useRepostPost } from '../../hooks/useRepostPost';
import { useVisibility } from '../../hooks/useVisibility';
import { useSwipeCarousel } from '../../hooks/useSwipeCarousel';
import { useVideoAutoplay } from '../../hooks/useVideoAutoplay';
import { useFollowToggle } from '../../hooks/useFollowToggle';
import { useShareLink } from '../../hooks/useShareLink';
import { useHeartFill } from '../../hooks/useHeartFill';
import { events } from '../../state/events';
import { formatRelativeTime, resolveMediaUrl } from '../../utils';
import { parsePostImages } from '../../lib/parsePostImages';
import Avatar from '../ui/Avatar';
import TaggedText from '../TaggedText';
import styles from './PostCard.module.css';

/** 完全可见后延迟启动自动播放（快速划过不误触） */
const VIDEO_AUTOPLAY_DELAY_MS = 500;

interface PostCardProps {
  post: Post;
  onLikeToggle?: () => void;
  /** 打开详情页；imageIndex 为当前图片索引（详情页/全屏首屏定位用） */
  onPostClick?: (postId: number, imageIndex?: number) => void;
  onProfileClick?: (userId: number) => void;
  onLikeChange?: (postId: number, liked: boolean, likeCount: number) => void;
}

function PostCard({ post, onLikeToggle, onPostClick, onProfileClick, onLikeChange }: PostCardProps) {
  const { user, openLoginPrompt } = useAuth();
  const inRoom = useVoiceInRoom();
  const { getFollowStatus, setFollowStatus } = useFollow();
  const { requireLogin, notifyChanged } = useFollowUser();
  const { getLikeInfo } = useLike();
  const { getReposted } = useRepost();
  // 点赞/转发：交互逻辑统一由 hooks 提供（与 PostDetail 共用同一实现）
  const {
    liked,
    setLiked,
    likeCount,
    setLikeCount,
    toggle: toggleLike,
  } = useLikePost(post.id, {
    onToggle: onLikeToggle,
    onChange: onLikeChange,
  });
  const { reposted, setReposted, repostCount, setRepostCount, toggle: toggleRepost } = useRepostPost(post.id);
  const [showTooltip, setShowTooltip] = useState(false);
  const [isFollowing, setIsFollowing] = useState(false);
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  // 用户手动触摸/滑动过轮播图后停止自动轮播（移动端无 hover，isPaused 恒 false，
  // 此前手动切图 3 秒后会被自动轮播切走——"抢权限"；触摸过一次即不再自动播）
  const [userInteracted, setUserInteracted] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // transform 轨道：GPU 合成器驱动，60fps 丝滑（scrollLeft 走主线程会掉帧）
  const trackRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const heartRef = useRef<SVGSVGElement>(null);
  const navigate = useNavigate();

  // 帖子可见性检测（IntersectionObserver 逻辑自 useVisibility 拆出，行为不变）
  const { isFullyVisible, isPartiallyVisible } = useVisibility(cardRef);
  // 手势轮播轨道（手势/动画逻辑自 useSwipeCarousel 拆出，行为不变）
  const swipeCarousel = useSwipeCarousel(trackRef, scrollRef);

  // useMemo 化：post 未变时返回同一引用，避免手势 effect 依赖 [images] 每次渲染 detach/reattach
  // （图片数组解析自 lib/parsePostImages 拆出，行为不变：images 非空直接返回）
  const images = useMemo(() => parsePostImages(post), [post]);

  // Auto-play carousel: 部分可见且未悬停暂停时每 3 秒推进一张；
  // 用户手动触摸/滑动过后（userInteracted）不再自动播
  useEffect(() => {
    if (images.length <= 1 || isPaused || userInteracted || !isPartiallyVisible) return;
    const timer = setInterval(() => {
      setCurrentImageIndex((prev) => (prev + 1) % images.length);
    }, 3000);
    return () => clearInterval(timer);
  }, [images.length, isPaused, userInteracted, isPartiallyVisible]);

  // 视频：帖子完全可见后稍作延迟再加载播放（快速划过不触发）。
  // 布局由封面图撑起（.videoPoster），视频作为绝对定位覆盖层淡入——
  // 全程零布局跳变，从结构上杜绝闪屏。
  // 语音房间优先：进房后信息流视频暂停自动加载/播放并卸载覆盖层，
  // 让出同一链路的带宽给 P2P 语音（主动点进详情播放不受影响）
  const videoShouldBeReady = !!(post.video_url && isFullyVisible && !inRoom);
  // 帖子几乎不可见时重置到封面（渲染期调整，prev 值由 currentImageIndex 守卫）
  if (!isPartiallyVisible && images.length > 1 && currentImageIndex !== 0) {
    setCurrentImageIndex(0);
  }
  // 离开视口后同步重置吸附基准（渲染期不写 ref，放 effect 里避免 lint 告警）
  useEffect(() => {
    if (!isPartiallyVisible) {
      swipeCarousel.setSettled(0);
    }
  }, [isPartiallyVisible, swipeCarousel]);
  // 视频延迟自动播放（延迟判定与定时器清理语义自 useVideoAutoplay 拆出，行为不变；
  // 卸载清理 transition 定时器已随手势逻辑移入 useSwipeCarousel）
  const videoReady = useVideoAutoplay(videoRef, videoShouldBeReady, VIDEO_AUTOPLAY_DELAY_MS);

  // 关注状态：缓存命中时渲染期同步，未命中才发请求；并监听全局 follow:changed 实时更新
  if (user && post.user_id !== user.id) {
    const cached = getFollowStatus(post.user_id);
    if (cached !== undefined && isFollowing !== cached) setIsFollowing(cached);
  }
  useEffect(() => {
    const h = (uid: number) => {
      if (uid === post.user_id) {
        const c = getFollowStatus(uid);
        if (c !== undefined) setIsFollowing(c);
      }
    };
    events.on('follow:changed', h);
    return () => {
      events.off('follow:changed', h);
    };
  }, [post.user_id, getFollowStatus]);
  useEffect(() => {
    if (!user || post.user_id === user.id) return;
    if (getFollowStatus(post.user_id) !== undefined) return; // 渲染期已同步
    followStatus(post.user_id)
      .then(({ is_following }) => {
        setIsFollowing(is_following);
        setFollowStatus(post.user_id, is_following);
      })
      .catch(() => {});
  }, [post.user_id, user, getFollowStatus, setFollowStatus]);

  useEffect(() => {
    const cached = getLikeInfo(post.id);
    if (cached) {
      setLiked(cached.liked);
      setLikeCount(cached.likeCount);
    } else {
      setLiked(!!post.liked);
      setLikeCount(post.like_count);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post.id]);

  useEffect(() => {
    const cached = getReposted(post.id);
    if (cached !== undefined) {
      setReposted(cached);
    } else {
      setReposted(!!post.reposted);
    }
    setRepostCount(post.repost_count || 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post.id]);

  // 直接操作 SVG DOM，绕过 React 渲染（自 useHeartFill 拆出，行为不变）
  useHeartFill(heartRef, liked);

  // —— 手势完全接管（WebView 原生惯性/scroll-snap 不可控，快速滑动会跨页）——
  // transform 轨道驱动：touchmove 直接写 translate3d（合成器线程，不触发 layout，
  // 60fps 丝滑）；松手用 CSS transition（同样走合成器）落位。
  // 轨道位移基准：offset = index * 容器宽度。（手势/轨道逻辑已拆出至 useSwipeCarousel，行为不变）

  // index 变化 → 轨道动画到对应位置（自动轮播/重置/外部切换统一走这里）
  useEffect(() => {
    if (images.length <= 1 || isPaused) return;
    swipeCarousel.animateTrackTo(currentImageIndex);
  }, [currentImageIndex, images.length, isPaused, swipeCarousel]);

  useEffect(() => {
    const track = trackRef.current;
    const viewport = scrollRef.current;
    // 事件绑定在 viewport 上（覆盖含黑色填充的整个区域；横版图片黑边处也能滑动翻页）
    if (!track || !viewport || images.length <= 1) return;
    const detach = swipeCarousel.attachGesture(
      viewport,
      track,
      images.length,
      () => setUserInteracted(true), // 手动触摸后停止自动轮播
      (target) => setCurrentImageIndex(target)
    );
    return detach;
  }, [images, swipeCarousel]);

  // —— 关注切换 / 分享：自 handleFollow / handleShare 拆出至
  // useFollowToggle / useShareLink（行为不变）——
  const { toggle: toggleFollow } = useFollowToggle({
    userId: post.user_id,
    isFollowing,
    setIsFollowing,
    onSuccess: () => notifyChanged(post.user_id),
  });

  const handleFollow = (e: React.MouseEvent) => {
    e.stopPropagation();
    void toggleFollow();
  };

  const handleShare = useShareLink({
    postId: post.id,
    requireLogin,
    setShowTooltip,
  });

  return (
    <div className={styles.card} ref={cardRef}>
      <div className={styles.header}>
        <div
          onClick={() =>
            onProfileClick ? onProfileClick(post.user_id) : navigate(`/profile/${post.user_id}`)
          }
          style={{ cursor: 'pointer' }}
        >
          <Avatar src={post.avatar} username={post.username} size={40} className={styles.avatar} />
        </div>
        <div className={styles.headerInfo}>
          <strong
            className={styles.username}
            onClick={() =>
              onProfileClick ? onProfileClick(post.user_id) : navigate(`/profile/${post.user_id}`)
            }
            style={{ cursor: 'pointer' }}
          >
            {post.username}
          </strong>
          <small className={styles.time}>{formatRelativeTime(post.created_at)}</small>
        </div>
        {user && post.user_id !== user.id && (
          <button
            className={`${styles.followBtn} ${isFollowing ? styles.following : ''}`}
            onClick={handleFollow}
          >
            {isFollowing ? '已关注' : '关注'}
          </button>
        )}
      </div>

      <div
        className={styles.imageWrapper}
        onClick={() =>
          onPostClick
            ? onPostClick(post.id, currentImageIndex)
            : navigate(`/post/${post.id}`, { state: { from: 'home' } })
        }
        onMouseEnter={() => setIsPaused(true)}
        onMouseLeave={() => setIsPaused(false)}
      >
        {post.video_url ? (
          videoShouldBeReady ? (
            <div className={styles.videoWrapper}>
              {/* 封面撑起布局（宽高比稳定）；视频作为覆盖层淡入，全程零布局跳变 */}
              {post.video_cover ? (
                <img
                  src={resolveMediaUrl(post.video_cover) || undefined}
                  alt={post.title}
                  className={styles.videoPoster}
                />
              ) : (
                /* 无封面（历史帖子）：用 video 元素自身撑起尺寸 */
                <video
                  src={resolveMediaUrl(post.video_url) || undefined}
                  muted
                  playsInline
                  preload="metadata"
                  className={styles.videoPoster}
                />
              )}
              {videoShouldBeReady && (
                <video
                  ref={videoRef}
                  src={resolveMediaUrl(post.video_url) || undefined}
                  muted
                  playsInline
                  preload="auto"
                  className={`${styles.videoOverlay} ${videoReady ? styles.videoOn : ''}`}
                />
              )}
            </div>
          ) : (
            // 语音房间内不自动播放：显示封面图（正确宽高比），不渲染 video 元素
            // （无 src 的 video 会回落到 300x150 默认比例，把容器压扁）
            <div className={styles.videoWrapper}>
              {post.video_cover ? (
                <img
                  src={resolveMediaUrl(post.video_cover) || undefined}
                  alt={post.title}
                  className={styles.video}
                />
              ) : (
                <video
                  src={resolveMediaUrl(post.video_url) || undefined}
                  muted
                  playsInline
                  preload="metadata"
                  className={styles.video}
                />
              )}
            </div>
          )
        ) : (
          <>
            <div className={styles.imageCarousel} ref={scrollRef}>
              <div className={styles.imageTrack} ref={trackRef}>
                {images.map((url, i) => (
                  <img
                    key={i}
                    src={resolveMediaUrl(url) || url}
                    alt={post.title}
                    className={styles.image}
                    // P10：首图立即加载撑起布局，其余全部懒加载降低首屏请求
                    loading={i === 0 ? 'eager' : 'lazy'}
                    decoding="async"
                  />
                ))}
              </div>
            </div>
            {images.length > 1 && (
              <div className={styles.imageDots}>
                {images.map((_, i) => (
                  <span
                    key={i}
                    className={`${styles.imageDot} ${i === currentImageIndex ? styles.active : ''}`}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <div className={styles.actions}>
        <button
          className={`${styles.actionBtn} ${liked ? styles.liked : ''}`}
          onClick={toggleLike}
          aria-label={liked ? '取消点赞' : '点赞'}
        >
          <svg
            ref={heartRef}
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path
              d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"
              fill="none"
              stroke="currentColor"
            />
          </svg>
          {likeCount > 0 && <span className={styles.actionCount}>{likeCount}</span>}
        </button>
        <button
          className={styles.actionBtn}
          onClick={() => {
            if (!user) {
              openLoginPrompt();
              return;
            }
            if (onPostClick) {
              onPostClick(post.id, currentImageIndex);
            } else {
              navigate(`/post/${post.id}`);
            }
          }}
          aria-label="评论"
        >
          <MessageCircle size={24} />
          {post.comment_count > 0 && <span className={styles.actionCount}>{post.comment_count}</span>}
        </button>
        <button
          className={`${styles.actionBtn} ${reposted ? styles.reposted : ''}`}
          onClick={toggleRepost}
          aria-label={reposted ? '取消转发' : '转发'}
        >
          {reposted ? <RepostCheck size={25} strokeWidth={1.8} /> : <Repeat2 size={25} strokeWidth={1.8} />}
          {repostCount > 0 && <span className={styles.actionCount}>{repostCount}</span>}
        </button>
        <button
          className={`${styles.actionBtn} ${styles.shareTooltip}`}
          onClick={handleShare}
          aria-label="分享"
        >
          <Share2 size={24} />
          {showTooltip && <span className={styles.shareTooltipText}>已复制链接</span>}
        </button>
      </div>

      {post.description && (
        <div className={styles.caption}>
          <span className={styles.captionUsername}>{post.username}</span>
          <TaggedText text={post.description} />
        </div>
      )}
    </div>
  );
}

// P7 修复：memo 让 props 不变时跳过渲染；配合 HomePage 的 useCallback 回调，
// 信息流任一 state 变化不再触发整列表卡片重渲染。
export default memo(PostCard);
