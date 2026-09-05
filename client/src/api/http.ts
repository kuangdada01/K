/**
 * ============================================================
 * K API 客户端配置
 * ============================================================
 * 基于 Axios 的 HTTP 客户端实例
 *
 * 功能:
 * 1. 统一 baseURL 配置（/api，由 Vite 代理转发到后端）
 * 2. 请求拦截器: 自动附加 JWT Token 到请求头
 * 3. 响应拦截器: 401 错误自动清除 token 并跳转登录页
 * ============================================================
 */

import axios from 'axios';
import { getApiBaseUrl } from '../config';
import { showToast } from '../components/ui/Toast';
import { queryClient } from '../state/queryClient';
import { clearInteractionCaches } from '../state/cache';

const api = axios.create({
  baseURL: getApiBaseUrl(),
  timeout: 15000,
});

/**
 * 请求拦截器
 * 从 localStorage 读取 token，自动添加到请求头 Authorization
 * Token 存储键名: 'k_token'
 */
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('k_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

/**
 * 响应拦截器
 * 处理 401 未授权错误:
 * - 清除本地 token
 * - 如果之前存在 token（说明 token 过期），派发 auth:expired 事件通知 AuthContext
 * - 如果之前无 token（未登录用户的预期 401），静默 reject
 */
api.interceptors.response.use(
  (response) => response,
  (error) => {
    // 封禁提示：服务端 403 且带 banned 标记时统一弹提示（各页面 catch 大多静默）
    if (error.response?.status === 403 && error.response?.data?.banned) {
      showToast(error.response.data.error || '账号已被封禁，封禁期间仅可浏览');
    }
    if (error.response?.status === 401) {
      const hadToken = !!localStorage.getItem('k_token');
      localStorage.removeItem('k_token');
      if (hadToken) {
        // B5 修复：登录失效即清空跨账号残留缓存（信息流 + 点赞/关注/收藏/转发）
        queryClient.removeQueries();
        clearInteractionCaches();
        window.dispatchEvent(new CustomEvent('auth:expired'));
      }
    }
    return Promise.reject(error);
  }
);

export default api;
