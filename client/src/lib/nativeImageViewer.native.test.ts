/**
 * nativeImageViewer 的**原生环境**分支测试：
 * 用 mock 的 @capacitor/core 假装跑在原生里，验证
 * - http(s) 图片 → 真的调用插件
 * - blob:/data: 图片 → 直接返回 null（原生抓不到 WebView 进程内的地址，
 *   例如私密文件夹里还没上传的 blob: 预览），由调用方回退 Web 查看器
 * - 插件抛错 → 返回 null（看图不失效）
 * - 鉴权头：含 /api/ 图片时带上当前 token
 * - willClose 事件：退场飞行开始时就把返回的索引分发给订阅者（对齐轮播）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openMock = vi.fn(async () => ({ index: 3 }));
const closeMock = vi.fn(async () => {});
/** 插件侧注册的 willClose 回调（测试里手动触发，模拟原生发事件） */
let willCloseNativeCb: ((data: { index: number }) => void) | null = null;
const addListenerMock = vi.fn(async (_event: string, cb: (data: { index: number }) => void) => {
  willCloseNativeCb = cb;
  return { remove: async () => {} };
});

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    isPluginAvailable: () => true,
  },
  registerPlugin: () => ({ open: openMock, close: closeMock, addListener: addListenerMock }),
}));

const { authHeadersFor, isNativeViewerAvailable, openNativeViewer, onNativeViewerWillClose } =
  await import('./nativeImageViewer');

beforeEach(() => {
  openMock.mockClear();
  openMock.mockResolvedValue({ index: 3 });
  addListenerMock.mockClear();
  willCloseNativeCb = null;
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('原生环境', () => {
  it('能力探测为 true', () => {
    expect(isNativeViewerAvailable()).toBe(true);
  });

  it('http(s) 图片：调用插件并把索引带回来', async () => {
    const res = await openNativeViewer({
      images: ['https://a/1.jpg', 'https://a/2.jpg'],
      index: 1,
    });
    expect(openMock).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ index: 3 });
  });

  it('含 blob: 图片：不调用插件、返回 null（原生拿不到 WebView 内的 blob）', async () => {
    const res = await openNativeViewer({
      images: ['https://a/1.jpg', 'blob:http://localhost/abc'],
      index: 0,
    });
    expect(res).toBeNull();
    expect(openMock).not.toHaveBeenCalled();
  });

  it('含 data: 图片：同样回退', async () => {
    const res = await openNativeViewer({ images: ['data:image/png;base64,AAA'], index: 0 });
    expect(res).toBeNull();
    expect(openMock).not.toHaveBeenCalled();
  });

  it('插件抛错：返回 null（回退 Web 查看器，看图不失效）', async () => {
    openMock.mockRejectedValueOnce(new Error('activity 启动失败'));
    const res = await openNativeViewer({ images: ['https://a/1.jpg'], index: 0 });
    expect(res).toBeNull();
  });
});

describe('onNativeViewerWillClose（原生环境）', () => {
  it('插件 listener 只注册一次；事件分发给所有订阅者，抛错的不影响别人，退订后不再收到', () => {
    const a = vi.fn();
    const boom = vi.fn(() => {
      throw new Error('x');
    });
    const b = vi.fn();
    const offA = onNativeViewerWillClose(a);
    onNativeViewerWillClose(boom);
    onNativeViewerWillClose(b);
    expect(addListenerMock).toHaveBeenCalledTimes(1); // 全进程只注册一次
    expect(addListenerMock.mock.calls[0]?.[0]).toBe('willClose');

    willCloseNativeCb?.({ index: 4 });
    expect(a).toHaveBeenCalledWith(4);
    expect(b).toHaveBeenCalledWith(4); // 前一个订阅者抛错也没被带崩

    offA();
    willCloseNativeCb?.({ index: 1 });
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
