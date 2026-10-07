/**
 * ============================================================
 * 原生桥协议单测（lib/native/bridge）
 * ============================================================
 * 这里是「网页 ↔ 原生」的唯一关节，两边都不在同一语言里，协议错了很难查
 * （页面只会表现为"某个功能静默失效"）。所以把契约钉死：
 * - 无桥（浏览器）→ isNative()=false，call 立即 reject（ERR_NO_BRIDGE）
 * - 版本不兼容 → isNative()=false
 * - 调用成功/失败/未实现方法 → 分别 resolve、错误码透传、ERR_UNSUPPORTED
 * - 超时 → ERR_TIMEOUT（不能让页面一直等）；`timeoutMs: 0` → 永不超时
 * - prefs / info 同步读
 * - 返回键裁决处理器能被原生读到（__KNative.onBackPressed）
 * - webReady 握手（缺该方法的老宿主也要安全）
 * ============================================================
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  call,
  isNative,
  notifyWebReady,
  on,
  prefsGet,
  prefsSet,
  setBackDecisionHandler,
  syncAppInfo,
} from './bridge';

type Responder = (callId: string, method: string, params: unknown) => void;

const recorded: Array<{ method: string; params: unknown }> = [];
let responder: Responder = (callId, method) => {
  window.__KNative?.resolve(callId, true, JSON.stringify({ ok: true, method }));
};
let bridgeVersion = 1;
let prefs: Record<string, string> = {};
let webReadyCalled = false;

/**
 * @param version 宿主协议版本（默认 1）
 * @param withWebReady 是否暴露 webReady() —— 老宿主没有这个方法，用于验证握手可安全跳过
 */
function installBridge(version = 1, withWebReady = false): void {
  bridgeVersion = version;
  (window as unknown as { KNative: unknown }).KNative = {
    ...(withWebReady
      ? {
          webReady: () => {
            webReadyCalled = true;
          },
        }
      : {}),
    version: () => bridgeVersion,
    info: () =>
      JSON.stringify({
        platform: 'android',
        versionName: '0.1.0',
        versionCode: 1,
        packageName: 'top.kuangdada.k',
        bridgeVersion: 1,
      }),
    prefsGet: (key: string) => prefs[key] ?? null,
    prefsSet: (key: string, value: string) => {
      prefs[key] = value;
    },
    cancel: () => {},
    invoke: (callId: string, method: string, paramsJson: string) => {
      const params = JSON.parse(paramsJson) as unknown;
      recorded.push({ method, params });
      responder(callId, method, params);
    },
  };
}

function removeBridge(): void {
  delete (window as unknown as { KNative?: unknown }).KNative;
}

beforeEach(() => {
  recorded.length = 0;
  prefs = {};
  webReadyCalled = false;
  responder = (callId, method) => {
    window.__KNative?.resolve(callId, true, JSON.stringify({ ok: true, method }));
  };
  installBridge();
});

