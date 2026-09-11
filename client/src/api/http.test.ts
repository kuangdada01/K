/**
 * ============================================================
 * API 客户端拦截器测试（api/http —— 滑动续期的读取端）
 * ============================================================
 * 客户端与服务端之间靠**响应头名**约定：服务端 middleware/auth.ts 下发
 * `X-Refreshed-Token`，这里必须读同一个名字（axios 会把响应头键名小写化）。
 * 名字写错不会有任何报错，只会静默失去续期能力 —— 所以拿测试钉住。
 *
 * 覆盖:
 * - 响应带续期头 → 落盘为本地 k_token
 * - 响应不带该头 → 不动本地 token
 * - 401 仍按原逻辑清 token 并派发 auth:expired（旧行为不被续期改动破坏）
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AxiosError } from 'axios';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import api from './http';

/**
 * 用自定义 adapter 直接产出响应，绕开真实网络（拦截器链照常执行）。
 * 非 2xx 必须像 axios 内置 adapter 那样 **reject**（内置 adapter 里的 settle() 负责这件事；
 * 自定义 adapter 若直接 resolve 一个 401，错误拦截器根本不会跑）。
 */
function respondWith(headers: Record<string, string>, status = 200) {
  api.defaults.adapter = async (config: AxiosRequestConfig) => {
    const response: AxiosResponse = {
      data: { ok: true },
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      headers,
      config: config as never,
    };
    if (status >= 200 && status < 300) return response;
    throw new AxiosError('Request failed', 'ERR_BAD_REQUEST', config as never, null, response);
  };
}

/** 造一张形如真实 JWT 的 token（只需 payload 可解析出 iat） */
function makeToken(iat: number): string {
  const enc = (obj: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ id: 1, iat })}.sig`;
}

let originalAdapter: typeof api.defaults.adapter;

beforeEach(() => {
  localStorage.clear();
  originalAdapter = api.defaults.adapter;
});

afterEach(() => {
  // 还原初始值（初始为 undefined；exactOptionalPropertyTypes 下经由 defaults 写入）
  (api.defaults as { adapter?: unknown }).adapter = originalAdapter;
  vi.restoreAllMocks();
});

describe('响应拦截器：滑动续期', () => {
  it('★ 响应带 X-Refreshed-Token 时落盘为新 token', async () => {
    localStorage.setItem('k_token', makeToken(1788883037));
    const refreshed = makeToken(1788889000);
    respondWith({ 'x-refreshed-token': refreshed });

    await api.get('/auth/me');

    expect(localStorage.getItem('k_token')).toBe(refreshed);
  });

  it('响应不带该头时不动本地 token', async () => {
    const current = makeToken(1788883037);
    localStorage.setItem('k_token', current);
    respondWith({ 'content-type': 'application/json' });

    await api.get('/auth/me');

    expect(localStorage.getItem('k_token')).toBe(current);
  });

  it('下发的 token 比本地更旧时不覆盖（乱序响应）', async () => {
    const newer = makeToken(1788889000);
    localStorage.setItem('k_token', newer);
    respondWith({ 'x-refreshed-token': makeToken(1788883037) });

    await api.get('/auth/me');

    expect(localStorage.getItem('k_token')).toBe(newer);
  });

  it('401 仍清 token 并派发 auth:expired（续期改动不破坏原行为）', async () => {
    localStorage.setItem('k_token', makeToken(1788883037));
    const expired = vi.fn();
    window.addEventListener('auth:expired', expired);
    respondWith({}, 401);

    await expect(api.get('/auth/me')).rejects.toBeTruthy();

    expect(localStorage.getItem('k_token')).toBeNull();
    expect(expired).toHaveBeenCalledTimes(1);
    window.removeEventListener('auth:expired', expired);
  });
});
