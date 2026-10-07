/**
 * ============================================================
 * 原生图片查看器桥接（nativeImageViewer）
 * ============================================================
 * 原生宿主内优先走**原生查看器**（ViewPager2 + 原生缩放手势 +
 * 下拉关闭 + 缩略图 Hero 转场），这是微信朋友圈/酷安/系统相册那一套；
 * 浏览器或原生不可用时返回 null，调用方回退到现有 Web 查看器。
 *
 * 用法：
 *   const native = await openNativeViewer({ images, index, headers, rect });
 *   if (!native) { 走 Web 覆盖层 }
 *   else 用 native.index 同步自己的状态（用户可能在原生里翻过页）
 *
 * 与旧实现的差异：原来经 Capacitor `registerPlugin('NativeImageViewer')`，
 * 现在经自研桥 `lib/native`（方法名 `viewer.open` / `viewer.close`，
 * 事件 `willClose`），**参数与返回契约完全不变**。
 * ============================================================
 */

import { NativeError, call, isNative, on } from './native';
import type { NativeViewerRect, NativeViewerResult, OpenNativeViewerOptions } from './native';

export type { NativeViewerRect, OpenNativeViewerOptions, NativeViewerResult };

/** 「即将退出」的本地订阅者与「桥事件是否已注册」标记（见 onNativeViewerWillClose） */
const willCloseListeners = new Set<(index: number) => void>();
let willCloseBound = false;

/** Hero 是否被真机应急开关关掉（k_viewer_hero=off） */
function heroDisabled(): boolean {
  try {
    return localStorage.getItem('k_viewer_hero') === 'off';
  } catch {
    // localStorage 不可用（隐私模式等）：照常做 Hero
    return false;
  }
}

/** 是否可用：仅原生宿主内（浏览器恒为 false） */
export function isNativeViewerAvailable(): boolean {
  return isNative();
}

/**
 * 元素 → **物理像素**矩形（Hero 用）。
 *
 * 为什么在这里换算而不是交给原生：原生侧要用只能靠 `WebView.getScale()` 猜
 * 缩放比（语义含糊，取到异常值就表现为「从错误位置放大」）；网页层
 * `devicePixelRatio` 是确定的。App 里页面缩放已关闭（setSupportZoom(false)），
 * 因此 CSS px × DPR 就是屏幕物理像素，精确无歧义。
 *
 * 应急开关：localStorage 置 `k_viewer_hero=off` 可关掉 Hero（退化为淡入），
 * 便于真机上快速区分「是 Hero 的问题还是查看器本身的问题」。
 */
export function rectOf(el: Element | null): NativeViewerRect | undefined {
  if (!el || heroDisabled()) return undefined;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return undefined;
  const dpr = window.devicePixelRatio || 1;
  return { x: r.left * dpr, y: r.top * dpr, width: r.width * dpr, height: r.height * dpr };
}

/** 一个元素 → 物理像素矩形（内部用；不做应急开关判断） */
function rectOfRaw(el: Element): NativeViewerRect | null {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  const dpr = window.devicePixelRatio || 1;
  return { x: r.left * dpr, y: r.top * dpr, width: r.width * dpr, height: r.height * dpr };
}

/**
 * 横向分页轨道 → 每页各自的缩略图矩形（物理像素，与轨道子元素同序）。
 *
 * ★ 没滚到视口的页要**换算**：轨道停在第 0 页时，第 2 张的 `getBoundingClientRect()`
 *   在屏幕右侧外（left ≈ 轨道左 + 2×页宽）。退场时网页层会先把轮播对齐到那一张，
 *   所以真正有意义的是「该页滚到视口时」的矩形 —— 减去 (i×页宽 − scrollLeft) 即得。
 *   纵坐标不用换算：flex 布局下纵向位置与横向滚动无关。
 */
export function rectsOfTrack(track: HTMLElement | null): (NativeViewerRect | null)[] {
  if (!track || heroDisabled()) return [];
  const els = Array.from(track.children);
  const first = els[0];
  if (!first) return [];
  const slideWidth = first.getBoundingClientRect().width;
  const scrollLeft = track.scrollLeft || 0;
  return els.map((el, i) => {
    const r = rectOfRaw(el);
    if (!r) return null;
    if (els.length === 1 || !(slideWidth > 0)) return r;
    const dx = (scrollLeft - i * slideWidth) * (window.devicePixelRatio || 1);
    return { ...r, x: r.x + dx };
  });
}

