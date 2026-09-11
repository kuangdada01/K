/**
 * ============================================================
 * 幂等读请求重试（api/retry + api/http 接线）
 * ============================================================
 * 覆盖（每一条对应 retry.ts 顶部写下的边界）:
 * - GET 遇到「连不上」→ 重放一次后成功
 * - GET 遇到 503 → 重放一次
 * - POST 不重放（写操作不幂等）
 * - 404 / 401 不重放
 * - 超时（ECONNABORTED）不重放
 * - 已取消的请求不重放
 * - `kRetry: false`（后台轮询）不重放
 * - 只重放一次（第二次仍失败就放弃）
 * - 等待期间被取消 → 不再补发
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AxiosError } from 'axios';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import api from './http';
import { shouldRetryRequest, delayBeforeRetry, RETRY_DELAY_MS } from './retry';
import type { RetryableConfig } from './retry';

let originalAdapter: typeof api.defaults.adapter;

/**
 * 造一个「前 N 次失败、之后成功」的 adapter，并记录调用次数。
 * `makeError` 必须收到 **adapter 拿到的真实 config** —— 真实 axios adapter
 * 就是这样把 config 塞进 AxiosError 的，而重试计数与 `kRetry` 都挂在它上面。
 */
function flakyAdapter(failures: number, makeError: (config: AxiosRequestConfig) => unknown) {
  let calls = 0;
  api.defaults.adapter = async (config: AxiosRequestConfig) => {
    calls += 1;
    if (calls <= failures) throw makeError(config);
    const response: AxiosResponse = {
      data: { ok: true },
      status: 200,
      statusText: 'OK',
      headers: {},
      config: config as never,
    };
    return response;
  };
  return () => calls;
}

function networkError(config: AxiosRequestConfig): AxiosError {
  return new AxiosError('Network Error', 'ERR_NETWORK', config as never, null);
}

function statusError(config: AxiosRequestConfig, status: number): AxiosError {
  const response: AxiosResponse = {
    data: { error: 'x' },
    status,
    statusText: 'Error',
    headers: {},
    config: config as never,
  };
  return new AxiosError('Request failed', 'ERR_BAD_RESPONSE', config as never, null, response);
}

beforeEach(() => {
  localStorage.clear();
  originalAdapter = api.defaults.adapter;
});

afterEach(() => {
  (api.defaults as { adapter?: unknown }).adapter = originalAdapter;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('shouldRetryRequest 策略', () => {
  const get = { method: 'get' } as RetryableConfig;
  const post = { method: 'post' } as RetryableConfig;

  it('GET + 无响应（ERR_NETWORK）→ 重试', () => {
    expect(shouldRetryRequest(new AxiosError('x', 'ERR_NETWORK'), get)).toBe(true);
  });

  it('GET + 502/503/504 → 重试；其他状态码不重试', () => {
    for (const status of [502, 503, 504]) {
      expect(shouldRetryRequest(statusError({ method: 'get' }, status), get)).toBe(true);
    }
    for (const status of [400, 401, 403, 404, 422, 500]) {
      expect(shouldRetryRequest(statusError({ method: 'get' }, status), get)).toBe(false);
    }
  });

  it('写操作（POST）永不重试，哪怕是无响应', () => {
    expect(shouldRetryRequest(new AxiosError('x', 'ERR_NETWORK'), post)).toBe(false);
  });

  it('超时 / 取消不重试', () => {
    expect(shouldRetryRequest(new AxiosError('t', 'ECONNABORTED'), get)).toBe(false);
    expect(shouldRetryRequest(new AxiosError('t', 'ETIMEDOUT'), get)).toBe(false);
    expect(shouldRetryRequest(new AxiosError('c', 'ERR_CANCELED'), get)).toBe(false);
  });

  it('已取消的信号 / kRetry:false / 已重试过 → 不重试', () => {
    expect(
      shouldRetryRequest(new AxiosError('x', 'ERR_NETWORK'), { ...get, signal: { aborted: true } as never })
    ).toBe(false);
    expect(shouldRetryRequest(new AxiosError('x', 'ERR_NETWORK'), { ...get, kRetry: false })).toBe(false);
    expect(
      shouldRetryRequest(new AxiosError('x', 'ERR_NETWORK'), { ...get, __kRetryCount: 1 } as RetryableConfig)
    ).toBe(false);
  });

  it('非 AxiosError（拦截器里抛出的普通错误）不重试', () => {
    expect(shouldRetryRequest(new Error('boom'), get)).toBe(false);
  });
});

describe('接线后的实际行为', () => {
  it('★ GET 连不上一次后重放并成功（用户看不到失败）', async () => {
    vi.useFakeTimers();
    const calls = flakyAdapter(1, (config) => networkError(config));

    const pending = api.get('/posts');
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    const res = await pending;

    expect(res.status).toBe(200);
    expect(calls()).toBe(2);
  });

  it('★ GET 遇到 503 会重放', async () => {
    vi.useFakeTimers();
    const calls = flakyAdapter(1, (config) => statusError(config, 503));

    const pending = api.get('/posts');
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    await pending;

    expect(calls()).toBe(2);
  });

  it('★ 只重放一次：两次都失败就直接 reject', async () => {
    vi.useFakeTimers();
    const calls = flakyAdapter(Number.MAX_SAFE_INTEGER, (config) => networkError(config));

    const pending = api.get('/posts').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS * 4);
    const err = await pending;

    expect(err).toBeInstanceOf(AxiosError);
    expect(calls()).toBe(2);
  });

  it('写操作失败不会被重放', async () => {
    vi.useFakeTimers();
    const calls = flakyAdapter(Number.MAX_SAFE_INTEGER, (config) => networkError(config));

    const pending = api.post('/posts', { content: 'x' }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS * 4);
    await pending;

    expect(calls()).toBe(1);
  });

  it('404 不会被重放', async () => {
    vi.useFakeTimers();
    const calls = flakyAdapter(Number.MAX_SAFE_INTEGER, (config) => statusError(config, 404));

    const pending = api.get('/posts/999').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS * 4);
    await pending;

    expect(calls()).toBe(1);
  });

  it('kRetry:false 的后台轮询不会被重放', async () => {
    vi.useFakeTimers();
    const calls = flakyAdapter(Number.MAX_SAFE_INTEGER, (config) => networkError(config));

    const pending = api.get('/notifications', { kRetry: false }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS * 4);
    await pending;

    expect(calls()).toBe(1);
  });

  it('★ 等待期间被取消 → 不再补发请求', async () => {
    vi.useFakeTimers();
    const calls = flakyAdapter(1, (config) => networkError(config));
    const controller = new AbortController();

    const pending = api.get('/posts', { signal: controller.signal }).catch((e: unknown) => e);
    // 让第一次请求真的发出去并失败（此时才进入 400ms 重试等待）
    await vi.advanceTimersByTimeAsync(0);
    expect(calls()).toBe(1);

    controller.abort();
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS * 4);
    await pending;

    expect(calls()).toBe(1);
  });

  it('delayBeforeRetry：信号在等待中触发时立即结束（不等满 400ms）', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const started = Date.now();
    const p = delayBeforeRetry({ signal: controller.signal } as unknown as RetryableConfig, 10_000);
    controller.abort();
    await p;
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
