/**
 * nativeImageViewer 的**原生环境**分支测试：
 * 用假的 `window.KNative` 桥假装跑在原生宿主里，验证
 * - http(s) 图片 → 真的走 viewer.open，并把索引带回来
 * - blob:/data: 图片 → 直接返回 null（原生抓不到 WebView 进程内的地址，
 *   例如私密文件夹里还没上传的 blob: 预览），由调用方回退 Web 查看器
 * - 原生调用失败 → 返回 null（看图不失效）
 * - 鉴权头：含 /api/ 图片时带上当前 token
 * - willClose 事件：退场飞行开始时就把返回的索引分发给订阅者（对齐轮播）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface RecordedCall {
  callId: string;
  method: string;
  params: unknown;
}

const calls: RecordedCall[] = [];
/** 每次 viewer.open 的行为（各用例按需覆盖） */
let openBehavior: 'ok' | 'fail' = 'ok';

/** 安装假桥：与 android/.../bridge/KNativeBridge.kt 的契约一致 */
function installBridge(): void {
  (window as unknown as { KNative: unknown }).KNative = {
    version: () => 1,
    info: () =>
      JSON.stringify({
        platform: 'android',
        versionName: '0.1.0',
        versionCode: 1,
        packageName: 'top.kuangdada.k',
        bridgeVersion: 1,
      }),
    prefsGet: () => null,
    prefsSet: () => {},
    cancel: () => {},
    invoke: (callId: string, method: string, paramsJson: string) => {
      calls.push({ callId, method, params: JSON.parse(paramsJson) as unknown });
      // 桥是异步兑现的：原生处理完再回调 __KNative.resolve
      queueMicrotask(() => {
        const inbound = window.__KNative;
        if (!inbound) throw new Error('__KNative 未安装');
        if (method === 'viewer.open') {
          if (openBehavior === 'fail') {
            inbound.resolve(callId, false, JSON.stringify({ code: 'ERR_FAILED', message: '启动失败' }));
          } else {
            inbound.resolve(callId, true, JSON.stringify({ index: 3 }));
          }
        } else {
          inbound.resolve(callId, true, 'null');
        }
      });
    },
  };
}

const { authHeadersFor, isNativeViewerAvailable, openNativeViewer, onNativeViewerWillClose } =
  await import('./nativeImageViewer');

beforeEach(() => {
  calls.length = 0;
  openBehavior = 'ok';
  installBridge();
  localStorage.clear();
});

afterEach(() => {
  delete (window as unknown as { KNative?: unknown }).KNative;
  vi.restoreAllMocks();
});

describe('原生环境', () => {
  it('能力探测为 true', () => {
    expect(isNativeViewerAvailable()).toBe(true);
  });

  it('http(s) 图片：走 viewer.open 并把索引带回来', async () => {
    const res = await openNativeViewer({
      images: ['https://a/1.jpg', 'https://a/2.jpg'],
      index: 1,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('viewer.open');
    expect(calls[0]!.params).toMatchObject({
      images: ['https://a/1.jpg', 'https://a/2.jpg'],
      index: 1,
    });
    expect(res).toEqual({ index: 3 });
  });

  it('含 blob: 图片：不调用原生、返回 null（原生拿不到 WebView 内的 blob）', async () => {
    const res = await openNativeViewer({
      images: ['https://a/1.jpg', 'blob:http://localhost/abc'],
      index: 0,
    });
    expect(res).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('含 data: 图片：同样回退', async () => {
    const res = await openNativeViewer({ images: ['data:image/png;base64,AAA'], index: 0 });
    expect(res).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('原生返回失败：resolve 为 null（回退 Web 查看器，看图不失效）', async () => {
    openBehavior = 'fail';
    const res = await openNativeViewer({ images: ['https://a/1.jpg'], index: 0 });
    expect(res).toBeNull();
  });
});

describe('onNativeViewerWillClose（原生环境）', () => {
  it('事件分发给所有订阅者，抛错的不影响别人，退订后不再收到', () => {
    const a = vi.fn();
    const boom = vi.fn(() => {
      throw new Error('x');
    });
    const b = vi.fn();
    const offA = onNativeViewerWillClose(a);
    onNativeViewerWillClose(boom);
    onNativeViewerWillClose(b);

    window.__KNative!.emit('willClose', JSON.stringify({ index: 4 }));
    expect(a).toHaveBeenCalledWith(4);
    expect(b).toHaveBeenCalledWith(4); // 前一个订阅者抛错也没被带崩

    offA();
    window.__KNative!.emit('willClose', JSON.stringify({ index: 1 }));
    expect(a).toHaveBeenCalledTimes(1); // 已退订
    expect(b).toHaveBeenLastCalledWith(1);
  });
});

describe('authHeadersFor', () => {
  it('普通静态图不加请求头', () => {
    expect(authHeadersFor(['https://a/uploads/1.jpg'])).toEqual({});
  });

  it('含 /api/ 图片时带 Bearer token', () => {
    localStorage.setItem('k_token', 'tok123');
    expect(authHeadersFor(['https://a/api/messages/1/image'])).toEqual({
      headers: { Authorization: 'Bearer tok123' },
    });
  });

  it('没有 token 时不带请求头（交给原生按 401 处理）', () => {
    expect(authHeadersFor(['https://a/api/private/1'])).toEqual({});
  });
});