afterEach(() => {
  removeBridge();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('能力探测', () => {
  it('桥存在且版本兼容 → true', () => {
    expect(isNative()).toBe(true);
  });

  it('无桥（浏览器）→ false', () => {
    removeBridge();
    expect(isNative()).toBe(false);
  });

  it('宿主协议版本过低 → false（宁可降级，也不要用不存在的接口）', () => {
    installBridge(0);
    expect(isNative()).toBe(false);
  });
});

describe('异步调用', () => {
  it('成功：resolve 出原生返回的 JSON，并把参数原样投递', async () => {
    const result = await call<{ ok: boolean; method: string }>('statusBar.setStyle', {
      mode: 'dark',
    });
    expect(result).toEqual({ ok: true, method: 'statusBar.setStyle' });
    expect(recorded).toEqual([{ method: 'statusBar.setStyle', params: { mode: 'dark' } }]);
  });

  it('失败：reject 出带 code/message 的 NativeError', async () => {
    responder = (callId) =>
      window.__KNative?.resolve(
        callId,
        false,
        JSON.stringify({ code: 'ERR_UNSUPPORTED', message: '未实现的方法: x.y' })
      );
    await expect(call('x.y')).rejects.toMatchObject({
      name: 'NativeError',
      code: 'ERR_UNSUPPORTED',
      message: '未实现的方法: x.y',
    });
  });

  it('无桥：立即 reject（ERR_NO_BRIDGE），调用方据此走 Web 回退', async () => {
    removeBridge();
    await expect(call('viewer.open')).rejects.toMatchObject({ code: 'ERR_NO_BRIDGE' });
  });

  it('超时：到点 reject（ERR_TIMEOUT），不让页面一直等', async () => {
    vi.useFakeTimers();
    responder = () => {
      /* 原生永远不回 */
    };
    const pending = call('viewer.open');
    const assertion = expect(pending).rejects.toMatchObject({ code: 'ERR_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(15_001);
    await assertion;
  });
});

describe('同步读', () => {
  it('info() → AppInfo', () => {
    expect(syncAppInfo()).toEqual({
      platform: 'android',
      versionName: '0.1.0',
      versionCode: 1,
      packageName: 'top.kuangdada.k',
      bridgeVersion: 1,
    });
  });

  it('无桥时 info 返回 null（不抛）', () => {
    removeBridge();
    expect(syncAppInfo()).toBeNull();
  });

  it('prefs 读写走原生（键名由调用方加 k_native_ 前缀）', () => {
    expect(prefsGet('k_native_x')).toBeNull();
    prefsSet('k_native_x', 'v');
    expect(prefsGet('k_native_x')).toBe('v');
  });
});

describe('事件与返回键', () => {
  it('emit 分发给订阅者，退订后不再收到', () => {
    const seen: unknown[] = [];
    const off = on('willClose', (payload) => seen.push(payload));
    window.__KNative!.emit('willClose', JSON.stringify({ index: 2 }));
    off();
    window.__KNative!.emit('willClose', JSON.stringify({ index: 5 }));
    expect(seen).toEqual([{ index: 2 }]);
  });

  it('emit 同时派发 DOM 事件（knative:<event>），便于非 React 侧监听', () => {
    const domEvents: unknown[] = [];
    const handler = (e: Event) => domEvents.push((e as CustomEvent).detail);
    window.addEventListener('knative:deeplink', handler);
    window.__KNative!.emit('deeplink', JSON.stringify({ path: '/post/1' }));
    window.removeEventListener('knative:deeplink', handler);
    expect(domEvents).toEqual([{ path: '/post/1' }]);
  });

  it('返回键裁决处理器可被原生同步读到', () => {
    setBackDecisionHandler(() => 'minimize');
    expect(window.__KNative!.onBackPressed?.()).toBe('minimize');
  });
});

describe('超时策略（真机回归：看图/指纹不能被 15s 误判）', () => {
  it('timeoutMs: 0 → 永不超时（viewer.open 要等用户看完图）', async () => {
    vi.useFakeTimers();
    responder = () => {
      /* 原生永远不回：模拟用户一直看着查看器 */
    };
    let settled = false;
    void call('viewer.open', {}, { timeoutMs: 0 }).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    // 推进 10 分钟：仍不应 settle（旧实现 15s 就 reject，导致网页叠一层 Web 全屏图）
    await vi.advanceTimersByTimeAsync(600_000);
    expect(settled).toBe(false);
  });

  it('webReady 握手：老宿主没有该方法时静默忽略，新的则被调用到', () => {
    // 当前 mock 未暴露 webReady（模拟老宿主）→ 不应抛错
    expect(() => notifyWebReady()).not.toThrow();
    expect(webReadyCalled).toBe(false);

    installBridge(1, true);
    notifyWebReady();
    expect(webReadyCalled).toBe(true);
  });
});
