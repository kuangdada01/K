/**
 * ============================================================
 * 帖子详情组件 (PostDetail)
 * ============================================================
 * 帖子详情模态框，显示完整帖子内容和评论
 *
 * 功能:
 * - 图片展示（轮播、左右切换、缩放查看）
 * - 视频播放（自动播放带声音）
 * - 嵌套评论（支持回复、折叠/展开、高亮跳转）
 * - 评论点赞/删除
 * - 帖子点赞/关注/分享
 * - 关闭动画效果
 *
 * 子模块:
 * - PostDetailActions  底部操作栏（纯展示）
 * - CommentComposer    评论输入区（纯展示）
 * - usePostDetailClose 关闭/返回/滚轮生命周期
 * - useCommentThread   评论线程交互（提交/分页/折叠/点赞/删除/回复）
 * ============================================================
 */

import { useState, useEffect, useRef, useCallback, Suspense, lazy } from 'react';

import { X, Trash2, ChevronLeft, Pencil } from 'lucide-react';
import PostMedia from './PostMedia';
import PostDetailComments from './PostDetailComments';

const LazyProfileOverlay = lazy(() => import('../profile/ProfileOverlay'));
import ConfirmDialog from '../ui/ConfirmDialog';
import { getApiErrorMessage } from '../../api/http';
import * as postsApi from '../../api/posts';
import { useAuth } from '../../context/AuthContext';
import { useQueryClient } from '@tanstack/react-query';
import { postsFeedKey, updatePostsFeed } from '../../hooks/usePostsFeed';
import { useFollow, useLike, useBookmark, useRepost } from '../../state/cache';
import { useFollowUser } from '../../hooks/useFollowUser';
import { useFollowToggle } from '../../hooks/useFollowToggle';
import { useShareLink } from '../../hooks/useShareLink';
import { useHeartFill } from '../../hooks/useHeartFill';
import { useLikePost } from '../../hooks/useLikePost';
import { useRepostPost } from '../../hooks/useRepostPost';
import { useBookmarkPost } from '../../hooks/useBookmarkPost';
import { usePostDetailData } from '../../hooks/usePostDetailData';
import { useCommentThread } from '../../hooks/useCommentThread';
import { useEvent } from '../../context/EventContext';
import { events } from '../../state/events';
import { showToast } from '../ui/Toast';
import { resolveMediaUrl } from '../../utils';
import { parsePostImages, cleanEditImages } from '../../lib/parsePostImages';
import PostDetailActions from './PostDetailActions';
import CommentComposer from './CommentComposer';
import { usePostDetailClose } from './usePostDetailClose';
import styles from './PostDetail.module.css';

interface PostDetailProps {
  postId: number;
  /** 进入详情页时定位到的图片索引（首页卡片点开时传入当前轮播位置） */
  initialImageIndex?: number;
  onClose?: () => void;
  onLikeChange?: (postId: number, liked: boolean, likeCount: number) => void;
  onCommentChange?: (postId: number, commentCount: number) => void;
  highlightCommentId?: number | null;
  noAnimation?: boolean;
}

