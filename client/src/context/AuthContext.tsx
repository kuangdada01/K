/**
 * ============================================================
 * 认证上下文 (AuthContext)
 * ============================================================
 * 全局用户认证状态管理
 *
 * 功能:
 * 1. 管理用户登录状态（user, token）
 * 2. 提供登录/注册/登出方法
 * 3. 应用启动时自动验证 token 有效性
 * 4. Token 存储在 localStorage（键名: 'k_token'）
 *
 * 使用方式:
 * - 在 App.tsx 中用 <AuthProvider> 包裹应用
 * - 在组件中调用 useAuth() 获取认证状态和方法
 * ============================================================
 */

import { createContext, useContext, useState, useEffect, useMemo, useCallback, ReactNode } from 'react';
import { isAxiosError } from 'axios';
import api from '../api/http';
import { queryClient } from '../state/queryClient';
import { clearInteractionCaches, seedFollowedUsers } from '../state/cache';
import { myFollowing } from '../api/friends';
import { bumpSessionEpoch, currentSessionEpoch } from '../lib/sessionEpoch';
import { User, AuthResponse } from '../types';

/** 认证上下文类型定义 */
interface AuthContextType {
  user: User | null; // 当前用户信息（null=未登录）
  token: string | null; // JWT token
  loading: boolean; // 是否正在加载（验证token中）
  /**
   * 离线态：本地有 token 但 /auth/me 因**网络原因**失败（无响应/超时）。
   * 凭证保留、请求照常携带 —— 这不是“未登录”，UI 应给离线/重试提示
   * 而不是当成游客（P1-3.1：临时网络错误不再被当作退出处理）。
   */
  offline: boolean;
  login: (email: string, password: string) => Promise<void>; // 登录方法
  register: (username: string, email: string, password: string, code: string) => Promise<void>; // 注册方法
  logout: () => void; // 登出方法
  updateUser: (user: User) => void; // 更新用户信息（如修改资料后）
  retry: () => void; // 离线态下重试恢复会话（把 token 置回触发重新验证）
  showLoginPrompt: boolean; // 是否显示登录提示弹窗
  openLoginPrompt: () => void; // 打开登录提示弹窗
  closeLoginPrompt: () => void; // 关闭登录提示弹窗
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/**
 * 认证上下文提供者组件
 *
 * 生命周期:
 * 1. 初始化: 从 localStorage 读取 token
 * 2. 如果有 token: 请求 /api/auth/me 验证有效性
 * 3. 验证成功: 设置 user 状态
 * 4. 验证失败: 清除 token（登录统一走 LoginPrompt 弹窗）
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(localStorage.getItem('k_token'));
  // 初始加载态直接由 token 是否存在推导（有 token 才需要启动验证），
  // 避免 effect 中同步 setState（react-hooks/set-state-in-effect）
  const [loading, setLoading] = useState(() => !!localStorage.getItem('k_token'));
  const [showLoginPrompt, setShowLoginPrompt] = useState(false);
  const [offline, setOffline] = useState(false);
  /** 手动重试（离线态）：换个 token 引用触发下面的验证 effect 重跑 */
  const [retryTick, setRetryTick] = useState(0);

  /** 应用启动时验证 token */
  useEffect(() => {
    if (token) {
      // 捕获发出时的会话代次：A 的资料在登出/换号后才回来时，不允许再改身份
      const epochAtStart = currentSessionEpoch();
      api
        .get('/auth/me')
        .then((res) => {
          if (currentSessionEpoch() !== epochAtStart) return;
          setOffline(false);
          setUser(res.data);
        })
        .catch((err) => {
          if (currentSessionEpoch() !== epochAtStart) return;
          // 网络层失败（无响应/超时）≠ 凭证无效：保留 token、标记离线，
          // 恢复网络后 retry() 重新验证（P1-3.1：不再把临时网络错误当作退出）
          if (isAxiosError(err) && err.response == null) {
            setUser(null);
            setOffline(true);
            return;
          }
          // 服务端明确拒绝（401 等）：凭证确实无效，清掉
          localStorage.removeItem('k_token');
          setToken(null);
          setOffline(false);
        })
        .finally(() => setLoading(false));
    }
  }, [token, retryTick]);