/**
 * 一组元素（网格缩略图等，不做分页换算）→ 每张各自的缩略图矩形。
 * 顺序必须与传给原生查看器的 images 一致。
 */
export function rectsOfElements(els: Array<Element | null | undefined>): (NativeViewerRect | null)[] {
  if (heroDisabled()) return [];
  return els.map((el) => (el ? rectOfRaw(el) : null));
}

/**
 * 构造鉴权请求头：只要列表里有 `/api/` 图片就带上当前 token。
 *
 * 为什么必须由网页层传：原生侧是普通 HTTP 请求（可以自定义请求头），
 * 而 WebView 里的 `<img>` 不能 —— 私信/私密图片在 Web 侧是「先取 blob 再显示」，
 * 原生侧得直连 URL，因此需要这张 token。
 * 返回可展开对象（而不是 `headers: undefined`），避免 exactOptionalPropertyTypes 报错。
 */
export function authHeadersFor(images: string[]): { headers?: Record<string, string> } {
  if (!images.some((u) => u.includes('/api/'))) return {};
  try {
    const token = localStorage.getItem('k_token');
    return token ? { headers: { Authorization: `Bearer ${token}` } } : {};
  } catch {
    // localStorage 不可用：不带鉴权头，交给原生侧按 401 处理
    return {};
  }
}

/**
 * 打开原生查看器。不可用时返回 null（调用方回退 Web 查看器）。
 * 关闭（返回键/关闭按钮/下拉）后 resolve，带最终索引。
 */
export async function openNativeViewer(options: OpenNativeViewerOptions): Promise<NativeViewerResult | null> {
  if (!isNativeViewerAvailable()) return null;
  // 原生侧是普通 HTTP 抓图：blob:/data: 这类只存在于 WebView 进程内的地址它拿不到，
  // 直接回退 Web 查看器（典型场景：私密文件夹里「还没上传」的新文件是 blob: 预览）。
  if (!options.images.every((u) => /^https?:\/\//i.test(u))) return null;
  try {
    // **不设超时**：这个 Promise 要等用户看完图关掉查看器才 resolve。
    // 早期用默认 15s，看久一点就会被误判失败 → 网页叠一层 Web 全屏图（"两张图"），
    // 且随后的 willClose 被守卫丢掉，导致退出后轮播不同步。
    return await call<NativeViewerResult>('viewer.open', options, { timeoutMs: 0 });
  } catch (err) {
    // 超时只可能来自不认 timeoutMs 的旧版宿主：此时查看器多半**已经开着**，
    // 绝不能回退 Web 覆盖层（会叠图）—— 返回"仍在原生"的结果，让调用方不要接管。
    if (err instanceof NativeError && err.code === 'ERR_TIMEOUT') return { index: -1 };
    // 其它异常（Activity 启动失败等）才回退 Web —— 看图能力不会整体失效
    return null;
  }
}

/** 关闭原生查看器（若正开着） */
export async function closeNativeViewer(): Promise<void> {
  if (!isNativeViewerAvailable()) return;
  try {
    await call('viewer.close');
  } catch {
    // 忽略：没有打开中的查看器
  }
}

/**
 * 订阅「原生查看器即将退出」（退场飞行动画**开始**时就会触发，早于 resolve）。
 *
 * 为什么必须早于 resolve：退出时原生把图片飞回缩略图、黑幕全程不透明，黑幕揭开
 * 的那一帧网页层的轮播必须已经停在返回的这一张 —— 等 resolve 再同步就晚了，
 * 会出现「落地的是第 3 张、背景露出第 1 张」再跳一下（真机反馈的那个问题）。
 *
 * 桥事件全进程只注册一次，这里只做本地分发；返回退订函数。
 */
export function onNativeViewerWillClose(cb: (index: number) => void): () => void {
  if (!isNativeViewerAvailable()) return () => {};
  willCloseListeners.add(cb);
  if (!willCloseBound) {
    willCloseBound = true;
    on('willClose', (payload) => {
      const data = payload as { index?: number } | null;
      for (const fn of [...willCloseListeners]) {
        try {
          fn(data?.index ?? -1);
        } catch {
          // 单个订阅者出错不影响其它订阅者
        }
      }
    });
  }
  return () => {
    willCloseListeners.delete(cb);
  };
}
