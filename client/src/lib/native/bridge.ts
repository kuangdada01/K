/**
 * ============================================================
 * 原生桥：底层实现（lib/native/bridge）
 * ============================================================
 * 两个方向：
 * - **网页 → 原生**：`window.KNative`（Android `addJavascriptInterface` 注入的对象）
 *     · 同步读：`info()` / `prefsGet()` / `backPressed()`（立即返回字符串）
 *     · 异步调用：`invoke(callId, method, paramsJson)` → 原生处理完再回调
 * - **原生 → 网页**：`window.__KNative`（本模块安装；原生用 evaluateJavascript 调它）
 *     · `resolve(callId, ok, resultJson)` → 兑现上面的 Promise
 *     · `emit(event, payloadJson)` → 派发给订阅者（同时派发 DOM 事件 `knative:<event>`）
 *
 * 为什么不用同步调用做所有事：`addJavascriptInterface` 的同步方法跑在 WebView 的
 * Java 桥线程上，那里不能碰 UI；涉及界面/权限/Activity 的操作必须回主线程，
 * 因此统一走"投递 + 回调"，由原生自己决定在哪条线程执行。
 *
 * 浏览器环境（无桥）下所有 API 都会安全降级：`isNative()` 返回 false，
 * 调用返回 rejected Promise，订阅返回空退订函数 —— 调用方本来就有 Web 回退路径。
 * ============================================================
 */

import { BRIDGE_VERSION } from './types';
import type { NativeAppInfo, NativeErrorCode } from './types';

/** 原生侧注入的对象（方法由 @JavascriptInterface 暴露） */
interface RawBridge {
  /** 桥协议版本（整数）—— Java 侧只能暴露方法，不能暴露字段，故是函数 */
  version(): number;
  /** 同步返回 App 信息 JSON */
  info(): string;
  /** 同步读原生偏好（不存在返回 null） */
  prefsGet(key: string): string | null;
  /** 同步写原生偏好 */
  prefsSet(key: string, value: string): void;
  /** 异步调用：原生完成后回调 __KNative.resolve */
  invoke(callId: string, method: string, paramsJson: string): void;
  /** 取消在途调用 */
  cancel(callId: string): void;
  /** 网页已装好 window.__KNative（原生据此才补发冷启动深链） */
  webReady(): void;
}

interface InboundBridge {
  resolve(callId: string, ok: boolean, resultJson: string): void;
  emit(event: string, payloadJson: string): void;
  onBackPressed?: () => string;
}

declare global {
  interface Window {
    KNative?: RawBridge;
    __KNative?: InboundBridge;
  }
}

/** 单次调用超时（毫秒）：原生卡住时不能让页面一直等 */
const CALL_TIMEOUT_MS = 15000;

export class NativeError extends Error {
  code: NativeErrorCode;

  constructor(message: string, code: NativeErrorCode) {
    super(message);
    this.name = 'NativeError';
    this.code = code;
  }
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  /** null = 该调用不超时（例如等用户看完图/按完指纹） */
  timer: ReturnType<typeof setTimeout> | null;
}

const pending = new Map<string, PendingCall>();
const listeners = new Map<string, Set<(payload: unknown) => void>>();
let callSeq = 0;

/** 取原生桥（不存在或版本不可识别时返回 undefined） */
function raw(): RawBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  const bridge = window.KNative;
  if (!bridge || typeof bridge.version !== 'function') return undefined;
  if (typeof bridge.invoke !== 'function') return undefined;
  return bridge;
}

