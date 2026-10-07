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

import axios, { isAxiosError } from 'axios';
import type { AxiosRequestConfig, InternalAxiosRequestConfig } from 'axios';
import { getApiBaseUrl } from '../config';
import { showToast } from '../components/ui/Toast';
import { queryClient } from '../state/queryClient';
import { clearInteractionCaches } from '../state/cache';
import { storeRefreshedToken } from '../lib/token';
import { currentSessionEpoch } from '../lib/sessionEpoch';
import { delayBeforeRetry, markRetried, shouldRetryRequest } from './retry';

/** 滑动续期的响应头名（axios 会把响应头键名小写化） */
const REFRESHED_TOKEN_HEADER = 'x-refreshed-token';

const api = axios.create({
  baseURL: getApiBaseUrl(),
  timeout: 15000,
});

/**
 * 请求 → 发出时的会话代次（P1-3.1）。
 * 用 WeakMap 挂在 config 上而不是塞自定义字段：axios 的 config 类型对外封闭，
 * WeakMap 不侵入对象结构、随 config 一起被回收；重试路径 `api.request(config)`
 * 复用同一 config 对象，代次随请求延续。
 */
const requestEpochs = new WeakMap<AxiosRequestConfig, number>();

/** 该响应所属的会话是否仍是当前会话（登出/换号后的迟到响应 → false） */
function isSameSession(config: unknown): boolean {
  const epochAtSend = requestEpochs.get(config as AxiosRequestConfig);
  // 没打标的请求（如非拦截器路径构造的）按同会话处理，保持旧行为
  return epochAtSend === undefined || epochAtSend === currentSessionEpoch();
}

/**
 * 请求拦截器
 * 从 localStorage 读取 token，自动添加到请求头 Authorization
 * Token 存储键名: 'k_token'
 */
api.interceptors.request.use((config) => {
  requestEpochs.set(config, currentSessionEpoch());
  const token = localStorage.getItem('k_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

/**
 * 响应拦截器
 *
 * 成功路径：滑动续期 —— 服务端在 token 签发超过阈值时，用响应头回一张新 token
 * （见 server/src/lib/jwt.ts 的 shouldRefreshToken）。这里落盘，
 * 于是一直在用的用户不会在 7 天到点时被登出；彻底沉默的会话仍按原样过期。
 * **只有当前会话的响应才允许写 token**：A 会话的迟到续期在登出/换号后到达时
 * 直接丢弃，不能把已清空的凭证写回来（正常续期不换代会话，不受影响）。
 *
 * 失败路径，处理 401 未授权错误（同样先校验代次 —— B 登录后 A 的过期 401
 * 不得清掉 B 的 token 与缓存）：
 * - 同代会次且之前存在 token（说明 token 过期）：清 token、清跨账号缓存、
 *   派发 auth:expired 事件通知 AuthContext
 * - 同代会次且之前无 token（未登录用户的预期 401）：静默 reject
 * - 跨代次的迟到 401：什么都不动，只把错误交给调用方
 *
 * 失败路径末尾：幂等读请求（GET/HEAD）按 `api/retry.ts` 的策略**最多重放一次**
 * （只针对「连不上」与 502/503/504；写操作、超时、已取消、后台轮询都不重试）。
 */
api.interceptors.response.use(
  (response) => {
    // 服务端下发的续期 token（无该头时是 undefined → 内部直接返回 false）
    if (isSameSession(response.config)) {
      storeRefreshedToken(response.headers[REFRESHED_TOKEN_HEADER]);
    }
    return response;
  },
  (error) => {
    // 封禁提示：服务端 403 且带 banned 标记时统一弹提示（各页面 catch 大多静默）
    if (error.response?.status === 403 && error.response?.data?.banned) {
      showToast(error.response.data.error || '账号已被封禁，封禁期间仅可浏览');
    }
    if (error.response?.status === 401 && isSameSession(error.config)) {
      const hadToken = !!localStorage.getItem('k_token');
      localStorage.removeItem('k_token');
      if (hadToken) {
        // B5 修复：登录失效即清空跨账号残留缓存（信息流 + 点赞/关注/收藏/转发）
        queryClient.removeQueries();
        clearInteractionCaches();
        window.dispatchEvent(new CustomEvent('auth:expired'));
      }
    }

    const config = error?.config as InternalAxiosRequestConfig | undefined;
    if (shouldRetryRequest(error, config) && config) {
      markRetried(config);
      return delayBeforeRetry(config).then(() => {
        // 等待期间被取消（组件卸载 / RQ 取消）→ 不再补发
        if (config.signal?.aborted) return Promise.reject(error);
        return api.request(config);
      });
    }

    return Promise.reject(error);
  }
);

/**
 * 原生 fetch 上传路径抛出的错误：与 Axios 错误结构兼容（response.data.error），
 * 让调用方能用统一的 getApiErrorMessage 提取文案
 */
export class ApiError extends Error {
  response: { data: { error?: string }; status?: number };

  constructor(message: string, response: { data: { error?: string }; status?: number }) {
    super(message);
    this.response = response;
  }
}

/** 从任意抛出值提取可展示的错误文案（Axios/ApiError 优先取服务端 error 字段） */
export function getApiErrorMessage(err: unknown, fallback: string): string {
  if (isAxiosError(err)) {
    const data = err.response?.data as { error?: string } | undefined;
    return data?.error || fallback;
  }
  if (err instanceof ApiError) return err.response.data.error || fallback;
  return err instanceof Error ? err.message : fallback;
}

export default api;
