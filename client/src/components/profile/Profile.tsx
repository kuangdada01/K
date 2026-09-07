/**
 * ============================================================
 * 用户主页组件 (Profile)
 * ============================================================
 * 展示用户资料和帖子网格（状态编排层）
 *
 * 功能:
 * - 用户资料展示（头像、用户名、简介、统计数据）
 * - 头像上传（自己的主页）
 * - 资料编辑（用户名、简介）
 * - 帖子网格展示（9宫格布局）
 * - 私密文件夹管理（最多10张私密图片）
 * - 关注/取消关注、发消息按钮（他人主页）
 *
 * 结构: 数据/行为逻辑保留在本组件，
 * 视图拆分到 components/profile/（ProfileHeader/ProfilePostGrid/PrivateFolder）。
 * ============================================================
 */

import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { postsFeedKey, updatePostsFeed } from '../../hooks/usePostsFeed';
import api from '../../api/http';
import { getApiErrorMessage } from '../../api/http';
import { Post } from '../../types';
import { useAuth } from '../../context/AuthContext';
import { useFollow } from '../../state/cache';
import { useFollowUser } from '../../hooks/useFollowUser';
import { useEvent } from '../../context/EventContext';
import { events } from '../../state/events';
import { showToast } from '../ui/Toast';
import { useProfileData } from '../../hooks/useProfileData';
import { useProfileEventsSync } from '../../hooks/useProfileEventsSync';
import { usePrivateFolder } from '../../hooks/usePrivateFolder';
import ConfirmDialog from '../ui/ConfirmDialog';
import PostDetail from '../post/PostDetail';
import FollowersModal from './FollowersModal';
import ProfileHeader from './ProfileHeader';
import ProfilePostGrid from './ProfilePostGrid';
import PrivateFolder from './PrivateFolder';
import styles from './Profile.module.css';

interface ProfileProps {
  embeddedUserId?: number;
  onBack?: () => void;
}

