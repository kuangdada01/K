/**
 * ============================================================
 * 用户主页资料加载 Hook（useProfileData）
 * ============================================================
 * 自 client/src/components/profile/Profile.tsx 拆出（纯搬移，行为不变）。
 *
 * 拥有资料相关的全部 state，并在依赖变化时并行拉取用户资料与帖子：
 * - cancelled 守卫：快速切换 userId 时丢弃慢到的旧响应，避免旧用户资料覆盖新页面
 * - 非本人主页：关注状态优先读关注缓存，未命中再请求 /friends/status/:id
 *   并回填缓存（setFollowStatus）
 * - 失败仅提示一次"加载失败"（cancelled 后不再提示）
 *
 * 注意：
 * - userId / isOwnProfile 的 embeddedUserId 优先判定保留在 Profile 组件内，
 *   本 hook 只接收计算好的 userId，判定语义不变
 * - 依赖数组与 Profile 原版完全一致：
 *   [userId, currentUser, getFollowStatus, setFollowStatus]
 *   （头像上传后 updateUser 更新 currentUser → 仍按原语义触发重取，未做调整）
 * ============================================================
 */

import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import api from '../api/http';
import { showToast } from '../components/ui/Toast';
import type { Post, User } from '../types';

export interface UseProfileDataOptions {
  /** 目标用户 ID（Profile 内已按 embeddedUserId 优先判定；undefined=未就绪不加载） */
  userId: number | undefined;
  /** 当前登录用户（AuthContext.user） */
  currentUser: User | null;
  /** 关注缓存读取（useFollow().getFollowStatus） */
  getFollowStatus: (userId: number) => boolean | undefined;
  /** 关注缓存写入（useFollow().setFollowStatus） */
  setFollowStatus: (userId: number, isFollowing: boolean) => void;
}

export interface UseProfileDataResult {
  profileUser: User | null;
  setProfileUser: Dispatch<SetStateAction<User | null>>;
  posts: Post[];
  setPosts: Dispatch<SetStateAction<Post[]>>;
  username: string;
  setUsername: Dispatch<SetStateAction<string>>;
  bio: string;
  setBio: Dispatch<SetStateAction<string>>;
  followersCount: number;
  setFollowersCount: Dispatch<SetStateAction<number>>;
  followingCount: number;
  setFollowingCount: Dispatch<SetStateAction<number>>;
  isFollowing: boolean;
  setIsFollowing: Dispatch<SetStateAction<boolean>>;
}

export function useProfileData({
  userId,
  currentUser,
  getFollowStatus,
  setFollowStatus,
}: UseProfileDataOptions): UseProfileDataResult {
  const [profileUser, setProfileUser] = useState<User | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [username, setUsername] = useState('');
  const [bio, setBio] = useState('');
  const [isFollowing, setIsFollowing] = useState(false);
  const [followersCount, setFollowersCount] = useState(0);
  const [followingCount, setFollowingCount] = useState(0);

  useEffect(() => {
    if (!userId) return;
    // 取消标志：快速切换 userId 时丢弃慢到的旧响应，避免旧用户资料覆盖新页面
    let cancelled = false;
    const loadProfile = async () => {
      try {
        const [userRes, postsRes] = await Promise.all([
          api.get(`/users/${userId}`),
          api.get(`/users/${userId}/posts`),
        ]);
        if (cancelled) return;
        setProfileUser(userRes.data);
        setPosts(postsRes.data.posts);
        setUsername(userRes.data.username);
        setBio(userRes.data.bio || '');
        setFollowersCount(userRes.data.followers_count || 0);
        setFollowingCount(userRes.data.following_count || 0);

        // Load follow status if not own profile
        if (currentUser && userId !== currentUser.id) {
          const cached = getFollowStatus(userId);
          if (cached !== undefined) {
            setIsFollowing(cached);
          } else {
            const statusRes = await api.get(`/friends/status/${userId}`);
            if (cancelled) return;
            setIsFollowing(statusRes.data.is_following);
            setFollowStatus(userId, statusRes.data.is_following);
          }
        }
      } catch {
        if (!cancelled) showToast('加载失败');
      }
    };
    loadProfile();
    return () => {
      cancelled = true;
    };
  }, [userId, currentUser, getFollowStatus, setFollowStatus]);

  return {
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
    setFollowingCount,
    isFollowing,
    setIsFollowing,
  };
}