export default function PostDetail({
  postId,
  initialImageIndex = 0,
  onClose,
  onLikeChange,
  onCommentChange,
  highlightCommentId,
  noAnimation,
}: PostDetailProps) {
  const { user, openLoginPrompt } = useAuth();
  const queryClient = useQueryClient();
  const { getFollowStatus, setFollowStatus } = useFollow();
  const { getLikeInfo } = useLike();
  const { getBookmarked } = useBookmark();
  const { openEdit } = useEvent();
  // P6 修复：PostDetail 不再整包消费 MusicContext。开视频时发 music:pause 事件，
  // 关闭时发 music:resume（MusicProvider 内部处理"是否真的在播/是否要恢复"）。
  const [musicWasPlaying, setMusicWasPlaying] = useState(false);
  const { getReposted } = useRepost();
  const { requireLogin } = useFollowUser();
  const {
    liked,
    setLiked,
    likeCount,
    setLikeCount,
    toggle: toggleLike,
  } = useLikePost(postId, { onChange: onLikeChange });
  const { reposted, setReposted, repostCount, setRepostCount, toggle: toggleRepost } = useRepostPost(postId);
  const { bookmarked, setBookmarked, toggle: toggleBookmark } = useBookmarkPost(postId);
  // 首页卡片点开时带图片索引进来，详情页/全屏首屏定位到同一张
  const [currentImageIndex, setCurrentImageIndex] = useState(initialImageIndex);
  const [zoomed, setZoomed] = useState(false);
  const [profileUserId, setProfileUserId] = useState<number | null>(null);
  const [showDeletePostConfirm, setShowDeletePostConfirm] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);
  const highlightRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const detailVideoRef = useRef<HTMLVideoElement>(null);
  const heartRef = useRef<SVGSVGElement>(null);

  const [activeHighlightId, setActiveHighlightId] = useState<number | null>(null);

  // 帖子/用户切换时重置高亮与图片索引（渲染期 prev 值模式，替代 effect 内同步 setState；
  // 评论/分页/加载错误的重置在 usePostDetailData 内同步完成，续拉标志的重置在 useCommentThread 内同步完成）
  const [prevDetailKey, setPrevDetailKey] = useState('');
  const detailKey = `${postId}|${user?.id ?? 'anon'}`;
  if (detailKey !== prevDetailKey) {
    setPrevDetailKey(detailKey);
    setActiveHighlightId(null);
    setCurrentImageIndex(initialImageIndex);
  }

  // 详情数据层：帖子/评论首屏拉取、登录态字段回填、切换重置（自本组件拆出，行为不变）
  const {
    post,
    comments,
    setComments,
    commentHasMore,
    setCommentHasMore,
    commentTotal,
    setCommentTotal,
    loadError,
    shareCount,
    setShareCount,
    alreadyShared,
    setAlreadyShared,
    isFollowing,
    setIsFollowing,
    collapsedReplies,
    setCollapsedReplies,
  } = usePostDetailData({
    postId,
    userId: user?.id,
    highlightCommentId,
    getFollowStatus,
    setFollowStatus,
    getLikeInfo,
    getBookmarked,
    getReposted,
    setLiked,
    setLikeCount,
    setBookmarked,
    setReposted,
    setRepostCount,
    onHighlight: setActiveHighlightId,
  });

  // 评论交互层：提交/分页/删除/点赞/折叠/回复（自本组件拆出，行为不变）。
  // 评论数据层 state（comments/commentHasMore/commentTotal）由 usePostDetailData 持有
  // （首屏注入 + 切换重置），此处注入 useCommentThread；collapsedReplies 的 setter 一并注入
  // （getter 留在本组件供渲染）
  const {
    commentsLoadingMore,
    replyingTo,
    setReplyingTo,
    newComment,
    setNewComment,
    submitting,
    deleteTargetId,
    setDeleteTargetId,
    commentsEndRef,
    commentInputRef,
    handleComment,
    loadMoreComments,
    handleDeleteComment,
    confirmDeleteComment,
    handleCommentLike,
    toggleReplies,
    handleReply,
  } = useCommentThread({
    postId,
    comments,
    setComments,
    commentHasMore,
    setCommentHasMore,
    commentTotal,
    setCommentTotal,
    setCollapsedReplies,
    userId: user?.id,
    closeComments: post?.close_comments,
    detailKey,
    openLoginPrompt,
    onCommentChange,
  });

  const { closing, handleClose } = usePostDetailClose({
    onClose,
    zoomed,
    setZoomed,
    overlayRef,
    onClosing: () => {
      if (musicWasPlaying) {
        events.emit('music:resume');
        setMusicWasPlaying(false);
      }
    },
  });

  // 帖子加载时自动播放带声音的视频，并暂停音乐（P6：经事件总线通知 MusicProvider 暂停）
  useEffect(() => {
    if (!post?.video_url) return;
    const timer = setTimeout(() => {
      if (detailVideoRef.current) {
        // 通知全局音乐暂停（MusicProvider 自行判断是否需要真正暂停）；关闭时用 music:resume 恢复
        setMusicWasPlaying(true);
        events.emit('music:pause');
        detailVideoRef.current.muted = false;
        detailVideoRef.current.volume = 0.8;
        detailVideoRef.current.play().catch(() => {});
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [post?.video_url]);

  // 直接操作 SVG DOM，绕过 React 渲染（自 useHeartFill 拆出，行为不变）
  useHeartFill(heartRef, liked);

  // —— 关注切换 / 分享：自 handleFollow / handleShare 拆出至
  // useFollowToggle / useShareLink（行为不变）——
  // userId 未就绪（post 未加载）时切换短路，对应原 handleFollow 的 "if (!post) return" 守卫
  const { toggle: toggleFollow } = useFollowToggle({
    userId: post?.user_id,
    isFollowing,
    setIsFollowing,
  });
  const handleFollow = () => {
    void toggleFollow();
  };
  const handleShare = useShareLink({
    postId,
    requireLogin,
    setShowTooltip,
    alreadyShared,
    setAlreadyShared,
    setShareCount,
  });

  const handleDeletePost = async () => {
    if (!post) return;
    try {
      await postsApi.deletePost(post.id);
      showToast('帖子已删除');
      // 同步移除信息流缓存，删除后立即生效（staleTime: Infinity 不会自动重取）
      updatePostsFeed(queryClient, (prev) => prev.filter((p) => p.id !== post.id));
      queryClient.invalidateQueries({ queryKey: postsFeedKey });
      events.emit('post:deleted', post.id);
      handleClose();
    } catch (err) {
      showToast(getApiErrorMessage(err, '删除失败，请重试'));
    }
    setShowDeletePostConfirm(false);
  };

  const handleNavigate = (path: string) => {
    // 提取 /profile/:id 中的 userId
    const match = path.match(/\/profile\/(\d+)/);
    if (match) {
      setProfileUserId(parseInt(match[1]!));
    }
  };

  /** 稳定的评论项回调：原实现在 map 里每条评论各建一个箭头函数，
   *  连同未 memo 的 CommentItem 一起，让输入评论时每条评论都重渲染 */
  const handleCommentProfileClick = useCallback((id: number) => {
    setProfileUserId(id);
  }, []);

  if (loadError) {
    return (
      <div
        ref={overlayRef}
        className={`${styles.overlay} ${closing ? styles.closing : ''}`}
        onClick={handleClose}
      >
        <div
          className={styles.container}
          onClick={(e) => e.stopPropagation()}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <div style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
            <p style={{ fontSize: 16, marginBottom: 12 }}>该帖子已被删除</p>
            <button
              onClick={handleClose}
              style={{
                padding: '8px 24px',
                background: 'var(--accent)',
                color: 'white',
                border: 'none',
                borderRadius: 8,
                cursor: 'pointer',
                fontWeight: 600,
              }}
            >
              关闭
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!post) return null;

  const images = parsePostImages(post);

  const overlayClass = `${styles.overlay} ${closing ? styles.closing : ''} ${noAnimation ? styles.noAnimation : ''}`;
  const containerClass = `${styles.container} ${closing ? styles.closing : ''} ${noAnimation ? styles.noAnimation : ''}`;

  return (
    <div ref={overlayRef} className={overlayClass} onClick={handleClose}>
      <button className={styles.close} data-back onClick={handleClose} aria-label="关闭">
        <X size={28} />
      </button>
      <div className={containerClass} onClick={(e) => e.stopPropagation()}>
        <div className={styles.mobileHeader}>
          <button className={styles.backBtn} data-back onClick={handleClose} aria-label="返回">
            <ChevronLeft size={24} />
          </button>
          <div className={styles.mobileUser} onClick={() => handleNavigate(`/profile/${post.user_id}`)}>
            {post.avatar ? (
              <img src={resolveMediaUrl(post.avatar) || ''} alt="" className={styles.avatar} />
            ) : (
              <div className={styles.avatarPlaceholder}>{post.username.charAt(0).toUpperCase()}</div>
            )}
            <span className={styles.username}>{post.username}</span>
          </div>
          {user && post.user_id === user.id && (
            <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
              <button
                className={styles.editBtn}
                onClick={() => {
                  handleClose();
                  setTimeout(() => {
                    // 与个人页编辑入口同一份清洗逻辑（lib/parsePostImages.cleanEditImages）
                    const cleanImages = cleanEditImages(post);
                    openEdit({
                      id: post.id,
                      description: post.description || '',
                      images: cleanImages,
                      closeComments: !!post.close_comments,
                      pinned: !!post.pinned,
                      videoUrl: post.video_url || null,
                      videoCover: post.video_cover || null,
                    });
                  }, 250);
                }}
                title="编辑帖子"
              >
                <Pencil size={18} />
              </button>
              <button
                className={styles.editBtn}
                onClick={() => setShowDeletePostConfirm(true)}
                title="删除帖子"
              >
                <Trash2 size={18} />
              </button>
            </div>
          )}
        </div>
        <PostMedia
          post={post}
          images={images}
          detailVideoRef={detailVideoRef}
          currentImageIndex={currentImageIndex}
          setCurrentImageIndex={setCurrentImageIndex}
          zoomed={zoomed}
          setZoomed={setZoomed}
        />
        <div className={styles.info}>
          <div className={styles.header}>
            <div
              className={styles.userLink}
              onClick={() => handleNavigate(`/profile/${post.user_id}`)}
              style={{ cursor: 'pointer' }}
            >
              {post.avatar ? (
                <img src={resolveMediaUrl(post.avatar) || ''} alt="" className={styles.avatar} />
              ) : (
                <div className={styles.avatarPlaceholder}>{post.username.charAt(0).toUpperCase()}</div>
              )}
              <span className={styles.username}>{post.username}</span>
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

          <PostDetailComments
            post={post}
            comments={comments}
            collapsedReplies={collapsedReplies}
            commentHasMore={commentHasMore}
            commentTotal={commentTotal}
            commentsLoadingMore={commentsLoadingMore}
            currentUserId={user?.id}
            activeHighlightId={activeHighlightId}
            highlightRef={highlightRef}
            endRef={commentsEndRef}
            onLoadMore={loadMoreComments}
            onProfileClick={handleCommentProfileClick}
            onReply={handleReply}
            onToggleReplies={toggleReplies}
            onLike={handleCommentLike}
            onDelete={handleDeleteComment}
          />

          {/* 底部操作栏 + 评论输入：移动端作为整体吸底 dock，桌面端仅作分组容器 */}
          <div className={styles.bottomDock}>
            <PostDetailActions
              liked={liked}
              likeCount={likeCount}
              commentsCount={commentTotal || comments.length}
              reposted={reposted}
              repostCount={repostCount}
              shareCount={shareCount}
              bookmarked={bookmarked}
              showTooltip={showTooltip}
              heartRef={heartRef}
              onLike={toggleLike}
              onComment={() => {
                if (!user) {
                  openLoginPrompt();
                  return;
                }
                commentInputRef.current?.focus();
              }}
              onRepost={toggleRepost}
              onShare={handleShare}
              onBookmark={toggleBookmark}
            />

            {post.close_comments ? (
              <div className={styles.commentsDisabled}>此帖子已关闭评论</div>
            ) : (
              <CommentComposer
                isLoggedIn={!!user}
                replyingTo={replyingTo}
                submitting={submitting}
                value={newComment}
                inputRef={commentInputRef}
                onChange={setNewComment}
                onEmoji={(emoji) => setNewComment((prev) => prev + emoji)}
                onSubmit={handleComment}
                onCancelReply={() => setReplyingTo(null)}
                onRequireLogin={openLoginPrompt}
              />
            )}
          </div>
        </div>
      </div>

      {deleteTargetId !== null && (
        <ConfirmDialog
          message="确定要删除这条评论吗？"
          onConfirm={confirmDeleteComment}
          onCancel={() => setDeleteTargetId(null)}
        />
      )}

      {showDeletePostConfirm && (
        <ConfirmDialog
          message="确定要删除这篇帖子吗？"
          onConfirm={handleDeletePost}
          onCancel={() => setShowDeletePostConfirm(false)}
        />
      )}

      {profileUserId && (
        <Suspense fallback={null}>
          <LazyProfileOverlay userId={profileUserId} onClose={() => setProfileUserId(null)} />
        </Suspense>
      )}
    </div>
  );
}