/** 是否运行在原生宿主里（桥存在且协议版本兼容） */
export function isNative(): boolean {
  const bridge = raw();
  if (!bridge) return false;
  try {
    // 协议向下兼容：宿主版本 >= 网页期望版本才认
    return bridge.version() >= BRIDGE_VERSION;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------
// 原生 → 网页
// ------------------------------------------------------------------

function dispatch(event: string, payload: unknown): void {
  const set = listeners.get(event);
  if (set) {
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[native] 事件订阅者异常 (${event})`, err);
      }
    }
  }
  try {
    window.dispatchEvent(new CustomEvent(`knative:${event}`, { detail: payload }));
  } catch {
    /* CustomEvent 不可用（极老环境）时忽略 */
  }
}

function installInboundBridge(): void {
  if (typeof window === 'undefined') return;
  const existing = window.__KNative;

  const bridge: InboundBridge = {
    resolve(callId, ok, resultJson) {
      const call = pending.get(callId);
      if (!call) return;
      pending.delete(callId);
      if (call.timer) clearTimeout(call.timer);
      let parsed: unknown = null;
      if (resultJson) {
        try {
          parsed = JSON.parse(resultJson) as unknown;
        } catch {
          parsed = null;
        }
      }
      if (ok) {
        call.resolve(parsed);
      } else {
        const data = parsed as { code?: string; message?: string } | null;
        call.reject(new NativeError(data?.message || '原生调用失败', data?.code || 'ERR_FAILED'));
      }
    },
    emit(event, payloadJson) {
      let payload: unknown = null;
      if (payloadJson) {
        try {
          payload = JSON.parse(payloadJson) as unknown;
        } catch {
          payload = null;
        }
      }
      dispatch(event, payload);
    },
  };

  // 保留已注册的返回键处理器（重复安装/热更新时不丢）
  if (existing?.onBackPressed) bridge.onBackPressed = existing.onBackPressed;

  window.__KNative = bridge;
}

installInboundBridge();

/**
 * 告诉原生"网页侧已经装好 __KNative，可以发事件了"。
 *
 * 为什么必须有这一步：冷启动时原生在**首个内容可见**就补发深链，而那一刻 JS bundle
 * 可能还没执行完、React 的订阅者更没注册 —— 事件发出去没人接，用户看到的就是
 * "点了通知 App 打开了但没跳转"。改由网页主动握手，原生收到才补发。
 */
export function notifyWebReady(): void {
  const bridge = raw();
  if (!bridge || typeof bridge.webReady !== 'function') return;
  try {
    bridge.webReady();
  } catch {
    /* 忽略：握手失败最多是深链晚一次 */
  }
}

/** 订阅原生事件；返回退订函数（非原生环境返回空函数） */
export function on(event: string, callback: (payload: unknown) => void): () => void {
  if (!isNative()) return () => {};
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  set.add(callback);
  return () => {
    const current = listeners.get(event);
    if (!current) return;
    current.delete(callback);
    if (current.size === 0) listeners.delete(event);
  };
}

/**
 * 注册返回键裁决器（由 useAndroidBackButton 调用）。
 * 原生同步调用 `__KNative.onBackPressed()`，本函数返回裁决字符串：
 * 'handled'（网页已处理）| 'minimize'（最小化到后台）| 'exit'（退出应用）
 */
export function setBackDecisionHandler(handler: () => string): void {
  if (typeof window === 'undefined') return;
  installInboundBridge();
  window.__KNative!.onBackPressed = handler;
}

// ------------------------------------------------------------------
// 网页 → 原生
// ------------------------------------------------------------------

/** 异步调用原生方法；非原生环境直接 reject（调用方负责降级） */
export function call<T>(
  method: string,
  params?: unknown,
  options?: {
    /**
     * 超时毫秒数；`0` = 不超时。
     *
     * 为什么需要区分：有些方法的"完成"取决于**用户行为**而不是原生处理速度 ——
     * 典型是 `viewer.open`（用户看完图才关）。统一用 15s 会把它们误判为失败：
     * 看图 20 秒 → 网页以为原生失败 → 叠加一层 Web 全屏图。
     *
     * （曾列在这里的第二个例子是 `biometric.authenticate`；生物识别随「私密文件夹」
     * 在 09-18 一起删掉了，那句提醒也跟着去掉。）
     */
    timeoutMs?: number;
  }
): Promise<T> {
  const bridge = raw();
  if (!bridge) {
    return Promise.reject(new NativeError('原生桥不可用（浏览器环境）', 'ERR_NO_BRIDGE'));
  }
  const timeoutMs = options?.timeoutMs ?? CALL_TIMEOUT_MS;
  const callId = `c${Date.now().toString(36)}-${++callSeq}`;
  return new Promise<T>((resolve, reject) => {
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            pending.delete(callId);
            reject(new NativeError(`原生调用超时: ${method}`, 'ERR_TIMEOUT'));
          }, timeoutMs)
        : null;
    pending.set(callId, {
      resolve: resolve as (value: unknown) => void,
      reject,
      timer,
    });
    try {
      bridge.invoke(callId, method, JSON.stringify(params ?? {}));
    } catch (err) {
      pending.delete(callId);
      if (timer) clearTimeout(timer);
      reject(err instanceof Error ? err : new NativeError(String(err), 'ERR_INVOKE'));
    }
  });
}

/** 同步读 App 信息（原生环境返回对象，浏览器返回 null） */
export function syncAppInfo(): NativeAppInfo | null {
  const bridge = raw();
  if (!bridge) return null;
  try {
    return JSON.parse(bridge.info()) as NativeAppInfo;
  } catch {
    return null;
  }
}

/** 原生偏好读写（键名以 k_native_ 前缀区分，避免与 localStorage 语义混淆） */
export function prefsGet(key: string): string | null {
  const bridge = raw();
  if (!bridge) return null;
  try {
    return bridge.prefsGet(key);
  } catch {
    return null;
  }
}

export function prefsSet(key: string, value: string): void {
  const bridge = raw();
  if (!bridge) return;
  try {
    bridge.prefsSet(key, value);
  } catch {
    /* 忽略 */
  }
}