  // P8 修复：登录后预取一次关注列表灌满缓存，PostCard 首屏 follow 状态全部内存命中，
  // 避免每条帖子各发一次 /friends/status/:id（首屏最多 20 个并发请求）。
  useEffect(() => {
    if (!user) return;
    // 仅当缓存里一条 follow 都没有时预取，避免每次 user 变化重复打
    const anyFollowCached = queryClient
      .getQueryCache()
      .getAll()
      .some((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'cache' && q.queryKey[1] === 'follow');
    if (anyFollowCached) return;
    myFollowing()
      .then((res) => {
        if (Array.isArray(res.friends)) {
          seedFollowedUsers(res.friends.map((f) => f.id));
        }
      })
      .catch(() => {});
  }, [user]);

  /** 监听 token 过期事件（由 api.ts 401 拦截器触发，拦截器已校验代次） */
  useEffect(() => {
    const handler = () => {
      // B5 修复：清空所有查询缓存与交互缓存，避免切换到新账号后残留上一个账号的数据
      queryClient.removeQueries();
      clearInteractionCaches();
      bumpSessionEpoch();
      setUser(null);
      setToken(null);
      setOffline(false);
    };
    window.addEventListener('auth:expired', handler);
    return () => window.removeEventListener('auth:expired', handler);
  }, []);

  /**
   * 用户登录
   * 全部动作都用 useCallback 固定引用：此前它们是每次渲染新建的函数，
   * 连带 provider value 也是新对象，于是 43 处 useAuth() 消费者在任何一次
   * provider 渲染（含启动时 loading true→false 那次）都会整树重渲染，
   * 并且会让下游 useCallback 依赖（如 useLikePost 的 toggle）持续失效。
   */
  const login = useCallback(async (email: string, password: string) => {
    const res = await api.post<AuthResponse>('/auth/login', { email, password });
    // 新会话：先递增代次（A 账号在途的续期/401/资料从此全部失效），再写新凭证
    bumpSessionEpoch();
    localStorage.setItem('k_token', res.data.token);
    setToken(res.data.token);
    setUser(res.data.user);
    setOffline(false);
  }, []);

  /** 用户注册 */
  const register = useCallback(async (username: string, email: string, password: string, code: string) => {
    const res = await api.post<AuthResponse>('/auth/register', { username, email, password, code });
    bumpSessionEpoch();
    localStorage.setItem('k_token', res.data.token);
    setToken(res.data.token);
    setUser(res.data.user);
    setOffline(false);
  }, []);

  /** 用户登出（递增会话代次 + 清除本地状态 + 清空跨账号缓存，B5 修复） */
  const logout = useCallback(() => {
    bumpSessionEpoch();
    localStorage.removeItem('k_token');
    // 清空全部查询缓存与交互缓存，切换账号后不会残留上一个账号的信息流/点赞/关注状态
    queryClient.removeQueries();
    clearInteractionCaches();
    setToken(null);
    setUser(null);
    setOffline(false);
  }, []);

  /** 离线态下手动重试恢复会话 */
  const retry = useCallback(() => {
    if (!localStorage.getItem('k_token')) return;
    setLoading(true);
    setRetryTick((n) => n + 1);
  }, []);

  /** 更新用户信息（用于修改资料后同步状态） */
  const updateUser = useCallback((updatedUser: User) => {
    setUser(updatedUser);
  }, []);

  const openLoginPrompt = useCallback(() => setShowLoginPrompt(true), []);
  const closeLoginPrompt = useCallback(() => setShowLoginPrompt(false), []);

  // value 必须 memo：否则对象字面量每次渲染都是新引用，useMemo/useCallback 下游全部失效
  const value = useMemo(
    () => ({
      user,
      token,
      loading,
      offline,
      login,
      register,
      logout,
      updateUser,
      retry,
      showLoginPrompt,
      openLoginPrompt,
      closeLoginPrompt,
    }),
    [
      user,
      token,
      loading,
      offline,
      login,
      register,
      logout,
      updateUser,
      retry,
      showLoginPrompt,
      openLoginPrompt,
      closeLoginPrompt,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * 认证上下文 Hook
 *
 * @returns 认证状态和方法
 * @throws 如果在 AuthProvider 外使用则抛出错误
 */
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
