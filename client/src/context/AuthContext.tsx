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

import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import api from '../api/http';
import { queryClient } from '../state/queryClient';
import { clearInteractionCaches, seedFollowedUsers } from '../state/cache';
import { myFollowing } from '../api/friends';
import { User, AuthResponse } from '../types';

/** 认证上下文类型定义 */
interface AuthContextType {
  user: User | null;                                      // 当前用户信息（null=未登录）
  token: string | null;                                   // JWT token
  loading: boolean;                                       // 是否正在加载（验证token中）
  login: (email: string, password: string) => Promise<void>;    // 登录方法
  register: (username: string, email: string, password: string, code: string) => Promise<void>; // 注册方法
  logout: () => void;                                     // 登出方法
  updateUser: (user: User) => void;                       // 更新用户信息（如修改资料后）
  showLoginPrompt: boolean;                               // 是否显示登录提示弹窗
  openLoginPrompt: () => void;                            // 打开登录提示弹窗
  closeLoginPrompt: () => void;                           // 关闭登录提示弹窗
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

  const openLoginPrompt = () => setShowLoginPrompt(true);
  const closeLoginPrompt = () => setShowLoginPrompt(false);

  /** 应用启动时验证 token */
  useEffect(() => {
    if (token) {
      api.get('/auth/me')
        .then(res => setUser(res.data))
        .catch(() => {
          // token 无效或已过期，清除本地存储
          localStorage.removeItem('k_token');
          setToken(null);
        })
        .finally(() => setLoading(false));
    }
  }, [token]);

  // P8 修复：登录后预取一次关注列表灌满缓存，PostCard 首屏 follow 状态全部内存命中，
  // 避免每条帖子各发一次 /friends/status/:id（首屏最多 20 个并发请求）。
  useEffect(() => {
    if (!user) return;
    // 仅当缓存里一条 follow 都没有时预取，避免每次 user 变化重复打
    const anyFollowCached = queryClient
      .getQueryCache()
      .getAll()
      .some(q => Array.isArray(q.queryKey) && q.queryKey[0] === 'cache' && q.queryKey[1] === 'follow');
    if (anyFollowCached) return;
    myFollowing().then(res => {
      if (Array.isArray(res.friends)) {
        seedFollowedUsers(res.friends.map(f => f.id));
      }
    }).catch(() => {});
  }, [user]);

  /** 监听 token 过期事件（由 api.ts 401 拦截器触发） */
  useEffect(() => {
    const handler = () => {
      // B5 修复：清空所有查询缓存与交互缓存，避免切换到新账号后残留上一个账号的数据
      queryClient.removeQueries();
      clearInteractionCaches();
      setUser(null);
      setToken(null);
    };
    window.addEventListener('auth:expired', handler);
    return () => window.removeEventListener('auth:expired', handler);
  }, []);

  /** 用户登录 */
  const login = async (email: string, password: string) => {
    const res = await api.post<AuthResponse>('/auth/login', { email, password });
    localStorage.setItem('k_token', res.data.token);
    setToken(res.data.token);
    setUser(res.data.user);
  };

  /** 用户注册 */
  const register = async (username: string, email: string, password: string, code: string) => {
    const res = await api.post<AuthResponse>('/auth/register', { username, email, password, code });
    localStorage.setItem('k_token', res.data.token);
    setToken(res.data.token);
    setUser(res.data.user);
  };

  /** 用户登出（清除本地状态 + 清空跨账号缓存，B5 修复） */
  const logout = () => {
    localStorage.removeItem('k_token');
    // 清空全部查询缓存与交互缓存，切换账号后不会残留上一个账号的信息流/点赞/关注状态
    queryClient.removeQueries();
    clearInteractionCaches();
    setToken(null);
    setUser(null);
  };

  /** 更新用户信息（用于修改资料后同步状态） */
  const updateUser = (updatedUser: User) => {
    setUser(updatedUser);
  };

  return (
    <AuthContext.Provider value={{ user, token, loading, login, register, logout, updateUser, showLoginPrompt, openLoginPrompt, closeLoginPrompt }}>
      {children}
    </AuthContext.Provider>
  );
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