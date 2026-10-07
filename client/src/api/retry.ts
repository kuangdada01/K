/**
 * ============================================================
 * 幂等读请求的单次重试（4.5）
 * ============================================================
 * 方案里这一条写的是「Axios 全局 retry」。真的做成「全局」是错的，
 * 这里把边界写清楚（每条都有具体理由，不是凭手感）：
 *
 * 1. **只重试 GET/HEAD**。`POST /posts`、`POST /messages`、`POST /voice/rooms`
 *    重放会重复发帖 / 重复私信 / 多开房间 —— 写操作不幂等，收益远小于代价。
 * 2. **只重试「连不上」与网关类 5xx**。4xx 重放还是同样的 4xx（401/403/404/422）；
 *    502/503/504 才是部署/重启期间反向代理的真实形态，值得再问一次。
 * 3. **超时不重试**。`timeout` 已经让用户等了 15s，再等一个 15s 不如直接看到失败
 *    （可以手动刷新）。这与第 12 章「不要自己制造重试风暴」是同一种克制。
 * 4. **被取消的请求不重试**。组件卸载 / React Query 取消之后再补发一次请求，
 *    会让「取消」这个语义失效。
 * 5. **只重试 1 次、延迟 400ms**。收益（弱网抖动、发布抖动）与代价（最坏多等 0.4s）
 *    在这个量级上是对称的；延迟而不是立即重放，避免与对端的瞬时过载叠加。
 * 6. **后台轮询显式关闭**（`kRetry: false`）：共享收件箱（10s/30s）、私信轮询（5s）、
 *    公告（30s）下一个 tick 自然会再问一次，重试只会把故障期间的无用请求量翻倍。
 *
 * 与 React Query 的关系：`queryClient` 的 `retry: false` 保持不变（见该文件注释）。
 * 两层重试会相乘（拦截器重试对 RQ 是透明的），所以这里只加一层、且只在拦截器层。
 */

import { AxiosError } from 'axios';
import type { InternalAxiosRequestConfig } from 'axios';

declare module 'axios' {
  export interface AxiosRequestConfig {
    /** 覆盖默认重试策略：false = 该请求不重试（后台轮询用） */
    kRetry?: boolean;
  }
}

/** 每个请求最多重放次数 */
export const RETRY_LIMIT = 1;
/** 重放前的等待（弱网下给对端一点喘息，也不至于让用户觉得卡住） */
export const RETRY_DELAY_MS = 400;

const IDEMPOTENT_METHODS = new Set(['get', 'head']);
/** 部署/重启期间由反向代理产生、值得再问一次的状态码 */
const RETRYABLE_GATEWAY_STATUS = new Set([502, 503, 504]);
/** 「连不上」类错误码（axios 在浏览器里主要是 ERR_NETWORK，其余见于 Node/Capacitor） */
const NETWORK_ERROR_CODES = new Set([
  'ERR_NETWORK',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);
/** 取消与超时：明确不重试 */
const NON_RETRYABLE_CODES = new Set(['ERR_CANCELED', 'ETIMEDOUT', 'ECONNABORTED']);

/** 带重试计数的请求配置（挂在 config 上随请求走，不进 URL/日志） */
export interface RetryableConfig extends InternalAxiosRequestConfig {
  __kRetryCount?: number;
}

/** 该失败请求是否值得重放一次 */
export function shouldRetryRequest(error: unknown, config: InternalAxiosRequestConfig | undefined): boolean {
  if (!config) return false;
  if (config.kRetry === false) return false;
  if ((config as RetryableConfig).__kRetryCount ?? 0) return false; // 已达上限
  const method = (config.method ?? 'get').toLowerCase();
  if (!IDEMPOTENT_METHODS.has(method)) return false;
  if (config.signal?.aborted) return false;
  if (!(error instanceof AxiosError)) return false;
  if (error.code && NON_RETRYABLE_CODES.has(error.code)) return false;
  if (error.response) return RETRYABLE_GATEWAY_STATUS.has(error.response.status);
  return !!error.code && NETWORK_ERROR_CODES.has(error.code);
}

/** 把请求标记为「已重放过一次」 */
export function markRetried(config: InternalAxiosRequestConfig): void {
  const retryable = config as RetryableConfig;
  retryable.__kRetryCount = (retryable.__kRetryCount ?? 0) + 1;
}

/**
 * 重放前的等待；请求在这期间被取消则立即结束（不白白占着计时器）。
 * 取消后是否真的不再重放由调用方再判断一次（`signal.aborted`）。
 */
export function delayBeforeRetry(
  config: InternalAxiosRequestConfig,
  delayMs: number = RETRY_DELAY_MS
): Promise<void> {
  return new Promise((resolve) => {
    const signal = config.signal;
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal?.addEventListener?.('abort', finish);
  });
}