export default function Profile({ embeddedUserId, onBack }: ProfileProps = {}) {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user: currentUser, updateUser } = useAuth();
  const { getFollowStatus, setFollowStatus } = useFollow();
  const { follow, unfollow } = useFollowUser();
  const { openEdit, setOnEditSave } = useEvent();
  const [editing, setEditing] = useState(false);
  const [selectedPostId, setSelectedPostId] = useState<number | null>(null);
  const [deletePostId, setDeletePostId] = useState<number | null>(null);
  const [showFollowModal, setShowFollowModal] = useState<'followers' | 'following' | null>(null);
  const [activeTab, setActiveTab] = useState<'posts' | 'bookmarks' | 'reposts'>('posts');
  const [bookmarkedPosts, setBookmarkedPosts] = useState<Post[]>([]);
  const [loadingBookmarks, setLoadingBookmarks] = useState(false);
  const [repostedPosts, setRepostedPosts] = useState<Post[]>([]);
  const [loadingReposts, setLoadingReposts] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isOwnProfile = !!(embeddedUserId
    ? currentUser && embeddedUserId === currentUser.id
    : !id || (currentUser && parseInt(id) === currentUser.id));
  const userId = embeddedUserId || (id ? parseInt(id) : currentUser?.id);

  // 资料加载：cancelled 守卫 + 非本人关注状态回填（自 useProfileData 拆出，行为不变）
  const {
    profileUser,
    setProfileUser,
    posts,
    setPosts,
    username,
    setUsername,
    bio,
    setBio,
    followersCount,
    setFollowersCount,
    followingCount,
    isFollowing,
    setIsFollowing,
  } = useProfileData({ userId, currentUser, getFollowStatus, setFollowStatus });

  // 帖子事件 → 三份本地列表 + 关注态实时同步（自 useProfileEventsSync 拆出，行为不变）
  useProfileEventsSync({
    userId,
    getFollowStatus,
    setPosts,
    setBookmarkedPosts,
    setRepostedPosts,
    setIsFollowing,
  });

  // 切到收藏/转发标签时进入加载态（渲染期 prev 值模式，替代 effect 内同步 setState）
  const [prevActiveTab, setPrevActiveTab] = useState(activeTab);
  if (activeTab !== prevActiveTab) {
    setPrevActiveTab(activeTab);
    if (activeTab === 'bookmarks' && isOwnProfile) setLoadingBookmarks(true);
    if (activeTab === 'reposts' && isOwnProfile) setLoadingReposts(true);
  }

  // 加载收藏帖子
  useEffect(() => {
    if (activeTab !== 'bookmarks' || !isOwnProfile) return;
    api
      .get('/posts/bookmarks/me')
      .then((res) => {
        setBookmarkedPosts(res.data.posts);
      })
      .catch(() => {
        showToast('加载收藏失败');
      })
      .finally(() => {
        setLoadingBookmarks(false);
      });
  }, [activeTab, isOwnProfile]);

  // 加载转发帖子
  useEffect(() => {
    if (activeTab !== 'reposts' || !isOwnProfile) return;
    api
      .get('/posts/reposts/me')
      .then((res) => {
        setRepostedPosts(res.data.posts);
      })
      .catch(() => {
        showToast('加载转发失败');
      })
      .finally(() => {
        setLoadingReposts(false);
      });
  }, [activeTab, isOwnProfile]);

  // 嵌入模式下：管理帖子详情的历史栈
  useEffect(() => {
    if (!embeddedUserId || !selectedPostId) return;
    window.history.pushState({ profilePost: true }, '');
    const onPopState = () => setSelectedPostId(null);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [selectedPostId, embeddedUserId]);

  const handleFollow = async () => {
    if (!profileUser) return;
    try {
      if (isFollowing) {
        const res = await unfollow(profileUser.id);
        setIsFollowing(false);
        setFollowersCount(res.followers_count);
        showToast('o(TヘTo)取消关注成功！');
      } else {
        const res = await follow(profileUser.id);
        setIsFollowing(true);
        setFollowersCount(res.followers_count);
        showToast('ヾ(≧▽≦*)o关注成功！');
      }
    } catch {
      showToast('操作失败，请重试');
    }
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // 检查头像大小 (10MB)
    const maxSize = 10 * 1024 * 1024;
    if (file.size > maxSize) {
      showToast('头像超过10MB限制');
      e.target.value = '';
      return;
    }

    const formData = new FormData();
    formData.append('avatar', file);

    try {
      const res = await api.post('/users/avatar', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setProfileUser((prev) => (prev ? { ...prev, avatar: res.data.avatar } : prev));
      updateUser(res.data);
    } catch {
      showToast('头像上传失败，请重试');
    }
  };

  const handleDeletePost = (postId: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeletePostId(postId);
  };

  const confirmDeletePost = async () => {
    if (deletePostId === null) return;
    const pid = deletePostId;
    try {
      await api.delete(`/posts/${pid}`);
      setPosts((prev) => prev.filter((p) => p.id !== pid));
      // 同步信息流缓存，回到首页立即生效（staleTime: Infinity 不会自动重取）
      updatePostsFeed(queryClient, (prev) => prev.filter((p) => p.id !== pid));
      queryClient.invalidateQueries({ queryKey: postsFeedKey });
      events.emit('post:deleted', pid);
      showToast('删除成功！');
    } catch {
      showToast('删除失败，请重试');
    }
    setDeletePostId(null);
  };

  const handleEditPost = (post: Post, e: React.MouseEvent) => {
    e.stopPropagation();
    // 视频帖子 withImages 会产出 ['[]'] 脏数据，需过滤；图文帖子才保留 images
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
    setOnEditSave(() => () => {
      // Refresh posts after edit
      if (userId) {
        api.get(`/users/${userId}/posts`).then((res) => {
          setPosts(res.data.posts);
        });
      }
    });
  };

  // 私密文件夹状态机（objectURL 生命周期 + 保存串行，自 usePrivateFolder 拆出，行为不变）
  const {
    showPrivateFolder,
    privateImages,
    privateNewFiles,
    privateDeletedIds,
    privateZoomIndex,
    setPrivateZoomIndex,
    privateFileInputRef,
    handleOpenPrivateFolder,
    handleAddPrivateImages,
    handleRemovePrivateNewFile,
    handleToggleDeletePrivate,
    handleSavePrivateFolder,
    handleCancelPrivateFolder,
    getAllPrivateImages,
  } = usePrivateFolder();

  const handleSaveProfile = async () => {
    try {
      const res = await api.put('/users/me', { username, bio });
      setProfileUser((prev) => (prev ? { ...prev, username: res.data.username, bio: res.data.bio } : prev));
      updateUser(res.data);
      setEditing(false);
    } catch (err) {
      alert(getApiErrorMessage(err, '保存失败'));
    }
  };

  if (!profileUser) return null;

  return (
    <div className={styles.container}>
      <ProfileHeader
        user={profileUser}
        isOwnProfile={isOwnProfile}
        isEmbedded={!!embeddedUserId}
        postsCount={posts.length}
        followersCount={followersCount}
        followingCount={followingCount}
        isFollowing={isFollowing}
        editing={editing}
        username={username}
        bio={bio}
        setUsername={setUsername}
        setBio={setBio}
        onBack={() => {
          if (onBack) onBack();
          else window.history.back();
        }}
        fileInputRef={fileInputRef}
        onAvatarUpload={handleAvatarUpload}
        onToggleEdit={() => setEditing(!editing)}
        onOpenPrivateFolder={handleOpenPrivateFolder}
        onFollow={handleFollow}
        onMessage={() => navigate(`/messages/${profileUser.id}`)}
        onSaveProfile={handleSaveProfile}
        onCancelEdit={() => setEditing(false)}
        onShowFollowers={() => setShowFollowModal('followers')}
        onShowFollowing={() => setShowFollowModal('following')}
      />

      <ProfilePostGrid
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        isOwnProfile={isOwnProfile}
        posts={posts}
        bookmarkedPosts={bookmarkedPosts}
        loadingBookmarks={loadingBookmarks}
        repostedPosts={repostedPosts}
        loadingReposts={loadingReposts}
        onPostClick={(postId) => setSelectedPostId(postId)}
        onEditPost={handleEditPost}
        onDeletePost={handleDeletePost}
      />

      {selectedPostId && (
        <PostDetail
          postId={selectedPostId}
          onClose={() => {
            setSelectedPostId(null);
          }}
        />
      )}

      {showPrivateFolder && (
        <PrivateFolder
          privateImages={privateImages}
          privateNewFiles={privateNewFiles}
          privateDeletedIds={privateDeletedIds}
          allImages={getAllPrivateImages()}
          privateZoomIndex={privateZoomIndex}
          setPrivateZoomIndex={setPrivateZoomIndex}
          privateFileInputRef={privateFileInputRef}
          onAddImages={handleAddPrivateImages}
          onToggleDelete={handleToggleDeletePrivate}
          onRemoveNew={handleRemovePrivateNewFile}
          onCancel={handleCancelPrivateFolder}
          onSave={handleSavePrivateFolder}
          onZoomClose={() => setPrivateZoomIndex(null)}
        />
      )}

      {deletePostId !== null && (
        <ConfirmDialog
          message="确定要删除这篇帖子吗？"
          onConfirm={confirmDeletePost}
          onCancel={() => setDeletePostId(null)}
        />
      )}

      {showFollowModal && userId && (
        <FollowersModal type={showFollowModal} userId={userId} onClose={() => setShowFollowModal(null)} />
      )}
    </div>
  );
}
