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
 * ============================================================
 */

import { useState, useEffect, useRef, Suspense, lazy } from 'react';

import { X, Trash2, ChevronLeft, Pencil } from 'lucide-react';
import CommentItem from '../CommentItem';
import PostMedia from './PostMedia';
import TaggedText from '../TaggedText';

const LazyProfileOverlay = lazy(() => import('../profile/ProfileOverlay'));
import ConfirmDialog from '../ui/ConfirmDialog';
import api, { getApiErrorMessage } from '../../api/http';
import * as postsApi from '../../api/posts';
import { isAxiosError } from 'axios';
import { Post, Comment } from '../../types';
import { computeInitialCollapsedIds, buildVisibleComments } from '../../lib/comments';
import { useAuth } from '../../context/AuthContext';
import { useQueryClient } from '@tanstack/react-query';
import { postsFeedKey, updatePostsFeed } from '../../hooks/usePostsFeed';
import { useFollow, useLike, useBookmark, useRepost } from '../../state/cache';
import { useFollowUser } from '../../hooks/useFollowUser';
import { useLikePost } from '../../hooks/useLikePost';
import { useRepostPost } from '../../hooks/useRepostPost';
import { useBookmarkPost } from '../../hooks/useBookmarkPost';
import { useEvent } from '../../context/EventContext';
import { events } from '../../state/events';
import { showToast } from '../ui/Toast';
import { resolveMediaUrl } from '../../utils';
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
  const [post, setPost] = useState<Post | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [newComment, setNewComment] = useState('');
  const [replyingTo, setReplyingTo] = useState<{ id: number; username: string } | null>(null);
  const [isFollowing, setIsFollowing] = useState(false);
  const [shareCount, setShareCount] = useState(0);
  const [alreadyShared, setAlreadyShared] = useState(false);
  const { getReposted } = useRepost();
  const { requireLogin, follow, unfollow } = useFollowUser();
  const {
    liked,
    setLiked,
    likeCount,
    setLikeCount,
    toggle: toggleLike,
  } = useLikePost(postId, { onChange: onLikeChange });
  const { reposted, setReposted, repostCount, setRepostCount, toggle: toggleRepost } = useRepostPost(postId);
  const { bookmarked, setBookmarked, toggle: toggleBookmark } = useBookmarkPost(postId);
  const [submitting, setSubmitting] = useState(false);
  // 首页卡片点开时带图片索引进来，详情页/全屏首屏定位到同一张
  const [currentImageIndex, setCurrentImageIndex] = useState(initialImageIndex);
  const [zoomed, setZoomed] = useState(false);
  const [collapsedReplies, setCollapsedReplies] = useState<Set<number>>(new Set());
  const [deleteTargetId, setDeleteTargetId] = useState<number | null>(null);
  const [profileUserId, setProfileUserId] = useState<number | null>(null);
  const [showDeletePostConfirm, setShowDeletePostConfirm] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);
  const highlightRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  // 评论分页：comment_limit 首屏拉最近一页，after_id 游标续拉（高亮跳转场景走全量）
  const [commentHasMore, setCommentHasMore] = useState(false);
  const [commentTotal, setCommentTotal] = useState(0);
  const [commentsLoadingMore, setCommentsLoadingMore] = useState(false);
  const commentsEndRef = useRef<HTMLDivElement>(null);
  const detailVideoRef = useRef<HTMLVideoElement>(null);
  const heartRef = useRef<SVGSVGElement>(null);
  const commentInputRef = useRef<HTMLInputElement>(null);

  const [loadError, setLoadError] = useState(false);
  const [activeHighlightId, setActiveHighlightId] = useState<number | null>(null);

  // 帖子/用户切换时重置加载错误与高亮（渲染期 prev 值模式，替代 effect 内同步 setState）
  const [prevDetailKey, setPrevDetailKey] = useState('');
  const detailKey = `${postId}|${user?.id ?? 'anon'}`;
  if (detailKey !== prevDetailKey) {
    setPrevDetailKey(detailKey);
    setLoadError(false);
    setActiveHighlightId(null);
    setCurrentImageIndex(initialImageIndex);
    // 切换帖子：清空上一帖的评论与分页游标（避免旧帖评论在新帖下短暂残留）
    setComments([]);
    setCommentHasMore(false);
    setCommentTotal(0);
    setCommentsLoadingMore(false);
  }

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

  // 加载评论，全部折叠，若有高亮评论ID则展开其祖先
  // （loadError/highlight 重置已在渲染期完成）
  useEffect(() => {
    // 高亮跳转需要全量评论定位目标；普通打开按顶级评论分页（回复随顶级携带）
    postsApi
      .getPost(postId, highlightCommentId ? undefined : { commentLimit: 10 })
      .then(async (res) => {
        setPost(res.post);
        setComments(res.comments);
        setCommentHasMore(!!res.comments_has_more);
        setCommentTotal(res.comments_total ?? res.comments.length);
        const cachedLike = getLikeInfo(postId);
        if (cachedLike) {
          setLiked(cachedLike.liked);
          setLikeCount(cachedLike.likeCount);
        } else {
          setLiked(!!res.post.liked);
          setLikeCount(res.post.like_count);
        }
        setShareCount(res.post.share_count || 0);
        setAlreadyShared(!!res.post.shared);
        const cachedBookmark = getBookmarked(postId);
        if (cachedBookmark !== undefined) {
          setBookmarked(cachedBookmark);
        } else {
          setBookmarked(!!res.post.bookmarked);
        }
        const cachedRepost = getReposted(postId);
        if (cachedRepost !== undefined) {
          setReposted(cachedRepost);
        } else {
          setReposted(!!res.post.reposted);
        }
        setRepostCount(res.post.repost_count || 0);
        if (user && res.post.user_id !== user.id) {
          const cached = getFollowStatus(res.post.user_id);
          if (cached !== undefined) {
            setIsFollowing(cached);
          } else {
            try {
              const statusRes = await api.get(`/friends/status/${res.post.user_id}`);
              setIsFollowing(statusRes.data.is_following);
              setFollowStatus(res.post.user_id, statusRes.data.is_following);
            } catch {}
          }
        }
        // 默认折叠所有回复线程；若有高亮评论ID则展开其祖先使目标可见
        setCollapsedReplies(computeInitialCollapsedIds(res.comments, highlightCommentId));

        // 重新渲染后滚动 + 高亮
        if (highlightCommentId) {
          const targetId = Number(highlightCommentId);
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const el = document.getElementById(`comment-${targetId}`);
              if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              setActiveHighlightId(targetId);
            });
          });
        }
      })
      .catch(() => {
        setLoadError(true);
      });
  }, [
    postId,
    user,
    getFollowStatus,
    setFollowStatus,
    getBookmarked,
    getLikeInfo,
    getReposted,
    highlightCommentId,
    setBookmarked,
    setLikeCount,
    setLiked,
    setRepostCount,
    setReposted,
  ]);

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

  // 直接操作 SVG DOM
  useEffect(() => {
    const svg = heartRef.current;
    if (!svg) return;
    const path = svg.querySelector('path');
    if (!path) return;
    // SVG presentation attribute 不支持 var()，需读取 CSS 变量实际值
    const dangerColor =
      getComputedStyle(document.documentElement).getPropertyValue('--danger').trim() || '#ed4956';
    const c = liked ? dangerColor : 'none';
    const s = liked ? dangerColor : 'currentColor';
    path.setAttribute('fill', c);
    path.setAttribute('stroke', s);
    svg.setAttribute('fill', c);
    svg.setAttribute('stroke', s);
    void svg.getBoundingClientRect();
  }, [liked]);

  const handleComment = async () => {
    if (!user) {
      openLoginPrompt();
      return;
    }
    if (!newComment.trim() || submitting || post?.close_comments) return;
    setSubmitting(true);
    try {
      const res = await postsApi.createComment(postId, {
        content: newComment,
        parentId: replyingTo?.id || null,
      });
      // updater 必须纯函数：事件/回调副作用放在 setState 之外（StrictMode 下 updater 会双调用）
      const updated = [...comments, res];
      setComments(updated);
      const newTotal = commentTotal + 1;
      setCommentTotal(newTotal);
      onCommentChange?.(postId, newTotal);
      events.emit('post:comment', { postId, commentCount: newTotal });
      setNewComment('');
      setReplyingTo(null);
      setTimeout(() => commentsEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 403) {
        showToast('此帖子已关闭评论');
      } else {
        showToast(getApiErrorMessage(err, '评论发送失败，请重试'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  /** 向上续拉下一页评论：游标 = 已加载的最后一条顶级评论 id */
  const loadMoreComments = async () => {
    if (commentsLoadingMore || !commentHasMore) return;
    const tops = comments.filter((c) => !c.parent_id);
    const lastTop = tops[tops.length - 1];
    if (!lastTop) return;
    setCommentsLoadingMore(true);
    try {
      const res = await postsApi.listCommentsPaged(postId, { afterId: lastTop.id, limit: 10 });
      setComments((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        return [...prev, ...res.comments.filter((c) => !seen.has(c.id))];
      });
      setCommentHasMore(!!res.has_more);
      setCommentTotal(res.total ?? commentTotal);
    } catch (err) {
      showToast(getApiErrorMessage(err, '评论加载失败，请重试'));
    } finally {
      setCommentsLoadingMore(false);
    }
  };

  const handleDeleteComment = (commentId: number) => {
    setDeleteTargetId(commentId);
  };

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

  const confirmDeleteComment = async () => {
    if (deleteTargetId === null) return;
    try {
      await postsApi.deleteComment(deleteTargetId);
      const updated = comments.filter((c) => c.id !== deleteTargetId && c.parent_id !== deleteTargetId);
      setComments(updated);
      // 分页下总数按已加载列表的收缩量回推（被删回复可能级联多条）
      const newTotal = Math.max(0, commentTotal - (comments.length - updated.length));
      setCommentTotal(newTotal);
      onCommentChange?.(postId, newTotal);
      events.emit('post:comment', { postId, commentCount: newTotal });
      showToast('评论已删除');
    } catch (err) {
      showToast(getApiErrorMessage(err, '删除评论失败，请重试'));
    }
    setDeleteTargetId(null);
  };

  const handleCommentLike = async (commentId: number) => {
    if (!user) {
      openLoginPrompt();
      return;
    }
    const comment = comments.find((c) => c.id === commentId);
    if (!comment) return;

    const wasLiked = !!comment.liked;
    const prevCount = comment.like_count;

    setComments((prev) =>
      prev.map((c) =>
        c.id === commentId
          ? { ...c, liked: wasLiked ? 0 : 1, like_count: wasLiked ? prevCount - 1 : prevCount + 1 }
          : c
      )
    );

    try {
      if (wasLiked) {
        await postsApi.unlikeComment(commentId);
      } else {
        await postsApi.likeComment(commentId);
      }
    } catch {
      setComments((prev) =>
        prev.map((c) => (c.id === commentId ? { ...c, liked: wasLiked ? 1 : 0, like_count: prevCount } : c))
      );
      showToast('操作失败，请重试');
    }
  };

  const handleFollow = async () => {
    if (!requireLogin()) return;
    if (!post) return;
    try {
      if (isFollowing) {
        await unfollow(post.user_id);
        setIsFollowing(false);
        showToast('o(TヘTo)取消关注成功！');
      } else {
        await follow(post.user_id);
        setIsFollowing(true);
        showToast('ヾ(≧▽≦*)o关注成功！');
      }
    } catch {
      showToast('操作失败');
    }
  };

  const handleShare = async () => {
    if (!user) {
      openLoginPrompt();
      return;
    }
    const url = `${window.location.origin}/post/${postId}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setShowTooltip(true);
    setTimeout(() => setShowTooltip(false), 1500);
    if (!alreadyShared && user) {
      try {
        const res = await postsApi.sharePost(postId);
        setShareCount(res.share_count);
        setAlreadyShared(true);
      } catch {}
    }
  };

  const handleNavigate = (path: string) => {
    // 提取 /profile/:id 中的 userId
    const match = path.match(/\/profile\/(\d+)/);
    if (match) {
      setProfileUserId(parseInt(match[1]!));
    }
  };

  const toggleReplies = (commentId: number) => {
    setCollapsedReplies((prev) => {
      const next = new Set(prev);
      if (next.has(commentId)) {
        next.delete(commentId);
      } else {
        next.add(commentId);
      }
      return next;
    });
  };

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

  const images = (() => {
    if (post.images && post.images.length > 0) return post.images;
    try {
      const parsed = JSON.parse(post.image_url);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {}
    return [post.image_url];
  })();

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
                    const cleanImages = post.video_url
                      ? []
                      : post.images?.filter((u) => u !== '[]' && u !== '["[]"]') ||
                        [post.image_url].filter((u) => u !== '[]' && u !== '["[]"]');
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

          <div className={styles.comments}>
            {post.description && (
              <div className={styles.comment}>
                {post.avatar ? (
                  <img src={resolveMediaUrl(post.avatar) || ''} alt="" className={styles.commentAvatar} />
                ) : (
                  <div className={styles.commentAvatarPlaceholder}>
                    {post.username.charAt(0).toUpperCase()}
                  </div>
                )}
                <div>
                  <div className={styles.commentContent}>
                    <span className={styles.commentUsername}>{post.username}</span>
                    <TaggedText text={post.description} />
                  </div>
                </div>
              </div>
            )}
            {(() => {
              return buildVisibleComments(comments, collapsedReplies).map((item) => {
                if (!item) return null;
                const { comment, isReply, isCollapsed, hasReplies, replyCount } = item;
                const activeHighlighted = activeHighlightId === comment.id;

                return (
                  <CommentItem
                    key={comment.id}
                    comment={comment}
                    isReply={isReply}
                    isCollapsed={isCollapsed}
                    hasReplies={hasReplies}
                    replyCount={replyCount}
                    activeHighlighted={activeHighlighted}
                    currentUserId={user?.id}
                    innerRef={activeHighlighted ? highlightRef : undefined}
                    onProfileClick={(id) => handleNavigate(`/profile/${id}`)}
                    onReply={(c) => {
                      if (!user) {
                        openLoginPrompt();
                        return;
                      }
                      setReplyingTo({ id: c.id, username: c.username });
                      commentInputRef.current?.focus();
                    }}
                    onToggleReplies={toggleReplies}
                    onLike={handleCommentLike}
                    onDelete={handleDeleteComment}
                  />
                );
              });
            })()}
            {commentHasMore && (
              <button
                className={styles.commentsLoadMore}
                onClick={loadMoreComments}
                disabled={commentsLoadingMore}
              >
                {commentsLoadingMore
                  ? '加载中…'
                  : `加载更多评论（已加载 ${comments.length}/${commentTotal}）`}
              </button>
            )}
            <div ref={commentsEndRef} />
          </div>

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
